import HaneCore
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// 发送前在本地压缩：按 EXIF 方向转正，长边缩到 2048 以内，重新编码成 PNG / JPEG（顺带去掉拍摄位置等元数据）
enum ChatImagePrep {
    /// 截图和带透明的图（PNG、GIF 等非照片）先试 PNG（文字清楚），太大就改用 JPEG；照片用 JPEG，逐步降低质量和尺寸，
    /// 直到不超过目标大小（ChatImages.targetBytes）。都超过目标时取不超过 maxBytes 的最小的一个。返回的宽高是转正后的
    static func prepare(_ data: Data, maxBytes: Int) throws -> (data: Data, png: Bool, width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?, let utType = UTType(type), utType.conforms(to: .image),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0
        else { throw ChatImageError.unsupported }
        let photo = utType.conforms(to: .jpeg) || utType.conforms(to: .heic) || utType.conforms(to: .heif)
        let side = ChatImages.uploadMaxSide
        let attempts: [(png: Bool, side: Int, quality: Double)] = (photo ? [] : [(true, side, 1)])
            + [(false, side, 0.85), (false, side, 0.75), (false, side * 7 / 10, 0.75), (false, side / 2, 0.7)]
        let target = min(maxBytes, ChatImages.targetBytes)
        var best: (data: Data, png: Bool, width: Int, height: Int)?
        for a in attempts {
            guard let image = thumbnail(source, maxPixel: min(a.side, max(w, h))) else { throw ChatImageError.unsupported }
            guard let out = encode(image, png: a.png, quality: a.quality) else { continue }
            if out.count <= target { return (out, a.png, image.width, image.height) }
            if out.count <= maxBytes, out.count < best?.data.count ?? .max { best = (out, a.png, image.width, image.height) }
        }
        if let best { return best }
        throw ChatImageError.tooLarge
    }

    /// 解码并缩到 maxPixel 以内，按 EXIF 方向转正
    static func thumbnail(_ source: CGImageSource, maxPixel: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }

