import AVFoundation
import Foundation
import LiveKit
import HaneCore
import VideoToolbox

/// 共享状态（界面和诊断用）
public struct ShareStatus: Equatable, Sendable {
    public var intent: ShareIntentName
    /// 自定义档的参数（用户设置的值，实际值见 params）
    public var custom: CustomShare?
    public var withAudio: Bool
    public var codec: ShareCodec
    public var backupCodec: ShareCodec?
    /// 采集源的像素尺寸
    public var source: SourceSize
    /// 引擎当前的参数（模式、分辨率、帧率、码率上限）
    public var params: ShareParams
    /// 最近一次的内容变化信号
    public var changedAreaRatio = 0.0
    public var changeFps = 0.0
    public var qualityLimitation = ShareLimitation.none
    /// 实际发送的分辨率、帧率和码率（来自发送统计）
    public var sentWidth = 0, sentHeight = 0, sentFps = 0.0, sentKbps = 0

    public static func == (a: ShareStatus, b: ShareStatus) -> Bool {
        a.intent == b.intent && a.custom == b.custom && a.withAudio == b.withAudio && a.codec == b.codec && a.params == b.params
            && a.source.width == b.source.width && a.source.height == b.source.height
            && a.sentWidth == b.sentWidth && a.sentHeight == b.sentHeight && a.sentFps == b.sentFps && a.sentKbps == b.sentKbps
            && a.changedAreaRatio == b.changedAreaRatio && a.changeFps == b.changeFps && a.qualityLimitation == b.qualityLimitation
    }
}

extension ShareIntentName {
    var proto: Openhane_V1_ShareIntent {
        switch self {
        case .smart: .smart
        case .clarity: .clarity
        case .smoothness: .smoothness
        case .custom: .custom
        }
    }

    var engine: EngineIntent {
        switch self {
        case .smart: .smart
        case .clarity: .text
        case .smoothness: .motion
        case .custom: .custom
        }
    }
}

/// 屏幕共享发送端—— 与 Web 版 ShareController 对应：
/// 许可 → 系统选择器选择共享内容 → 选编码器并发布 → 每 500 ms 用采集信号和发送统计驱动自适应引擎 → 停止时收回许可。
///
/// 与 Web 版的区别：
/// - macOS 的分辨率在采集端（SCK 的 GPU 缩放）调整，编码器始终以 1:1 编码，不需要 scaleResolutionDownBy；
/// - macOS 的变化检测直接用 SCK 的脏区；iOS 的广播采集没有变化信号，智能模式保持清晰；
/// - 共享声音混入麦克风轨道（苹果的 WebRTC 没有可推入 PCM 的独立音频源），由 MediaSession 负责音量和码率。
@MainActor
final class ShareController {
    private let session: ServerSession
    private let room: LiveKit.Room
    private let capture: ShareCapture
    private let onStatus: @MainActor (ShareStatus?) -> Void
    private let clock = ContinuousClock()
    private let t0 = ContinuousClock.now

    private var grant: Openhane_V1_ScreenShareGrant?
    private var track: LocalVideoTrack?
    private var publication: LocalTrackPublication?
    private var engine: ScreenShareEngine?
    private var timer: Task<Void, Never>?
    private var applied: ShareParams?
    private(set) var status: ShareStatus?
    private var lastBytes: UInt64 = 0
    private var lastStatsAt = 0.0
    private var stopping = false
    /// 正在换编码器（取消发布 → 重新发布）：这期间不调整发送参数
    private var republishing = false
    /// 语音或摄像头吃紧时让路：按更低的上行带宽调整（见 HaneCore/TrafficPolicy.swift）
    private var yieldUplink = false

    init(session: ServerSession, room: LiveKit.Room, capture: ShareCapture, onStatus: @escaping @MainActor (ShareStatus?) -> Void) {
        self.session = session
        self.room = room
        self.capture = capture
        self.onStatus = onStatus
    }

    private func nowMs() -> Double {
        let d = clock.now - t0
        return Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
    }

