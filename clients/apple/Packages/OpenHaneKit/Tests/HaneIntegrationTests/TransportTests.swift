import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 屏幕共享连接的传输方式：默认 TCP 优先，共享连接从一开始就只走 ICE/TCP；
/// TCP 连不上时改用 UDP；管理员设为 UDP 优先时先走 UDP，需要时 ICE 重启切到 TCP。主连接（语音、摄像头）始终走 UDP。
/// 「自动」切换的判断逻辑见 HaneCoreTests/TransportMonitorTests。
@Suite(.serialized) @MainActor struct TransportTests {
    @Test func shareConnectionTCPFirstFallsBackToUDPAndVoiceStaysOnUDP() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        // 测试服务器默认关闭 TCP 回退端口：这里打开一个
        let server = try TestServer(env: ["HANE_TCP_FALLBACK_PORT": "\(TestServer.freePort())"])
        defer { server.stop() }
        let alice = makeSession(seed: 81, pins: tempPins())
        let bob = makeSession(seed: 82, pins: tempPins())
        let carol = makeSession(seed: 83, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        try await carol.connect(address: server.address, nickname: "Carol")
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        let cm = MediaSession(session: carol)
        bm.reportRemoteStatistics = true
        cm.reportRemoteStatistics = true
        // Carol 模拟 TCP 连不上（端口被拦）：超时设得极短
        cm.shareTCPTimeout = 0.01
        let synthetic = SyntheticFrameSource(width: 1280, height: 720)
        synthetic.motion = true
        am.shareSourceFactory = { synthetic }
        for m in [am, bm, cm] { m.start() }
        try await eventually(20) { [am, bm, cm].allSatisfy { $0.status == .connected } }

        // 开始共享：共享连接按需建立，从一开始就走 TCP（没有切换）
        let start = ContinuousClock.now
        try await am.startScreenShare(intent: .smoothness, withAudio: false)
        try await eventually(20) { am.transportProtocol == .tcp && bm.transportProtocol == .tcp }
        print("TRANSPORT share connections on TCP after \(ContinuousClock.now - start)")
        #expect(am.tcpSwitched == nil && bm.tcpSwitched == nil)
        // Carol 的 TCP 连接超时，改用 UDP，照样能看到共享
        try await eventually(20) { cm.transportProtocol == .udp }

        // 主连接（语音）仍走 UDP
        let mic = try #require(am.liveRoom?.localParticipant.audioTracks.first?.track)
        await mic.set(reportStatistics: true)
        try await eventually(5) { mic.statistics?.localIceCandidate?.protocol != nil }
        #expect(mic.statistics?.localIceCandidate?.protocol == "udp")

        // Bob、Carol 在共享连接上收到画面，Bob 在主连接上收到 Alice 的声音
        let aliceID = alice.state.me!.sessionID
        let aliceIdentity = try #require(am.liveRoom?.localParticipant.identity)
        func micPackets() -> UInt64 {
            let pub = bm.liveRoom?.remoteParticipants[aliceIdentity]?.audioTracks.first
            return (pub?.track as? RemoteAudioTrack)?.statistics?.inboundRtpStream.first?.packetsReceived ?? 0
        }
        func screenFrames(_ m: MediaSession) -> UInt {
            m.videoTracks.first { $0.isScreen && $0.sessionID == aliceID }.flatMap { ($0.track as? RemoteVideoTrack)?.statistics?.inboundRtpStream.first?.framesDecoded } ?? 0
        }
        try await eventually(15) { micPackets() > 0 && screenFrames(bm) > 0 && screenFrames(cm) > 0 }
        let (p0, f0, c0) = (micPackets(), screenFrames(bm), screenFrames(cm))
        try await Task.sleep(for: .seconds(3))
        print("TRANSPORT mic packets \(p0) → \(micPackets()), screen frames bob \(f0) → \(screenFrames(bm)), carol \(c0) → \(screenFrames(cm))")
        #expect(micPackets() > p0) // 测试里麦克风是静音输入，开着 DTX 时包很少，只看是否还在发
        #expect(screenFrames(bm) > f0 + 10)
        #expect(screenFrames(cm) > c0 + 10)

        // 管理员设为 UDP 优先：新的共享连接先走 UDP，需要时 ICE 重启切到 TCP（和「自动」检测相同的切换路径），画面继续
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        try await alice.updateSettings(["media.share_transport": "\"udp\""])
        let dave = makeSession(seed: 84, pins: tempPins())
        try await dave.connect(address: server.address, nickname: "Dave")
        let dm = MediaSession(session: dave)
        dm.reportRemoteStatistics = true
        dm.start()
        try await eventually(20) { dm.status == .connected && dm.transportProtocol == .udp }
        let share = try #require(dm.liveShareRoom)
        try await share.debug_simulate(scenario: .forceTCP)
        try await share.debug_simulate(scenario: .fullReconnect)
        try await eventually(20) { dm.transportProtocol == .tcp }
        try await eventually(15) { screenFrames(dm) > 10 }

        await am.stopScreenShare()
        for m in [am, bm, cm, dm] { await m.stop() }
        for s in [alice, bob, carol, dave] { s.disconnect() }
    }
}
