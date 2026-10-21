import CryptoKit
import Foundation
import LiveKit
import Observation
import HaneCore

/// 端到端加密的密钥管理—— 与 Web 版 packages/media/src/e2ee.ts 逐项对应：发送者密钥模型。
/// - 进入加密房间：生成密钥（索引 0）发给所有人；之后有人进来，把当前密钥发给他；
/// - 有人离开：轮换自己的密钥（索引 +1）并重新分发，约 1 秒后切换到新密钥发送；
/// - 收到别人的密钥包：解开后交给帧解密器（HKDF，与 Web 互通）；
/// - 聊天：用发送者媒体密钥派生的聊天密钥加解密（ChatCipher），收到新密钥后让 ServerSession 重试还解不开的消息。
@MainActor
@Observable
public final class E2EEKeys {
    public struct Rotation: Equatable, Sendable {
        public var startedAt: ContinuousClock.Instant
        public var switchedAt: ContinuousClock.Instant?
        public var index: Int32
    }

    public private(set) var enabled = false
    /// 安全码：8 个 emoji 的序号（SafetyEmoji.all）。所有人相同即说明大家看到的成员列表一致；计算中为 nil
    public private(set) var safetyCode: [Int]?
    /// 自己当前发送使用的密钥索引
    public private(set) var keyIndex: Int32 = 0
    /// 还没收到其密钥的成员（session id）
    public private(set) var missing: Set<String> = []
    public private(set) var lastRotation: Rotation?
    /// 各轨道的帧加密器状态（按轨道 sid；诊断和测试用：远端轨道为 .ok 即说明能解密对方的帧）
    public private(set) var tracks: [String: TrackState] = [:]

    public struct TrackState: Equatable, Sendable {
        public var identity: String
        public var remote: Bool
        public var state: E2EEState
    }

    /// 测试用：丢弃收到的密钥包（模拟拿不到密钥的成员）
    @ObservationIgnored public var dropIncoming = false

    /// 密钥环大小（LiveKit 帧加密器的默认值）
    static let keyRing: Int32 = 16
    static let switchDelay: Duration = .seconds(1)

    @ObservationIgnored let provider = BaseKeyProvider(options: KeyProviderOptions(sharedKey: false, ratchetWindowSize: 0, keyDerivationAlgorithm: .hkdf))
    @ObservationIgnored private let session: ServerSession
    @ObservationIgnored private weak var room: LiveKit.Room?
    @ObservationIgnored private var roomID = ""
    @ObservationIgnored private var selfID = ""
    @ObservationIgnored private var localIdentity = ""
    /// 最新密钥的索引（轮换后、切换前比 keyIndex 大 1）
    @ObservationIgnored private var myIndex: Int32 = 0
    @ObservationIgnored private var myKey = Data()
    @ObservationIgnored private var members: Set<String> = []
    @ObservationIgnored private var haveKeyFrom: Set<String> = []
    @ObservationIgnored private var verified: [String: Bool] = [:]
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var cancelSink: (() -> Void)?
    @ObservationIgnored private var cancelCipher: (() -> Void)?
    /// 聊天密钥：发送者 session id → 密钥索引 → 密钥（包括自己的）。离开的人的也留着，已收到的历史消息还要用
    @ObservationIgnored private var chatKeys: [String: [UInt32: SymmetricKey]] = [:]
    @ObservationIgnored private var switchTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false
    /// 当前安全码对应的成员（safetyDigest）：成员没变就不重新计算
    @ObservationIgnored private var safetyInput = Data()

    init(session: ServerSession) {
        self.session = session
    }

    /// 进入加密房间（媒体连接建立之后、发布轨道之前调用）：设置并分发自己的密钥
    /// 同一把密钥同时配给共享连接的身份（主连接身份 + #s）
    private func setKey(_ key: Data, _ identity: String, _ index: Int32) {
        provider.setKey(keyData: key, participantId: identity, index: index)
        provider.setKey(keyData: key, participantId: identity + MediaSession.shareSuffix, index: index)
    }

