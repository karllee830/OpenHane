import Foundation

public enum VoiceMode: String, Codable, Sendable, CaseIterable {
    case voice // 语音激活
    case ptt // 按键说话
    case open // 常开
}

/// 降噪档位。苹果端的系统 Voice Processing 始终开着（回声消除离不开它），
/// AI 降噪（DeepFilterNet3）在它之后再处理一遍。
public enum NoiseSuppression: String, Codable, Sendable, CaseIterable {
    case ai // AI 降噪（默认）
    case system // 只用系统语音处理
}

/// 把 DeepFilterNet 的局部信噪比换算成语音概率（0 dB 对应 0.5），供发言门控使用。
/// 与 Web 版 audio-dsp/deepfilter.ts 的 lsnrToVad 相同；局部信噪比无效（NaN）时返回 nil。
public func lsnrToVad(_ lsnr: Float) -> Double? {
    lsnr.isFinite ? 1 / (1 + exp(-Double(lsnr) / 3)) : nil
}

/// 发言门控，按 10 ms 帧更新。与 Web 版 audio-dsp/gate.ts 是同一份规格、同一组测试。
/// 开启 AI 降噪时传入由局部信噪比换算的语音概率，电平用降噪后的；否则只用能量门限（自适应噪声底）。
public struct VoiceGate: Sendable {
    public static let frameMs = 10
    static let voiceHoldMs = 300
    static let pttHoldMs = 200

    public var mode: VoiceMode
    /// nil 表示自动，否则为手动门限（dBFS）
    public var manualThresholdDb: Double?
    public var pttPressed = false
    public private(set) var noiseFloorDb = -60.0
    private var holdMs = 0
    private var isOpen = false

    public init(mode: VoiceMode, manualThresholdDb: Double? = nil) {
        self.mode = mode
        self.manualThresholdDb = manualThresholdDb
    }

    public var thresholdDb: Double { manualThresholdDb ?? max(noiseFloorDb + 10, -55) }

    /// 处理一帧，vad 为语音概率（没有时传 nil）。返回门是否打开。
    public mutating func update(levelDb: Double, vad: Double? = nil) -> Bool {
        let threshold = thresholdDb
        let speech = vad.map { $0 >= 0.5 && levelDb > threshold - 10 } ?? (levelDb > threshold)
        // 噪声底：下降快、上升慢；语音帧上升更慢（约 5 秒吸收持续的稳态噪声）
        let a = levelDb < noiseFloorDb ? 0.2 : (speech ? 0.005 : 0.02)
        noiseFloorDb = min(-20, max(-90, noiseFloorDb + a * (levelDb - noiseFloorDb)))
        switch mode {
        case .open:
            isOpen = true
        case .ptt:
            if pttPressed {
                isOpen = true
                holdMs = Self.pttHoldMs
            } else if isOpen {
                holdMs -= Self.frameMs
                isOpen = holdMs > 0
            }
        case .voice:
            if speech {
                isOpen = true
                holdMs = Self.voiceHoldMs
            } else if isOpen {
                holdMs -= Self.frameMs
                isOpen = holdMs > 0
            }
        }
        return isOpen
    }
}
