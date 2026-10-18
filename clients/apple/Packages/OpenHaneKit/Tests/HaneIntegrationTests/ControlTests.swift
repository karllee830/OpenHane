import Foundation
@testable import HaneCore
import Testing

@MainActor
func makeSession(seed: UInt8, pins: URL) -> ServerSession {
    var s = Data(count: 32)
    s[0] = seed
    return ServerSession(trust: TrustStore(fileURL: pins), seeds: MemorySeedStore(seed: s),
                         client: .init(appVersion: "test", platform: .macos, osVersion: "test", deviceName: "test"))
}

@MainActor
func eventually(_ timeout: Double = 5, sourceLocation: SourceLocation = #_sourceLocation, _ cond: @MainActor () -> Bool) async throws {
    let end = Date().addingTimeInterval(timeout)
    while !cond() {
        if Date() > end {
            Issue.record("condition not met within \(timeout)s", sourceLocation: sourceLocation)
            throw HaneError.timeout
        }
        try await Task.sleep(for: .milliseconds(20))
    }
}

func tempPins() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("hane-pins-\(UUID().uuidString).json") }

@Suite(.serialized) @MainActor struct ControlTests {
    @Test func joinChatTokenSettingsAndTOFU() async throws {
        let server = try TestServer()
        defer { server.stop() }
        let pinsA = tempPins(), pinsB = tempPins()
        let alice = makeSession(seed: 1, pins: pinsA)
        let bob = makeSession(seed: 2, pins: pinsB)
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")

        // 自签名证书在第一次连接时被记住；鉴权时携带的指纹与服务端一致（否则会被拒绝）
        #expect(alice.trust.pinned(hostPort: server.address) == server.fingerprint)
        #expect(alice.status == .connected)
        #expect(alice.state.media?.token.isEmpty == false)
        #expect(alice.state.media?.url.absoluteString == "wss://\(server.address)")
        try await eventually { alice.state.participants.count == 2 }

        try await bob.sendChat("你好，Alice")
        try await eventually { alice.state.chat["main"]?.contains { $0.text == "你好，Alice" } == true }

        try await alice.updateSelf(micMuted: true)
        let aliceID = alice.state.me!.sessionID
        try await eventually { bob.state.participants[aliceID]?.state.micMuted == true }

        #expect(try await alice.redeemToken(server.adminToken.lowercased()) == .admin)
        try await eventually { alice.state.me?.role == .admin }
        try await alice.updateSettings(["server.name": "\"Swift 测试\"", "audio.preset": "\"hd\""])
        try await eventually { bob.state.serverInfo.name == "Swift 测试" }
        try await eventually { bob.state.media?.policy.audio.maxBitrateBps == 64000 }
        await #expect(throws: HaneError.self) { try await bob.getSettings() }

        alice.disconnect()
        bob.disconnect()
    }

    @Test func fingerprintChangeIsRejectedUntilAccepted() async throws {
        let server = try TestServer()
        defer { server.stop() }
        let pins = tempPins()
        try JSONEncoder().encode([server.address: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]).write(to: pins)
        let s = makeSession(seed: 3, pins: pins)
        var mismatch: TrustStore.Mismatch?
        do {
            try await s.connect(address: server.address, nickname: "Carol")
            Issue.record("connection should be rejected")
        } catch let HaneError.fingerprintChanged(m) {
            mismatch = m
        }
        #expect(mismatch?.actual == server.fingerprint)
        #expect(s.status == .failed(.fingerprintChanged(mismatch!)))
        s.trust.accept(mismatch!)
        try await s.reconnect()
        #expect(s.status == .connected)
        s.disconnect()
    }

    @Test func resumesSessionAfterDrop() async throws {
        let server = try TestServer()
        defer { server.stop() }
        let a = makeSession(seed: 4, pins: tempPins())
        try await a.connect(address: server.address, nickname: "Dropper")
        let sid = a.state.me!.sessionID
        a.simulateNetworkDrop()
        try await eventually { if case .reconnecting = a.status { return true }; return false }
        try await eventually(10) { a.status == .connected }
        #expect(a.state.me?.sessionID == sid)
        a.disconnect()
    }
}