    /// 苹果平台能编码的集合：H.264 和 H.265 都走 VideoToolbox 硬件编码，CPU 占用很低。
    /// 苹果芯片没有 AV1 硬件编码器（LiveKitWebRTC 也没有接 VideoToolbox 的 AV1），软件 AV1 / VP9 / VP8 不用于发送。
    static let encodeCaps: EncodeCaps = {
        var codecs: [(codec: ShareCodec, hardware: Bool)] = [(.h264, true)]
        if hasHardwareHEVCEncoder() { codecs.insert((.h265, true), at: 0) }
        return EncodeCaps(codecs: codecs)
    }()

    /// 本机有没有 HEVC 硬件编码器（Apple 芯片、A10 及以后的 iPhone / iPad、2017 年以后的大部分 Intel Mac 都有）
    private static func hasHardwareHEVCEncoder() -> Bool {
        #if os(iOS)
        return true // 支持的 iOS 版本只能装在 A12 及以后的设备上，都有 HEVC 硬件编码器
        #else
        let spec = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary
        var id: CFString?
        var props: CFDictionary?
        return VTCopySupportedPropertyDictionaryForEncoder(width: 1920, height: 1080, codecType: kCMVideoCodecType_HEVC,
                                                           encoderSpecification: spec, encoderIDOut: &id,
                                                           supportedPropertiesOut: &props) == noErr
        #endif
    }

    /// 开始共享。用户在系统选择器中取消时抛出 ShareCancelled；服务器拒绝时抛出 HaneError。
    func start(intent: ShareIntentName, withAudio: Bool, custom: CustomShare? = nil) async throws {
        let custom = intent == .custom ? custom ?? .default : nil
        let grant = try await session.requestScreenShare(intent: intent.proto, withAudio: withAudio)
        self.grant = grant
        let limits = grant.limits
        let track: LocalVideoTrack
        let size: SourceSize
        do {
            (track, size) = try await capture.start(withAudio: grant.withAudio, onStop: { [weak self] in
                Task { @MainActor in await self?.stop() }
            })
        } catch {
            await release()
            throw error
        }

        // 按原始分辨率采集，只在超过上限时等比缩小（不放大）
        let maxW = Int(limits.maxWidth == 0 ? 3840 : limits.maxWidth)
        let maxH = Int(limits.maxHeight == 0 ? 2160 : limits.maxHeight)
        var src = size
        if size.width > maxW || size.height > maxH {
            let k = min(Double(maxW) / Double(size.width), Double(maxH) / Double(size.height))
            src = SourceSize(width: Int((Double(size.width) * k / 2).rounded()) * 2, height: Int((Double(size.height) * k / 2).rounded()) * 2)
        }
        let choice = Self.chooseCodec(grant: grant, intent: intent, custom: custom)
        let engine = ScreenShareEngine(intent: intent.engine,
                                       caps: ShareCaps(maxHeight: limits.maxHeight == 0 ? src.height : Int(limits.maxHeight),
                                                       maxFps: limits.maxFps == 0 ? 60 : Int(limits.maxFps),
                                                       maxKbps: limits.maxBitrateBps == 0 ? 8000 : Int(limits.maxBitrateBps) / 1000),
                                       source: src, codec: choice.codec, custom: custom)
        self.engine = engine
        let p0 = engine.update(ShareSignals(t: nowMs(), changedAreaRatio: 0, changeFps: 0, uplinkKbps: 50000,
                                            thermal: Self.thermal()))
        await capture.apply(width: p0.width, height: p0.height, fps: p0.fps)

        // 发布前需要至少一帧（SDK 用采集尺寸计算编码参数）：等第一帧到达编码器
        for _ in 0 ..< 100 where track.capturer.dimensions == nil {
            try? await Task.sleep(for: .milliseconds(50))
        }
        // 获得共享许可后，服务端异步把发布权限同步到 SFU：等权限生效再发布，否则画面已经就绪时会报「权限不足」
        for _ in 0 ..< 50 where !room.localParticipant.permissions.canPublishSources.contains(Track.Source.screenShareVideo.rawValue) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        do {
            publication = try await room.localParticipant.publish(videoTrack: track, options: Self.publishOptions(choice, p0))
        } catch {
            await capture.stop()
            self.engine = nil
            await release()
            throw error
        }
        self.track = track
        applied = p0
        status = ShareStatus(intent: intent, custom: custom, withAudio: grant.withAudio, codec: choice.codec, backupCodec: choice.backup,
                             source: src, params: p0)
        onStatus(status)
        timer = Task { [weak self] in
            // 固定节拍（按截止时间，不累积处理耗时），与 Web 版的 setInterval 一致
            let clock = ContinuousClock()
            var next = clock.now
            while !Task.isCancelled {
                next += .milliseconds(500)
                try? await Task.sleep(until: next, clock: clock)
                await self?.tick()
            }
        }
    }