    static func encode(_ image: CGImage, png: Bool, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, (png ? UTType.png : UTType.jpeg).identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, png ? nil : [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}

/// 解码服务器给的聊天图片：先检查文件头，只按 PNG / JPEG 解码（不让系统自动识别其他格式），缩到 maxPixel 以内
func decodeChatImage(_ data: Data, maxPixel: Int) -> CGImage? {
    guard let kind = ChatImages.sniff(data) else { return nil }
    let hint = (kind == .png ? UTType.png : UTType.jpeg).identifier
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceTypeIdentifierHint: hint, kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetType(source) as String? == hint
    else { return nil }
    return ChatImagePrep.thumbnail(source, maxPixel: maxPixel)
}

/// 已下载的聊天图片（房间/图片 → 数据），只保留最近的一些
@MainActor
final class ChatImageCache {
    static let shared = ChatImageCache()
    private var data: [String: Data] = [:]
    private var order: [String] = []
    private var loading: [String: Task<Data?, Never>] = [:]
    private let keep = 60

    func load(_ session: ServerSession, room: String, id: String) async -> Data? {
        let key = "\(room)/\(id)"
        if let d = data[key] { return d }
        if let t = loading[key] { return await t.value }
        let t = Task { try? await session.loadChatImage(room: room, id: id) }
        loading[key] = t
        let d = await t.value
        loading[key] = nil
        if let d {
            data[key] = d
            order.append(key)
            if order.count > keep { data[order.removeFirst()] = nil }
        }
        return d
    }
}

/// 消息里图片的显示尺寸：按原图比例放进 maxW × maxH，服务端给的宽高不合格时按正方形
func chatImageDisplaySize(_ image: ChatImage, maxW: CGFloat, maxH: CGFloat) -> CGSize {
    guard ChatImages.validSize(image.width, image.height) else { return CGSize(width: min(maxW, maxH), height: min(maxW, maxH)) }
    let w = CGFloat(image.width), h = CGFloat(image.height)
    let scale = min(1, maxW / w, maxH / h)
    return CGSize(width: max(24, (w * scale).rounded()), height: max(24, (h * scale).rounded()))
}

/// 消息里的图片：按原图比例占好位置再加载，点击看大图
struct ChatMessageImage: View {
    @Environment(AppModel.self) private var model
    let room: String
    let image: ChatImage
    @State private var data: Data?
    @State private var thumb: CGImage?
    @State private var failed = false
    @State private var viewing = false

    var body: some View {
        let size = chatImageDisplaySize(image, maxW: 220, maxH: 240)
        Group {
            if let thumb {
                Button { viewing = true } label: {
                    Image(decorative: thumb, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFill()
                        .frame(width: size.width, height: size.height)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("查看大图")
                .accessibilityLabel("图片")
            } else if failed {
                VStack(spacing: 4) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text("图片无法显示").font(.caption)
                }
                .foregroundStyle(.secondary)
                .frame(width: max(size.width, 120), height: min(max(size.height, 72), 120))
            } else {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: size.width, height: size.height)
                    .overlay(ProgressView().controlSize(.small))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
        .task(id: image.id) {
            guard let d = await ChatImageCache.shared.load(model.session, room: room, id: image.id) else {
                failed = true
                return
            }
            // 列表里只解码成缩略图，看大图时再解码原图
            if let t = decodeChatImage(d, maxPixel: 720) {
                data = d
                thumb = t
            } else {
                failed = true
            }
        }
        #if os(macOS)
        .sheet(isPresented: $viewing) {
            if let data { ChatImageViewer(data: data, id: image.id) }
        }
        #else
        .fullScreenCover(isPresented: $viewing) {
            if let data { ChatImageViewer(data: data, id: image.id) }
        }
        #endif
    }
}

/// 大图：适应窗口显示，可以保存
struct ChatImageViewer: View {
    let data: Data
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var image: CGImage?

    var body: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            content
                .frame(minWidth: 480, idealWidth: 900, maxWidth: .infinity, minHeight: 320, idealHeight: 640, maxHeight: .infinity)
            Divider()
            HStack {
                Button("存储…", action: save)
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .task { image = decodeChatImage(data, maxPixel: ChatImages.maxSide) }
        #else
        NavigationStack {
            content
                .background(Color.black)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("完成") { dismiss() }
                    }
                    if let image {
                        ToolbarItem(placement: .primaryAction) {
                            ShareLink(item: Image(decorative: image, scale: 1), preview: SharePreview("图片", image: Image(decorative: image, scale: 1)))
                        }
                    }
                }
                .toolbarBackground(.visible, for: .navigationBar)
        }
        .task { image = decodeChatImage(data, maxPixel: ChatImages.maxSide) }
        #endif
    }

    private var content: some View {
        ZStack {
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .padding(8)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    #if os(macOS)
    private func save() {
        let png = ChatImages.sniff(data) == .png
        let panel = NSSavePanel()
        panel.allowedContentTypes = [png ? .png : .jpeg]
        panel.nameFieldStringValue = "openhane-\(id.prefix(8)).\(png ? "png" : "jpg")"
        if panel.runModal() == .OK, let url = panel.url {
            try? data.write(to: url, options: .atomic)
        }
    }
    #endif
}

extension ChatImageError {
    /// 显示给用户的说明
    func describe(maxBytes: Int) -> String {
        switch self {
        case .tooLarge: String(localized: "图片太大（上限 \(max(1, maxBytes >> 20)) MB）")
        case .unsupported: String(localized: "不支持这种图片格式")
        case .rateLimited: String(localized: "图片发得太快了，请稍后再试")
        case .storageFull: String(localized: "服务器的图片存储空间已满，请联系管理员")
        case .disabled: String(localized: "这台服务器不允许发送图片")
        case .forbidden: String(localized: "不能在这个房间发送图片")
        case .failed: String(localized: "图片上传失败")
        }
    }
}
