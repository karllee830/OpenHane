import Foundation

/// 上传聊天图片失败的原因（服务端返回的 error 字段；其他情况都是 failed）
public enum ChatImageError: String, Error, Sendable {
    case tooLarge = "too_large"
    case unsupported
    case rateLimited = "rate_limited"
    case storageFull = "storage_full"
    case disabled
    case forbidden
    case failed
}

/// 聊天图片：上传到 POST /api/v1/chat/images，读取 GET /api/v1/chat/images/<房间>/<图片>，都带会话凭据。
/// 服务端返回的内容一律不信任：限制读取的字节数、不跟随重定向，检查 ID 格式、尺寸和文件头。
public enum ChatImages {
    /// 图片的最大边长（服务端保存的不超过 4096，留余量）
    public static let maxSide = 8192
    /// 读取一张图片最多多少字节
    public static let fetchMaxBytes = 64 << 20
    /// 上传的图片长边不超过这么多像素
    public static let uploadMaxSide = 4096

    public static func isImageID(_ s: String) -> Bool {
        s.count == 26 && s.unicodeScalars.allSatisfy { ("0" ... "9").contains($0) || ("a" ... "z").contains($0) }
    }

    public static func isRoomID(_ s: String) -> Bool {
        (1 ... 32).contains(s.count) && s.unicodeScalars.allSatisfy { ("0" ... "9").contains($0) || ("a" ... "z").contains($0) || $0 == "_" }
    }

    /// 宽高都在 1–maxSide 之间
    public static func validSize(_ w: UInt32, _ h: UInt32) -> Bool {
        (1 ... UInt32(maxSide)).contains(w) && (1 ... UInt32(maxSide)).contains(h)
    }

    public enum Kind: Sendable { case png, jpeg }

    /// 看文件头判断是不是 PNG 或 JPEG（不解码）；PNG 还检查宽高。不合格时返回 nil
    public static func sniff(_ data: Data) -> Kind? {
        if ServerProbe.isSafePNG(data, maxSide: maxSide) { return .png }
        let b = [UInt8](data.prefix(3))
        return b == [0xFF, 0xD8, 0xFF] ? .jpeg : nil
    }

    static func session(trust: TrustStore, hostPort: String, timeout: TimeInterval) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: ProbeTrust(trust: trust, hostPort: hostPort), delegateQueue: nil)
    }
}

extension ServerSession {
    /// 上传聊天图片（PNG 或 JPEG），返回图片 ID，随后用 sendChat 发出
    public func uploadChatImage(_ data: Data, png: Bool) async throws -> String {
        let room = state.media?.roomID ?? "main"
        guard let address, !apiToken.isEmpty, ChatImages.isRoomID(room),
              let url = URL(string: "\(address.httpBase)/api/v1/chat/images?room=\(room)")
        else { throw ChatImageError.failed }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        req.setValue(png ? "image/png" : "image/jpeg", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        let session = ChatImages.session(trust: trust, hostPort: address.hostPort, timeout: 180)
        defer { session.invalidateAndCancel() }
        let (body, status): (Data, Int)
        do {
            (body, status) = try await ServerProbe.readLimited(req, session, limit: 4096, requireOK: false)
        } catch {
            throw ChatImageError.failed
        }
        struct Reply: Decodable {
            var id: String?
            var error: String?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: body)
        guard status == 200 else {
            if status == 413 { throw ChatImageError.tooLarge }
            throw ChatImageError(rawValue: reply?.error ?? "") ?? .failed
        }
        guard let id = reply?.id, ChatImages.isImageID(id) else { throw ChatImageError.failed }
        return id
    }

    /// 读取聊天图片：大小有上限，文件头必须是 PNG / JPEG
    public func loadChatImage(room: String, id: String) async throws -> Data {
        guard let address, !apiToken.isEmpty, ChatImages.isRoomID(room), ChatImages.isImageID(id),
              let url = URL(string: "\(address.httpBase)/api/v1/chat/images/\(room)/\(id)")
        else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        let session = ChatImages.session(trust: trust, hostPort: address.hostPort, timeout: 60)
        defer { session.invalidateAndCancel() }
        let data = try await ServerProbe.readLimited(req, session, limit: ChatImages.fetchMaxBytes).data
        guard ChatImages.sniff(data) != nil else { throw URLError(.cannotDecodeContentData) }
        return data
    }
}
