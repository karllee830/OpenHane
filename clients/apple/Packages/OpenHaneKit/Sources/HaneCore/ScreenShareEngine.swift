// 屏幕共享自适应引擎（Swift 版）—— 与 Web 版 clients/web/packages/media/src/share/engine.ts 逐行对应。
// 两个实现必须通过同一组测试向量（testdata/share-engine/vectors.json）。

public enum ShareMode: String, Sendable { case text, motion }
public enum EngineIntent: String, Sendable { case smart, text, motion, custom }

/// 自定义档：用户指定的分辨率（高度，nil 为原始分辨率）、帧率、码率（kbps，nil 为自动）
/// 和编码器（只能选本机能硬件编码的，nil 为自动；引擎本身不使用）
public struct CustomShare: Codable, Equatable, Sendable {
    public var height: Int?
    public var fps: Int
    public var kbps: Int?
    public var codec: ShareCodec?
    public init(height: Int?, fps: Int, kbps: Int?, codec: ShareCodec? = nil) {
        self.height = height
        self.fps = fps
        self.kbps = kbps
        self.codec = codec
    }
    public static let `default` = CustomShare(height: nil, fps: 30, kbps: nil)

    /// 24 fps 及以上按动态画面（保帧率），以下按文字（保分辨率）
    public var mode: ShareMode { fps >= 24 ? .motion : .text }
}
public enum ShareCodec: String, Codable, Sendable { case av1, vp9, h265, h264, vp8 }
public enum ShareLimitation: String, Sendable { case none, cpu, bandwidth, other }
public enum ShareThermal: String, Sendable { case nominal, fair, serious, critical }

public struct ShareCaps: Sendable {
    public var maxHeight: Int, maxFps: Int, maxKbps: Int
    public init(maxHeight: Int, maxFps: Int, maxKbps: Int) {
        self.maxHeight = maxHeight; self.maxFps = maxFps; self.maxKbps = maxKbps
    }
}

public struct SourceSize: Sendable {
    public var width: Int, height: Int
    public init(width: Int, height: Int) { self.width = width; self.height = height }
}

/// 一次信号采样（每 500 ms）
public struct ShareSignals: Sendable {
    public var t: Double // 毫秒
    public var changedAreaRatio: Double
    public var changeFps: Double
    public var uplinkKbps: Double
    public var qualityLimitation: ShareLimitation
    public var thermal: ShareThermal
    /// 媒体连接的往返时间（毫秒）。有这个信号时按 BBR 的思路调整档位（见 paceByDelivery）
    public var rttMs: Double?
    /// 这路共享实际发送的码率（kbps）
    public var sentKbps: Double?
    public init(t: Double, changedAreaRatio: Double, changeFps: Double, uplinkKbps: Double,
                qualityLimitation: ShareLimitation = .none, thermal: ShareThermal = .nominal,
                rttMs: Double? = nil, sentKbps: Double? = nil)
    {
        self.t = t; self.changedAreaRatio = changedAreaRatio; self.changeFps = changeFps
        self.uplinkKbps = uplinkKbps; self.qualityLimitation = qualityLimitation; self.thermal = thermal
        self.rttMs = rttMs; self.sentKbps = sentKbps
    }
}

public struct ShareParams: Equatable, Sendable {
    public var mode: ShareMode
    public var level: Int
    public var width: Int, height: Int, fps: Int
    public var maxKbps: Int
    public var degradationPreference: String
    public var contentHint: String
}

public enum Tuning {
    public static let toMotionMinChangedArea = 0.15
    public static let toMotionMinChangeFps = 20.0
    public static let toMotionHoldMs = 2000.0
    public static let toTextWindowMs = 8000.0
    public static let toTextMaxActiveRatio = 0.4
    public static let toTextMinDwellMs = 4000.0
    public static let jitterToleranceMs = 250.0
    public static let cpuHoldMs = 3000.0
    public static let bandwidthHoldMs = 5000.0
    public static let bandwidthRatio = 0.6
    public static let recoverStableMs = 10000.0
    public static let recoverHeadroom = 1.3
    public static let uplinkUsable = 0.85
    // 借鉴 BBR，与 Web 版 TUNING.pace 一致
    public static let paceWindowMs = 10000.0
    public static let paceQueueFactor = 1.5
    public static let paceQueueSlackMs = 30.0
    public static let paceQueueHoldMs = 1000.0
    public static let paceDrainGain = 0.9
    public static let paceProbeMs = 3000.0
    public static let paceLimitedHoldMs = 2000.0
}

