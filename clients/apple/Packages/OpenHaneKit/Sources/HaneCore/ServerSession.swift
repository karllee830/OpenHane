import CryptoKit
import Foundation
import Observation
import SwiftProtobuf

/// 一个服务器连接：握手鉴权、请求 / 响应、事件归并到状态、心跳、断线自动恢复。
/// 与 Web 客户端 core/client.ts 的行为保持一致。
@MainActor
@Observable
public final class ServerSession {
    public private(set) var status: ConnectionStatus = .idle
    public private(set) var state = SessionState()
    public private(set) var address: ServerAddress?
    /// 最近一次心跳往返时间（毫秒）
    public private(set) var rttMs: Int?

    public struct ClientIdentity: Sendable {
        public var appVersion: String
        public var platform: Openhane_V1_Platform
        public var osVersion: String
        public var deviceName: String
        /// 本机能解码的视频编码器（上报给服务端计算房间可解码集合）
        public var decodableVideoCodecs: [String]
        /// 其中能硬件解码的：LiveKitWebRTC 只有 H.264 / H.265 走 VideoToolbox，AV1 / VP9 / VP8 是软件解码
        public var hardwareDecodedVideoCodecs: [String]
        public init(appVersion: String, platform: Openhane_V1_Platform, osVersion: String, deviceName: String,
                    decodableVideoCodecs: [String] = ["video/h264", "video/h265", "video/vp8", "video/vp9", "video/av1"],
                    hardwareDecodedVideoCodecs: [String] = ["video/h264", "video/h265"])
        {
            self.appVersion = appVersion
            self.platform = platform
            self.osVersion = osVersion
            self.deviceName = deviceName
            self.decodableVideoCodecs = decodableVideoCodecs
            self.hardwareDecodedVideoCodecs = hardwareDecodedVideoCodecs
        }
    }

    public let trust: TrustStore
    private let seeds: SeedStore
    /// 已经读出的主种子（读钥匙串可能弹密码框，只在后台线程读一次）
    private var seed: Data?
    private let client: ClientIdentity
    @ObservationIgnored private var nickname = ""
    @ObservationIgnored private var password = ""
    @ObservationIgnored private var inviteCode = ""
    /// 本次连接的 X25519 密钥交换密钥（端到端加密）；每次 connect 换一把
    @ObservationIgnored public private(set) var keyExchange = Curve25519.KeyAgreement.PrivateKey()
    @ObservationIgnored private var conn: ControlConnection?
    @ObservationIgnored private var resumeTicket = Data()
    @ObservationIgnored private var nextID: UInt32 = 1
    @ObservationIgnored private var pending: [UInt32: CheckedContinuation<Openhane_V1_Response, Error>] = [:]
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var closedByUser = false
    @ObservationIgnored private var lastReceived = Date()
    @ObservationIgnored private var eventContinuations: [UUID: AsyncStream<Openhane_V1_Event>.Continuation] = [:]
    /// 端到端加密的密钥包：密钥管理器开始接收之前到达的先存起来（见 setKeyPackageSink）
    @ObservationIgnored private var keyInbox: [Openhane_V1_KeyPackage] = []
    @ObservationIgnored private var keySink: (id: UUID, fn: (Openhane_V1_KeyPackage) -> Void)?

    public init(trust: TrustStore, seeds: SeedStore, client: ClientIdentity) {
        self.trust = trust
        self.seeds = seeds
        self.client = client
    }

    /// 原始事件流（界面用于提示音、通知等；状态请读 state）。
    public func events() -> AsyncStream<Openhane_V1_Event> {
        let (stream, cont) = AsyncStream<Openhane_V1_Event>.makeStream(bufferingPolicy: .bufferingNewest(64))
        let id = UUID()
        eventContinuations[id] = cont
        cont.onTermination = { [weak self] _ in Task { @MainActor in self?.eventContinuations[id] = nil } }
        return stream
    }