    /// 共享中切换意图（切到自定义时给出参数，已经是自定义时也可以只改参数）：引擎立即切换，并通知服务端（观众端显示）。编码器不变
    /// 共享中切换意图（切到自定义时给出参数）。自定义里指定的编码器与当前的不同时（或从自定义切回其他模式）换编码器：
    /// 重新发布视频轨道，对方的画面会中断一下
    func setIntent(_ intent: ShareIntentName, custom: CustomShare? = nil) async {
        guard let engine, var s = status else { return }
        let custom = custom ?? s.custom ?? (intent == .custom ? .default : nil)
        let changed = intent != s.intent
        engine.setIntent(intent.engine, now: nowMs(), custom: custom)
        s.intent = intent
        s.custom = custom
        status = s
        onStatus(s)
        if changed { _ = try? await session.requestScreenShare(intent: intent.proto, withAudio: s.withAudio) }
        if let grant {
            let next = Self.chooseCodec(grant: grant, intent: intent, custom: custom)
            if next.codec != s.codec { await republish(next) }
        }
        await tick()
    }

    /// 按共享开始时的许可（房间可解码集合、策略、是否加密）选编码器；自定义时优先用用户指定的。
    /// 苹果平台总有硬件 H.264，不会选不出编码器
    static func chooseCodec(grant: Openhane_V1_ScreenShareGrant, intent: ShareIntentName, custom: CustomShare?) -> CodecChoice {
        chooseShareCodec(caps: encodeCaps,
                         roomDecodable: grant.roomDecodable.isEmpty ? ["video/h264", "video/vp8"] : grant.roomDecodable,
                         policy: grant.codecMode == .compat ? .compat : .auto, // 旧服务器的 QUALITY 按自动处理
                         e2ee: grant.e2Ee, prefer: intent == .custom ? custom?.codec : nil) ?? CodecChoice(codec: .h264, backup: nil)
    }

    static func encoding(_ p: ShareParams) -> VideoEncoding {
        VideoEncoding(maxBitrate: p.maxKbps * 1000, maxFps: p.fps, bitratePriority: .low, networkPriority: .low)
    }

    /// 语音或摄像头吃紧时让路（每秒由媒体会话根据流量优先级设置）
    func setYield(_ on: Bool) {
        yieldUplink = on
    }

    static func publishOptions(_ choice: CodecChoice, _ p: ShareParams) -> VideoPublishOptions {
        VideoPublishOptions(
            // 屏幕共享的优先级低于语音和摄像头
            screenShareEncoding: Self.encoding(p),
            simulcast: false,
            preferredCodec: videoCodec(choice.codec),
            preferredBackupCodec: choice.backup.map(videoCodec),
            degradationPreference: degradation(p)
        )
    }

    /// 换编码器：取消发布 → 用新编码器重新发布同一条轨道（SDK 取消发布时会停止轨道，发布时重新启动并等到下一帧；采集端一直在推帧）
    private func republish(_ choice: CodecChoice) async {
        guard let track, let publication, let engine, var s = status, !republishing else { return }
        republishing = true
        defer { republishing = false }
        do {
            try await room.localParticipant.unpublish(publication: publication)
            self.publication = nil
            engine.codec = choice.codec
            self.publication = try await room.localParticipant.publish(videoTrack: track, options: Self.publishOptions(choice, s.params))
            applied = nil
            lastStatsAt = 0
            s.codec = choice.codec
            s.backupCodec = choice.backup
            status = s
            onStatus(s)
        } catch {
            // 重新发布失败：结束共享（与采集中断的处理一致）
            await stop()
        }
    }

    func stop() async {
        guard !stopping else { return }
        stopping = true
        defer { stopping = false }
        timer?.cancel()
        timer = nil
        await capture.stop()
        if let publication { try? await room.localParticipant.unpublish(publication: publication) }
        if let track { try? await track.stop() }
        track = nil
        publication = nil
        engine = nil
        status = nil
        onStatus(nil)
        await release()
    }

