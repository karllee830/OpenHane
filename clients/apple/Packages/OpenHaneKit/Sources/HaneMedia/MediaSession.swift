import AVFoundation
#if os(iOS)
import Combine
#endif
import Foundation
import LiveKit
import Observation
import HaneCore

/// 媒体会话：封装 LiveKit Room。跟随 ServerSession 下发的媒体目标连接 SFU，
/// 发布经过系统 Voice Processing 和发言门控的麦克风，播放远端声音，处理静音、关闭声音、每人音量和说话指示。
@MainActor
@Observable
public final class MediaSession {
    public enum Status: Equatable, Sendable {
        case idle, connecting, connected, reconnecting
        case failed(String)
    }

    /// 降噪的实际状态（界面显示）
    public enum NoiseState: Equatable, Sendable {
        /// 选了「标准」：只用系统语音处理
        case system
        /// 选了「标准」、回声消除用软件：只用 WebRTC 自带的降噪
        case software
        /// 这次构建没有 AI 降噪，或模型加载失败
        case unavailable
        /// 不在会议中：进入会议时加载
        case standby
        case loading
        case active
        /// 系统「语音突显」已开启：它已经在做 AI 降噪，应用内的暂停（不叠加两道）
        case pausedForVoiceIsolation
        /// 共享声音时暂停（共享的声音和麦克风在同一条轨道里，会被当成噪声去掉）
        case pausedForShare
        /// 当前音频设备不是 48 kHz（例如蓝牙耳机的通话模式），AI 降噪暂停
        case unsupportedFormat
    }

    /// 这次构建是否带有 AI 降噪（DeepFilterNet3）
    public nonisolated static var aiNoiseAvailable: Bool { DeepFilter.available }

    public private(set) var status: Status = .idle
    public private(set) var micMuted = false
    public private(set) var deafened = false
    /// 正在说话的媒体 identity（远端来自 SFU 的音量检测，自己来自本地门控）
    public private(set) var speaking: Set<String> = []
    public private(set) var localLevelDb: Double = -100
    public private(set) var localThresholdDb: Double = -55
    public private(set) var transmitting = false
    public private(set) var micError: String?
    /// 系统里没有音频输入设备（例如没接麦克风的 Mac mini）：不发布麦克风，只能收听。接上设备后自动发布
    public private(set) var micUnavailable = false
    /// 每人音量（按媒体 identity），0–2，默认 1
    public private(set) var volumes: [String: Double] = [:]
    public var mode: VoiceMode = .voice {
        didSet { processor.configure(mode: mode, manualThresholdDb: manualThresholdDb) }
    }
    public var manualThresholdDb: Double? {
        didSet { processor.configure(mode: mode, manualThresholdDb: manualThresholdDb) }
    }
    /// 麦克风音量（0–2，1 为原始音量）：在发言处理之前调整，电平和语音激活都按调整后的音量算
    public var inputVolume: Double = 1 {
        didSet { processor.setInputGain(Float(inputVolume)) }
    }
    /// 所有人声音的总音量（0–2），再乘上每个人单独的音量
    public var outputVolume: Double = 1 {
        didSet { applyVolumes() }
    }
    /// 降噪档位：AI 降噪在回声消除之后再处理一遍
    public var noiseSuppression: NoiseSuppression = .ai {
        didSet {
            applyNoiseSuppression()
            if oldValue != noiseSuppression, echoProcessing == .software { applyAudioProcessing() }
        }
    }
    /// 回声消除用软件还是系统语音处理（见 EchoProcessing）；会议中切换立即生效
    public var echoProcessing: EchoProcessing = .platformDefault {
        didSet { if oldValue != echoProcessing { applyAudioProcessing() } }
    }
    public private(set) var noiseState: NoiseState = .standby
    /// 诊断用：降噪状态、AI 降噪最近一帧的情况、采集后处理的采样率
    public var noiseDiagnostics: String { "\(noiseState) frame=\(aiFrame.map { "\($0)" } ?? "-") rate=\(captureRate)" }

    // 视频
    public private(set) var cameraOn = false
    public private(set) var cameraError: String?
    /// 上次打开摄像头时没有可用的设备（例如笔记本合上了屏幕）；再次尝试或关闭摄像头时清除
    public private(set) var cameraUnavailable: CameraUnavailable?
    /// 自己的屏幕共享状态；未共享时为 nil
    public private(set) var share: ShareStatus?
    /// 是否在共享：只在开始 / 结束时变化。share 里的统计每 500 ms 更新一次，界面上只有共享控制条读它，
    /// 其他地方（主界面、工具栏）读这个，避免整个会议界面跟着每秒重算两次
    public private(set) var isSharing = false
    /// iOS：广播开始后申请共享失败（例如服务器不允许）。界面显示后可置为 nil
    public var shareFailure: HaneError?
    /// 最近一次切换房间的耗时
    public private(set) var lastSwitch: RoomSwitch?
    /// 当前房间的端到端加密（未加密时为 nil）
    public private(set) var e2ee: E2EEKeys?
    /// 媒体连接走的协议（还没连上时为 nil）
    public private(set) var transportProtocol: TransportProtocol?
    /// UDP 不稳定被切到 TCP 的原因（界面提示一次；「始终 TCP」时为 .always）
    public private(set) var tcpSwitched: TransportMonitor.Reason?