    /// 接收发给自己的 E2EE 密钥包。新成员进入加密房间时，其他人立即发出的密钥包可能在本地媒体连接建立、
    /// 密钥管理器开始接收之前就到了：这些包先存起来，设置接收者时按房间交给它。返回的函数用于取消。
    public func setKeyPackageSink(room roomID: String, _ fn: @escaping (Openhane_V1_KeyPackage) -> Void) -> () -> Void {
        let id = UUID()
        keySink = (id, fn)
        let held = keyInbox.filter { $0.roomID == roomID }
        keyInbox = []
        for k in held { fn(k) }
        return { [weak self] in
            if self?.keySink?.id == id { self?.keySink = nil }
        }
    }

    // MARK: 连接

    /// 连接服务器；成功收到 Welcome 后返回，被拒绝时抛出 HaneError。
    /// inviteCode：通过邀请链接进入（免服务器密码、可附带角色）；不填时使用地址中的邀请码（https://host/j/<码>）
    public func connect(address input: String, nickname: String, password: String = "", inviteCode: String? = nil) async throws {
        disconnect()
        closedByUser = false
        let addr: ServerAddress
        do { addr = try ServerAddress.parse(input) } catch { throw HaneError.unreachable("invalid address") }
        address = addr
        self.nickname = nickname
        self.password = password
        self.inviteCode = inviteCode ?? addr.invite ?? ""
        keyExchange = Curve25519.KeyAgreement.PrivateKey()
        keyInbox = []
        resumeTicket = Data()
        state = SessionState()
        status = .connecting
        do {
            // 先读身份再连服务器：读钥匙串可能弹出密码框，放在后台线程（主线程不卡），也不会在握手中途等用户输入密码而超时
            _ = try await loadSeed()
            try await open()
        } catch {
            let err = (error as? HaneError) ?? .unreachable(error.localizedDescription)
            if !closedByUser { status = .failed(err) }
            throw err
        }
    }

    private func loadSeed() async throws -> Data {
        if let seed { return seed }
        let store = seeds
        let s = try await Task.detached(priority: .userInitiated) { try store.masterSeed() }.value
        seed = s
        return s
    }

    /// 用上一次的参数重新连接（例如用户确认了新的证书指纹之后）。
    public func reconnect() async throws {
        guard let address else { return }
        try await connect(address: address.hostPort.isEmpty ? "" : (address.secure ? "" : "http://") + address.hostPort,
                          nickname: nickname, password: password)
    }

    /// 主动断开（离开）。
    public func disconnect() {
        closedByUser = true
        generation += 1
        for t in tasks { t.cancel() }
        tasks = []
        failPending(HaneError.connectionLost)
        conn?.close(leaving: true)
        conn = nil
        if status != .idle {
            status = .idle
            state = SessionState()
            rttMs = nil
        }
    }

    /// 建立控制连接（到 WebSocket 升级完成为止）。地址没写端口时同时尝试几个端口、按优先级选一个。
    private func dial(_ target: ServerAddress) async throws -> (ServerAddress, ControlConnection) {
        let trust = trust
        let attempts = target.candidates.map { a in
            { @Sendable () async throws -> (ServerAddress, ControlConnection) in
                let c = ControlConnection(url: a.controlURL, hostPort: a.hostPort, trust: trust)
                do {
                    try await withTaskCancellationHandler { try await c.open() } onCancel: { c.close() }
                } catch {
                    c.close()
                    throw error
                }
                return (a, c)
            }
        }
        return try await firstByPriority(attempts, grace: .milliseconds(500),
                                         decisive: { if case .fingerprintChanged = $0 as? HaneError { true } else { false } },
                                         discard: { $0.1.close() })
    }

