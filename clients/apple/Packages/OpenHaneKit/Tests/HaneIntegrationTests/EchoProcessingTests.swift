import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 回声消除的实现：软件处理时不用系统语音处理（不压低其他应用的声音），AI 降噪时不叠加 WebRTC 降噪
@Suite struct EchoProcessingTests {
    @Test func platformDefaults() {
        #if os(macOS)
        #expect(EchoProcessing.platformDefault == .software)
        #else
        #expect(EchoProcessing.platformDefault == .system)
        #endif
    }

    @Test func softwareForcesWebRTCProcessing() {
        let ai = audioProcessingOptions(.software, noise: .ai)
        #expect(ai.echoCancellation && ai.echoCancellationMode == .software)
        #expect(ai.autoGainControl && ai.autoGainControlMode == .software)
        #expect(!ai.noiseSuppression) // AI 降噪负责，不叠加
        let standard = audioProcessingOptions(.software, noise: .system)
        #expect(standard.noiseSuppression && standard.noiseSuppressionMode == .software)
    }

    @Test func systemUsesPlatformVoiceProcessing() {
        let o = audioProcessingOptions(.system, noise: .ai)
        #expect(o.echoCancellation && o.echoCancellationMode == .automatic && o.noiseSuppression && o.noiseSuppressionMode == .automatic)
        let c = audioCaptureOptions(.software, noise: .ai)
        #expect(c.echoCancellationMode == .software && !c.noiseSuppression)
    }
}
