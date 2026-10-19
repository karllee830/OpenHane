#if os(macOS)
import AppKit
#else
import UIKit
#endif
import AVFoundation
import Network
import HaneCore
import HaneMedia
import Observation

/// 应用级状态：一个服务器连接 + 媒体会话 + 个人设置。macOS 与 iOS 共用，平台差异用条件编译区分。
@MainActor
@Observable
final class AppModel {
    /// 应用唯一的实例。SwiftUI 可能不止一次初始化 App 结构体（@State 的初始值也会被多创建一次），
    /// 所以由这里保证只有一个；快捷指令、实时活动都通过它操作当前会议。
    static let shared = AppModel()

    let session: ServerSession
    let media: MediaSession
    var tofuMismatch: TrustStore.Mismatch?
    var connectError: HaneError?
    var chatOpen = true
    var unread = 0
    /// 短暂提示（例如共享被拒绝），几秒后自动消失
    var notice: String? {
        didSet {
            noticeTask?.cancel()
            guard notice != nil else { return }
            noticeTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                if !Task.isCancelled { self?.notice = nil }
            }
        }
    }
    /// openhane:// 链接带来的地址（预填连接页）和权限令牌（进入会议后确认再兑换）
    var linkAddress: String?
    var linkToken: String?
    /// 邀请链接（openhane://…?invite=、https://host/j/<码>）带来的邀请码：连接时携带，免服务器密码、可附带角色
    var linkInvite: String?

    /// 默认昵称：最近一次连接时用的昵称，新服务器默认用它
    var nickname: String { didSet { defaults.set(nickname, forKey: "nickname") } }
    /// 主页的服务器列表（收藏的和最近连接的），最新的在前
    var recentServers: [RecentServer] { didSet { RecentServers.save(recentServers, to: defaults) } }
    /// 列表里每台服务器的延迟和在线人数（按地址；还没测完的没有）
    var serverStatus: [String: ServerStatus] = [:]
    /// 服务器图标（按地址；服务器设置了图标才有），缓存在本地，见 ServerLogos.swift
    var serverLogos: [String: Data] = [:]
    /// 屏幕共享「自定义」档上次用的参数
    var shareCustom: CustomShare { didSet { defaults.set(try? JSONEncoder().encode(shareCustom), forKey: "shareCustom") } }
    var voiceMode: VoiceMode {
        didSet {
            defaults.set(voiceMode.rawValue, forKey: "voiceMode")
            media.mode = voiceMode
            #if os(macOS)
            updateHotkey()
            #endif
        }
    }
    #if os(macOS)
    var pttBinding: HotkeyBinding {
        didSet {
            defaults.set(try? JSONEncoder().encode(pttBinding), forKey: "pttBinding")
            updateHotkey()
        }
    }
    #endif
    #if os(macOS)
    /// 选中的输入 / 输出设备（空表示系统默认）。重启后由系统默认重新选择，这里只记住 ID 供设置和会议里的菜单显示
    var inputDeviceID: String { didSet { defaults.set(inputDeviceID, forKey: "inputDevice") } }
    var outputDeviceID: String { didSet { defaults.set(outputDeviceID, forKey: "outputDevice") } }
    /// 设置里选的摄像头（AVCaptureDevice.uniqueID）；空表示系统默认
    var cameraID: String {
        didSet {
            defaults.set(cameraID, forKey: "cameraDevice")
            Task { await media.setPreferredCamera(cameraID.isEmpty ? nil : cameraID) }
        }
    }
    #endif
    /// 麦克风音量和所有人声音的总音量（0–2，1 为原始音量）
    var inputVolume: Double {
        didSet {
            defaults.set(inputVolume, forKey: "inputVolume")
            media.inputVolume = inputVolume
        }
    }
    var outputVolume: Double {
        didSet {
            defaults.set(outputVolume, forKey: "outputVolume")
            media.outputVolume = outputVolume
        }
    }
    var manualThreshold: Double? {
        didSet {
            defaults.set(manualThreshold, forKey: "manualThreshold")
            media.manualThresholdDb = manualThreshold
        }
    }
    /// 回声消除用软件还是系统语音处理：macOS 默认软件（不压低其他应用的声音），iPhone 默认系统
    var echoProcessing: EchoProcessing {
        didSet {
            defaults.set(echoProcessing.rawValue, forKey: "echoProcessing")
            media.echoProcessing = echoProcessing
        #if os(macOS)
        media.preferredCameraID = cameraID.isEmpty ? nil : cameraID
        #endif
        }
    }
    /// 降噪档位：默认 AI 降噪
    var noiseSuppression: NoiseSuppression {
        didSet {
            defaults.set(noiseSuppression.rawValue, forKey: "noiseSuppression")
            media.noiseSuppression = noiseSuppression
        }
    }
    #if os(macOS)
    private(set) var hotkeyAvailable = HotkeyMonitor.hasPermission
    @ObservationIgnored private let hotkeys = HotkeyMonitor()
    @ObservationIgnored private var activity: NSObjectProtocol?
    #endif
    /// 是否在会议中（已进入、尚未离开）
    @ObservationIgnored private var inCall = false
    #if os(iOS)
    @ObservationIgnored private var airPodsObserver: NSObjectProtocol?
    #endif

    /// 端到端检查（HANE_E2E=1）用单独的偏好设置：自动连接不会改掉真实的昵称、最近连接
    @ObservationIgnored private let defaults = ProcessInfo.processInfo.environment["HANE_E2E"] == "1"
        ? UserDefaults(suiteName: "com.0http.openhane.e2e") ?? .standard : .standard
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    #if os(iOS)
    @ObservationIgnored private var liveActivity: LiveActivityController?
    /// 画中画（切到其他应用时继续显示共享画面）
    @ObservationIgnored let pip = PictureInPicture()
    #endif

    private init() {
        defer {
            #if os(iOS)
            liveActivity = LiveActivityController(model: self)
            #endif
        }
        let e2e = ProcessInfo.processInfo.environment["HANE_E2E"] == "1"
        let info = Bundle.main.infoDictionary
        session = ServerSession(
            trust: .defaultStore(),
            seeds: e2e ? MemorySeedStore(seed: Data(repeating: UInt8(DevHooks.environment["HANE_SEED_BYTE"] ?? "") ?? 7, count: 32)) : KeychainSeedStore(),
            client: .init(appVersion: info?["HaneVersion"] as? String ?? info?["CFBundleShortVersionString"] as? String ?? "dev", platform: Self.platform,
                          osVersion: ProcessInfo.processInfo.operatingSystemVersionString, deviceName: Self.deviceName)
        )
        media = MediaSession(session: session)
        nickname = defaults.string(forKey: "nickname") ?? Self.defaultNickname
        let recent = RecentServers.load(defaults)
        recentServers = recent
        serverLogos = Dictionary(uniqueKeysWithValues: recent.compactMap { r in ServerLogoCache.data(for: r.address).map { (r.address, $0) } })
        shareCustom = defaults.data(forKey: "shareCustom").flatMap { try? JSONDecoder().decode(CustomShare.self, from: $0) } ?? .default
        voiceMode = VoiceMode(rawValue: defaults.string(forKey: "voiceMode") ?? "") ?? .voice
        #if os(macOS)
        pttBinding = (defaults.data(forKey: "pttBinding")).flatMap { try? JSONDecoder().decode(HotkeyBinding.self, from: $0) } ?? .defaultBinding
        cameraID = defaults.string(forKey: "cameraDevice") ?? ""
        inputDeviceID = defaults.string(forKey: "inputDevice") ?? ""
        outputDeviceID = defaults.string(forKey: "outputDevice") ?? ""
        #endif
        manualThreshold = defaults.object(forKey: "manualThreshold") as? Double
        inputVolume = defaults.object(forKey: "inputVolume") as? Double ?? 1
        outputVolume = defaults.object(forKey: "outputVolume") as? Double ?? 1
        noiseSuppression = NoiseSuppression(rawValue: defaults.string(forKey: "noiseSuppression") ?? "") ?? .ai
        echoProcessing = EchoProcessing(rawValue: defaults.string(forKey: "echoProcessing") ?? "") ?? .platformDefault
        media.mode = voiceMode
        media.manualThresholdDb = manualThreshold
        media.inputVolume = inputVolume
        media.outputVolume = outputVolume
        media.noiseSuppression = noiseSuppression
        media.echoProcessing = echoProcessing
        #if os(macOS)
        hotkeys.onChange = { [weak self] pressed in self?.media.setPushToTalk(pressed) }
        #endif
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.session.retryNow() }
        }
        pathMonitor.start(queue: .main)
        watchStatus()
        // 退出应用 = 主动离开：发送正常关闭帧，服务端立即移除会话（否则其他人会看到一个「重连中」的成员直到宽限期结束）
        NotificationCenter.default.addObserver(forName: Self.willTerminate, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isInMeeting else { return }
                self.session.disconnect()
                Thread.sleep(forTimeInterval: 0.2) // 关闭帧由 URLSession 的后台线程发送
            }
        }
    }

    var isInMeeting: Bool {
        switch session.status {
        case .connected, .reconnecting: return true
        default: return false
        }
    }

    // MARK: 连接

    /// 连接一台服务器。nickname 为 nil 时用这台服务器记住的昵称，没有就用默认昵称
    func connect(address: String, password: String, nickname nick: String? = nil) async {
        connectError = nil
        let nick = (nick ?? nickname(for: address)).trimmingCharacters(in: .whitespaces)
        do {
            try await session.connect(address: address, nickname: nick, password: password, inviteCode: linkInvite)
            let info = session.state.serverInfo
            nickname = nick
            // 默认名称与应用同名，记下来没有意义：列表里改为显示地址。每台服务器记住自己用的昵称
            recentServers = RecentServers.remember(
                RecentServer(address: address, name: DisplayName.serverName(info.name), lastUsed: Date(), needsPassword: info.requiresPassword, nickname: nick),
                in: recentServers)
            didEnterMeeting()
        } catch let HaneError.fingerprintChanged(m) {
            tofuMismatch = m
        } catch let e as HaneError {
            connectError = e
        } catch {
            connectError = .unreachable(error.localizedDescription)
        }
    }

    func forget(_ server: RecentServer) {
        recentServers.removeAll { $0.address == server.address }
        ServerLogoCache.remove(server.address)
        serverLogos[server.address] = nil
    }

    /// 在这台服务器上用的昵称：记住的昵称，没有就用默认昵称
    func nickname(for address: String) -> String {
        let n = RecentServers.find(address, in: recentServers)?.nickname ?? ""
        return n.isEmpty ? nickname : n
    }

    func toggleFavorite(_ server: RecentServer) {
        recentServers = RecentServers.update(server.address, in: recentServers) { $0.favorite.toggle() }
    }

    /// 修改备注和在这台服务器上用的昵称
    func edit(_ server: RecentServer, note: String, nickname: String) {
        recentServers = RecentServers.update(server.address, in: recentServers) {
            $0.note = note.trimmingCharacters(in: .whitespaces)
            $0.nickname = nickname.trimmingCharacters(in: .whitespaces)
        }
    }

    /// 主页显示期间定期测一遍列表里的服务器（延迟和在线人数）；视图消失时随任务取消
    func watchServerStatus() async {
        while !Task.isCancelled {
            await withTaskGroup(of: Void.self) { group in
                for address in recentServers.map(\.address) {
                    group.addTask { [trust = session.trust] in
                        let s = await ServerProbe.probe(address, trust: trust)
                        await MainActor.run { self.serverStatus[address] = s }
                        await self.updateFromProbe(address, status: s)
                    }
                }
            }
            try? await Task.sleep(for: .seconds(30))
        }
    }

    func acceptFingerprint() async {
        guard let m = tofuMismatch else { return }
        session.trust.accept(m)
        tofuMismatch = nil
        do {
            try await session.reconnect()
            didEnterMeeting()
        } catch let e as HaneError {
            connectError = e
        } catch {}
    }

    func cancelFingerprint() {
        tofuMismatch = nil
        session.disconnect()
    }

    func leave() async {
        session.disconnect()
        await didLeaveMeeting()
    }

    private func didEnterMeeting() {
        // 服务器开启了「加入时静音」时，Welcome 中的自身状态是静音
        let muted = session.state.selfParticipant?.state.micMuted ?? false
        Task { await media.setMicMuted(muted) }
        media.start()
        // 防止 App Nap：后台时音频和心跳不能被节流
        inCall = true
        #if os(macOS)
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "OpenHane call")
        updateHotkey()
        #else
        watchAirPodsMute()
        #endif
        unread = 0
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.session.events() {
                self.onEvent(ev)
            }
        }
    }

    private func didLeaveMeeting() async {
        eventsTask?.cancel()
        await media.stop()
        inCall = false
        #if os(macOS)
        hotkeys.stop()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
        #endif
    }

    /// 被踢、被封禁、证书指纹在重连时变化等：离开会议并在连接页说明原因
    private func watchStatus() {
        statusTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if case let .failed(err) = self.session.status, self.inCall {
                    if case let .fingerprintChanged(m) = err { self.tofuMismatch = m } else { self.connectError = err }
                    await self.didLeaveMeeting()
                }
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    withObservationTracking { _ = self.session.status } onChange: { c.resume() }
                }
            }
        }
    }

    private func onEvent(_ ev: Openhane_V1_Event) {
        let room = session.state.media?.roomID ?? "main"
        switch ev.body {
        case let .participantJoined(e) where e.participant.roomID == room:
            Self.play(.joined)
        case .participantLeft:
            Self.play(.left)
        case let .chatMessage(m) where m.senderSessionID != session.state.me?.sessionID:
            if !chatOpen || !Self.appIsActive { unread += 1 }
        case let .moderationNotice(n):
            notice = NoticeText.moderation(n)
            // 被强制静音：本地也切到静音（解除后由用户自己开麦）
            if n.action == .forceMute { Task { await setMuted(true) } }
        case let .youWereMoved(m):
            notice = NoticeText.moved(m, state: session.state)
            Self.play(.joined)
        default:
            break
        }
    }

    /// openhane://host:port?token=…
    func handle(url: URL) {
        guard url.scheme?.lowercased() == "openhane", let a = try? ServerAddress.parse(url.absoluteString) else { return }
        linkAddress = a.hostPort
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        linkToken = query?.first { $0.name == "token" }?.value
        linkInvite = query?.first { $0.name == "invite" }?.value ?? a.invite
    }

    // MARK: 麦克风与声音

    func setMuted(_ muted: Bool) async {
        #if os(iOS)
        // 与 AirPods 按压静音双向同步
        try? AVAudioApplication.shared.setInputMuted(muted)
        #endif
        // 关闭声音时取消静音会同时开启声音
        if !muted, media.deafened {
            media.setDeafened(false)
            try? await session.updateSelf(micMuted: false, deafened: false)
        } else {
            try? await session.updateSelf(micMuted: muted)
        }
        await media.setMicMuted(muted)
    }

    // MARK: 屏幕共享

    func startShare(intent: ShareIntentName, withAudio: Bool) async {
        do {
            try await media.startScreenShare(intent: intent, withAudio: withAudio, custom: intent == .custom ? shareCustom : nil)
        } catch is ShareCancelled {
            // 用户在系统选择器中取消
        } catch let e as HaneError {
            notice = e.code == .permissionDenied ? L("服务器不允许你共享屏幕") : e.code == .shareLimitReached ? L("同时共享的人数已达上限") : describe(e)
        } catch {
            notice = L("无法开始共享：\(error.localizedDescription)")
        }
    }

    func setDeafened(_ d: Bool) async {
        media.setDeafened(d)
        await media.setMicMuted(d)
        try? await session.updateSelf(micMuted: d, deafened: d)
    }

    #if os(macOS)
    func updateHotkey() {
        hotkeys.binding = pttBinding
        if voiceMode == .ptt, isInMeeting {
            hotkeyAvailable = hotkeys.start()
        } else {
            hotkeys.stop()
            hotkeyAvailable = HotkeyMonitor.hasPermission
        }
    }

    #endif

    /// 引导用户在控制中心选择「语音突显」（系统级 AI 降噪）
    func showMicrophoneModes() {
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    }

    var activeMicrophoneMode: AVCaptureDevice.MicrophoneMode { AVCaptureDevice.activeMicrophoneMode }

    // MARK: 平台差异

    enum Sound { case joined, left }

    #if os(macOS)
    static let platform = Openhane_V1_Platform.macos
    static var deviceName: String { Host.current().localizedName ?? "Mac" }
    static var defaultNickname: String { NSFullUserName() }
    static let willTerminate = NSApplication.willTerminateNotification
    static var appIsActive: Bool { NSApp.isActive }
    static func play(_ s: Sound) { NSSound(named: s == .joined ? "Pop" : "Bottle")?.play() }
    #else
    static let platform = Openhane_V1_Platform.ios
    static var deviceName: String { UIDevice.current.name }
    static var defaultNickname: String { "" }
    static let willTerminate = UIApplication.willTerminateNotification
    static var appIsActive: Bool { UIApplication.shared.applicationState == .active }
    static func play(_: Sound) {} // iOS 上不播放进出提示音（会与通话声音混在一起），由触感和界面提示代替

    /// AirPods 按压耳机柄静音（iOS 17）：系统切换输入静音后发出通知，应用内的静音状态跟随（反方向由 setMuted 同步）
    private func watchAirPodsMute() {
        guard airPodsObserver == nil else { return }
        airPodsObserver = NotificationCenter.default.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { [weak self] n in
            guard let muted = n.userInfo?[AVAudioApplication.muteStateKey] as? Bool else { return }
            MainActor.assumeIsolated {
                guard let self, muted != self.media.micMuted else { return }
                Task { await self.setMuted(muted) }
            }
        }
    }
    #endif
}