    private func open() async throws {
        guard let target = address else { return }
        generation += 1
        let gen = generation
        // 选中的端口写回 address，之后断线重连只用这个端口
        let (address, c) = try await dial(target)
        guard gen == generation else {
            c.close()
            throw HaneError.connectionLost
        }
        self.address = address
        conn = c
        let welcome = try await withTimeout(seconds: 10) { [self] in
            try await c.send(.with {
                $0.clientHello = .with {
                    $0.protocolVersion = 1
                    $0.client = .with {
                        $0.appVersion = client.appVersion
                        $0.platform = client.platform
                        $0.osVersion = client.osVersion
                        $0.deviceName = client.deviceName
                    }
                    $0.resumeTicket = resumeTicket
                    $0.inviteCode = inviteCode
                    $0.caps = .with { caps in
                        caps.e2Ee = true // SDK 自带帧加密器
                        caps.codecs = client.decodableVideoCodecs.map { mime in
                            .with {
                                $0.mime = mime
                                $0.decode = true
                                $0.hardware = client.hardwareDecodedVideoCodecs.contains(mime)
                            }
                        }
                        caps.hardwareReported = true
                    }
                }
            })
            let challenge = try await c.receive()
            if case let .goodbye(g) = challenge.msg { throw HaneError.from(g.error) }
            guard case let .serverChallenge(ch) = challenge.msg else { throw HaneError.protocolViolation("expected ServerChallenge") }
            let key = Identity.deriveKey(masterSeed: try await loadSeed(), serverID: ch.serverID)
            let seen = trust.seenSPKI(hostPort: address.hostPort) ?? Data(count: 32)
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let sig = try key.signature(for: Identity.authSignatureInput(serverID: ch.serverID, nonce: ch.nonce, seenSPKI: address.secure ? seen : Data(count: 32), timestampMs: ts))
            try await c.send(.with {
                $0.clientAuth = .with {
                    $0.publicKey = key.publicKey.rawRepresentation
                    $0.signature = sig
                    $0.seenSpkiSha256 = address.secure ? seen : Data(count: 32)
                    $0.timestampMs = ts
                    $0.nickname = nickname
                    $0.serverPassword = password
                    let kx = keyExchange.publicKey.rawRepresentation
                    if let sig = try? key.signature(for: E2EECrypto.keySigInput(kx)) {
                        $0.e2EeKey = .with {
                            $0.publicKey = kx
                            $0.signature = sig
                        }
                    }
                }
            })
            let reply = try await c.receive()
            if case let .goodbye(g) = reply.msg { throw HaneError.from(g.error) }
            guard case let .welcome(w) = reply.msg else { throw HaneError.protocolViolation("expected Welcome") }
            return w
        }
        guard gen == generation else { throw HaneError.connectionLost }
        onWelcome(welcome, connection: c, generation: gen)
    }

