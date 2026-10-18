// 屏幕共享编码器选择—— 与 Web 版 clients/web/packages/media/src/share/codec.ts 的 chooseShareCodec 一致：
// 发送端能编码的集合 ∩ 房间可解码集合，按固定顺序取第一个。

public enum CodecPolicy: Sendable { case auto, compat }
public enum ShareIntentName: String, Sendable, CaseIterable {
    case smart, clarity, smoothness, custom
}

public struct EncodeCaps: Sendable {
    /// 能编码的编码器；hardware 表示能效高（基本等同于硬件编码）
    public var codecs: [(codec: ShareCodec, hardware: Bool)]
    public init(codecs: [(codec: ShareCodec, hardware: Bool)]) {
        self.codecs = codecs
    }
}

public struct CodecChoice: Equatable, Sendable {
    public var codec: ShareCodec
    /// 备用编码器（LiveKit backup codec：只有出现无法解码主编码器的观众时才额外编码）
    public var backup: ShareCodec?
    public init(codec: ShareCodec, backup: ShareCodec?) {
        self.codec = codec
        self.backup = backup
    }
}

/// 自定义里可以选的编码器：本机能硬件编码的 AV1 / H.265 / H.264（加密房间没有 AV1；服务器设为只用 H.264 时不能选）
public func selectableShareCodecs(caps: EncodeCaps, policy: CodecPolicy, e2ee: Bool) -> [ShareCodec] {
    guard policy == .auto else { return [] }
    return [ShareCodec.av1, .h265, .h264].filter { c in caps.codecs.contains { $0.codec == c && $0.hardware } && !(e2ee && c == .av1) }
}

/// AV1 和 H.265 只用硬件编码；软件编码只允许 H.264 兜底（VP8 / VP9 不用于发送）。
/// 返回 nil 表示本机连 H.264 都不能编码，无法共享（苹果平台不会出现）。
/// prefer：自定义里用户指定的编码器。本机能硬件编码时直接用，不看房间可解码集合（解不了的观众看备用的 H.264）；不满足时按自动选。
public func chooseShareCodec(caps: EncodeCaps, roomDecodable: [String], policy: CodecPolicy, e2ee: Bool,
                             prefer: ShareCodec? = nil) -> CodecChoice?
{
    func has(_ c: ShareCodec, _ hw: Bool? = nil) -> Bool {
        caps.codecs.contains { $0.codec == c && (hw == nil || $0.hardware == hw) }
    }
    if let prefer, selectableShareCodecs(caps: caps, policy: policy, e2ee: e2ee).contains(prefer) {
        return CodecChoice(codec: prefer, backup: prefer != .h264 && has(.h264) ? .h264 : nil)
    }
    func can(_ c: ShareCodec, _ hw: Bool) -> Bool {
        has(c, hw) && roomDecodable.contains("video/\(c.rawValue)")
            && !(e2ee && c == .av1) // S9：LiveKit 的帧加密不支持 AV1
    }
    let prefs: [ShareCodec] = policy == .compat ? [.h264] : [.av1, .h265, .h264]
    guard let pick = prefs.first(where: { can($0, true) }) else {
        // 没有全房间都能解码的硬件编码器：用 H.264（硬件优先，没有就软件）。个别解不了 H.264 的观众看不到这一路
        return has(.h264) ? CodecChoice(codec: .h264, backup: nil) : nil
    }
    return CodecChoice(codec: pick, backup: pick != .h264 && has(.h264) ? .h264 : nil)
}

/// 自定义共享选编码器时的提示：同一房间里（不含自己）不能硬件解码某个编码器的人的昵称。
/// 没有上报解码能力的旧版本客户端不计入。解不了 AV1 / H.265 的人会看备用的 H.264 画面；解不了 H.264 的人看不到画面
public struct DecodeGap: Equatable, Sendable {
    public var unsupported: [String] = []
    public var softwareOnly: [String] = []
    public var isEmpty: Bool { unsupported.isEmpty && softwareOnly.isEmpty }
    public init(unsupported: [String] = [], softwareOnly: [String] = []) {
        self.unsupported = unsupported
        self.softwareOnly = softwareOnly
    }
}

public func decodeGap(codec: ShareCodec, others: [Openhane_V1_Participant]) -> DecodeGap {
    let mime = "video/\(codec.rawValue)"
    var g = DecodeGap()
    for p in others where !(p.decodeHardware.isEmpty && p.decodeSoftware.isEmpty) {
        if p.decodeSoftware.contains(mime) {
            g.softwareOnly.append(p.nickname)
        } else if !p.decodeHardware.contains(mime) {
            g.unsupported.append(p.nickname)
        }
    }
    return g
}
