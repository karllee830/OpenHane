import HaneCore
#if os(iOS)
import PhotosUI
#endif
import SwiftUI
import UniformTypeIdentifiers

/// 房间聊天。同一个人五分钟内连续发的消息合在一起，只显示一次头像和名字。
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var error: String?
    /// 待发送的图片（发送前预览）
    @State private var pending: PendingImage?
    @State private var busy = false
    @State private var dropTargeted = false
    #if os(macOS)
    @FocusState private var inputFocused: Bool
    @State private var picking = false
    #else
    @State private var inputFocused = false
    @State private var photoItem: PhotosPickerItem?
    #endif

    private struct PendingImage {
        var data: Data
        var png: Bool
        var width: Int
        var height: Int
        var preview: CGImage
    }

    /// 连续消息合并显示的时间窗口
    private static let groupWindowMs: Int64 = 5 * 60 * 1000

    private var canSend: Bool { !busy && (pending != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }

    /// 服务器允许的图片大小上限；0 表示不允许发送图片
    private var imageMaxBytes: Int { min(Int(model.session.state.serverInfo.chatImageMaxBytes), 50 << 20) }

    var body: some View {
        let state = model.session.state
        let room = state.media?.roomID ?? "main"
        let messages = state.chat[room] ?? []
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if state.chatHasMore[room] == true {
                            Button("加载更早的消息") {
                                Task { try? await model.session.loadOlderChat(room: room) }
                            }
                            #if os(macOS)
                            .buttonStyle(.link)
                            #endif
                            .font(.callout)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 10)
                        }
                        if messages.isEmpty {
                            emptyState
                        }
                        ForEach(Array(messages.enumerated()), id: \.element.id) { i, m in
                            let grouped = i > 0 && messages[i - 1].senderUid == m.senderUid && m.createdAtMs - messages[i - 1].createdAtMs < Self.groupWindowMs
                            MessageRow(m: m, room: room, showHeader: !grouped, isMe: m.senderUid == state.me?.uid)
                                .padding(.top, grouped ? 3 : 14)
                                .id(m.id)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            Divider()
            composer
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.background.opacity(0.9)))
                    .overlay(Label("松开以添加图片", systemImage: "photo.badge.plus").foregroundStyle(.tint))
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: imageMaxBytes > 0 ? $dropTargeted : .constant(false)) { providers in
            guard imageMaxBytes > 0, let p = providers.first else { return false }
            loadDropped(p)
            return true
        }
        // 换房间（或房间的加密状态变了）时丢掉没发出去的图片
        .onChange(of: room) { pending = nil }
        .onChange(of: state.rooms[room]?.e2Ee) { pending = nil }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 30))
                .foregroundStyle(.tertiary)
            Text("还没有消息")
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text("在这里发送的消息，房间里的人都能看到。")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.horizontal, 12)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let pending {
                ZStack(alignment: .topTrailing) {
                    Image(decorative: pending.preview, scale: 1)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 140, maxHeight: 90)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
                        .overlay { if busy { ProgressView().controlSize(.small) } }
                        .padding([.top, .trailing], 6)
                    Button { self.pending = nil } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.black.opacity(0.6))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .help("移除图片")
                    .accessibilityLabel("移除图片")
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                if imageMaxBytes > 0 { attachButton }
                inputField
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.primary.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.35)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .help("发送")
                .accessibilityLabel("发送")
                .padding(.bottom, 1)
            }
        }
        .padding(10)
        .animation(.easeOut(duration: 0.15), value: canSend)
        #if os(macOS)
        .background(PasteImageCatcher(enabled: inputFocused && imageMaxBytes > 0 && !busy) { attach($0) })
        #endif
    }

    @ViewBuilder private var inputField: some View {
        #if os(macOS)
        TextField("发送消息…", text: $text, axis: .vertical)
            .focused($inputFocused)
            .lineLimit(1 ... 5)
            .textFieldStyle(.plain)
            .onSubmit(send)
        #else
        ChatInputField(text: $text, focused: $inputFocused, placeholder: L("发送消息…"), onSubmit: send,
                       onImage: imageMaxBytes > 0 && !busy ? { attach($0) } : nil)
        #endif
    }

    @ViewBuilder private var attachButton: some View {
        let label = Image(systemName: "photo.badge.plus")
            .font(.system(size: 16))
            .foregroundStyle(.secondary)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
        #if os(macOS)
        Button { picking = true } label: { label }
            .buttonStyle(.plain)
            .disabled(busy)
            .help("发送图片")
            .accessibilityLabel("发送图片")
            .padding(.bottom, 1)
            .fileImporter(isPresented: $picking, allowedContentTypes: [.image]) { result in
                guard case let .success(url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { attach(data) }
            }
        #else
        PhotosPicker(selection: $photoItem, matching: .images) { label }
            .disabled(busy)
            .accessibilityLabel("发送图片")
            .padding(.bottom, 1)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                photoItem = nil
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) { attach(data) }
                }
            }
        #endif
    }

    /// 拖进来的图片：Finder 里的文件，或其他应用里拖出的图片数据
    private func loadDropped(_ p: NSItemProvider) {
        if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                guard let url, let data = try? Data(contentsOf: url) else { return }
                Task { @MainActor in attach(data) }
            }
        } else {
            p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                guard let data else { return }
                Task { @MainActor in attach(data) }
            }
        }
    }

    /// 选好图片后先在后台压缩、转换格式，再放进待发送的预览
    private func attach(_ data: Data) {
        let max = imageMaxBytes
        guard max > 0, !busy else { return }
        error = nil
        busy = true
        Task {
            let result = await Task.detached(priority: .userInitiated) { () -> Result<PendingImage, ChatImageError> in
                do {
                    let (out, png, w, h) = try ChatImagePrep.prepare(data, maxBytes: max)
                    guard let preview = decodeChatImage(out, maxPixel: 400) else { return .failure(.unsupported) }
                    return .success(PendingImage(data: out, png: png, width: w, height: h, preview: preview))
                } catch {
                    return .failure(error as? ChatImageError ?? .unsupported)
                }
            }.value
            busy = false
            switch result {
            case let .success(p):
                pending = p
                inputFocused = true
            case let .failure(e):
                error = e.describe(maxBytes: max)
            }
        }
    }

    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let image = pending
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                let id = if let image {
                    try await model.session.uploadChatImage(image.data, png: image.png, width: image.width, height: image.height)
                } else { "" }
                try await model.session.sendChat(body, imageID: id)
                if text.trimmingCharacters(in: .whitespacesAndNewlines) == body { text = "" }
                pending = nil
            } catch let e as HaneError {
                error = describe(e)
            } catch let e as ChatImageError {
                error = e.describe(maxBytes: imageMaxBytes)
            } catch {}
        }
    }
}