    private func onWelcome(_ w: Openhane_V1_Welcome, connection c: ControlConnection, generation gen: Int) {
        resumeTicket = w.resumeTicket
        state.apply(welcome: w, mediaURL: address!.mediaURL)
        status = .connected
        lastReceived = Date()
        let room = w.autoJoin.roomID
        // 接收循环
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let env = try await c.receive()
                    guard let self, gen == self.generation else { return }
                    self.lastReceived = Date()
                    self.dispatch(env)
                } catch {
                    guard let self, gen == self.generation else { return }
                    self.onConnectionLost()
                    return
                }
            }
        })
        // 心跳：每 15 秒一次；45 秒没收到任何数据即判定断线
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, gen == self.generation else { return }
                if Date().timeIntervalSince(self.lastReceived) > 45 {
                    c.close()
                    return
                }
                try? await c.send(.with { $0.ping = .with { $0.clientTimeMs = Int64(Date().timeIntervalSince1970 * 1000) } })
            }
        })
        if !room.isEmpty { Task { try? await self.loadChatHistory(room: room) } }
    }

    private func onConnectionLost() {
        for t in tasks { t.cancel() }
        tasks = []
        failPending(HaneError.connectionLost)
        conn?.close()
        conn = nil
        guard !closedByUser else { return }
        scheduleReconnect(attempt: 1)
    }

    /// 重连退避：0.5、1、2、4……最长 30 秒，叠加 ±20% 抖动
    nonisolated static func backoff(attempt: Int) -> Duration {
        let base = min(30.0, 0.5 * pow(2.0, Double(max(0, attempt - 1))))
        return .milliseconds(Int(base * Double.random(in: 0.8 ... 1.2) * 1000))
    }

    private func scheduleReconnect(attempt: Int) {
        status = .reconnecting(attempt: attempt)
        let gen = generation
        tasks.append(Task { [weak self] in
            try? await Task.sleep(for: Self.backoff(attempt: attempt))
            guard let self, !Task.isCancelled, gen == self.generation, !self.closedByUser else { return }
            do {
                try await self.open()
            } catch {
                let err = (error as? HaneError) ?? .unreachable(error.localizedDescription)
                if self.closedByUser { return }
                if err.isFatal {
                    self.status = .failed(err)
                } else {
                    self.scheduleReconnect(attempt: attempt + 1)
                }
            }
        })
    }

    /// 测试用：直接关掉底层连接，模拟网络中断。
    func simulateNetworkDrop() { conn?.close() }

    /// 网络恢复时立即重试（NWPathMonitor）。
    public func retryNow() {
        guard case .reconnecting = status else { return }
        for t in tasks { t.cancel() }
        tasks = []
        scheduleReconnect(attempt: 0)
    }

    private func failPending(_ err: Error) {
        let p = pending
        pending = [:]
        for c in p.values { c.resume(throwing: err) }
    }

    // MARK: 收到的消息

    private func dispatch(_ env: Openhane_V1_Envelope) {
        switch env.msg {
        case let .response(r):
            guard let cont = pending.removeValue(forKey: r.id) else { return }
            if r.hasError { cont.resume(throwing: HaneError.from(r.error)) } else { cont.resume(returning: r) }
        case let .event(ev):
            state.apply(event: ev)
            // 被主持人移动、房间关闭等：事件附带新房间的媒体令牌，媒体会话据此直接切换
            if case let .youWereMoved(m) = ev.body, let address { state.apply(join: m.joined, mediaURL: address.mediaURL) }
            if case let .keyPackage(k) = ev.body {
                if let sink = keySink { sink.fn(k) } else { keyInbox = Array((keyInbox + [k]).suffix(64)) }
            }
            for c in eventContinuations.values { c.yield(ev) }
        case let .pong(p):
            rttMs = Int(Int64(Date().timeIntervalSince1970 * 1000) - p.clientTimeMs)
        case let .goodbye(g):
            let err = HaneError.from(g.error)
            if !g.reconnect {
                // 被踢、被封禁、会话被替换：不再重连
                closedByUser = true
                generation += 1
                for t in tasks { t.cancel() }
                tasks = []
                failPending(err)
                conn?.close()
                conn = nil
                status = .failed(err)
            }
        default:
            break
        }
    }

    // MARK: 请求

    /// 发送请求并等待响应（默认 10 秒超时）；失败时抛出 HaneError。
    public func request(_ body: Openhane_V1_Request.OneOf_Body, timeout: Double = 10) async throws -> Openhane_V1_Response {
        guard let c = conn, status == .connected else { throw HaneError.connectionLost }
        let id = nextID
        nextID &+= 1
        let req = Openhane_V1_Envelope.with { $0.request = .with { $0.id = id; $0.body = body } }
        return try await withTimeout(seconds: timeout, onTimeout: { [weak self] in self?.pending[id] = nil }) { [self] in
            try await withCheckedThrowingContinuation { cont in
                pending[id] = cont
                Task {
                    do { try await c.send(req) } catch {
                        if let cont = self.pending.removeValue(forKey: id) { cont.resume(throwing: HaneError.connectionLost) }
                    }
                }
            }
        }
    }

    /// 获取当前房间的新媒体令牌（媒体需要重连而令牌已过期时调用）。
    @discardableResult
    public func refreshMedia() async throws -> MediaTarget? {
        let room = state.media?.roomID ?? "main"
        let r = try await request(.joinRoom(.with { $0.roomID = room }))
        if case let .joinRoom(j) = r.body, let address { state.apply(join: j, mediaURL: address.mediaURL) }
        return state.media
    }

    public func updateSelf(micMuted: Bool? = nil, deafened: Bool? = nil, handRaised: Bool? = nil, nickname: String? = nil) async throws {
        _ = try await request(.updateSelf(.with {
            if let micMuted { $0.micMuted = micMuted }
            if let deafened { $0.deafened = deafened }
            if let handRaised { $0.handRaised = handRaised }
            if let nickname { $0.nickname = nickname }
        }))
    }

    public func sendChat(_ text: String) async throws {
        let room = state.media?.roomID ?? "main"
        let r = try await request(.sendChat(.with {
            $0.roomID = room
            $0.text = text
            $0.clientMsgID = UUID().uuidString
        }))
        if case let .sendChat(s) = r.body { state.mergeChat(room: room, [s.message]) }
    }

    /// 加载 beforeID 之前的一页聊天（0 表示最新一页）。
    public func loadChatHistory(room: String, before beforeID: Int64 = 0) async throws {
        let r = try await request(.getChatHistory(.with {
            $0.roomID = room
            $0.beforeID = beforeID
            $0.limit = 50
        }))
        guard case let .getChatHistory(h) = r.body else { return }
        state.mergeChat(room: room, h.messages)
        if beforeID != 0 || state.chatHasMore[room] == nil { state.chatHasMore[room] = h.hasMore_p }
    }

    public func redeemToken(_ token: String) async throws -> Role {
        let r = try await request(.redeemToken(.with { $0.token = token }))
        if case let .redeemToken(t) = r.body { return t.role }
        throw HaneError.protocolViolation("unexpected response")
    }

    public func getSettings() async throws -> [String: String] {
        let r = try await request(.getSettings(.init()))
        if case let .getSettings(s) = r.body { return s.values }
        return [:]
    }

    @discardableResult
    public func updateSettings(_ patch: [String: String]) async throws -> [String: String] {
        let r = try await request(.updateSettings(.with { $0.patch = patch }))
        if case let .updateSettings(s) = r.body { return s.values }
        return [:]
    }

    /// 申请屏幕共享许可（获得后 SFU 才允许发布屏幕轨道）；重复申请会更新意图并沿用同一个许可。
    /// 共享连接的媒体令牌：屏幕共享单独走一条媒体连接（<房间 ID>~share），自己要共享、或者房间里有人在共享时请求。
    /// url 为空时与主连接同一地址
    public func joinShareMedia(transport: Openhane_V1_ShareTransport = .unspecified) async throws -> Openhane_V1_MediaGrant {
        let r = try await request(.joinShareMedia(.with { $0.transport = transport }))
        guard case let .joinShareMedia(g) = r.body else { throw HaneError.protocolViolation("unexpected response") }
        return g
    }

    public func requestScreenShare(intent: Openhane_V1_ShareIntent, withAudio: Bool) async throws -> Openhane_V1_ScreenShareGrant {
        let r = try await request(.requestScreenShare(.with {
            $0.intent = intent
            $0.withAudio = withAudio
        }))
        guard case let .requestScreenShare(g) = r.body else { throw HaneError.protocolViolation("unexpected response") }
        return g
    }

    public func releaseScreenShare(grantID: String) async throws {
        _ = try await request(.releaseScreenShare(.with { $0.grantID = grantID }))
    }

    public func createToken(role: Role, maxUses: UInt32) async throws -> (token: String, info: Openhane_V1_TokenInfo) {
        let r = try await request(.createToken(.with {
            $0.role = role
            $0.maxUses = maxUses
        }))
        guard case let .createToken(t) = r.body else { throw HaneError.protocolViolation("unexpected response") }
        return (t.token, t.info)
    }

    public func listTokens() async throws -> [Openhane_V1_TokenInfo] {
        let r = try await request(.listTokens(.init()))
        if case let .listTokens(l) = r.body { return l.tokens }
        return []
    }

    public func revokeToken(id: String) async throws {
        _ = try await request(.revokeToken(.with { $0.id = id }))
    }
}