    private func release() async {
        guard let g = grant else { return }
        grant = nil
        try? await session.releaseScreenShare(grantID: g.grantID)
    }

    private func tick() async {
        guard let engine, let track, var s = status, !republishing else { return }
        var limitation = ShareLimitation.none
        var uplinkKbps = 50000.0
        var rttMs: Double?
        if let stats = track.statistics {
            if let out = stats.outboundRtpStream.first {
                if let r = out.qualityLimitationReason { limitation = ShareLimitation(rawValue: r.rawValue) ?? .none }
                // 统计的刷新周期比 tick 长：只在拿到新样本时更新码率（时间戳单位为微秒）
                let bytes = out.bytesSent ?? 0
                if out.timestamp > lastStatsAt {
                    s.sentKbps = lastStatsAt > 0 && bytes >= lastBytes ? Int(Double(bytes - lastBytes) * 8 * 1000 / (out.timestamp - lastStatsAt)) : 0
                    lastBytes = bytes
                    lastStatsAt = out.timestamp
                }
                s.sentWidth = Int(out.frameWidth ?? 0)
                s.sentHeight = Int(out.frameHeight ?? 0)
                s.sentFps = out.framesPerSecond ?? 0
            }
            // 带宽估计：优先用可用上行带宽；拿不到时用编码器的目标码率（WebRTC 按带宽估计设定，受带宽限制时就是估计值）
            if let pair = stats.iceCandidatePair.first(where: { $0.nominated == true }), let bps = pair.availableOutgoingBitrate {
                uplinkKbps = bps / 1000
            } else if let target = stats.outboundRtpStream.first?.targetBitrate {
                uplinkKbps = target / 1000
            }
            // 往返时间用接收报告（约每秒一次）里的值：候选地址对的往返时间要 5 秒左右才更新一次
            if let rtt = stats.remoteInboundRtpStream.first?.roundTripTime { rttMs = rtt * 1000 }
        }
        // 让路：告诉引擎的可用带宽比现在实际发出的低三成，引擎随之降低码率，直到语音和摄像头恢复正常
        if yieldUplink { uplinkKbps = min(uplinkKbps, (s.sentKbps > 0 ? Double(s.sentKbps) : uplinkKbps) * 0.7) }
        let sig = capture.signals() ?? (0, 0) // 没有变化信号时按静止处理
        let p = engine.update(ShareSignals(t: nowMs(), changedAreaRatio: sig.area, changeFps: sig.fps, uplinkKbps: uplinkKbps,
                                           qualityLimitation: limitation, thermal: Self.thermal(),
                                           rttMs: rttMs, sentKbps: s.sentKbps > 0 ? Double(s.sentKbps) : nil))
        await apply(p)
        s.params = p
        s.changedAreaRatio = sig.area
        s.changeFps = sig.fps
        s.qualityLimitation = limitation
        if s != status {
            status = s
            onStatus(s)
        }
    }

    /// 把引擎参数应用到发送端：采集分辨率、采样帧率、码率、编码帧率、降级偏好（不重新协商、不中断画面）
    private func apply(_ p: ShareParams) async {
        guard p != applied, let publication else { return }
        if applied?.width != p.width || applied?.height != p.height || applied?.fps != p.fps {
            await capture.apply(width: p.width, height: p.height, fps: p.fps)
        }
        await publication.setVideoEncoding(Self.encoding(p),
                                           degradationPreference: Self.degradation(p))
        applied = p
    }

    static func degradation(_ p: ShareParams) -> DegradationPreference {
        p.degradationPreference == "maintain-framerate" ? .maintainFramerate : .maintainResolution
    }

    static func videoCodec(_ c: ShareCodec) -> VideoCodec {
        switch c {
        case .av1: .av1
        case .vp9: .vp9
        case .h265: .h265
        case .h264: .h264
        case .vp8: .vp8
        }
    }

    static func thermal() -> ShareThermal {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: .nominal
        case .fair: .fair
        case .serious: .serious
        case .critical: .critical
        @unknown default: .nominal
        }
    }
}
