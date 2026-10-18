import LiveKit
import HaneCore

/// 回声消除的实现。
/// 系统语音处理（Voice Processing I/O）效果好、能用「语音突显」，但工作时系统会压低其他应用的声音，而且没有「不压低」这一档；
/// 浏览器（例如 Chrome）在 Mac 上用的是软件回声消除，不会压低。所以 macOS 默认用软件回声消除（WebRTC AEC3，与网页版相同），
/// iPhone 默认用系统语音处理（手机外放的回声更难处理，系统效果明显更好）。
public enum EchoProcessing: String, Codable, Sendable, CaseIterable {
    /// WebRTC 的软件回声消除和自动增益，不压低其他应用的声音
    case software
    /// 系统语音处理：回声消除、降噪、自动增益都由系统完成，会压低其他应用的声音
    case system

    public static var platformDefault: EchoProcessing {
        #if os(macOS)
        .software
        #else
        .system
        #endif
    }
}

/// 麦克风的音频处理参数。软件处理时：选了 AI 降噪就不再叠加 WebRTC 的降噪（与网页版相同），选「标准」时用 WebRTC 的降噪
func audioProcessingOptions(_ echo: EchoProcessing, noise: NoiseSuppression) -> AudioProcessingOptions {
    switch echo {
    case .system:
        AudioProcessingOptions() // 全部 automatic：有系统语音处理就用系统的
    case .software:
        AudioProcessingOptions(echoCancellation: true, autoGainControl: true, noiseSuppression: noise == .system,
                               echoCancellationMode: .software, autoGainControlMode: .software, noiseSuppressionMode: .software)
    }
}

func audioCaptureOptions(_ echo: EchoProcessing, noise: NoiseSuppression) -> AudioCaptureOptions {
    let o = audioProcessingOptions(echo, noise: noise)
    return AudioCaptureOptions(echoCancellation: o.echoCancellation, autoGainControl: o.autoGainControl, noiseSuppression: o.noiseSuppression,
                               echoCancellationMode: o.echoCancellationMode, autoGainControlMode: o.autoGainControlMode,
                               noiseSuppressionMode: o.noiseSuppressionMode)
}
