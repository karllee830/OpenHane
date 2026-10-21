import Foundation

/// 流量优先级：语音 > 摄像头 > 屏幕共享 > 聊天图片—— 与 Web 版 packages/media/src/traffic.ts 一致，
/// 共用 testdata/traffic/vectors.json。
///
/// 不给图片设固定的带宽上限，而是让它只用媒体剩下的空闲带宽（类似 LEDBAT 这类低优先级后台传输）：
/// 每秒看一次媒体的状况，出现拥堵的迹象（往返时间比平时高出一截＝开始排队、丢包、编码器受带宽限制、接收端抖动缓冲变长或卡顿）
/// 就把图片的速度减半，一切正常时逐步加速（1.5 倍），网络空闲时照样能跑满。
/// 屏幕共享在语音或摄像头吃紧时也让路（往返时间上升、丢包或摄像头受带宽限制时，共享引擎按更低的上行带宽调整）。
public enum Traffic {
    /// 往返时间、抖动缓冲的基准取最近这么久的最低值
    static let baselineMs = 30000.0
    /// 往返时间比基准高出这么多：链路上开始排队了
    static let rttRiseMs = 60.0
    /// 丢包率超过这个值算拥堵
    static let loss = 0.03
    /// 下行丢包率要在收到这么多包时才可信
    static let minPackets = 50
    /// 语音的抖动缓冲比基准长出这么多：下行在排队
    static let jitterRiseMs = 60.0
    /// 图片传输的速度（字节/秒）：起始、下限、上限
    public static let initialBps = 250_000
    static let minBps = 4000
    static let maxBps = 125_000_000
    /// 正常时每次乘以 increase，拥堵时乘以 decrease
    static let increase = 1.5
    static let decrease = 0.5
    /// 这么久没有传输就回到起始速度（下次传输从头试探）
    static let idleMs = 10000.0
}

/// 每秒一次的媒体状况
public struct TrafficSample: Codable, Equatable, Sendable {
    public var t: Double
    /// 上行：自己发出的语音和视频的往返时间（毫秒，对方接收报告里的最大值）和丢包率（0–1），没有数据时为 nil
    public var upRttMs: Double?
    public var upLoss: Double?
    /// 摄像头 / 屏幕共享的编码器受带宽限制
    public var cameraLimited = false
    public var shareLimited = false
    /// 下行：这段时间收到的包里丢了多少（0–1）和收到的包数
    public var downLoss: Double?
    public var downPackets = 0
    /// 下行：远端语音的平均抖动缓冲延迟（毫秒），没有数据时为 nil
    public var jitterBufferMs: Double?
    /// 下行：这段时间远端视频的卡顿次数
    public var freezes = 0
    /// 上次采样以来有没有在上传 / 下载图片（没在用时不加速）
    public var upActive = false
    public var downActive = false

    public init(t: Double) { self.t = t }
}

public struct TrafficState: Codable, Equatable, Sendable {
    public var upCongested: Bool
    public var downCongested: Bool
    /// 屏幕共享应当让路（语音或摄像头吃紧）
    public var shareYield: Bool
    /// 图片上传 / 下载当前允许的速度（字节/秒）
    public var upBps: Int
    public var downBps: Int
}

/// 一段时间内的最低值
private struct WindowMin {
    private var samples: [(t: Double, v: Double)] = []
    mutating func update(_ t: Double, _ v: Double?) -> Double? {
        if let v { samples.append((t, v)) }
        samples.removeAll { t - $0.t >= Traffic.baselineMs }
        return samples.map(\.v).min()
    }
}

private struct Lane {
    var bps = Traffic.initialBps
    private var lastActive = -Double.infinity

    mutating func update(_ t: Double, congested: Bool, active: Bool) -> Int {
        if active { lastActive = t }
        if congested {
            bps = max(Traffic.minBps, Int((Double(bps) * Traffic.decrease).rounded()))
        } else if active {
            bps = min(Traffic.maxBps, Int((Double(bps) * Traffic.increase).rounded()))
        } else if t - lastActive >= Traffic.idleMs {
            bps = Traffic.initialBps
        }
        return bps
    }
}

public struct TrafficPolicy: Sendable {
    private var rtt = WindowMin()
    private var jitter = WindowMin()
    private var up = Lane()
    private var down = Lane()

    public init() {}

