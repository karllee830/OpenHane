import Foundation

/// 服务器列表（主页）里的一台服务器：最近连接过的和收藏的。记录地址、服务器名称、上次连接时间、是否需要服务器密码，
/// 以及用户自己加的备注和在这台服务器上用的昵称。与 Web 客户端 ui/src/recent.ts 的行为一致。
public struct RecentServer: Codable, Hashable, Sendable, Identifiable {
    /// 连接时填写的地址（去掉了邀请码）
    public var address: String
    /// 服务器名称；旧版本保存的记录可能没有
    public var name: String
    /// 上次连接成功的时间；旧记录没有
    public var lastUsed: Date?
    /// 服务器设置了密码：再次连接时直接显示密码框
    public var needsPassword: Bool
    /// 收藏：一直留在列表里，不受最近连接条数的限制
    public var favorite: Bool
    /// 用户加的备注，列表里代替服务器名称显示
    public var note: String
    /// 在这台服务器上用的昵称；为空时用默认昵称
    public var nickname: String

    public var id: String { address }

    /// 列表里显示的名称：备注 → 服务器名称 → 地址
    public var title: String {
        let n = note.trimmingCharacters(in: .whitespaces)
        return !n.isEmpty ? n : !name.isEmpty ? name : address
    }

    public init(address: String, name: String = "", lastUsed: Date? = nil, needsPassword: Bool = false,
                favorite: Bool = false, note: String = "", nickname: String = "")
    {
        self.address = address
        self.name = name
        self.lastUsed = lastUsed
        self.needsPassword = needsPassword
        self.favorite = favorite
        self.note = note
        self.nickname = nickname
    }

    private enum CodingKeys: String, CodingKey { case address, name, lastUsed, needsPassword, favorite, note, nickname }

    /// 旧版本保存的记录没有收藏、备注和昵称
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        address = try c.decode(String.self, forKey: .address)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        lastUsed = try c.decodeIfPresent(Date.self, forKey: .lastUsed)
        needsPassword = try c.decodeIfPresent(Bool.self, forKey: .needsPassword) ?? false
        favorite = try c.decodeIfPresent(Bool.self, forKey: .favorite) ?? false
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        nickname = try c.decodeIfPresent(String.self, forKey: .nickname) ?? ""
    }
}

public enum RecentServers {
    /// 没有收藏的服务器最多保留几条
    public static let limit = 5

    /// 同一台服务器的不同写法（meet.example.com 与 meet.example.com:9800）视为同一条
    public static func sameServer(_ a: String, _ b: String) -> Bool {
        key(a) == key(b)
    }

    private static func key(_ s: String) -> String {
        guard let a = try? ServerAddress.parse(s) else { return s.trimmingCharacters(in: .whitespaces).lowercased() }
        return "\(a.secure ? "s" : "p"):\(a.hostPort.lowercased())"
    }

    /// 去掉地址中的邀请码（https://host/j/<码>）：邀请码可能已用完或过期，不应在下次连接时再带上
    public static func withoutInvite(_ address: String) -> String {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let a = try? ServerAddress.parse(trimmed), a.invite != nil else { return trimmed }
        return (a.secure ? "" : "http://") + a.hostPort
    }

    /// 收藏的全部保留，其余的只留最近 limit 条（最新的在前）
    static func trim(_ list: [RecentServer]) -> [RecentServer] {
        var others = 0
        return list.filter { r in
            if r.favorite { return true }
            others += 1
            return others <= limit
        }
    }

    /// 连接成功后记下这台服务器（放到最前面，同一台服务器只留一条）；保留原来的收藏和备注
    public static func remember(_ entry: RecentServer, in list: [RecentServer]) -> [RecentServer] {
        var e = entry
        e.address = withoutInvite(entry.address)
        if let prev = find(e.address, in: list) {
            e.favorite = e.favorite || prev.favorite
            if e.note.isEmpty { e.note = prev.note }
        }
        return trim([e] + list.filter { !sameServer($0.address, e.address) })
    }

    /// 修改一条记录（收藏、备注、昵称）；位置不变
    public static func update(_ address: String, in list: [RecentServer], _ change: (inout RecentServer) -> Void) -> [RecentServer] {
        trim(list.map { r in
            guard r.address == address else { return r }
            var r = r
            change(&r)
            return r
        })
    }

    /// 与地址对应的记录
    public static func find(_ address: String, in list: [RecentServer]) -> RecentServer? {
        guard !address.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return list.first { sameServer($0.address, address) }
    }

    /// 地址栏兼作搜索框：按备注、服务器名称、地址、昵称匹配（不区分大小写）
    public static func matches(_ r: RecentServer, _ query: String, defaultNickname: String = "") -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return true }
        return [r.note, r.name, r.address, r.nickname.isEmpty ? defaultNickname : r.nickname].contains { $0.localizedCaseInsensitiveContains(q) }
    }

    /// 看起来是一个完整的地址（带点、冒号、斜杠，或 localhost），而不是搜索词
    public static func looksLikeAddress(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        return t.contains { ".:/".contains($0) } || t.lowercased() == "localhost"
    }

    /// 在地址栏按回车（或点「连接」）时要连的服务器：正好是列表里的某一台就连它；
    /// 输入的是完整地址就连这个地址；否则当作搜索词，连第一台匹配的服务器（matches 已按列表顺序过滤）
    public static func connectTarget(in list: [RecentServer], matches: [RecentServer], text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespaces)
        if let r = find(t, in: list) { return r.address }
        return looksLikeAddress(t) ? t : matches.first?.address ?? t
    }

    /// 从 UserDefaults 读取；旧版本只保存了地址列表（键 recent）
    public static func load(_ defaults: UserDefaults, key: String = "recentServers", legacyKey: String = "recent") -> [RecentServer] {
        if let data = defaults.data(forKey: key), let list = try? JSONDecoder().decode([RecentServer].self, from: data) {
            return trim(list.filter { !$0.address.isEmpty })
        }
        return (defaults.stringArray(forKey: legacyKey) ?? []).filter { !$0.isEmpty }.prefix(limit).map { RecentServer(address: $0) }
    }

    public static func save(_ list: [RecentServer], to defaults: UserDefaults, key: String = "recentServers") {
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
    }
}