    func start(room: LiveKit.Room, roomID: String, localIdentity: String) async {
        self.room = room
        self.roomID = roomID
        self.localIdentity = localIdentity
        selfID = session.state.me?.sessionID ?? ""
        keyIndex = 0
        myIndex = 0
        myKey = E2EECrypto.newMediaKey()
        setKey(myKey, localIdentity, 0)
        await room.e2eeManager?.setLocalKeyIndex(0)
        chatKeys[selfID, default: [:]][0] = E2EECrypto.chatKey(mediaKey: myKey)
        members = currentMembers()
        enabled = true
        cancelCipher = session.setChatCipher(self)
        // 进入房间前（媒体连接建立期间）到达的密钥包由控制连接暂存，这里一并取出
        cancelSink = session.setKeyPackageSink(room: roomID) { [weak self] k in self?.onKeyPackage(k) }
        eventsTask = Task { [weak self] in
            guard let events = self?.session.events() else { return }
            for await ev in events {
                guard let self, !self.stopped else { return }
                switch ev.body {
                case .participantJoined, .participantUpdated, .participantLeft, .youWereMoved: await self.onMembersChanged()
                default: break
                }
            }
        }
        for id in members { await sendTo(id) }
        refresh()
    }

    func stop() {
        stopped = true
        eventsTask?.cancel()
        cancelSink?()
        cancelCipher?()
        switchTask?.cancel()
        enabled = false
        safetyInput = Data()
        safetyCode = nil
        missing = []
    }

    private func currentMembers() -> Set<String> {
        Set(session.state.participants.values.filter { $0.roomID == roomID && $0.sessionID != selfID }.map(\.sessionID))
    }

    private func onMembersChanged() async {
        let next = currentMembers()
        let added = next.subtracting(members)
        let removed = members.subtracting(next)
        members = next
        haveKeyFrom.subtract(removed)
        if !removed.isEmpty {
            await rotate() // 有人离开：轮换（新密钥也会发给刚进来的人）
        } else {
            for id in added { await sendTo(id) }
        }
        refresh()
    }

    /// 轮换自己的密钥：先分发新密钥，稍后再切换过去发送
    private func rotate() async {
        let index = (myIndex + 1) % Self.keyRing
        let key = E2EECrypto.newMediaKey()
        myIndex = index
        myKey = key
        chatKeys[selfID, default: [:]][UInt32(index)] = E2EECrypto.chatKey(mediaKey: key)
        let started = ContinuousClock.now
        lastRotation = Rotation(startedAt: started, switchedAt: nil, index: index)
        for id in members { await sendTo(id) }
        switchTask?.cancel()
        switchTask = Task { [weak self] in
            try? await Task.sleep(for: Self.switchDelay)
            guard let self, !Task.isCancelled, !self.stopped, self.myIndex == index else { return }
            self.setKey(key, self.localIdentity, index)
            await self.room?.e2eeManager?.setLocalKeyIndex(index)
            self.keyIndex = index
            self.lastRotation = Rotation(startedAt: started, switchedAt: .now, index: index)
        }
    }

    private func verify(_ p: HaneCore.Participant) -> Bool {
        guard p.hasE2EeKey else { return false }
        let cacheKey = p.sessionID + p.e2EeKey.publicKey.base64EncodedString()
        if let v = verified[cacheKey] { return v }
        let v = E2EECrypto.verifyKey(uid: p.uid, identityPub: p.publicKey, x25519Pub: p.e2EeKey.publicKey, signature: p.e2EeKey.signature)
        verified[cacheKey] = v
        return v
    }

