import Foundation

/// 服务器列表里一台服务器的状态：延迟和在线人数（GET /api/v1/info）
public struct ServerStatus: Equatable, Sendable {
    /// 往返延迟（毫秒）；nil 表示连不上
    public var latencyMs: Int?
    /// 在线人数；旧版本服务器不提供
    public var online: Int?
    /// 服务器图标的地址（服务器设置了图标时；地址里带上摘要，换了图标地址就变）
    public var logo: URL?

    public init(latencyMs: Int?, online: Int? = nil, logo: URL? = nil) {
        self.latencyMs = latencyMs
        self.online = online
        self.logo = logo
    }

    public static let unreachable = ServerStatus(latencyMs: nil)

    /// 信号格数（1–4）；0 表示连不上
    public var bars: Int {
        guard let ms = latencyMs else { return 0 }
        return ms < 60 ? 4 : ms < 120 ? 3 : ms < 250 ? 2 : 1
    }
}

/// 服务端返回的内容一律不信任：限制读取的字节数、不跟随重定向，图标只接受文件头合格的 PNG。
public enum ServerProbe {
    static let timeout: TimeInterval = 4
    /// info 的大小上限（正常只有一两百字节）
    static let infoMaxBytes = 64 << 10
    /// 图标的大小上限，以及允许的最大边长（服务端给的是 512 以内的 PNG）
    public static let logoMaxBytes = 1 << 20
    public static let logoMaxSide = 1024

    /// 测一台服务器。地址里没写端口时与连接时一样同时尝试几个候选端口，用最先响应的
    public static func probe(_ address: String, trust: TrustStore) async -> ServerStatus {
        guard let target = try? ServerAddress.parse(address) else { return .unreachable }
        return await withTaskGroup(of: ServerStatus?.self) { group in
            for a in target.candidates {
                group.addTask { await probe(a, trust: trust) }
            }
            for await r in group {
                if let r {
                    group.cancelAll()
                    return r
                }
            }
            return .unreachable
        }
    }

    /// 测一个具体的端口：第一次请求要建立 TCP / TLS 连接，延迟取复用连接的第二次请求
    private static func probe(_ a: ServerAddress, trust: TrustStore) async -> ServerStatus? {
        guard let url = URL(string: "\(a.secure ? "https" : "http")://\(a.hostPort)/api/v1/info") else { return nil }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config, delegate: ProbeTrust(trust: trust, hostPort: a.hostPort), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            _ = try await fetch(url, session)
            let start = ContinuousClock.now
            let info = try await fetch(url, session)
            let ms = (ContinuousClock.now - start).components
            let logo = logoURL(info.logo, relativeTo: url)
            return ServerStatus(latencyMs: max(1, Int(ms.seconds * 1000 + ms.attoseconds / 1_000_000_000_000_000)), online: info.online, logo: logo)
        } catch {
            return nil
        }
    }

    private struct Info: Decodable {
        var online: Int?
        var logo: String?
    }

    private static func fetch(_ url: URL, _ session: URLSession) async throws -> Info {
        try await JSONDecoder().decode(Info.self, from: readLimited(url, session, limit: infoMaxBytes))
    }

    /// 读响应体，最多 limit 字节：超了立即停止并报错（恶意服务端可以一直发数据）
    static func readLimited(_ url: URL, _ session: URLSession, limit: Int) async throws -> Data {
        let (bytes, response) = try await session.bytes(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        if http.expectedContentLength > limit { throw URLError(.dataLengthExceedsMaximum) }
        var data = Data()
        data.reserveCapacity(min(limit, max(0, Int(http.expectedContentLength))))
        for try await byte in bytes {
            if data.count >= limit { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return data
    }

    /// info 里的 logo 字段换成图标地址：必须是十六进制摘要，否则当作没有图标
    static func logoURL(_ hash: String?, relativeTo url: URL) -> URL? {
        guard let hash, (8 ... 64).contains(hash.count), hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        return URL(string: "logo?v=\(hash)", relativeTo: url)?.absoluteURL
    }

    /// 是不是 PNG，且宽高在 1–maxSide 之间（只看文件头，不解码）
    public static func isSafePNG(_ data: Data, maxSide: Int = logoMaxSide) -> Bool {
        let b = [UInt8](data.prefix(24))
        guard b.count == 24, b[0 ..< 8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], b[12 ..< 16] == [0x49, 0x48, 0x44, 0x52] else { return false }
        let w = b[16 ..< 20].reduce(0) { $0 << 8 | Int($1) }
        let h = b[20 ..< 24].reduce(0) { $0 << 8 | Int($1) }
        return (1 ... maxSide).contains(w) && (1 ... maxSide).contains(h)
    }

    /// 下载服务器图标（ServerStatus.logo）；证书规则与探测相同。不超过 1 MB、文件头合格的 PNG 才返回
    public static func logo(_ url: URL, trust: TrustStore) async -> Data? {
        guard let host = url.host() else { return nil }
        let port = url.port ?? (url.scheme == "https" ? 443 : 80)
        let hostPort = host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        let session = URLSession(configuration: config, delegate: ProbeTrust(trust: trust, hostPort: hostPort), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        guard let data = try? await readLimited(url, session, limit: logoMaxBytes), isSafePNG(data) else { return nil }
        return data
    }
}

/// 探测时的证书校验：只接受 CA 签发的有效证书或已记住的自签名证书
private final class ProbeTrust: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let trust: TrustStore
    let hostPort: String

    init(trust: TrustStore, hostPort: String) {
        self.trust = trust
        self.hostPort = hostPort
    }

    /// 不跟随重定向：服务端不能把请求转到别的地址
    func urlSession(_: URLSession, task _: URLSessionTask, willPerformHTTPRedirection _: HTTPURLResponse,
                    newRequest _: URLRequest, completionHandler: @escaping (URLRequest?) -> Void)
    {
        completionHandler(nil)
    }

    func urlSession(_: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if trust.isTrusted(serverTrust, hostPort: hostPort) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