    public struct RoomSwitch: Equatable, Sendable {
        public var totalMs: Int
        /// 新房间的麦克风发布完成前，旧房间的麦克风一直在发送；这是新麦克风发布所花的时间
        public var publishMs: Int
        public var shareStopped: Bool
    }
    /// 房间里所有视频轨道（摄像头和屏幕共享，含自己的），按 identity 排序
    public private(set) var videoTracks: [VideoTrackRef] = []
    /// 弱网测试：只走指定的 TURN 中继（server/cmd/hanenetem）。下次建立媒体连接时生效
    @ObservationIgnored public var relayOnly: (url: String, username: String, credential: String)?
    /// 测试与诊断：让 SDK 每秒更新远端轨道的统计（收包数等）
    @ObservationIgnored public var reportRemoteStatistics = false
    /// 屏幕采集源（测试注入合成画面；默认 macOS 用 ScreenCaptureKit）
    @ObservationIgnored public var shareSourceFactory: @MainActor () -> ShareFrameSource = { MediaSession.defaultShareSource() }
    @ObservationIgnored private var shareController: ShareController?
    /// 屏幕共享单独的媒体连接：麦克风和摄像头在主连接上（始终 UDP），共享画面在这里（UDP 不稳定时自动改走 TCP）。
    /// 苹果端的共享声音混在麦克风轨道里，仍在主连接上
    @ObservationIgnored private var shareRoom: LiveKit.Room?
    @ObservationIgnored private var shareRoomFor: String?
    @ObservationIgnored private var shareJoining: Task<LiveKit.Room, Error>?
    @ObservationIgnored private var shareIdleTask: Task<Void, Never>?
    @ObservationIgnored private var shareDelegate: RoomDelegateProxy?
    /// 共享连接的身份 = 主连接身份 + 这个后缀（服务端约定）
    public static let shareSuffix = "#s"
    /// 这次会议里共享连接已经从 UDP 切到过 TCP：之后的共享连接直接请求 TCP，不再来回切
    @ObservationIgnored private var preferTcp = false
    /// 这次会议里共享连接走 TCP 连不上（ICE-TCP 端口被拦等）：之后的共享连接直接请求 UDP
    @ObservationIgnored private var shareUdp = false
    /// 共享连接只走 TCP 时的连接超时（秒）：端口被防火墙拦住时连通性检查会一直挂着，超时后改用 UDP
    @ObservationIgnored var shareTCPTimeout: TimeInterval = 8
    @ObservationIgnored private var transportTask: Task<Void, Never>?
    /// 已经打开统计的轨道（SDK 每次设置都会重置统计计时器，只设一次）
    @ObservationIgnored private var statsEnabled: Set<ObjectIdentifier> = []

    private let session: ServerSession
    @ObservationIgnored private var room: LiveKit.Room?
    @ObservationIgnored private var delegate: RoomDelegateProxy?
    @ObservationIgnored private var processor: VoiceProcessor!
    /// AI 降噪：进入会议时在后台加载（约 0.15 秒），离开时释放（约 30 MB 内存）
    @ObservationIgnored private var deepFilter: DeepFilter?
    @ObservationIgnored private var deepFilterTask: Task<Void, Never>?
    @ObservationIgnored private var aiFrame: VoiceProcessor.AIFrame?
    @ObservationIgnored private var captureRate = 0
    @ObservationIgnored private var statusCount = 0
    @ObservationIgnored private var grantVersion = -1
    @ObservationIgnored private var connecting = false
    @ObservationIgnored private var retry = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var followTask: Task<Void, Never>?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var localIdentity = ""
    /// 当前媒体连接所在的控制面房间
    @ObservationIgnored private var roomID: String?
    /// 当前媒体连接是否开启了端到端加密（加密配置在建立连接时确定，变化时需要重连）
    @ObservationIgnored private var roomE2EE = false

    public init(session: ServerSession) {
        self.session = session
        processor = VoiceProcessor(mode: mode) { [weak self] status in
            Task { @MainActor in self?.onVoiceStatus(status) }
        }
    }