private struct Profile {
    let fpsLadder: [Int]
    let heightLadder: [Int]
    let degradationPreference: String
    let contentHint: String
    let fpsFirst: Bool // true：先降帧率再降分辨率
}

private let profiles: [ShareMode: Profile] = [
    .text: Profile(fpsLadder: [15, 10, 5], heightLadder: [2160, 1440, 1080],
                   degradationPreference: "maintain-resolution", contentHint: "text", fpsFirst: true),
    .motion: Profile(fpsLadder: [60, 30], heightLadder: [1080, 720],
                     degradationPreference: "maintain-framerate", contentHint: "motion", fpsFirst: false),
]

private let textBitrate: [Int: Double] = [1080: 800, 1440: 1200, 2160: 2500]
private let motionBitrate: [Int: [Int: Double]] = [720: [30: 2000, 60: 3000], 1080: [30: 3500, 60: 7000], 1440: [30: 5500, 60: 8000]]
/// 其他编码器相对 AV1 的码率系数，按模式分开：滚动文字时 H.264 需要的码率远高于 AV1，动态画面时差距小得多
/// （H.265 同码率下画质明显高于 H.264，文字仍不如 AV1）
public let codecFactor: [ShareMode: [ShareCodec: Double]] = [
    .text: [.av1: 1.0, .vp9: 2.0, .h265: 1.2, .h264: 1.5, .vp8: 1.6],
    .motion: [.av1: 1.0, .vp9: 1.3, .h265: 1.0, .h264: 1.2, .vp8: 1.6],
]

private func nearestKey(_ keys: some Collection<Int>, _ h: Int) -> Int {
    let sorted = keys.sorted()
    return sorted.first { $0 >= h } ?? sorted.last!
}

public final class ScreenShareEngine {
    public private(set) var intent: EngineIntent
    public private(set) var custom: CustomShare?
    public let caps: ShareCaps
    public let source: SourceSize
    public var codec: ShareCodec
    public private(set) var mode: ShareMode
    public private(set) var level = 0
    private var modeSince = -Double.infinity
    private var history: [ShareSignals] = []
    private var lastProblemAt = -Double.infinity
    private var degradeObserveFrom = -Double.infinity
    private var levelChangedAt = -Double.infinity

    public init(intent: EngineIntent, caps: ShareCaps, source: SourceSize, codec: ShareCodec, custom: CustomShare? = nil) {
        self.intent = intent; self.caps = caps; self.source = source; self.codec = codec; self.custom = custom
        // 智能模式从「清晰」起步
        mode = intent == .motion ? .motion : intent == .custom ? (custom?.mode ?? .text) : .text
    }

    /// 切换意图；切到自定义时同时给出参数
    public func setIntent(_ intent: EngineIntent, now: Double, custom: CustomShare? = nil) {
        self.intent = intent
        if let custom { self.custom = custom }
        if intent == .custom, let c = self.custom { switchMode(c.mode, now: now) }
        else if intent != .smart { switchMode(intent == .motion ? .motion : .text, now: now) }
    }

    private func switchMode(_ m: ShareMode, now: Double) {
        guard m != mode else { return }
        mode = m
        modeSince = now
        level = 0
        lastProblemAt = -.infinity
        degradeObserveFrom = now
    }

    private func sustained(_ pred: (ShareSignals) -> Bool, holdMs: Double, now: Double, from: Double = -.infinity) -> Bool {
        // 窗口多看一个抖动容差：采样间隔略大于 500 ms 时，最早的一个样本不会刚好掉出窗口（否则永远凑不满 holdMs）
        let window = history.filter { now - $0.t <= holdMs + Tuning.jitterToleranceMs && $0.t >= from }
        guard let first = window.first, now - first.t >= holdMs - Tuning.jitterToleranceMs else { return false }
        return window.allSatisfy(pred)
    }

    private func ratio(_ pred: (ShareSignals) -> Bool, windowMs: Double, now: Double, from: Double, minCoverMs: Double) -> Double? {
        let window = history.filter { now - $0.t <= windowMs && $0.t >= from }
        guard let first = window.first, now - first.t >= minCoverMs - Tuning.jitterToleranceMs else { return nil }
        return Double(window.filter(pred).count) / Double(window.count)
    }

