#if os(iOS)
import HaneCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// iOS 的聊天输入框。SwiftUI 的 TextField 只能粘贴文字，这里用 UITextView 接管「粘贴」：
/// 剪贴板里有图片时，长按菜单（和外接键盘的 ⌘V）粘贴的是图片，交给 onImage。
/// 最多显示 5 行，超过后在框内滚动；换行键发送。
struct ChatInputField: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let onSubmit: () -> Void
    /// 收到粘贴的图片；nil 表示现在不接受图片（服务器不允许或正在发送）
    let onImage: ((Data) -> Void)?

    private static let maxLines: CGFloat = 5

    func makeUIView(context: Context) -> ChatTextView {
        let v = ChatTextView()
        v.delegate = context.coordinator
        v.font = .preferredFont(forTextStyle: .body)
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.returnKeyType = .send
        v.isScrollEnabled = false
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.placeholder.text = placeholder
        v.accessibilityLabel = placeholder
        if let path = DevHooks.environment["HANE_SNAPSHOT_PASTE"] {
            // 自动检查：把图片放进测试剪贴板后模拟粘贴（不动用户的剪贴板）
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                ChatTextView.pasteboard.setData(FileManager.default.contents(atPath: path) ?? Data(), forPasteboardType: UTType.png.identifier)
                if v.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil) { v.paste(nil) }
            }
        }
        return v
    }

    func updateUIView(_ v: ChatTextView, context: Context) {
        context.coordinator.parent = self
        if v.text != text { v.text = text }
        v.placeholder.isHidden = !text.isEmpty
        v.onImage = onImage
        if focused, !v.isFirstResponder {
            DispatchQueue.main.async { v.becomeFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: ChatTextView, context _: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maxHeight = ceil((v.font?.lineHeight ?? 20) * Self.maxLines)
        let scroll = fit > maxHeight
        if v.isScrollEnabled != scroll { DispatchQueue.main.async { v.isScrollEnabled = scroll } }
        return CGSize(width: width, height: min(fit, maxHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatInputField

        init(_ parent: ChatInputField) { self.parent = parent }

        func textViewDidChange(_ v: UITextView) {
            parent.text = v.text
            (v as? ChatTextView)?.placeholder.isHidden = !v.text.isEmpty
        }

        func textView(_: UITextView, shouldChangeTextIn _: NSRange, replacementText t: String) -> Bool {
            guard t == "\n" else { return true }
            parent.onSubmit()
            return false
        }

        func textViewDidBeginEditing(_: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_: UITextView) { if parent.focused { parent.focused = false } }
    }
}

final class ChatTextView: UITextView {
    var onImage: ((Data) -> Void)?
    let placeholder = UILabel()

    /// 自动检查（HANE_SNAPSHOT_PASTE）用单独的剪贴板
    static var pasteboard: UIPasteboard {
        DevHooks.environment["HANE_SNAPSHOT_PASTE"] != nil ? UIPasteboard(name: UIPasteboard.Name("com.0http.openhane.test-paste"), create: true)! : .general
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.isAccessibilityElement = false
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholder.topAnchor.constraint(equalTo: topAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    /// 剪贴板里只有图片时，系统默认不提供「粘贴」：能接受图片时打开
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onImage != nil, Self.pasteboard.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if let onImage, Self.pasteboard.hasImages, let data = Self.pastedImage() {
            onImage(data)
            return
        }
        super.paste(sender)
    }

    /// 剪贴板里的图片：优先取原始数据（PNG / JPEG / HEIC），没有时把 UIImage 编码成 PNG
    private static func pastedImage() -> Data? {
        let pb = pasteboard
        for type in [UTType.png, .jpeg, .heic] {
            if let d = pb.data(forPasteboardType: type.identifier) { return d }
        }
        return pb.image?.pngData()
    }
}
#endif
