import Foundation
import LiveKit
import HaneCore

/// 发言处理：挂在 LiveKit 的采集后处理回调上（系统 Voice Processing 已完成回声消除和降噪之后），
/// 先做 AI 降噪（开启时），再按 10 ms 帧计算电平、更新发言门控，门关闭时输出静音帧（配合 DTX，带宽接近零；不走静音信令）。
final class VoiceProcessor: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    /// AI 降噪这一帧的情况
    enum AIFrame: Equatable, Sendable {
        case processed
        /// 共享的声音混在麦克风这条轨道里，AI 降噪会把它当噪声去掉
        case pausedForShare
        /// 系统「语音突显」已经在做 AI 降噪，不再叠加一道
        case pausedForVoiceIsolation
        /// 采集不是 48 kHz、10 ms 一帧（例如蓝牙耳机的通话模式）
        case unsupportedFormat
    }

    struct Status: Sendable {
        var levelDb: Double
        var speaking: Bool
        var thresholdDb: Double
        /// 没有启用 AI 降噪时为 nil
        var ai: AIFrame?
        /// 采集后处理的采样率（诊断用）
        var sampleRate: Int
    }

    private let lock = NSLock()
    private var gate: VoiceGate
    private var gain: Float = 0
    private var frames = 0
    private var passthrough = false
    private var deepFilter: DeepFilter?
    private var voiceIsolation = false
    private var sampleRate = 0
    private let onStatus: @Sendable (Status) -> Void

    init(mode: VoiceMode, onStatus: @escaping @Sendable (Status) -> Void) {
        gate = VoiceGate(mode: mode)
        self.onStatus = onStatus
    }

    var audioProcessingName: String { "openhane_voice_gate" }

    func configure(mode: VoiceMode, manualThresholdDb: Double?) {
        lock.withLock {
            gate.mode = mode
            gate.manualThresholdDb = manualThresholdDb
        }
    }

    func setPushToTalk(_ pressed: Bool) {
        lock.withLock { gate.pttPressed = pressed }
    }

    /// 共享声音时关闭门控：共享的声音混在同一条轨道里，不能被发言门控截断
    func setPassthrough(_ on: Bool) {
        lock.withLock { passthrough = on }
    }

    /// 启用 / 停用 AI 降噪（nil 为停用）
    func setDeepFilter(_ df: DeepFilter?) {
        lock.withLock { deepFilter = df }
    }

    /// 系统麦克风模式是否为「语音突显」
    func setVoiceIsolation(_ on: Bool) {
        lock.withLock { voiceIsolation = on }
    }

    func audioProcessingInitialize(sampleRate: Int, channels _: Int) {
        lock.withLock { self.sampleRate = sampleRate }
    }

    func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        let n = audioBuffer.frames
        guard n > 0, audioBuffer.channels > 0 else { return }
        // WebRTC 的音频缓冲是 16 位 PCM 数值范围的浮点数
        let ch0 = audioBuffer.rawBuffer(forChannel: 0)
        // 取出强引用后在锁外处理：主线程同时停用 AI 降噪也不会释放正在使用的实例
        let (df, rate, isolation, bypass) = lock.withLock { (deepFilter, sampleRate, voiceIsolation, passthrough) }
        var vad: Double?
        var ai: AIFrame?
        if let df {
            if bypass {
                ai = .pausedForShare
            } else if isolation {
                ai = .pausedForVoiceIsolation
            } else if rate != DeepFilter.sampleRate || n != DeepFilter.frame {
                ai = .unsupportedFormat
            } else {
                // 噪声已经去掉，门控按降噪后的电平判断；人声与否看局部信噪比
                vad = lsnrToVad(df.process(ch0))
                for c in 1 ..< audioBuffer.channels { audioBuffer.rawBuffer(forChannel: c).update(from: ch0, count: n) }
                ai = .processed
            }
        }
        var sum: Float = 0
        for i in 0 ..< n { sum += ch0[i] * ch0[i] }
        let levelDb = 10 * log10(Double(sum / Float(n)) / (32768.0 * 32768.0) + 1e-12)
        let (open, threshold) = lock.withLock { (gate.update(levelDb: levelDb, vad: vad), gate.thresholdDb) }
        // 门开关时 5 ms 淡入淡出，避免爆音
        let target: Float = open || bypass ? 1 : 0
        let step: Float = 1 / Float(max(1, n / 2))
        for c in 0 ..< audioBuffer.channels {
            let buf = audioBuffer.rawBuffer(forChannel: c)
            var g = gain
            for i in 0 ..< n {
                if g != target { g = target > g ? min(target, g + step) : max(target, g - step) }
                buf[i] *= g
            }
            if c == audioBuffer.channels - 1 { gain = g }
        }
        frames += 1
        if frames % 5 == 0 { onStatus(Status(levelDb: levelDb, speaking: open, thresholdDb: threshold, ai: ai, sampleRate: rate)) }
    }

    func audioProcessingRelease() {}
}