    private static func isActive(_ x: ShareSignals) -> Bool {
        x.changedAreaRatio > Tuning.toMotionMinChangedArea && x.changeFps >= Tuning.toMotionMinChangeFps
    }

    @discardableResult
    public func update(_ s: ShareSignals) -> ShareParams {
        let now = s.t
        history.append(s)
        history.removeAll { now - $0.t > 12000 }
        if intent == .custom, let custom { return customParams(custom) }

        // 1. 内容状态（只在智能模式下自动切换）
        if intent == .smart {
            if mode == .text, sustained(Self.isActive, holdMs: Tuning.toMotionHoldMs, now: now) {
                switchMode(.motion, now: now)
            } else if mode == .motion,
                      let active = ratio(Self.isActive, windowMs: Tuning.toTextWindowMs, now: now,
                                         from: modeSince, minCoverMs: Tuning.toTextMinDwellMs),
                      active < Tuning.toTextMaxActiveRatio
            {
                switchMode(.text, now: now)
            }
        }

        // 2. 降级 / 恢复
        let target = compute(level)
        let usable = s.uplinkKbps * Tuning.uplinkUsable
        let from = degradeObserveFrom
        let cpuTrouble = sustained({ $0.qualityLimitation == .cpu }, holdMs: Tuning.cpuHoldMs, now: now, from: from)
        let hot = sustained({ $0.thermal == .serious || $0.thermal == .critical }, holdMs: Tuning.cpuHoldMs, now: now, from: from)
        let bwTrouble = sustained({ $0.uplinkKbps * Tuning.uplinkUsable < target.targetKbps * Tuning.bandwidthRatio },
                                  holdMs: Tuning.bandwidthHoldMs, now: now, from: from)
        let paced = s.rttMs != nil
        if paced {
            paceByDelivery(s, now: now, overloaded: cpuTrouble || hot)
        } else if cpuTrouble || hot || bwTrouble {
            if level < maxLevel() {
                level += 1
                degradeObserveFrom = now // 降级后重新观察
            }
            lastProblemAt = now
        } else if level > 0, now - lastProblemAt >= Tuning.recoverStableMs {
            if usable >= compute(level - 1).targetKbps * Tuning.recoverHeadroom {
                level -= 1
                lastProblemAt = now // 每次只恢复一级，再观察一个稳定期
            }
        }

        // 3. 生成参数
        let p = compute(level)
        let profile = profiles[mode]!
        return ShareParams(mode: mode, level: level, width: p.width, height: p.height, fps: p.fps,
                           // 按送达速率调整档位时不按带宽估计压上限：实际发多少交给 WebRTC 的拥塞控制
                           maxKbps: Int(min(p.targetKbps, Double(caps.maxKbps), paced ? .infinity : max(usable, 150)).rounded()),
                           // 按送达速率调整档位时分辨率由引擎决定：WebRTC 只降帧率，不自己降分辨率（它降下去以后升回来极慢）
                           degradationPreference: paced ? "maintain-resolution" : profile.degradationPreference,
                           contentHint: profile.contentHint)
    }

    /// 借鉴 BBR 调整档位（有往返时间信号时），与 Web 版 paceByDelivery 一致：分辨率由引擎决定（降级偏好设为保分辨率）；
    /// 往返时间持续升高 = 在排队，降到最近送达速率放得下的档位；WebRTC 报告受带宽限制、估计不到当前档位的 60%，降到估计值放得下的档位
    /// （都可以一次降多级）；既不排队也不受限持续 3 秒，试探着升一档；CPU、发热时每次降一级。
    private func paceByDelivery(_ s: ShareSignals, now: Double, overloaded: Bool) {
        let window = history.filter { now - $0.t <= Tuning.paceWindowMs && $0.rttMs != nil }
        let rtProp = window.compactMap(\.rttMs).min() ?? .infinity
        let inflated = { (x: ShareSignals) -> Bool in
            guard let r = x.rttMs else { return false }
            return r > rtProp * Tuning.paceQueueFactor + Tuning.paceQueueSlackMs
        }
        func setLevel(_ l: Int) {
            level = l
            levelChangedAt = now
            lastProblemAt = now
            degradeObserveFrom = now
        }
        let maxL = maxLevel()
        // 降到 budget 放得下的档位（码率不低于档位参考码率的 ratio 倍），至少降一级
        func dropTo(_ budget: Double, ratio: Double) {
            var l = level + 1
            while l < maxL, compute(l).targetKbps * ratio > budget { l += 1 }
            setLevel(min(l, maxL))
        }
        let target = compute(level).targetKbps
        let limited = { (x: ShareSignals) in x.qualityLimitation == .bandwidth && x.uplinkKbps < target * Tuning.bandwidthRatio }
        if sustained(inflated, holdMs: Tuning.paceQueueHoldMs, now: now, from: degradeObserveFrom) {
            guard level < maxL else { return }
            let recent = history.filter { now - $0.t <= Tuning.paceQueueHoldMs + Tuning.jitterToleranceMs }
            dropTo((recent.map { $0.sentKbps ?? $0.uplinkKbps }.max() ?? 0) * Tuning.paceDrainGain, ratio: 1)
        } else if sustained(limited, holdMs: Tuning.paceLimitedHoldMs, now: now, from: degradeObserveFrom) {
            if level < maxL { dropTo(s.uplinkKbps, ratio: Tuning.bandwidthRatio) }
        } else if overloaded {
            if level < maxL { setLevel(level + 1) }
        } else if level > 0, now - levelChangedAt >= Tuning.paceProbeMs,
                  sustained({ !inflated($0) && $0.qualityLimitation != .bandwidth }, holdMs: Tuning.paceProbeMs, now: now)
        {
            setLevel(level - 1)
        }
    }

