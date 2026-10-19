import Foundation

public typealias Participant = Openhane_V1_Participant
public typealias Room = Openhane_V1_Room
public typealias ChatMessage = Openhane_V1_ChatMessage
public typealias ServerInfo = Openhane_V1_ServerInfo
public typealias MediaPolicy = Openhane_V1_MediaPolicy
public typealias Role = Openhane_V1_Role

public enum ConnectionStatus: Equatable, Sendable {
    case idle
    case connecting
    case connected
    /// 断线后自动重连中（会话在服务端保留 60 秒）
    case reconnecting(attempt: Int)
    case failed(HaneError)
}

public struct SelfInfo: Equatable, Sendable {
    public var sessionID: String
    public var uid: String
    public var nickname: String
    public var role: Role
}

/// 当前房间的媒体连接参数。令牌每次更新 version 加一。
public struct MediaTarget: Equatable, Sendable {
    public var roomID: String
    public var url: URL
    public var token: String
    public var policy: MediaPolicy
    public var version: Int
}

/// 一个服务器连接的全部界面状态。只由 reduce 函数根据协议消息更新（单向数据流）。
public struct SessionState: Equatable, Sendable {
    public static let chatKeep = 500

    public var serverInfo = ServerInfo()
    public var me: SelfInfo?
    public var rooms: [String: Room] = [:]
    public var participants: [String: Participant] = [:]
    public var chat: [String: [ChatMessage]] = [:]
    public var chatHasMore: [String: Bool] = [:]
    public var media: MediaTarget?

    public init() {}

    /// 应用 Welcome（完整快照）。恢复会话时保留已加载的聊天。
    public mutating func apply(welcome w: Openhane_V1_Welcome, mediaURL: URL) {
        let keepChat = w.resumed
        serverInfo = w.snapshot.info.withCleanName()
        rooms = Dictionary(w.snapshot.rooms.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        participants = Dictionary(w.snapshot.participants.map { ($0.sessionID, $0) }, uniquingKeysWith: { $1 })
        me = SelfInfo(sessionID: w.sessionID, uid: w.uid, nickname: w.nickname, role: w.role)
        if !keepChat {
            chat = [:]
            chatHasMore = [:]
        }
        apply(join: w.autoJoin, mediaURL: mediaURL)
    }

    public mutating func apply(join r: Openhane_V1_JoinRoomResult, mediaURL: URL) {
        let url = r.media.url.isEmpty ? mediaURL : (URL(string: r.media.url) ?? mediaURL)
        media = MediaTarget(roomID: r.roomID, url: url, token: r.media.token,
                            policy: r.hasPolicy ? r.policy : (media?.policy ?? MediaPolicy()),
                            version: (media?.version ?? 0) + 1)
    }

    public mutating func apply(event ev: Openhane_V1_Event) {
        switch ev.body {
        case let .participantJoined(e): upsert(e.participant)
        case let .participantUpdated(e): upsert(e.participant)
        case let .participantLeft(e): participants[e.sessionID] = nil
        case let .roomCreated(e): rooms[e.room.id] = e.room
        case let .roomUpdated(e): rooms[e.room.id] = e.room
        case let .roomClosed(e): rooms[e.roomID] = nil
        case let .chatMessage(m): mergeChat(room: m.roomID, [m])
        case let .roleChanged(e):
            if me?.uid == e.uid { me?.role = e.role }
        case let .policyUpdated(e):
            if media?.roomID == e.roomID { media?.policy = e.policy }
        case let .shareStateChanged(e): rooms[e.roomID]?.shares = e.shares
        case let .serverInfoUpdated(e): serverInfo = e.info.withCleanName()
        // 被移动时的媒体切换由 ServerSession 处理（需要服务器地址）；处置提示和密钥包不改变共享状态
        case .youWereMoved, .moderationNotice, .keyPackage, .serverNotice, .none: break
        }
    }

    private mutating func upsert(_ p: Participant) {
        participants[p.sessionID] = p
        if p.sessionID == me?.sessionID {
            me?.nickname = p.nickname
            me?.role = p.role
        }
    }

    /// 按 id 合并聊天消息（去重、升序、截断）
    public mutating func mergeChat(room: String, _ incoming: [ChatMessage]) {
        var byID = Dictionary((chat[room] ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for m in incoming { byID[m.id] = m }
        var all = byID.values.sorted { $0.id < $1.id }
        if all.count > Self.chatKeep { all.removeFirst(all.count - Self.chatKeep) }
        chat[room] = all
    }

    /// 当前房间的成员（按昵称排序）
    public func members(of room: String) -> [Participant] {
        participants.values.filter { $0.roomID == room }.sorted { $0.nickname.localizedStandardCompare($1.nickname) == .orderedAscending }
    }

    public var selfParticipant: Participant? { me.flatMap { participants[$0.sessionID] } }
}