/// 在时限内完成 operation，否则抛出 HaneError.timeout。
func withTimeout<T: Sendable>(seconds: Double, onTimeout: (@MainActor @Sendable () -> Void)? = nil,
                              _ operation: @escaping @MainActor @Sendable () async throws -> T) async throws -> T
{
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            await onTimeout?()
            throw HaneError.timeout
        }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

// MARK: - 房间、主持操作、管理

/// 创建 / 修改房间的选项（nil 表示不修改）
public struct RoomOptions: Sendable {
    public var name: String?
    /// 空字符串表示取消密码
    public var password: String?
    public var locked: Bool?
    public var capacity: UInt32?
    public var overrides: Openhane_V1_RoomOverrides?
    public var emptyTimeoutSec: UInt32?
    public init(name: String? = nil, password: String? = nil, locked: Bool? = nil, capacity: UInt32? = nil,
                overrides: Openhane_V1_RoomOverrides? = nil, emptyTimeoutSec: UInt32? = nil)
    {
        self.name = name
        self.password = password
        self.locked = locked
        self.capacity = capacity
        self.overrides = overrides
        self.emptyTimeoutSec = emptyTimeoutSec
    }
}

extension ServerSession {
    fileprivate func applyJoin(_ j: Openhane_V1_JoinRoomResult) {
        if let address { state.apply(join: j, mediaURL: address.mediaURL) }
    }
}

