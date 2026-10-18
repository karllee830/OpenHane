import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// AI 降噪（DeepFilterNet3 静态库）：与 Web 版 audio-dsp/src/deepfilter.test.ts 相同的用例。
/// 构建时没有生成库（没装 Rust）时跳过；CI 会生成，设置 HANE_REQUIRE_DFN=1 时缺库就失败。
@Suite struct DeepFilterTests {
    static let enabled = DeepFilter.available || ProcessInfo.processInfo.environment["HANE_REQUIRE_DFN"] == "1"

    @Test(.enabled(if: enabled)) func removesSteadyNoiseAndReportsLowLocalSNR() throws {
        let df = try #require(DeepFilter())
        var seed: UInt32 = 7
        var frame = [Float](repeating: 0, count: DeepFilter.frame)
        var levels: [Double] = []
        var lsnrs: [Float] = []
        for f in 0 ..< 300 {
            for i in 0 ..< DeepFilter.frame {
                seed = seed &* 1_103_515_245 &+ 12345
                frame[i] = (Float(seed >> 8) / Float(1 << 24) * 2 - 1) * 0.05 * 32768 // 约 -31 dBFS 的白噪声（16 位 PCM 数值范围）
            }
            let lsnr = frame.withUnsafeMutableBufferPointer { df.process($0.baseAddress!) }
            let finite = frame.allSatisfy(\.isFinite)
            #expect(finite)
            if f >= 100 {
                let e = frame.reduce(0) { $0 + Double($1 / 32768) * Double($1 / 32768) } / Double(frame.count)
                levels.append(10 * log10(e + 1e-12))
                lsnrs.append(lsnr)
            }
        }
        #expect(levels.reduce(0, +) / Double(levels.count) < -31 - 25) // 至少压低 25 dB
        #expect(lsnrs.reduce(0, +) / Float(lsnrs.count) < 0) // 门控不会把纯噪声当成人声
    }

    @Test(.enabled(if: enabled)) func keepsDigitalSilenceSilent() throws {
        let df = try #require(DeepFilter())
        var frame = [Float](repeating: 0, count: DeepFilter.frame)
        for _ in 0 ..< 50 {
            for i in frame.indices { frame[i] = 0 }
            _ = frame.withUnsafeMutableBufferPointer { df.process($0.baseAddress!) }
        }
        let silent = frame.allSatisfy { $0 == 0 }
        #expect(silent)
    }
}

/// AI 降噪跟随会议：进入会议时在后台加载模型，离开时释放；切到「标准」立即停用
@Suite(.serialized) @MainActor struct NoiseSuppressionStateTests {
    @Test(.enabled(if: DeepFilterTests.enabled)) func followsTheMeeting() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let media = MediaSession(session: makeSession(seed: 41, pins: tempPins()))
        media.noiseSuppression = .ai
        #expect(media.noiseState == .standby)
        media.start()
        try await eventually(10) { media.noiseState == .active }
        media.noiseSuppression = .system
        #expect(media.noiseState == .software) // macOS 默认软件回声消除：「标准」用 WebRTC 的降噪
        media.echoProcessing = .system
        #expect(media.noiseState == .system)
        media.echoProcessing = .software
        media.noiseSuppression = .ai // 模型已经加载过，立即恢复
        #expect(media.noiseState == .active)
        await media.stop()
        #expect(media.noiseState == .standby)
    }
}

/// AI 降噪在真实的采集链路里运行：连上内嵌 SFU、发布麦克风后，采集后处理回调是 48 kHz、10 ms 一帧，每帧都经过 AI 降噪
@Suite(.serialized) @MainActor struct NoiseSuppressionPipelineTests {
    @Test(.enabled(if: DeepFilterTests.enabled)) func processesCapturedFramesAt48kHz() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 51, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        let media = MediaSession(session: alice)
        media.noiseSuppression = .ai
        media.start()
        try await eventually(20) { media.status == .connected }
        try await eventually(10) { media.liveRoom?.localParticipant.audioTracks.isEmpty == false }
        try await eventually(10) { media.noiseDiagnostics.contains("frame=processed") }
        #expect(media.noiseDiagnostics.contains("rate=48000"))
        #expect(media.noiseState == .active)
        await media.stop()
        alice.disconnect()
    }
}