    /// 开始跟随控制连接的媒体目标：有令牌就连接，令牌更新后在需要时重连。
    public func start() {
        guard !started else { return }
        started = true
        Self.ignoreSIGPIPE()
        AudioManager.shared.capturePostProcessingDelegate = processor
        applyAudioProcessing()
        applyNoiseSuppression()
        #if os(iOS)
        // 广播开始 / 结束由我们自己处理（申请许可、选编码器、自适应），不让 SDK 自动发布
        BroadcastManager.shared.shouldPublishTrack = false
        broadcastWatch = BroadcastManager.shared.isBroadcastingPublisher.removeDuplicates().sink { [weak self] on in
            Task { @MainActor in await self?.onBroadcast(on) }
        }
        #endif
        followTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.follow()
                await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                    withObservationTracking {
                        _ = self.session.state.media
                        _ = self.session.status
                    } onChange: {
                        cont.resume()
                    }
                }
            }
        }
    }

    /// 离开：断开媒体，释放麦克风。
    public func stop() async {
        started = false
        await stopScreenShare()
        cameraOn = false
        followTask?.cancel()
        retryTask?.cancel()
        retryTask = nil
        grantVersion = -1
        retry = 0
        let r = room
        room = nil
        roomID = nil
        delegate = nil
        attachKeys(nil)
        await r?.disconnect()
        transportTask?.cancel()
        transportTask = nil
        await closeShareRoom()
        preferTcp = false
        shareUdp = false
        transportProtocol = nil
        tcpSwitched = nil
        AudioManager.shared.capturePostProcessingDelegate = nil
        processor.setDeepFilter(nil)
        deepFilterTask?.cancel()
        deepFilterTask = nil
        deepFilter = nil
        aiFrame = nil
        updateNoiseState()
        status = .idle
        speaking = []
        transmitting = false
        videoTracks = []
    }

    private func follow() {
        followShare()
        guard session.status == .connected, let target = session.state.media, !target.token.isEmpty else { return }
        if let p = session.state.media?.policy { applyPolicy(p) }
        guard !connecting else { return }
        let live = room.map { $0.connectionState != .disconnected } ?? false
        // 切换了房间：立即连接新房间（先连后断）
        // 房间开启 / 关闭了端到端加密：重新连接
        let e2eeChanged = live && target.policy.e2Ee.roomEnabled != roomE2EE
        let changedRoom = live && roomID != nil && (target.roomID != roomID || e2eeChanged)
        // 只在拿到新令牌（版本变化）且当前没有在线的房间时连接；退避等待期间不抢跑
        if changedRoom || (!live && retryTask == nil && target.version != grantVersion) {
            Task { await connect(target) }
        }
    }

    private func connect(_ target: MediaTarget) async {
        guard !connecting else { return }
        connecting = true
        defer { connecting = false }
        grantVersion = target.version
        let started = ContinuousClock.now
        let old = room
        // 共享连接属于原来的房间：断开（换房间时共享许可也已收回）
        if shareRoomFor != nil, shareRoomFor != target.roomID { await closeShareRoom() }
        // 切换房间：先连新房间、把麦克风转过去、再断开旧房间（「先连后断」）
        let switching = old?.connectionState == .connected && roomID != nil && roomID != target.roomID
        if let old, !switching {
            room = nil
            await old.disconnect()
        }
        if !switching { status = retry > 0 ? .reconnecting : .connecting }
        // 端到端加密的房间：每个人一把发送者密钥，经控制面中转的 HPKE 密钥包分发
        let encrypted = target.policy.e2Ee.roomEnabled
        let keys = encrypted ? E2EEKeys(session: session) : nil
        let proxy = RoomDelegateProxy(owner: self)
        let r = LiveKit.Room(delegate: proxy, roomOptions: LiveKit.RoomOptions(encryptionOptions: keys.map { EncryptionOptions(keyProvider: $0.provider) },
                                                                                 reportRemoteTrackStatistics: reportRemoteStatistics))
        room = r
        delegate = proxy
        let port = session.address?.port ?? ServerAddress.defaultPort
        do {
            try await r.connect(url: target.url.absoluteString, token: target.token,
                                connectOptions: ConnectOptions(iceServers: relayOnly.map { [IceServer(urls: [$0.url], username: $0.username, credential: $0.credential)] } ?? [],
                                                               iceTransportPolicy: relayOnly == nil ? .all : .relay,
                                                               serverTrustEvaluator: session.trust.evaluator(port: port)))
        } catch {
            if switching { await old?.disconnect() }
            guard room === r else { return }
            room = nil
            status = .reconnecting
            scheduleReconnect()
            return
        }
        guard room === r else { return }
        retry = 0
        status = .connected
        roomID = target.roomID
        localIdentity = r.localParticipant.identity?.stringValue ?? ""
        roomE2EE = encrypted
        // 加密房间每次连接都换一套密钥：共享连接用的是旧密钥，重新连接（不加密时共享连接不受主连接重连影响）
        if shareRoom != nil, keys != nil || e2ee != nil { await closeShareRoom() }
        attachKeys(keys)
        // 先设置并分发自己的密钥，再发布轨道
        await keys?.start(room: r, roomID: target.roomID, localIdentity: localIdentity)
        if switching, let old {
            await handOver(from: old, to: r, policy: target.policy, started: started)
        } else {
            await publishMicrophone(r, policy: target.policy)
        }
        // 房间里已经有人在共享：连上共享连接
        followShare()
        // 连接期间又切换了房间：接着切到最新的房间
        if let latest = session.state.media, latest.roomID != roomID, !latest.token.isEmpty {
            Task { await self.connect(latest) }
        }
    }

    /// 把本地媒体从旧房间转到新房间：新房间的麦克风发布完成后才断开旧房间（两边短暂同时发送，声音不断），
    /// 摄像头在新房间重新开启，屏幕共享结束（共享许可绑定在房间上）。
    private func handOver(from old: LiveKit.Room, to r: LiveKit.Room, policy: MediaPolicy, started: ContinuousClock.Instant) async {
        let shareStopped = shareController != nil
        if shareStopped { await shareController?.stop() }
        let cameraWasOn = cameraOn
        let publishStart = ContinuousClock.now
        await publishMicrophone(r, policy: policy)
        let publishMs = Self.ms(ContinuousClock.now - publishStart)
        await old.disconnect()
        if cameraWasOn {
            cameraOn = false
            await setCameraEnabled(true)
        }
        refreshVideoTracks()
        lastSwitch = RoomSwitch(totalMs: Self.ms(ContinuousClock.now - started), publishMs: publishMs, shareStopped: shareStopped)
    }

    fileprivate func onE2EEState(_ r: LiveKit.Room, sid: String, identity: String, remote: Bool, state: E2EEState) {
        guard r === room else { return }
        e2ee?.noteTrackState(sid: sid, identity: identity, remote: remote, state: state)
    }

    private func attachKeys(_ keys: E2EEKeys?) {
        e2ee?.stop()
        e2ee = keys
    }

    private static func ms(_ d: Duration) -> Int {
        Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
    }

    /// 有没有音频输入设备。没有时不能开麦克风：LiveKit 会把不存在的输入接进音频引擎，AVAudioEngine 抛异常直接闪退
    private static var hasAudioInput: Bool { AVCaptureDevice.default(for: .audio) != nil }

    private func publishMicrophone(_ r: LiveKit.Room, policy: MediaPolicy) async {
        watchDevices()
        guard Self.hasAudioInput else {
            micUnavailable = true
            micError = nil
            return
        }
        micUnavailable = false
        // 同一个房间的麦克风发布不并发：两次 setMicrophone 撞在一起时，其中一次会等不到服务器的回应而超时
        let id = ObjectIdentifier(r)
        guard !publishingMic.contains(id) else { return }
        publishingMic.insert(id)
        defer { publishingMic.remove(id) }
        let audio = policy.audio
        do {
            try await r.localParticipant.setMicrophone(
                enabled: true,
                captureOptions: audioCaptureOptions(echoProcessing, noise: noiseSuppression),
                publishOptions: AudioPublishOptions(encoding: AudioEncoding(maxBitrate: Int(audio.maxBitrateBps == 0 ? 32000 : audio.maxBitrateBps)),
                                                    dtx: audio.dtx, red: audio.red)
            )
            if micMuted { try await r.localParticipant.setMicrophone(enabled: false) }
            appliedAudioBitrate = Int(audio.maxBitrateBps == 0 ? 32000 : audio.maxBitrateBps)
            micError = nil
        } catch {
            micError = error.localizedDescription
        }
    }

    /// 应用回声消除的实现：系统语音处理只在选了它时才允许使用（不允许时 LiveKit 一律走软件处理）；
    /// 麦克风已经发布时直接改轨道的处理参数，不用重新发布
    private func applyAudioProcessing() {
        let system = echoProcessing == .system
        try? AudioManager.shared.setPlatformVoiceProcessingAllowed(system)
        if system {
            // 系统语音处理一定会压低其他应用的声音，尽量压得少：最小档、不随说话动态加大
            if #available(iOS 17, macOS 14, *) { AudioManager.shared.duckingLevel = .min }
            AudioManager.shared.isAdvancedDuckingEnabled = false
        } else {
            processor.setVoiceIsolation(false) // 「语音突显」只在系统语音处理下生效
        }
        // 静音时关闭麦克风输入（指示灯熄灭）：系统语音处理下直接关掉它的输入，软件处理时重启音频引擎、不带麦克风
        try? AudioManager.shared.set(microphoneMuteMode: system ? .voiceProcessing : .restart)
        let options = audioProcessingOptions(echoProcessing, noise: noiseSuppression)
        if let track = room?.localParticipant.audioTracks.first?.track as? LocalAudioTrack {
            _ = try? track.setAudioProcessingOptions(options)
        }
        updateNoiseState()
    }

    /// 往已经被对端关闭的 socket 写数据时，macOS / iOS 默认向整个进程发 SIGPIPE、直接结束进程。
    /// WebRTC 的 ICE-TCP 连接在服务器重启或断网时会碰到（否则媒体走 TCP 时会闪退）：忽略这个信号，写操作改为返回 EPIPE
    private static let sigpipeIgnored: Void = { signal(SIGPIPE, SIG_IGN) }()
    static func ignoreSIGPIPE() { _ = sigpipeIgnored }

    /// 共享连接要请求的传输方式：TCP 连不上过就要 UDP，从 UDP 切到过 TCP 就要 TCP，否则按服务器设置
    private var shareTransport: Openhane_V1_ShareTransport {
        shareUdp ? .udp : preferTcp ? .tcp : .unspecified
    }

    /// 只有 UDP 优先、走的是 UDP、服务器开放了 ICE-TCP 时才需要检测 UDP 是否稳定
    private func shareMonitorMode(_ p: MediaPolicy?, tcp: Bool) -> TcpFallbackMode {
        guard let t = p?.transport, !tcp, !shareUdp, t.tcpAvailable, t.shareTransport == .udp else { return .off }
        return .auto
    }

    /// 共享连接的传输状态（主连接的语音和摄像头始终走 UDP）：每 2 秒从共享连接的轨道统计里取一次采样，更新当前协议。
    /// UDP 优先时交给 TransportMonitor 判断，需要切换时通过 LiveKit 的「切换候选协议」让服务端改为只提供 TCP 候选，SDK 重连后恢复，轨道保留。与 Web 版一致
    private func watchTransport(_ r: LiveKit.Room, policy: MediaPolicy?, tcp: Bool) {
        transportTask?.cancel()
        let monitor = TransportMonitor(mode: shareMonitorMode(policy, tcp: tcp), startedAt: 0)
        let clock = ContinuousClock()
        let t0 = clock.now
        transportTask = Task { [weak self] in
            var prev: (lost: Int64, received: UInt64) = (0, 0)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, self.shareRoom === r else { return }
                guard r.connectionState == .connected else { continue }
                let sample = await self.transportSample(r, prev: &prev)
                if sample.protocol != transportProtocol { transportProtocol = sample.protocol }
                guard monitor.update(now: Double(Self.ms(clock.now - t0)), sample) else { continue }
                preferTcp = true
                tcpSwitched = monitor.reason
                // 服务端记下这个人改走 TCP（按身份缓存），SDK 发完后只断开信令连接、要等十来秒才重连：
                // 直接发起完整重连（重新发布所有轨道），约 2 秒恢复
                try? await r.debug_simulate(scenario: .forceTCP)
                try? await r.debug_simulate(scenario: .fullReconnect)
            }
        }
    }

    private func transportSample(_ r: LiveKit.Room, prev: inout (lost: Int64, received: UInt64)) async -> TransportSample {
        var proto: TransportProtocol?
        var rtt: Double?
        var lossUp: Double?
        var lost: Int64 = 0
        var received: UInt64 = 0
        var tracks: [Track] = r.localParticipant.audioTracks.compactMap(\.track) + r.localParticipant.videoTracks.compactMap(\.track)
        for p in r.remoteParticipants.values {
            tracks += p.videoTracks.compactMap(\.track)
        }
        for t in tracks {
            if statsEnabled.insert(ObjectIdentifier(t)).inserted { await t.set(reportStatistics: true) }
            guard let st = t.statistics else { continue }
            if let pair = st.iceCandidatePair.first(where: { $0.nominated == true && $0.state == .succeeded }) {
                if let ms = pair.currentRoundTripTime.map({ $0 * 1000 }) { rtt = max(rtt ?? 0, ms) }
                // 发送和接收各一条连接，可能一条走 TCP、另一条还在 UDP：只要有一条在走 UDP 就按 UDP 判断
                if let p = st.localIceCandidate?.protocol.flatMap(TransportProtocol.init(rawValue:)) { proto = proto == .udp ? .udp : p }
            }
            for ri in st.remoteInboundRtpStream { if let f = ri.fractionLost { lossUp = max(lossUp ?? 0, f) } }
            for inb in st.inboundRtpStream {
                lost += max(0, inb.packetsLost ?? 0)
                received += inb.packetsReceived ?? 0
            }
        }
        let dLost = max(0, lost - prev.lost)
        let dReceived = received >= prev.received ? received - prev.received : 0
        prev = (lost, received)
        let total = Double(dLost) + Double(dReceived)
        return TransportSample(protocol: proto, rttMs: rtt, lossUp: lossUp, lossDown: total > 0 ? Double(dLost) / total : nil, packetsDown: Int(dReceived))
    }

    /// 媒体断开或连接失败（例如服务器重启后旧令牌失效）：退避后向控制面要新令牌，新令牌经 follow() 触发连接。
    private func scheduleReconnect() {
        guard started, retryTask == nil else { return }
        let delays: [Double] = [1, 2, 4, 8, 15]
        let delay = delays[min(retry, delays.count - 1)]
        retry += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.retryTask = nil
            guard self.started, self.session.status == .connected else { return }
            do { try await self.session.refreshMedia() } catch { self.scheduleReconnect() }
        }
    }

    /// 服务器策略变化（管理员改了语音码率）：实时调整，不需要重新发布（SDK 补丁中的 setAudioEncoding）。
    private func applyPolicy(_ policy: MediaPolicy) {
        let bps = Int(policy.audio.maxBitrateBps)
        guard bps > 0, bps != appliedAudioBitrate, let pub = room?.localParticipant.audioTracks.first as? LocalTrackPublication else { return }
        appliedAudioBitrate = bps
        Task { await pub.setAudioEncoding(maxBitrate: bps) }
    }

    /// 正在发布麦克风的房间
    @ObservationIgnored private var publishingMic: Set<ObjectIdentifier> = []

    /// 当前麦克风轨道使用的码率上限（bps）
    public private(set) var appliedAudioBitrate = 0

    // MARK: 用户操作

    public func setMicMuted(_ muted: Bool) async {
        micMuted = muted
        if muted { transmitting = false }
        if sharingAudio {
            // 共享声音混在麦克风轨道里：静音只关掉麦克风这一路，轨道保持发布
            AudioManager.shared.mixer.micVolume = muted ? 0 : 1
            return
        }
        guard let r = room, r.connectionState == .connected else { return }
        if !muted, !Self.hasAudioInput {
            micUnavailable = true
            return
        }
        _ = try? await r.localParticipant.setMicrophone(enabled: !muted)
    }

    public func setCameraEnabled(_ on: Bool) async {
        guard let r = connectedRoom else { return }
        cameraUnavailable = nil
        var device: AVCaptureDevice?
        #if os(macOS)
        // LiveKit 默认直接用列表里的第一个摄像头（内置），不管它是否被挂起：笔记本合上屏幕时内置摄像头打开后一直没有画面，
        // 等到超时才报「Timed out」。这里先挑一个可用的，没有就直接说明原因
        if on {
            let devices = (try? await CameraCapturer.captureDevices()) ?? []
            let candidates = devices.map { CameraCandidate(id: $0.uniqueID, connected: $0.isConnected, suspended: $0.isSuspended) }
            switch chooseCamera(candidates, defaultID: preferredCameraID ?? AVCaptureDevice.default(for: .video)?.uniqueID) {
            case let .success(i):
                device = devices[i]
                watchCameraDisconnect()
            case let .failure(reason):
                cameraUnavailable = reason
                cameraOn = false
                cameraError = nil
                return
            }
        }
        #endif
        do {
            try await r.localParticipant.setCamera(
                enabled: on,
                captureOptions: CameraCaptureOptions(device: device, dimensions: .h720_169, fps: 30),
                publishOptions: VideoPublishOptions(simulcast: true)
            )
            cameraOn = on
            cameraDeviceID = on ? device?.uniqueID : nil
            cameraError = nil
        } catch {
            cameraOn = false
            cameraError = error.localizedDescription
        }
        refreshVideoTracks()
    }

    /// 设置里选的摄像头（AVCaptureDevice.uniqueID）；nil 表示系统默认。不可用时自动换一个能用的
    @ObservationIgnored public var preferredCameraID: String?

    /// 换摄像头：正开着时重新打开，立即换成新设备
    public func setPreferredCamera(_ id: String?) async {
        preferredCameraID = id
        guard cameraOn else { return }
        await setCameraEnabled(false)
        await setCameraEnabled(true)
    }

    /// 正在使用的摄像头（macOS 自己挑选的设备）；被拔掉时据此关闭摄像头
    @ObservationIgnored private var cameraDeviceID: String?
    @ObservationIgnored private var cameraDisconnectObserver: NSObjectProtocol?

    /// 摄像头被拔掉后 LiveKit 的轨道还在发布，只是一直没有新画面：主动关闭并提示
    private func watchCameraDisconnect() {
        guard cameraDisconnectObserver == nil else { return }
        cameraDisconnectObserver = NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: .main) { [weak self] note in
            let id = (note.object as? AVCaptureDevice)?.uniqueID
            Task { @MainActor in
                guard let self, self.cameraOn, let id, id == self.cameraDeviceID else { return }
                await self.setCameraEnabled(false)
                self.cameraUnavailable = .disconnected
            }
        }
    }

    // MARK: 屏幕共享

    /// 开始共享。用户在系统选择器中取消时抛出 ShareCancelled；服务器拒绝（权限、并发上限）时抛出 HaneError。
    /// iOS：只弹出系统的广播选择器并返回；广播真正开始后再申请许可和发布，失败时写入 shareFailure。
    public func startScreenShare(intent: ShareIntentName, withAudio: Bool, custom: CustomShare? = nil) async throws {
        guard shareController == nil else { return }
        #if os(iOS)
        pendingShare = (intent, withAudio, custom)
        BroadcastManager.shared.requestActivation()
        #else
        // 刚进入会议时媒体通道可能还在建立：最多等 10 秒（与 Web 版一致）
        for _ in 0 ..< 100 where connectedRoom == nil && started {
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard connectedRoom != nil else { throw HaneError.connectionLost }
        let r = try await ensureShareRoom()
        let capture = FrameSourceCapture(source: shareSourceFactory(), onAudio: { AudioManager.shared.mixer.capture(appAudio: $0) })
        let c = ShareController(session: session, room: r, capture: capture, onStatus: { [weak self] s in self?.onShareStatus(s) })
        shareController = c
        do {
            try await c.start(intent: intent, withAudio: withAudio, custom: custom)
        } catch {
            shareController = nil
            followShare()
            throw error
        }
        refreshVideoTracks()
        #endif
    }

    public func stopScreenShare() async {
        #if os(iOS)
        if BroadcastManager.shared.isBroadcasting { BroadcastManager.shared.requestStop() }
        #endif
        await shareController?.stop()
    }

    #if os(iOS)
    @ObservationIgnored private var pendingShare: (intent: ShareIntentName, withAudio: Bool, custom: CustomShare?)?
    @ObservationIgnored private var broadcastWatch: AnyCancellable?

    /// 广播开始：申请许可并发布（用户也可能直接从控制中心开始广播，此时用默认设置）；广播结束：停止发布并收回许可
    private func onBroadcast(_ on: Bool) async {
        guard on else {
            await shareController?.stop()
            return
        }
        guard shareController == nil else { return }
        let (intent, withAudio, custom) = pendingShare ?? (.smart, false, nil)
        pendingShare = nil
        guard connectedRoom != nil, let r = try? await ensureShareRoom() else {
            // 不在会议中：结束广播
            BroadcastManager.shared.requestStop()
            shareFailure = .connectionLost
            return
        }
        let c = ShareController(session: session, room: r, capture: BroadcastCapture(), onStatus: { [weak self] s in self?.onShareStatus(s) })
        shareController = c
        do {
            try await c.start(intent: intent, withAudio: withAudio, custom: custom)
            refreshVideoTracks()
        } catch {
            shareController = nil
            BroadcastManager.shared.requestStop()
            shareFailure = (error as? HaneError) ?? .protocolViolation(error.localizedDescription)
        }
    }
    #endif

    // MARK: 共享连接

    /// 需要共享连接：自己在共享，或者房间里有别人在共享
    private var shareNeeded: Bool {
        if shareController != nil { return true }
        guard let rid = roomID ?? session.state.media?.roomID else { return false }
        let me = session.state.me?.sessionID
        return session.state.rooms[rid]?.shares.contains { $0.sessionID != me } ?? false
    }

    /// 按需连接 / 断开共享连接；没人共享 15 秒后断开（共享常常停了又开）
    private func followShare() {
        guard started, room != nil else { return }
        if shareNeeded {
            shareIdleTask?.cancel()
            shareIdleTask = nil
            if shareRoom == nil, shareJoining == nil {
                Task { [weak self] in
                    do { _ = try await self?.ensureShareRoom() } catch {
                        try? await Task.sleep(for: .seconds(2))
                        self?.followShare()
                    }
                }
            }
        } else if shareRoom != nil, shareIdleTask == nil {
            shareIdleTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                self.shareIdleTask = nil
                if !self.shareNeeded { await self.closeShareRoom() }
            }
        }
    }

    /// 连接共享连接（已连上时直接返回）：向控制面要令牌，和主连接共用端到端加密的密钥
    func ensureShareRoom() async throws -> LiveKit.Room {
        if let r = shareRoom, shareRoomFor == roomID, r.connectionState != .disconnected { return r }
        if let t = shareJoining { return try await t.value }
        let rid = roomID
        let task = Task { () throws -> LiveKit.Room in
            defer { self.shareJoining = nil }
            var grant: Openhane_V1_MediaGrant
            var r: LiveKit.Room
            var proxy: RoomDelegateProxy
            while true {
                grant = try await session.joinShareMedia(transport: shareTransport)
                guard let mainURL = session.state.media?.url else { throw HaneError.connectionLost }
                let url = grant.url.isEmpty ? mainURL : (URL(string: grant.url) ?? mainURL)
                proxy = RoomDelegateProxy(owner: self)
                r = LiveKit.Room(delegate: proxy, roomOptions: LiveKit.RoomOptions(encryptionOptions: e2ee.map { EncryptionOptions(keyProvider: $0.provider) },
                                                                                 reportRemoteTrackStatistics: true))
                let port = session.address?.port ?? ServerAddress.defaultPort
                // 只走 TCP 时等不了太久：端口被防火墙拦住时连通性检查会一直挂着，超时后改用 UDP
                let timeout: TimeInterval = grant.tcp ? shareTCPTimeout : .defaultTransportState
                do {
                    try await r.connect(url: url.absoluteString, token: grant.token,
                                        connectOptions: ConnectOptions(primaryTransportConnectTimeout: timeout,
                                                                       publisherTransportConnectTimeout: timeout,
                                                                       iceServers: relayOnly.map { [IceServer(urls: [$0.url], username: $0.username, credential: $0.credential)] } ?? [],
                                                                       iceTransportPolicy: relayOnly == nil ? .all : .relay,
                                                                       serverTrustEvaluator: session.trust.evaluator(port: port)))
                    break
                } catch {
                    await r.disconnect()
                    guard grant.tcp, started, roomID == rid else { throw error }
                    shareUdp = true
                }
            }
            guard started, roomID == rid else {
                await r.disconnect()
                throw HaneError.connectionLost
            }
            shareRoom = r
            shareRoomFor = rid
            shareDelegate = proxy
            watchTransport(r, policy: session.state.media?.policy, tcp: grant.tcp)
            refreshVideoTracks()
            return r
        }
        shareJoining = task
        return try await task.value
    }

    private func closeShareRoom() async {
        shareIdleTask?.cancel()
        shareIdleTask = nil
        transportTask?.cancel()
        transportTask = nil
        transportProtocol = nil
        let r = shareRoom
        shareRoom = nil
        shareRoomFor = nil
        shareDelegate = nil
        if let r {
            await r.disconnect()
            refreshVideoTracks()
        }
    }

    /// 测试与诊断：共享连接的 Room（没人共享时为 nil）
    public var liveShareRoom: LiveKit.Room? { shareRoom }

    /// 自定义共享里可以选的编码器：本机能硬件编码的（加密房间没有 AV1；服务器设为只用 H.264 时为空）
    public var shareCodecOptions: [ShareCodec] {
        let compat = session.state.media?.policy.codecs.mode == .compat
        return selectableShareCodecs(caps: ShareController.encodeCaps, policy: compat ? .compat : .auto, e2ee: e2ee?.enabled == true)
    }

    /// 共享中切换模式；切到自定义时给出参数（已经是自定义时也可以只改参数）
    public func setShareIntent(_ intent: ShareIntentName, custom: CustomShare? = nil) async {
        await shareController?.setIntent(intent, custom: custom)
    }

    @ObservationIgnored private var sharingAudio = false

    private func onShareStatus(_ s: ShareStatus?) {
        share = s
        if (s != nil) != isSharing { isSharing = s != nil }
        if s == nil {
            shareController = nil
            followShare()
        }
        let audio = s?.withAudio ?? false
        if audio != sharingAudio {
            sharingAudio = audio
            Task { await self.applyShareAudio(audio) }
        }
        refreshVideoTracks()
    }

    /// 共享声音开始 / 结束：麦克风轨道切到音乐码率、关闭发言门控（音乐不能被门控截断），静音改用混音器的麦克风音量
    private func applyShareAudio(_ on: Bool) async {
        processor.setPassthrough(on)
        let mixer = AudioManager.shared.mixer
        guard let r = room else { return }
        if on {
            mixer.micVolume = micMuted ? 0 : 1
            mixer.appVolume = 1
            if micMuted, Self.hasAudioInput { _ = try? await r.localParticipant.setMicrophone(enabled: true) }
            if let pub = r.localParticipant.audioTracks.first as? LocalTrackPublication {
                await pub.setAudioEncoding(maxBitrate: 128_000)
            }
        } else {
            mixer.micVolume = 1
            if micMuted { _ = try? await r.localParticipant.setMicrophone(enabled: false) }
            if let pub = r.localParticipant.audioTracks.first as? LocalTrackPublication, appliedAudioBitrate > 0 {
                await pub.setAudioEncoding(maxBitrate: appliedAudioBitrate)
            }
        }
    }

    private var connectedRoom: LiveKit.Room? {
        guard let r = room, r.connectionState == .connected else { return nil }
        return r
    }

    static func defaultShareSource() -> ShareFrameSource {
        #if os(macOS)
        SCKFrameSource()
        #else
        SyntheticFrameSource() // iOS 的真实屏幕采集走广播扩展（BroadcastCapture），这里只用于测试
        #endif
    }

    fileprivate func refreshVideoTracks() {
        guard let r = room else {
            if !videoTracks.isEmpty { videoTracks = [] }
            return
        }
        var out: [VideoTrackRef] = []
        let me = r.localParticipant.identity?.stringValue ?? ""
        for pub in r.localParticipant.videoTracks {
            if let t = pub.track as? VideoTrack, !pub.isMuted {
                out.append(VideoTrackRef(sid: pub.sid.stringValue, identity: me, isScreen: pub.source == .screenShareVideo, isLocal: true, track: t))
            }
        }
        for p in r.remoteParticipants.values {
            let id = p.identity?.stringValue ?? ""
            for pub in p.videoTracks {
                if let t = pub.track as? VideoTrack, !pub.isMuted {
                    out.append(VideoTrackRef(sid: pub.sid.stringValue, identity: id, isScreen: pub.source == .screenShareVideo, isLocal: false, track: t))
                }
            }
        }
        if let s = shareRoom {
            for pub in s.localParticipant.videoTracks {
                if let t = pub.track as? VideoTrack, !pub.isMuted {
                    out.append(VideoTrackRef(sid: pub.sid.stringValue, identity: me, isScreen: pub.source == .screenShareVideo, isLocal: true, track: t))
                }
            }
            for p in s.remoteParticipants.values {
                let id = Self.mainIdentity(p.identity?.stringValue ?? "")
                for pub in p.videoTracks {
                    if let t = pub.track as? VideoTrack, !pub.isMuted {
                        out.append(VideoTrackRef(sid: pub.sid.stringValue, identity: id, isScreen: pub.source == .screenShareVideo, isLocal: false, track: t))
                    }
                }
            }
        }
        out.sort { ($0.identity, $0.sid) < ($1.identity, $1.sid) }
        if out.map(\.sid) != videoTracks.map(\.sid) { videoTracks = out }
    }

    /// 关闭声音：所有远端声音静音（调用方同时静音麦克风）。
    public func setDeafened(_ d: Bool) {
        deafened = d
        applyVolumes()
    }

    public func setPushToTalk(_ pressed: Bool) {
        processor.setPushToTalk(pressed)
    }

    public func setVolume(_ v: Double, for identity: String) {
        volumes[identity] = v
        applyVolumes()
    }

    func applyVolumes() {
        // 共享连接里别人的共享声音按主连接的身份取音量
        for r in [room, shareRoom].compactMap(\.self) {
            for p in r.remoteParticipants.values {
                let v = deafened ? 0 : (volumes[Self.mainIdentity(p.identity?.stringValue ?? "")] ?? 1) * outputVolume
                for pub in p.audioTracks {
                    (pub.track as? RemoteAudioTrack)?.volume = v
                }
            }
        }
    }

    /// 共享连接的身份换回主连接的身份（界面和音量都按主连接身份找成员）
    static func mainIdentity(_ identity: String) -> String {
        identity.hasSuffix(shareSuffix) ? String(identity.dropLast(shareSuffix.count)) : identity
    }

    // MARK: AI 降噪

    private func applyNoiseSuppression() {
        guard noiseSuppression == .ai, started, DeepFilter.available else {
            processor.setDeepFilter(nil)
            updateNoiseState()
            return
        }
        if let deepFilter {
            processor.setDeepFilter(deepFilter)
        } else if deepFilterTask == nil {
            deepFilterTask = Task { [weak self] in
                let df = await Task.detached(priority: .userInitiated) { DeepFilter() }.value
                guard let self, !Task.isCancelled else { return }
                self.deepFilterTask = nil
                self.deepFilter = df
                if df == nil { self.updateNoiseState() } else { self.applyNoiseSuppression() }
            }
        }
        updateNoiseState()
    }

    private func updateNoiseState() {
        let next: NoiseState
        if noiseSuppression == .system {
            next = echoProcessing == .system ? .system : .software
        } else if !DeepFilter.available {
            next = .unavailable
        } else if !started {
            next = .standby
        } else if deepFilter != nil {
            switch aiFrame {
            case .pausedForShare: next = .pausedForShare
            case .pausedForVoiceIsolation: next = .pausedForVoiceIsolation
            case .unsupportedFormat: next = .unsupportedFormat
            case .processed, nil: next = .active
            }
        } else {
            next = deepFilterTask != nil ? .loading : .unavailable // 没有任务也没有实例：模型加载失败
        }
        if next != noiseState { noiseState = next }
    }

    // MARK: 回调

    private func onVoiceStatus(_ s: VoiceProcessor.Status) {
        localLevelDb = s.levelDb
        localThresholdDb = s.thresholdDb
        aiFrame = s.ai
        captureRate = s.sampleRate
        // 每秒看一次系统麦克风模式：用户可能随时在控制中心切换「语音突显」
        statusCount += 1
        if statusCount % 20 == 1 {
            processor.setVoiceIsolation(echoProcessing == .system && AVCaptureDevice.activeMicrophoneMode == .voiceIsolation)
        }
        updateNoiseState()
        let tx = s.speaking && !micMuted
        if tx != transmitting { transmitting = tx }
        let id = localIdentity
        if !id.isEmpty {
            if tx, !speaking.contains(id) { speaking.insert(id) }
            if !tx, speaking.contains(id) { speaking.remove(id) }
        }
    }

    fileprivate func onSpeakers(_ ids: Set<String>) {
        var next = ids
        next.remove(localIdentity)
        if transmitting, !localIdentity.isEmpty { next.insert(localIdentity) }
        if next != speaking { speaking = next }
    }

    /// SFU 权限变化：强制静音解除后重新允许发布麦克风时，把麦克风重新发布（保持静音，由用户自己开麦）。
    /// 只在已经连上、不在连接 / 换房间的过程中才处理：LiveKit 在连接中途（发送连接还没建好）就会通知一次权限，
    /// 这时发布会报「Publisher is nil」；连接完成后的发布由 connect 负责
    fileprivate func onPermissionsChanged(_ r: LiveKit.Room) {
        guard room === r, !connecting, r.connectionState == .connected,
              let p = r.localParticipant.permissions as ParticipantPermissions? else { return }
        let allowed = p.canPublishSources
        let micAllowed = allowed.isEmpty || allowed.contains(Track.Source.microphone.rawValue)
        if micAllowed, r.localParticipant.audioTracks.isEmpty, let policy = session.state.media?.policy {
            Task { await publishMicrophone(r, policy: policy) }
        }
    }

    /// 本地轨道被取消发布：主持人关闭了摄像头（SFU 收回权限）时同步本地状态
    fileprivate func onLocalUnpublished(_ r: LiveKit.Room, source: Track.Source) {
        guard room === r else { return }
        if source == .camera, cameraOn { cameraOn = false }
        refreshVideoTracks()
    }

    fileprivate func onDisconnected(_ r: LiveKit.Room) {
        if r === shareRoom {
            // 共享连接断开（令牌过期、SFU 重启）：还需要的话稍后重连
            shareRoom = nil
            shareRoomFor = nil
            refreshVideoTracks()
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                self?.followShare()
            }
            return
        }
        guard room === r, started else { return }
        room = nil
        speaking = []
        videoTracks = []
        cameraOn = false
        if shareController != nil { Task { await self.stopScreenShare() } }
        status = .reconnecting
        scheduleReconnect()
    }

    fileprivate func onReconnecting(_ r: LiveKit.Room, _ reconnecting: Bool) {
        guard room === r else { return }
        status = reconnecting ? .reconnecting : .connected
    }

    /// 诊断用：当前的 LiveKit.Room
    public var liveRoom: LiveKit.Room? { room }

    /// 音频设备（macOS）
    /// 输入 / 输出设备列表（缓存，见 refreshAudioDevices）
    public private(set) var inputDevices: [AudioDevice] = []
    public private(set) var outputDevices: [AudioDevice] = []
    public func selectInput(_ d: AudioDevice) { AudioManager.shared.inputDevice = d }
    public func selectOutput(_ d: AudioDevice) { AudioManager.shared.outputDevice = d }
    /// 改回跟随系统默认设备
    public func selectDefaultInput() { if let d = inputDevices.first(where: \.isDefault) { selectInput(d) } }
    public func selectDefaultOutput() { if let d = outputDevices.first(where: \.isDefault) { selectOutput(d) } }

    /// 在后台线程读取设备列表：每次读取都是对 WebRTC 内部线程的同步调用，共享屏幕时它忙着编码，在主线程上读会卡住界面。
    /// 第一次调用后跟随系统的设备变化（插拔耳机等）自动刷新
    public func refreshAudioDevices() async {
        struct Lists: @unchecked Sendable { let inputs, outputs: [AudioDevice] }
        watchDevices()
        let lists = await Task.detached(priority: .userInitiated) {
            let m = AudioManager.shared
            let lists = Lists(inputs: m.inputDevices, outputs: m.outputDevices)
            // 选中的设备被拔掉了：改回系统默认，不让音频引擎继续指向不存在的设备
            if !lists.inputs.contains(where: { $0.deviceId == m.inputDevice.deviceId }), let d = lists.inputs.first(where: \.isDefault) { m.inputDevice = d }
            if !lists.outputs.contains(where: { $0.deviceId == m.outputDevice.deviceId }), let d = lists.outputs.first(where: \.isDefault) { m.outputDevice = d }
            return lists
        }.value
        if lists.inputs.map(\.deviceId) != inputDevices.map(\.deviceId) || lists.inputs.map(\.name) != inputDevices.map(\.name) { inputDevices = lists.inputs }
        if lists.outputs.map(\.deviceId) != outputDevices.map(\.deviceId) || lists.outputs.map(\.name) != outputDevices.map(\.name) { outputDevices = lists.outputs }
        guard let r = connectedRoom else { return }
        if micUnavailable, Self.hasAudioInput, let policy = session.state.media?.policy {
            // 之前没有麦克风、现在接上了：补发布
            await publishMicrophone(r, policy: policy)
        } else if !micUnavailable, !Self.hasAudioInput, !sharingAudio,
                  let pub = r.localParticipant.audioTracks.first as? LocalTrackPublication {
            // 会议中拔掉了最后一个麦克风：取消发布，只能收听（LiveKit 补丁已保证音频引擎不会因此闪退）
            micUnavailable = true
            try? await r.localParticipant.unpublish(publication: pub)
        }
    }

    /// 跟随系统的音频设备变化（插拔麦克风、耳机）刷新设备列表并处理麦克风，只注册一次
    private func watchDevices() {
        guard !watchingDevices else { return }
        watchingDevices = true
        AudioManager.shared.onDeviceUpdate = { [weak self] _ in Task { @MainActor in await self?.refreshAudioDevices() } }
    }

    @ObservationIgnored private var watchingDevices = false
}