public extension ServerSession {
    /// 进入或切换房间（有密码的房间需要密码，主持人以上免密）
    func joinRoom(_ roomID: String, password: String = "") async throws {
        let r = try await request(.joinRoom(.with {
            $0.roomID = roomID
            $0.password = password
        }))
        if case let .joinRoom(j) = r.body { applyJoin(j) }
    }

    @discardableResult
    func createRoom(name: String, options o: RoomOptions = RoomOptions(), join: Bool) async throws -> Openhane_V1_Room {
        let r = try await request(.createRoom(.with {
            $0.name = name
            $0.password = o.password ?? ""
            $0.locked = o.locked ?? false
            $0.capacity = o.capacity ?? 0
            if let ov = o.overrides { $0.overrides = ov }
            if let t = o.emptyTimeoutSec { $0.emptyTimeoutSec = t }
            $0.join = join
        }))
        guard case let .createRoom(c) = r.body else { throw HaneError.protocolViolation("unexpected response") }
        if c.hasJoined { applyJoin(c.joined) }
        return c.room
    }

    func updateRoom(_ roomID: String, _ o: RoomOptions) async throws {
        _ = try await request(.updateRoom(.with {
            $0.roomID = roomID
            if let v = o.name { $0.name = v }
            if let v = o.password { $0.password = v }
            if let v = o.locked { $0.locked = v }
            if let v = o.capacity { $0.capacity = v }
            if let v = o.overrides { $0.overrides = v }
            if let v = o.emptyTimeoutSec { $0.emptyTimeoutSec = v }
        }))
    }

    func closeRoom(_ roomID: String) async throws {
        _ = try await request(.closeRoom(.with { $0.roomID = roomID }))
    }

    func moveParticipant(_ sessionID: String, to roomID: String) async throws {
        _ = try await request(.moveParticipant(.with {
            $0.sessionID = sessionID
            $0.roomID = roomID
        }))
    }

    @discardableResult
    func recallAll() async throws -> UInt32 {
        let r = try await request(.recallAll(.init()))
        if case let .recallAll(x) = r.body { return x.moved }
        return 0
    }

