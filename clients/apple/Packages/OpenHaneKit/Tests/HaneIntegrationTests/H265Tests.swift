import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// H.265 屏幕共享的可行性：苹果端用 VideoToolbox 硬件编 H.265，经内嵌 SFU 转发，另一个苹果端能解码出画面。
/// 只在设置 HANE_H265_TEST=1 时运行（实验，不进 CI）。
@Suite(.serialized) @MainActor struct H265Tests {
    nonisolated static let enabled = ProcessInfo.processInfo.environment["HANE_H265_TEST"] == "1"

    @Test(.enabled(if: enabled)) func appleToAppleScreenShareOverSFU() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 61, pins: tempPins())
        let bob = makeSession(seed: 62, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        bm.reportRemoteStatistics = true
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }

        // 屏幕共享走单独的共享连接
        _ = try await alice.requestScreenShare(intent: .clarity, withAudio: false)
        let room = try await am.ensureShareRoom()
        try await eventually(5) { room.localParticipant.permissions.canPublishSources.contains(Track.Source.screenShareVideo.rawValue) }
        let synthetic = SyntheticFrameSource(width: 2560, height: 1440)
        let capture = FrameSourceCapture(source: synthetic, onAudio: nil)
        let (track, _) = try await capture.start(withAudio: false, onStop: {})
        for _ in 0 ..< 100 where track.capturer.dimensions == nil {
            try? await Task.sleep(for: .milliseconds(50))
        }
        let pub = try await room.localParticipant.publish(videoTrack: track, options: VideoPublishOptions(
            screenShareEncoding: VideoEncoding(maxBitrate: 1_500_000, maxFps: 15),
            simulcast: false,
            preferredCodec: .h265,
            degradationPreference: .maintainResolution
        ))
        let aliceID = alice.state.me!.sessionID
        try await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID && ($0.pixelSize?.width ?? 0) > 0 } }
        try await Task.sleep(for: .seconds(4))

        let sent = (pub.track as? LocalVideoTrack)?.statistics
        let sentCodec = sent?.codec.first?.mimeType ?? "?"
        let out = sent?.outboundRtpStream.first
        let recv = bm.videoTracks.first { $0.isScreen && $0.sessionID == aliceID }
        let inStats = (recv?.track as? RemoteVideoTrack)?.statistics
        let recvCodec = inStats?.codec.first?.mimeType ?? "?"
        let inbound = inStats?.inboundRtpStream.first
        print("H265TEST sent codec=\(sentCodec) encoder=\(out?.encoderImplementation ?? "?") \(out?.frameWidth ?? 0)x\(out?.frameHeight ?? 0) frames=\(out?.framesEncoded ?? 0) bytes=\(out?.bytesSent ?? 0)")
        print("H265TEST recv codec=\(recvCodec) decoder=\(inbound?.decoderImplementation ?? "?") frames=\(inbound?.framesDecoded ?? 0) size=\(recv?.pixelSize.map { "\($0)" } ?? "-")")
        #expect(sentCodec.lowercased() == "video/h265")
        #expect(recvCodec.lowercased() == "video/h265")
        #expect((inbound?.framesDecoded ?? 0) > 10)

        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }

    /// 加密房间里苹果端 → 苹果端：编码 → 帧加密（LiveKitWebRTC 原生 FrameCryptor）→ SFU → 解密 → 解码
    @Test(.enabled(if: enabled), arguments: ["h264", "h265", "av1"]) func encryptedScreenShare(codec: String) async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 71, pins: tempPins())
        let bob = makeSession(seed: 72, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        bm.reportRemoteStatistics = true
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }
        var overrides = Openhane_V1_RoomOverrides()
        overrides.e2Ee = true
        let room = try await alice.createRoom(name: "机密", options: HaneCore.RoomOptions(overrides: overrides), join: true)
        try await bob.joinRoom(room.id)
        try await eventually(20) { [am, bm].allSatisfy { $0.liveRoom?.name == room.id && $0.e2ee?.enabled == true && $0.e2ee?.missing.isEmpty == true } }

        _ = try await alice.requestScreenShare(intent: .clarity, withAudio: false)
        let live = try await am.ensureShareRoom()
        try await eventually(5) { live.localParticipant.permissions.canPublishSources.contains(Track.Source.screenShareVideo.rawValue) }
        let capture = FrameSourceCapture(source: SyntheticFrameSource(width: 1920, height: 1080), onAudio: nil)
        let (track, _) = try await capture.start(withAudio: false, onStop: {})
        for _ in 0 ..< 100 where track.capturer.dimensions == nil {
            try? await Task.sleep(for: .milliseconds(50))
        }
        let vc: VideoCodec = codec == "h265" ? .h265 : codec == "av1" ? .av1 : .h264
        let pub = try await live.localParticipant.publish(videoTrack: track, options: VideoPublishOptions(
            screenShareEncoding: VideoEncoding(maxBitrate: 1_500_000, maxFps: 15),
            simulcast: false,
            preferredCodec: vc,
            degradationPreference: .maintainResolution
        ))
        let aliceID = alice.state.me!.sessionID
        _ = try? await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID && ($0.pixelSize?.width ?? 0) > 0 } }
        try await Task.sleep(for: .seconds(4))

        let sent = (pub.track as? LocalVideoTrack)?.statistics
        let out = sent?.outboundRtpStream.first
        let recv = bm.videoTracks.first { $0.isScreen && $0.sessionID == aliceID }
        let inStats = (recv?.track as? RemoteVideoTrack)?.statistics
        let inbound = inStats?.inboundRtpStream.first
        let aliceIdentity = am.liveRoom?.localParticipant.identity?.stringValue ?? ""
        let states = bm.e2ee?.tracks.values.filter { $0.remote && $0.identity.hasPrefix(aliceIdentity) }.map { $0.state.toString() } ?? []
        print("E2EETEST \(codec) sent codec=\(sent?.codec.first?.mimeType ?? "?") frames=\(out?.framesEncoded ?? 0) bytes=\(out?.bytesSent ?? 0) | recv codec=\(inStats?.codec.first?.mimeType ?? "?") frames=\(inbound?.framesDecoded ?? 0) size=\(recv?.pixelSize.map { "\($0)" } ?? "-") | bob e2ee states=\(states) | encryption=\(pub.encryptionType)")
        #expect((inbound?.framesDecoded ?? 0) > 10)
        #expect(!states.contains("decryption_failed"))

        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }
}