/// RoomDelegate 的回调不在主线程：转到 MediaSession 所在的主线程。
private final class RoomDelegateProxy: RoomDelegate, @unchecked Sendable {
    weak var owner: MediaSession?
    init(owner: MediaSession) { self.owner = owner }

    func room(_ room: LiveKit.Room, didUpdateSpeakingParticipants participants: [LiveKit.Participant]) {
        let ids = Set(participants.compactMap { $0.identity?.stringValue })
        Task { @MainActor in self.owner?.onSpeakers(ids) }
    }

    func room(_ room: LiveKit.Room, didDisconnectWithError _: LiveKitError?) {
        Task { @MainActor in self.owner?.onDisconnected(room) }
    }

    func room(_ room: LiveKit.Room, didStartReconnectWithMode _: ReconnectMode) {
        Task { @MainActor in self.owner?.onReconnecting(room, true) }
    }

    func room(_ room: LiveKit.Room, didCompleteReconnectWithMode _: ReconnectMode) {
        Task { @MainActor in self.owner?.onReconnecting(room, false) }
    }

    func room(_: LiveKit.Room, participant _: RemoteParticipant, didSubscribeTrack _: RemoteTrackPublication) {
        Task { @MainActor in
            self.owner?.applyVolumes()
            self.owner?.refreshVideoTracks()
        }
    }

