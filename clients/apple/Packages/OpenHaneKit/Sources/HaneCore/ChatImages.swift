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
    /// 发送的图片长边不超过这么多像素（聊天里看足够清楚）
    public static let uploadMaxSide = 2048
    /// 压缩的目标大小：超过时降低质量或尺寸再试（图片传输给语音和视频让路，小一些发得快）
    public static let targetBytes = 1 << 20
    /// 没有节奏控制时一块的大小；每一块（一次请求）的时限
    static let chunkUnpaced = 1 << 20
    static let chunkTimeout: TimeInterval = 60

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
    /// 上传聊天图片（PNG 或 JPEG），返回图片 ID，随后用 sendChat 发出。
    /// 端到端加密房间里先加密再上传（要传入宽高，放进加密的正文里）；调用方应先把图片重新编码、去掉元数据
    public func uploadChatImage(_ data: Data, png: Bool, width: Int = 0, height: Int = 0) async throws -> String {
        let room = state.media?.roomID ?? "main"
        guard let address, !apiToken.isEmpty, ChatImages.isRoomID(room) else { throw ChatImageError.failed }
        var upload = data
        var key: Openhane_V1_EncryptedImageKey?
        if state.rooms[room]?.e2Ee == true {
            guard let w = UInt32(exactly: width), let h = UInt32(exactly: height), ChatImages.validSize(w, h),
                  let sealed = try? E2EECrypto.sealChatImage(data)
            else { throw ChatImageError.unsupported }
            upload = sealed.file
            key = .with {
                $0.key = sealed.key
                $0.digest = sealed.digest
                $0.mime = png ? "image/png" : "image/jpeg"
                $0.width = w
                $0.height = h
            }
        }
        // 分块上传（开始 → 按顺序上传每一块 → 完成），会议中按媒体的状况控制速度
        let session = ChatImages.session(trust: trust, hostPort: address.hostPort, timeout: ChatImages.chunkTimeout)
        defer { session.invalidateAndCancel() }
        let base = "\(address.httpBase)/api/v1/chat/images/uploads"
        struct Reply: Decodable {
            var id: String?
            var upload: String?
            var error: String?
        }
        func call(_ url: String, method: String, body: Data? = nil) async throws -> Reply {
            guard let u = URL(string: url) else { throw ChatImageError.failed }
            var req = URLRequest(url: u)
            req.httpMethod = method
            req.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
            if let body {
                req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                req.httpBody = body
            }
            let (data, status): (Data, Int)
            do {
                (data, status) = try await ServerProbe.readLimited(req, session, limit: 4096, requireOK: false)
            } catch {
                throw ChatImageError.failed
            }
            let reply = (try? JSONDecoder().decode(Reply.self, from: data)) ?? Reply()
            guard (200 ... 299).contains(status) else {
                if status == 413 { throw ChatImageError.tooLarge }
                throw ChatImageError(rawValue: reply.error ?? "") ?? .failed
            }
            return reply
        }
        guard let uploadID = try await call("\(base)?room=\(room)&size=\(upload.count)", method: "POST").upload, ChatImages.isImageID(uploadID)
        else { throw ChatImageError.failed }
        var offset = 0
        while offset < upload.count {
            let n = min(transferPacer?.chunkBytes(.up) ?? ChatImages.chunkUnpaced, upload.count - offset)
            try await transferPacer?.wait(.up, bytes: n)
            let chunk = upload.subdata(in: offset ..< offset + n)
            let url = "\(base)/\(uploadID)?offset=\(offset)"
            // 网络出错时同一块重试一次（服务端会直接确认重复的块）
            do { _ = try await call(url, method: "PUT", body: chunk) } catch ChatImageError.failed { _ = try await call(url, method: "PUT", body: chunk) }
            offset += n
        }
        guard let id = try await call("\(base)/\(uploadID)/finish", method: "POST").id, ChatImages.isImageID(id) else { throw ChatImageError.failed }
        if let key { rememberImageKey(id, key) }
        return id
    }

    /// 读取聊天图片：大小有上限，文件头必须是 PNG / JPEG
    public func loadChatImage(room: String, id: String) async throws -> Data {
        guard let address, !apiToken.isEmpty, ChatImages.isRoomID(room), ChatImages.isImageID(id),
              let url = URL(string: "\(address.httpBase)/api/v1/chat/images/\(room)/\(id)")
        else { throw URLError(.badURL) }
        let session = ChatImages.session(trust: trust, hostPort: address.hostPort, timeout: ChatImages.chunkTimeout)
        defer { session.invalidateAndCancel() }
        var data = try await downloadRanged(url, session: session)
        // 加密的图片：核对摘要后解密，解密后的内容照样只按 PNG / JPEG 接受（发送者也不可信）
        if let k = imageKeys[id] { data = try E2EECrypto.openChatImage(data, key: k.key, digest: k.digest) }
        guard ChatImages.sniff(data) != nil else { throw URLError(.cannotDecodeContentData) }
        return data
    }

    /// 分段下载（Range），每段之前按节奏等待；总大小超过上限时报错
    private func downloadRanged(_ url: URL, session: URLSession) async throws -> Data {
        var out = Data()
        var total = Int.max
        while out.count < total {
            let n = transferPacer?.chunkBytes(.down) ?? ChatImages.chunkUnpaced
            try await transferPacer?.wait(.down, bytes: n)
            var req = URLRequest(url: url)
            req.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
            req.setValue("bytes=\(out.count)-\(out.count + n - 1)", forHTTPHeaderField: "Range")
            let (part, http) = try await ServerProbe.readLimitedResponse(req, session, limit: max(n, ChatImages.fetchMaxBytes))
            // 服务端不支持分段：整个返回
            if http.statusCode == 200, out.isEmpty { return part }
            guard http.statusCode == 206, let range = http.value(forHTTPHeaderField: "Content-Range"),
                  let m = range.wholeMatch(of: /bytes (\d+)-(\d+)\/(\d+)/), Int(m.1) == out.count, let size = Int(m.3),
                  size <= ChatImages.fetchMaxBytes, !part.isEmpty, part.count <= n
            else { throw URLError(.badServerResponse) }
            total = size
            out.append(part)
        }
        return out
    }
}