    public mutating func update(_ s: TrafficSample) -> TrafficState {
        let minRtt = rtt.update(s.t, s.upRttMs)
        let minJitter = jitter.update(s.t, s.jitterBufferMs)
        let queued = if let r = s.upRttMs, let m = minRtt { r - m > Traffic.rttRiseMs } else { false }
        let lossyUp = (s.upLoss ?? 0) > Traffic.loss
        let shareYield = queued || lossyUp || s.cameraLimited
        let upCongested = shareYield || s.shareLimited
        let lossyDown = s.downPackets >= Traffic.minPackets && (s.downLoss ?? 0) > Traffic.loss
        let jitterUp = if let j = s.jitterBufferMs, let m = minJitter { j - m > Traffic.jitterRiseMs } else { false }
        let downCongested = lossyDown || jitterUp || s.freezes > 0
        return TrafficState(upCongested: upCongested, downCongested: downCongested, shareYield: shareYield,
                            upBps: up.update(s.t, congested: upCongested, active: s.upActive),
                            downBps: down.update(s.t, congested: downCongested, active: s.downActive))
    }
}

/// 下行统计的累计值（两次采样之间要记住）
public struct TrafficCounters: Sendable, Equatable {
    public var lost: Int64 = 0
    public var received: UInt64 = 0
    public var jitterDelay = 0.0
    public var jitterEmitted: UInt64 = 0
    public var freezes: UInt64 = 0

    public init() {}

    /// 用这次的累计值 now 和上次的比较，填好样本的下行部分，并记住这次的值。
    /// 轨道换了时累计值会变小：这一次按没有数据处理
    public mutating func fill(_ s: inout TrafficSample, now: TrafficCounters) {
        let reset = now.lost < lost || now.received < received || now.jitterDelay < jitterDelay || now.jitterEmitted < jitterEmitted || now.freezes < freezes
        let dLost = reset ? 0 : Double(now.lost - lost)
        let dReceived = reset ? 0 : Double(now.received - received)
        let dEmitted = reset ? 0 : Double(now.jitterEmitted - jitterEmitted)
        let dDelay = max(0, now.jitterDelay - jitterDelay)
        s.downLoss = dLost + dReceived > 0 ? dLost / (dLost + dReceived) : nil
        s.downPackets = Int(dReceived)
        s.jitterBufferMs = dEmitted > 0 ? dDelay / dEmitted * 1000 : nil
        s.freezes = reset ? 0 : Int(now.freezes - freezes)
        self = now
    }
}

public enum TransferDirection: Sendable { case up, down }

/// 聊天图片的传输节奏：会议中由媒体层提供，媒体拥堵时放慢、给语音和视频让路。ServerSession 没有设置时不限速
@MainActor
public protocol TransferPacer: AnyObject {
    /// 这一方向现在合适的分块大小（字节）
    func chunkBytes(_ d: TransferDirection) -> Int
    /// 传输 bytes 字节之前调用：按当前允许的速度等待
    func wait(_ d: TransferDirection, bytes: Int) async throws
}

/// 按 TrafficPolicy 给出的速度控制图片传输（令牌桶）。块的大小按当前速度取约半秒的量
@MainActor
public final class TrafficPacer: TransferPacer {
    private struct LaneState {
        var bps = Traffic.initialBps
        var tokens = 0.0
        var at = -Double.infinity
        var used = false
    }

    private var lanes: [TransferDirection: LaneState] = [.up: LaneState(), .down: LaneState()]
    private let now: () -> Double

    /// now 返回毫秒
    public init(now: @escaping () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }) {
        self.now = now
    }

    /// 采样后更新速度
    public func set(up: Int, down: Int) {
        lanes[.up]!.bps = up
        lanes[.down]!.bps = down
    }

    /// 上次调用以来有没有传输（交给 TrafficPolicy 判断是否加速），并清除标记
    public func takeActivity() -> (up: Bool, down: Bool) {
        defer {
            lanes[.up]!.used = false
            lanes[.down]!.used = false
        }
        return (lanes[.up]!.used, lanes[.down]!.used)
    }

    public func chunkBytes(_ d: TransferDirection) -> Int {
        min(1 << 20, max(16 << 10, Int((Double(lanes[d]!.bps) / 2).rounded())))
    }

    public func wait(_ d: TransferDirection, bytes: Int) async throws {
        lanes[d]!.used = true
        while true {
            try Task.checkCancellation()
            var l = lanes[d]!
            let t = now()
            let half = Double(l.bps) / 2
            // 最多攒半秒的量：空闲之后不会一下子冲出去一大块
            l.tokens = min(half, l.tokens + (t - l.at) / 1000 * Double(l.bps))
            l.at = t
            // 一块比半秒的量还大时，攒满半秒就放行（否则永远等不到）
            let need = min(Double(bytes), half)
            if l.tokens >= need {
                l.tokens -= Double(bytes)
                lanes[d] = l
                return
            }
            lanes[d] = l
            let ms = (need - l.tokens) / Double(l.bps) * 1000
            try await Task.sleep(for: .milliseconds(min(1000, max(5, ms))))
        }
    }
}
