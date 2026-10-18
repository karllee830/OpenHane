// 媒体传输：UDP 不稳定时改走 TCP—— 与 Web 版 clients/web/packages/media/src/transport.ts 一致。
// 运营商对 UDP 限速时，一有流量就大量丢包、延迟暴涨，WebRTC 只会不停降码率和分辨率；同一条线路走 TCP 往往完全正常。
// 判断由客户端做（发送和接收两个方向的丢包都看得到），切换用 LiveKit 的 ICE 重启（偏好 TCP），轨道保留。

public enum TcpFallbackMode: Sendable { case auto, off, always }

public enum TransportProtocol: String, Sendable { case udp, tcp }

/// 每次采样（约 2 秒一次）的媒体连接统计
public struct TransportSample: Sendable {
    /// 当前选中的候选地址对的协议；还没连上时为 nil
    public var `protocol`: TransportProtocol?
    /// 往返时间（毫秒）
    public var rttMs: Double?
    /// 上行丢包率（0–1，对方接收报告里的 fractionLost 取最大值）
    public var lossUp: Double?
    /// 下行丢包率（0–1，这段时间收到的包里丢了多少）
    public var lossDown: Double?
    /// 这段时间收到的包数（太少时不看下行丢包率）
    public var packetsDown: Int

    public init(protocol: TransportProtocol?, rttMs: Double?, lossUp: Double?, lossDown: Double?, packetsDown: Int) {
        self.protocol = `protocol`
        self.rttMs = rttMs
        self.lossUp = lossUp
        self.lossDown = lossDown
        self.packetsDown = packetsDown
    }
}

public enum TransportThresholds {
    /// 连上后先观察这么久再判断（带宽估计刚开始会波动）
    public static let warmupMs = 6000.0
    /// 丢包率达到这个值算一次「差」
    public static let loss = 0.05
    /// 下行丢包率要在收到这么多包时才可信
    public static let minPackets = 50
    /// 往返时间同时超过这个值和最低值的 rttFactor 倍，算一次「差」
    public static let rttMs = 300.0
    public static let rttFactor = 3.0
    /// 最近 window 次里有 bad 次差就切换（每 2 秒一次，约 10 秒）
    public static let window = 5
    public static let bad = 4
}

/// 判断什么时候该切到 TCP。update 返回 true 时调用方发起切换（只会返回一次）
public final class TransportMonitor {
    public enum Reason: String, Sendable { case loss, rtt, always }

    private let mode: TcpFallbackMode
    private let startedAt: Double
    private var history: [Bool] = []
    private var minRtt = Double.infinity
    private var switched = false
    public private(set) var reason: Reason?

    public init(mode: TcpFallbackMode, startedAt: Double) {
        self.mode = mode
        self.startedAt = startedAt
    }

    public func update(now: Double, _ s: TransportSample) -> Bool {
        guard !switched, mode != .off, s.protocol == .udp else { return false }
        if mode == .always { return fire(.always) }
        if let rtt = s.rttMs, rtt > 0 { minRtt = min(minRtt, rtt) }
        guard now - startedAt >= TransportThresholds.warmupMs else { return false }
        let lossy = (s.lossUp ?? 0) >= TransportThresholds.loss
            || (s.packetsDown >= TransportThresholds.minPackets && (s.lossDown ?? 0) >= TransportThresholds.loss)
        let slow = s.rttMs.map { $0 >= TransportThresholds.rttMs && $0 >= minRtt * TransportThresholds.rttFactor } ?? false
        history.append(lossy || slow)
        if history.count > TransportThresholds.window { history.removeFirst() }
        if history.filter(\.self).count >= TransportThresholds.bad { return fire(lossy ? .loss : .rtt) }
        return false
    }

    private func fire(_ r: Reason) -> Bool {
        switched = true
        reason = r
        return true
    }
}