    func room(_: LiveKit.Room, participant _: RemoteParticipant, didUnsubscribeTrack _: RemoteTrackPublication) {
        Task { @MainActor in self.owner?.refreshVideoTracks() }
    }

    func room(_: LiveKit.Room, participant _: LocalParticipant, didPublishTrack _: LocalTrackPublication) {
        Task { @MainActor in self.owner?.refreshVideoTracks() }
    }

    func room(_ room: LiveKit.Room, participant _: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        let source = publication.source
        Task { @MainActor in self.owner?.onLocalUnpublished(room, source: source) }
    }

    func room(_ room: LiveKit.Room, participant: LiveKit.Participant, didUpdatePermissions _: ParticipantPermissions) {
        guard participant is LocalParticipant else { return }
        Task { @MainActor in self.owner?.onPermissionsChanged(room) }
    }

    func room(_: LiveKit.Room, participant _: LiveKit.Participant, trackPublication _: TrackPublication, didUpdateIsMuted _: Bool) {
        Task { @MainActor in self.owner?.refreshVideoTracks() }
    }

    func room(_: LiveKit.Room, participantDidDisconnect _: RemoteParticipant) {
        Task { @MainActor in self.owner?.refreshVideoTracks() }
    }

    func room(_ room: LiveKit.Room, trackPublication: TrackPublication, didUpdateE2EEState state: E2EEState) {
        let sid = trackPublication.sid.stringValue
        let local = room.localParticipant.trackPublications[trackPublication.sid] != nil
        let owner = local ? room.localParticipant : room.remoteParticipants.values.first { $0.trackPublications[trackPublication.sid] != nil }
        let identity = owner?.identity?.stringValue ?? ""
        Task { @MainActor in self.owner?.onE2EEState(room, sid: sid, identity: identity, remote: !local, state: state) }
    }
}

/// 一条视频轨道（界面用）
public struct VideoTrackRef: Identifiable, @unchecked Sendable {
    public var id: String { sid }
    public let sid: String
    /// 媒体 identity（uid:session_id）
    public let identity: String
    /// 控制面的 session_id
    public var sessionID: String { identity.split(separator: ":").last.map(String.init) ?? identity }
    public let isScreen: Bool
    public let isLocal: Bool
    public let track: VideoTrack
}