    /// 自定义档：用用户指定的参数，只截到管理员上限，不随内容切换、不自动降级、不按上行带宽压码率
    /// （带宽不够时由 WebRTC 的拥塞控制兜底）。分辨率不超过原始分辨率（不放大）。
    private func customParams(_ c: CustomShare) -> ShareParams {
        mode = c.mode
        level = 0
        let height = Int((Double(min(c.height ?? source.height, source.height, caps.maxHeight)) / 2).rounded()) * 2
        let width = Int((Double(source.width * height) / Double(source.height) / 2).rounded()) * 2
        let fps = max(1, min(c.fps, caps.maxFps))
        // 码率自动：清晰档按 15 fps 的参考码率随帧率放大，流畅档按 30 / 60 fps 的参考码率
        let base: Double = mode == .text
            ? textBitrate[nearestKey(textBitrate.keys, height)]! * max(1, Double(fps) / 15)
            : motionBitrate[nearestKey(motionBitrate.keys, height)]![fps >= 45 ? 60 : 30]!
        let auto = base * (codecFactor[mode]?[codec] ?? 1.5)
        let profile = profiles[mode]!
        return ShareParams(mode: mode, level: 0, width: width, height: height, fps: fps,
                           maxKbps: Int(max(100, min(c.kbps.map(Double.init) ?? auto, Double(caps.maxKbps))).rounded()),
                           degradationPreference: profile.degradationPreference, contentHint: profile.contentHint)
    }

    private func ladders() -> (heights: [Int], fps: [Int]) {
        let pr = profiles[mode]!
        let capH = min(caps.maxHeight, source.height)
        var heights = pr.heightLadder.filter { $0 <= capH }
        if heights.isEmpty { heights = [capH] }
        var fps = pr.fpsLadder.filter { $0 <= caps.maxFps }
        if fps.isEmpty { fps = [caps.maxFps] }
        return (heights, fps)
    }

    private func maxLevel() -> Int {
        let l = ladders()
        return l.heights.count - 1 + l.fps.count - 1
    }

    private func compute(_ level: Int) -> (width: Int, height: Int, fps: Int, targetKbps: Double) {
        let pr = profiles[mode]!
        let l = ladders()
        var hi = 0, fi = 0, remaining = level
        for fpsStep in pr.fpsFirst ? [true, false] : [false, true] {
            if fpsStep { let d = min(remaining, l.fps.count - 1); fi = d; remaining -= d }
            else { let d = min(remaining, l.heights.count - 1); hi = d; remaining -= d }
        }
        let height = l.heights[hi]
        let width = Int((Double(source.width * height) / Double(source.height) / 2).rounded()) * 2
        let fps = l.fps[fi]
        let base: Double
        if mode == .text {
            base = textBitrate[nearestKey(textBitrate.keys, height)]!
        } else {
            let row = motionBitrate[nearestKey(motionBitrate.keys, height)]!
            base = row[fps >= 45 ? 60 : 30]!
        }
        return (width, height, fps, base * (codecFactor[mode]?[codec] ?? 1.5))
    }
}
