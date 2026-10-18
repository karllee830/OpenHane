import Foundation

/// 最近连接的服务器（连接页）：地址、服务器名称、上次连接时间、是否需要服务器密码。
/// 与 Web 客户端 ui/src/recent.ts 的行为一致。
public struct RecentServer: Codable, Hashable, Sendable, Identifiable {
    /// 连接时填写的地址（去掉了邀请码）
    public var address: String
    /// 服务器名称；旧版本保存的记录可能没有
    public var name: String
    /// 上次连接成功的时间；旧记录没有
    public var lastUsed: Date?
    /// 服务器设置了密码：再次连接时直接显示密码框
    public var needsPassword: Bool

    public var id: String { address }

    public init(address: String, name: String = "", lastUsed: Date? = nil, needsPassword: Bool = false) {
        self.address = address
        self.name = name
        self.lastUsed = lastUsed
        self.needsPassword = needsPassword
    }
}

public enum RecentServers {
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

    /// 连接成功后记下这台服务器（放到最前面，同一台服务器只留一条）
    public static func remember(_ entry: RecentServer, in list: [RecentServer]) -> [RecentServer] {
        var e = entry
        e.address = withoutInvite(entry.address)
        return Array(([e] + list.filter { !sameServer($0.address, e.address) }).prefix(limit))
    }

    /// 与地址对应的记录
    public static func find(_ address: String, in list: [RecentServer]) -> RecentServer? {
        guard !address.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return list.first { sameServer($0.address, address) }
    }

    /// 从 UserDefaults 读取；旧版本只保存了地址列表（键 recent）
    public static func load(_ defaults: UserDefaults, key: String = "recentServers", legacyKey: String = "recent") -> [RecentServer] {
        if let data = defaults.data(forKey: key), let list = try? JSONDecoder().decode([RecentServer].self, from: data) {
            return Array(list.filter { !$0.address.isEmpty }.prefix(limit))
        }
        return (defaults.stringArray(forKey: legacyKey) ?? []).filter { !$0.isEmpty }.prefix(limit).map { RecentServer(address: $0) }
    }

    public static func save(_ list: [RecentServer], to defaults: UserDefaults, key: String = "recentServers") {
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
    }
}
