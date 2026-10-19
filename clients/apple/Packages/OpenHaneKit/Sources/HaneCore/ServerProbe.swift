import Foundation

/// 服务器列表里一台服务器的状态：延迟和在线人数（GET /api/v1/info）
public struct ServerStatus: Equatable, Sendable {
    /// 往返延迟（毫秒）；nil 表示连不上
    public var latencyMs: Int?
    /// 在线人数；旧版本服务器不提供
    public var online: Int?

    public init(latencyMs: Int?, online: Int? = nil) {
        self.latencyMs = latencyMs
        self.online = online
    }

    public static let unreachable = ServerStatus(latencyMs: nil)

    /// 信号格数（1–4）；0 表示连不上
    public var bars: Int {
        guard let ms = latencyMs else { return 0 }
        return ms < 60 ? 4 : ms < 120 ? 3 : ms < 250 ? 2 : 1
    }
}

public enum ServerProbe {
    static let timeout: TimeInterval = 4

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
            let online = try await fetch(url, session)
            let ms = (ContinuousClock.now - start).components
            return ServerStatus(latencyMs: max(1, Int(ms.seconds * 1000 + ms.attoseconds / 1_000_000_000_000_000)), online: online)
        } catch {
            return nil
        }
    }

    private struct Info: Decodable { var online: Int? }

    private static func fetch(_ url: URL, _ session: URLSession) async throws -> Int? {
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(Info.self, from: data).online
    }
}

/// 探测时的证书校验：只接受 CA 签发的有效证书或已记住的自签名证书
private final class ProbeTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    let trust: TrustStore
    let hostPort: String

    init(trust: TrustStore, hostPort: String) {
        self.trust = trust
        self.hostPort = hostPort
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