    private func sendTo(_ sessionID: String) async {
        guard !stopped, let p = session.state.participants[sessionID], p.hasE2EeKey else { return }
        // 公钥签名不对（服务端或中间人塞进来的密钥）：不给它发密钥
        guard verify(p) else { return }
        let index = UInt32(myIndex)
        let aad = E2EECrypto.keyPackageAAD(room: roomID, from: selfID, to: sessionID, keyIndex: index)
        guard let sealed = try? E2EECrypto.seal(mediaKey: myKey, to: p.e2EeKey.publicKey, aad: aad) else { return }
        _ = try? await session.request(.sendKeyPackage(.with {
            $0.toSessionID = sessionID
            $0.roomID = roomID
            $0.keyIndex = index
            $0.enc = sealed.enc
            $0.ciphertext = sealed.ciphertext
        }))
    }

    private func onKeyPackage(_ k: Openhane_V1_KeyPackage) {
        guard !stopped, !dropIncoming, k.roomID == roomID, let from = session.state.participants[k.fromSessionID] else { return }
        let aad = E2EECrypto.keyPackageAAD(room: k.roomID, from: k.fromSessionID, to: selfID, keyIndex: k.keyIndex)
        guard let key = try? E2EECrypto.open(enc: k.enc, ciphertext: k.ciphertext, privateKey: session.keyExchange, aad: aad) else { return }
        setKey(key, from.mediaIdentity, Int32(k.keyIndex))
        // setKey 会改动全局的「当前索引」：恢复为自己的发送索引（数据包加密使用它）
        provider.setCurrentKeyIndex(keyIndex)
        chatKeys[k.fromSessionID, default: [:]][k.keyIndex] = E2EECrypto.chatKey(mediaKey: key)
        session.retryEncryptedChat()
        // 第一次收到对方的密钥：回发一次自己的当前密钥。对方进入房间时我们发的包可能在它开始监听之前就到了（被丢弃）
        let first = haveKeyFrom.insert(k.fromSessionID).inserted
        refresh()
        if first { Task { await self.sendTo(k.fromSessionID) } }
    }

    func noteTrackState(sid: String, identity: String, remote: Bool, state: E2EEState) {
        tracks[sid] = TrackState(identity: identity, remote: remote, state: state)
    }

    /// 更新「还没收到密钥」的成员；成员变了时在后台重新计算安全码（要算零点几秒，期间显示为计算中）
    private func refresh() {
        missing = members.subtracting(haveKeyFrom)
        let room = session.state.participants.values.filter { $0.roomID == roomID }
        let digest = E2EECrypto.safetyDigest(members: room.map { ($0.uid, $0.publicKey) })
        guard digest != safetyInput, !stopped else { return }
        safetyInput = digest
        safetyCode = nil
        Task {
            let code = await Task.detached(priority: .userInitiated) { E2EECrypto.safetyCode(digest: digest) }.value
            // 计算期间成员又变了：以后一次为准
            if digest == self.safetyInput, !self.stopped { self.safetyCode = code }
        }
    }
}

extension E2EEKeys: ChatCipher {
    public var chatRoomID: String { roomID }

    /// 用自己当前发送用的密钥（与媒体帧相同的索引）加密聊天
    public func sealChat(_ plaintext: Data) -> Openhane_V1_EncryptedChat? {
        let index = UInt32(keyIndex)
        guard !stopped, let key = chatKeys[selfID]?[index],
              let sealed = try? E2EECrypto.sealChat(plaintext, key: key, aad: E2EECrypto.chatAAD(room: roomID, from: selfID, keyIndex: index))
        else { return nil }
        return .with {
            $0.keyIndex = index
            $0.nonce = sealed.nonce
            $0.ciphertext = sealed.ciphertext
        }
    }

    public func openChat(_ m: Openhane_V1_ChatMessage) -> Data? {
        let e = m.encrypted
        guard m.hasEncrypted, let key = chatKeys[m.senderSessionID]?[e.keyIndex] else { return nil }
        return try? E2EECrypto.openChat(nonce: e.nonce, ciphertext: e.ciphertext, key: key,
                                        aad: E2EECrypto.chatAAD(room: m.roomID, from: m.senderSessionID, keyIndex: e.keyIndex))
    }
}
