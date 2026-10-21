import Foundation

/// 服务器地址。暂不支持 SRV 记录查询。
public struct ServerAddress: Hashable, Sendable {
    public static let defaultPort = 9800
    /// 地址里没写端口（也没写协议）时依次尝试的端口，排在前面的优先
    public static let fallbackPorts = [defaultPort, 443]

    public var host: String // IPv6 不带方括号
    public var port: Int
    public var invite: String?
    /// 只有显式写 http:// / ws:// 时为 false（本机开发、反向代理之后）
    public var secure: Bool
    /// 没写协议也没写端口：连接时同时尝试 fallbackPorts，port 只是第一个候选
    public var portImplicit: Bool

    public init(host: String, port: Int, invite: String? = nil, secure: Bool = true, portImplicit: Bool = false) {
        self.host = host
        self.port = port
        self.invite = invite
        self.secure = secure
        self.portImplicit = portImplicit
    }

    public enum ParseError: Error, Equatable { case empty, invalid, unsupportedScheme(String) }

    public static func parse(_ input: String) throws -> ServerAddress {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw ParseError.empty }
        if let r = s.range(of: "://") {
            let scheme = s[..<r.lowerBound].lowercased()
            guard ["https", "http", "wss", "ws", "openhane"].contains(scheme) else { throw ParseError.unsupportedScheme(scheme) }
            let secure = scheme != "http" && scheme != "ws"
            guard let comps = URLComponents(string: (scheme == "openhane" ? "https" : scheme) + "://" + s[r.upperBound...]),
                  var host = comps.host, !host.isEmpty
            else { throw ParseError.invalid }
            if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
            var invite: String?
            let path = comps.path
            if path.hasPrefix("/j/") { invite = String(path.dropFirst(3)).split(separator: "/").first.map(String.init) }
            invite = invite ?? comps.queryItems?.first(where: { $0.name == "invite" })?.value
            let port = comps.port ?? (scheme == "openhane" ? defaultPort : secure ? 443 : 80)
            return ServerAddress(host: host, port: port, invite: invite, secure: secure)
        }
        let noPath = s.split(separator: "/", maxSplits: 1).first.map(String.init) ?? s
        var host: String
        var port = defaultPort
        var portImplicit = true
        if noPath.hasPrefix("[") {
            guard let close = noPath.firstIndex(of: "]") else { throw ParseError.invalid }
            host = String(noPath[noPath.index(after: noPath.startIndex) ..< close])
            let rest = noPath[noPath.index(after: close)...]
            if rest.hasPrefix(":") {
                guard let p = Int(rest.dropFirst()) else { throw ParseError.invalid }
                port = p
                portImplicit = false
            }
        } else if noPath.filter({ $0 == ":" }).count > 1 {
            host = noPath // 裸 IPv6
        } else {
            let parts = noPath.split(separator: ":", omittingEmptySubsequences: false)
            host = String(parts[0])
            if parts.count == 2 {
                guard let p = Int(parts[1]) else { throw ParseError.invalid }
                port = p
                portImplicit = false
            }
        }
        guard !host.isEmpty, (1 ... 65535).contains(port) else { throw ParseError.invalid }
        return ServerAddress(host: host, port: port, secure: true, portImplicit: portImplicit)
    }

    /// 连接时要尝试的地址，按优先级排列
    public var candidates: [ServerAddress] {
        guard portImplicit else { return [self] }
        return Self.fallbackPorts.map { ServerAddress(host: host, port: $0, invite: invite, secure: secure) }
    }

    public var hostPort: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }
    public var controlURL: URL { URL(string: "\(secure ? "wss" : "ws")://\(hostPort)/ws")! }
    /// HTTP 接口（聊天图片等）的地址前缀
    public var httpBase: String { "\(secure ? "https" : "http")://\(hostPort)" }
    public var mediaURL: URL { URL(string: "\(secure ? "wss" : "ws")://\(hostPort)")! }
    /// 便于展示（默认端口省略）
    public var display: String { port == Self.defaultPort ? (host.contains(":") ? "[\(host)]" : host) : hostPort }
}