    func moderate(_ sessionID: String, _ action: Openhane_V1_ModerationAction, reason: String = "", durationSec: UInt32 = 0, banIP: Bool = false) async throws {
        _ = try await request(.moderate(.with {
            $0.sessionID = sessionID
            $0.action = action
            $0.reason = reason
            $0.durationSec = durationSec
            $0.banIp = banIP
        }))
    }

    @discardableResult
    func muteAll(_ roomID: String) async throws -> UInt32 {
        let r = try await request(.muteAll(.with { $0.roomID = roomID }))
        if case let .muteAll(x) = r.body { return x.muted }
        return 0
    }

    // 管理员

    func listIdentities(role: Role = .unspecified, limit: UInt32 = 200) async throws -> (identities: [Openhane_V1_Identity], total: UInt32) {
        let r = try await request(.listIdentities(.with {
            $0.role = role
            $0.limit = limit
        }))
        if case let .listIdentities(x) = r.body { return (x.identities, x.total) }
        return ([], 0)
    }

    func setRole(uid: String, role: Role) async throws {
        _ = try await request(.setRole(.with {
            $0.uid = uid
            $0.role = role
        }))
    }

    /// 在线会话的 IP、归属地和往返延迟
    func sessionInfo(_ sessionID: String) async throws -> Openhane_V1_GetSessionInfoResult {
        let r = try await request(.getSessionInfo(.with { $0.sessionID = sessionID }))
        if case let .getSessionInfo(x) = r.body { return x }
        return .init()
    }

    /// 让服务器下载 IPv6 归属地库（约 37 MB），完成后才返回
    func downloadIPv6GeoDB() async throws {
        _ = try await request(.downloadIpv6GeoDb(.init()), timeout: 600)
    }

    func listBans() async throws -> [Openhane_V1_BanInfo] {
        let r = try await request(.listBans(.init()))
        if case let .listBans(x) = r.body { return x.bans }
        return []
    }

    func addBan(uid: String = "", ipCIDR: String = "", durationSec: UInt32, reason: String) async throws {
        _ = try await request(.addBan(.with {
            $0.uid = uid
            $0.ipCidr = ipCIDR
            $0.durationSec = durationSec
            $0.reason = reason
        }))
    }

    func removeBan(id: Int64) async throws {
        _ = try await request(.removeBan(.with { $0.id = id }))
    }

    func auditLog(before: Int64 = 0, actionPrefix: String = "", limit: UInt32 = 100) async throws -> (entries: [Openhane_V1_AuditEntry], hasMore: Bool) {
        let r = try await request(.getAuditLog(.with {
            $0.beforeID = before
            $0.actionPrefix = actionPrefix
            $0.limit = limit
        }))
        if case let .getAuditLog(x) = r.body { return (x.entries, x.hasMore_p) }
        return ([], false)
    }

    func createInvite(maxUses: UInt32, expiresInSec: UInt32, bypassPassword: Bool, role: Role) async throws -> Openhane_V1_InviteInfo {
        let r = try await request(.createInvite(.with {
            $0.maxUses = maxUses
            $0.expiresInSec = expiresInSec
            $0.bypassPassword = bypassPassword
            $0.role = role
        }))
        guard case let .createInvite(x) = r.body else { throw HaneError.protocolViolation("unexpected response") }
        return x.invite
    }

    func listInvites() async throws -> [Openhane_V1_InviteInfo] {
        let r = try await request(.listInvites(.init()))
        if case let .listInvites(x) = r.body { return x.invites }
        return []
    }

    func revokeInvite(_ code: String) async throws {
        _ = try await request(.revokeInvite(.with { $0.code = code }))
    }

    /// 邀请码的网页链接（发给对方即可进入）
    func inviteLink(_ code: String) -> String {
        guard let a = address else { return code }
        return "\(a.secure ? "https" : "http")://\(a.hostPort)/j/\(code)"
    }
}