#if os(macOS)
/// 输入框有焦点时，⌘V 粘贴的如果是图片（截图、复制的图片或 Finder 里复制的图片文件），交给 onImage，不粘贴成文字
private struct PasteImageCatcher: NSViewRepresentable {
    let enabled: Bool
    let onImage: (Data) -> Void

    func makeNSView(context _: Context) -> PasteImageCatcherView {
        let v = PasteImageCatcherView()
        v.enabled = enabled
        v.onImage = onImage
        return v
    }

    func updateNSView(_ view: PasteImageCatcherView, context _: Context) {
        view.enabled = enabled
        view.onImage = onImage
    }
}

final class PasteImageCatcherView: NSView {
    var enabled = false
    var onImage: ((Data) -> Void)?
    private var monitor: Any?

    override func hitTest(_: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.enabled, event.window === self.window,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "v",
                  let data = Self.pastedImage()
            else { return event }
            self.onImage?(data)
            return nil
        }
    }

    /// 自动检查（HANE_SNAPSHOT_PASTE）用单独的剪贴板，不动用户的剪贴板
    static let testPasteboard = NSPasteboard.Name("com.0http.openhane.test-paste")

    private static func pastedImage() -> Data? {
        let pb = DevHooks.environment["HANE_SNAPSHOT_PASTE"] != nil ? NSPasteboard(name: testPasteboard) : .general
        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            if let d = pb.data(forType: type) { return d }
        }
        let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true,
                                                                      .urlReadingContentsConformToTypes: [UTType.image.identifier]]) as? [URL]
        return urls?.first.flatMap { try? Data(contentsOf: $0) }
    }
}
#endif

/// 一条消息：第一条带头像、名字和时间，后面连续的几条只有内容
private struct MessageRow: View {
    let m: ChatMessage
    let room: String
    let showHeader: Bool
    let isMe: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if showHeader {
                AvatarView(name: m.senderName, uid: m.senderUid, size: 30)
            } else {
                Color.clear.frame(width: 30, height: 1)
            }
            VStack(alignment: .leading, spacing: 3) {
                if showHeader {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(m.senderName)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(isMe ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
                            .lineLimit(1)
                        Text(Date(timeIntervalSince1970: Double(m.createdAtMs) / 1000), style: .time)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize()
                    }
                }
                if m.hasImage {
                    ChatMessageImage(room: room, image: m.image)
                        .padding(.vertical, 2)
                }
                if !m.text.isEmpty {
                    Text(m.text)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
