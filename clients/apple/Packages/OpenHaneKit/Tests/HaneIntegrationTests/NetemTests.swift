import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 弱网测试用的 TURN 中继（server/cmd/hanenetem）：注入限速、延迟、抖动、丢包，可切换场景、让中继分配失效（模拟换网）
final class NetemRelay: @unchecked Sendable {
    let turnPort: Int
    let controlPort: Int
    private let process: Process

    private static let serverDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("../../../../../../server").standardized

    init() throws {
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("hane-netem-\(UUID().uuidString)").path
        let build = Process()
        build.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        build.arguments = ["go", "build", "-o", bin, "./cmd/hanenetem"]
        build.currentDirectoryURL = Self.serverDir
        try build.run()
        build.waitUntilExit()
        guard build.terminationStatus == 0 else { throw NSError(domain: "NetemRelay", code: 1) }
        turnPort = TestServer.freeUDPPort()
        controlPort = TestServer.freeUDPPort()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["-listen", "127.0.0.1:\(turnPort)", "-control", "127.0.0.1:\(controlPort)"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        process = p
    }

    var relay: (url: String, username: String, credential: String) {
        ("turn:127.0.0.1:\(turnPort)?transport=udp", "hane", "hane")
    }

    @discardableResult
    func control(_ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(controlPort)\(path)")!)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func stop() { process.terminate() }
}

extension TestServer {
    /// 空闲端口（TCP 和 UDP 都没被占用的概率很高；本机测试足够）
    static func freeUDPPort() -> Int {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
    }
}

/// 苹果客户端的弱网与换网恢复。Alice 只走受损的中继，Bob 直连；看 Bob 收到 Alice 声音的情况。
/// 约 30 秒，设置 HANE_NETEM=1 时运行（与 Web 的 netem.spec 一致）。
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["HANE_NETEM"] != nil)) @MainActor struct NetemTests {
    /// Bob 收到的远端音频包数（SDK 每秒更新的轨道统计）
    private func received(_ m: MediaSession) -> UInt64 {
        guard let room = m.liveRoom else { return 0 }
        var n: UInt64 = 0
        for p in room.remoteParticipants.values {
            for pub in p.audioTracks {
                n += pub.track?.statistics?.inboundRtpStream.compactMap(\.packetsReceived).reduce(0, +) ?? 0
            }
        }
        return n
    }

    /// 每秒收包数（等待 window 秒取平均）
    private func rate(_ m: MediaSession, window: Double = 3) async throws -> Double {
        let a = received(m)
        try await Task.sleep(for: .seconds(window))
        return Double(received(m) - a) / window
    }

    @Test func voiceThroughImpairedRelayAndRecoveryAfterPathChange() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let netem = try NetemRelay()
        defer { netem.stop() }
        // 等中继的控制接口就绪
        for _ in 0..<50 where (try? await netem.control("/stats")) == nil { try await Task.sleep(for: .milliseconds(200)) }
        let alice = makeSession(seed: 61, pins: tempPins())
        let bob = makeSession(seed: 62, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        let am = MediaSession(session: alice)
        am.relayOnly = netem.relay
        let bm = MediaSession(session: bob)
        bm.reportRemoteStatistics = true
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }
        // Alice 确实只走中继
        let stats = try await netem.control("/stats")
        #expect((stats["allocations"] as? Int ?? 0) > 0)

        // 测试模式下麦克风输入是静音：Opus 的不连续传输（DTX）只发零星的包（约 3 包 / 秒），足以判断路径通不通
        try await eventually(15) { self.received(bm) > 20 }
        let base = try await rate(bm)
        print("netem: baseline \(base) packets/s")
        #expect(base >= 2)

        // 差网（上行 1 Mbps、单向 75 ms、5% 丢包）：仍然持续收到
        try await netem.control("/profile?name=poor")
        try await Task.sleep(for: .seconds(2))
        let poor = try await rate(bm, window: 5)
        print("netem: poor \(poor) packets/s")
        #expect(poor >= 1.5)
        try await netem.control("/profile?name=off")

        // 换网：中继分配全部失效。测量 Bob 重新收到 Alice 的包（连续两秒每秒 ≥ 2 个）的时间
        let t0 = ContinuousClock.now
        try await netem.control("/reset")
        var last = received(bm)
        var recovered: Duration?
        var good = 0
        var firstGood: Duration?
        while ContinuousClock.now - t0 < .seconds(60) {
            try await Task.sleep(for: .seconds(1))
            let now = received(bm)
            if now - last >= 2, ContinuousClock.now - t0 > .seconds(1.5) {
                good += 1
                if firstGood == nil { firstGood = ContinuousClock.now - t0 - .seconds(1) }
                if good >= 2 {
                    recovered = firstGood
                    break
                }
            } else {
                good = 0
                firstGood = nil
            }
            last = now
        }
        print("netem: path change recovered after \(recovered.map { "\($0)" } ?? "never")")
        let r = try #require(recovered)
        #expect(r < .seconds(30))

        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }
}
