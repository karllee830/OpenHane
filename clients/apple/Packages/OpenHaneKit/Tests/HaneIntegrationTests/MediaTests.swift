import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

@Suite(.serialized) @MainActor struct MediaTests {
    @Test func connectsToSFUWithTOFUAndPublishesMicrophone() async throws {
        // 手动渲染模式：不访问真实的音频设备（测试进程没有麦克风权限）
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 11, pins: tempPins())
        let bob = makeSession(seed: 12, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        let media = MediaSession(session: alice)
        media.start()

        // 媒体连接经过 TOFU（打过补丁的 SDK）连上内嵌 SFU；SFU 的 webhook 让控制面把 media_connected 推给 Bob
        let aliceID = alice.state.me!.sessionID
        try await eventually(20) { media.status == .connected }
        try await eventually(10) { bob.state.participants[aliceID]?.mediaConnected == true }
        try await eventually(10) { media.liveRoom?.localParticipant.audioTracks.isEmpty == false }

        // 管理员修改语音码率：已发布的麦克风轨道实时调整
        // 码率在麦克风发布完成后才记录：等一下（CI 的慢机器上发布完成和这里的检查可能有先后）
        try await eventually(5) { media.appliedAudioBitrate == 32000 }
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        try await alice.updateSettings(["audio.preset": "\"hd\""])
        try await eventually(5) { media.appliedAudioBitrate == 64000 }

        // 静音 / 取消静音
        await media.setMicMuted(true)
        #expect(media.liveRoom?.localParticipant.audioTracks.first?.isMuted == true)
        await media.setMicMuted(false)
        #expect(media.liveRoom?.localParticipant.audioTracks.first?.isMuted == false)

        await media.stop()
        try await eventually(10) { bob.state.participants[aliceID]?.mediaConnected == false }
        alice.disconnect()
        bob.disconnect()
    }

    @Test func screenShareGrantPublishAdaptAndView() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 21, pins: tempPins())
        let bob = makeSession(seed: 22, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        // 合成画面代替 ScreenCaptureKit（测试进程没有录屏权限，也无法操作系统选择器）
        let synthetic = SyntheticFrameSource(width: 1920, height: 1080)
        am.shareSourceFactory = { synthetic }
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }
        let aliceID = alice.state.me!.sessionID

        // 许可 → 发布：两端都能解码 H.265，苹果用硬件 H.265、备用 H.264；智能模式从「清晰」起步，按原始分辨率发送
        try await am.startScreenShare(intent: .smart, withAudio: false)
        let s0 = try #require(am.share)
        #expect(s0.codec == .h265 && s0.backupCodec == .h264)
        #expect(s0.params.mode == .text)
        #expect(s0.params.height <= 1080)
        try await eventually(10) { bob.state.rooms.values.flatMap(\.shares).map(\.sessionID) == [aliceID] }
        try await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID } }
        try await eventually(10) { (am.share?.sentFps ?? 0) > 0 && (am.share?.sentKbps ?? 0) > 0 }

        // 画面持续大面积变化（视频）：智能模式切到「流畅」
        synthetic.motion = true
        try await eventually(10) { am.share?.params.mode == .motion }

        // 用户改成「清晰优先」：立即切回文字模式，观众端看到新的意图
        await am.setShareIntent(.clarity)
        #expect(am.share?.params.mode == .text)
        try await eventually(5) { bob.state.rooms.values.flatMap(\.shares).first?.intent == .clarity }

        // 自定义：用户指定 720p、15 fps、900 kbps，引擎直接采用（按文字处理）；观众端看到「自定义」
        await am.setShareIntent(.custom, custom: CustomShare(height: 720, fps: 15, kbps: 900))
        let pc = try #require(am.share?.params)
        #expect(pc.height == 720 && pc.width == 1280 && pc.fps == 15 && pc.maxKbps == 900 && pc.mode == .text)
        #expect(am.share?.custom == CustomShare(height: 720, fps: 15, kbps: 900))
        try await eventually(5) { bob.state.rooms.values.flatMap(\.shares).first?.intent == .custom }

        // 自定义里指定编码器：苹果设备可选 H.265 / H.264（硬件）；改成 H.264 时重新发布，观众端继续收到画面
        #expect(am.shareCodecOptions == [.h265, .h264])
        // 成员信息里带着解码能力（选项上提示谁不能硬件解码）：苹果端 H.264 / H.265 硬件，其余软件
        let bobInfo = try #require(alice.state.participants[bob.state.me!.sessionID])
        #expect(bobInfo.decodeHardware == ["video/h264", "video/h265"] && bobInfo.decodeSoftware == ["video/vp8", "video/vp9", "video/av1"])
        #expect(decodeGap(codec: .h265, others: [bobInfo]).isEmpty)
        await am.setShareIntent(.custom, custom: CustomShare(height: 720, fps: 15, kbps: 900, codec: .h264))
        #expect(am.share?.codec == .h264 && am.share?.backupCodec == nil)
        try await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID && $0.pixelSize != nil } }
        try await eventually(10) { (am.share?.sentFps ?? 0) > 0 }
        // 切回智能：编码器回到自动（H.265）
        await am.setShareIntent(.smart)
        #expect(am.share?.codec == .h265 && am.share?.backupCodec == .h264)
        try await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID && $0.pixelSize != nil } }

        // 停止：收回许可，观众端的共享和画面消失
        await am.stopScreenShare()
        #expect(am.share == nil)
        try await eventually(10) { bob.state.rooms.values.flatMap(\.shares).isEmpty }
        try await eventually(10) { !bm.videoTracks.contains { $0.isScreen } }

        // 服务器设为「只用 H.264」（排查硬件编码器问题用）：下一次共享用 H.264
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        try await alice.updateSettings(["video.codec_policy": "\"compat\""])
        try await am.startScreenShare(intent: .smart, withAudio: false)
        #expect(am.share?.codec == .h264 && am.share?.backupCodec == nil)
        try await eventually(15) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID } }
        await am.stopScreenShare()

        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }

    /// 房间里已经有人在共享时进会议：麦克风正常发布，中途不报错。
    /// 发现过的问题：LiveKit 在连接中途（发送连接还没建好）就通知一次权限变化，权限处理里补发麦克风，报「Publisher is nil」
    @Test func joinWhileSomeoneSharesPublishesMicWithoutError() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 41, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        let am = MediaSession(session: alice)
        am.shareSourceFactory = { SyntheticFrameSource(width: 1280, height: 720) }
        am.start()
        try await eventually(20) { am.status == .connected }
        try await am.startScreenShare(intent: .clarity, withAudio: false)

        let bob = makeSession(seed: 42, pins: tempPins())
        try await bob.connect(address: server.address, nickname: "Bob")
        let bm = MediaSession(session: bob)
        bm.start()
        var errors: Set<String> = []
        let deadline = ContinuousClock.now + .seconds(8)
        while ContinuousClock.now < deadline {
            if let e = bm.micError { errors.insert(e) }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(errors.isEmpty, "mic errors while joining: \(errors)")
        #expect(bm.liveRoom?.localParticipant.audioTracks.count == 1)
        #expect(bm.liveShareRoom != nil)

        await am.stopScreenShare()
        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }
}
