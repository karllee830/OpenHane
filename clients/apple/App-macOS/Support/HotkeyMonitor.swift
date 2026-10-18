import AppKit
import CoreGraphics

/// 按键说话的热键：任意键盘按键、单独的修饰键或鼠标侧键。
struct HotkeyBinding: Codable, Equatable {
    enum Kind: String, Codable { case key, modifier, mouse }
    var kind: Kind
    /// 键码（key / modifier）或鼠标按键编号（mouse，2 起为侧键）
    var code: Int
    var label: String

    static let defaultBinding = HotkeyBinding(kind: .key, code: 50, label: "`") // kVK_ANSI_Grave
}

/// 全局按键监听（CGEventTap，只监听不拦截）。需要「输入监控」权限；窗口不在前台时也有效。
/// 事件源挂在主线程的 RunLoop 上，回调都在主线程执行。
final class HotkeyMonitor: @unchecked Sendable {
    var binding: HotkeyBinding?
    var onChange: ((Bool) -> Void)?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var pressed = false

    static var hasPermission: Bool { CGPreflightListenEventAccess() }
    @discardableResult static func requestPermission() -> Bool { CGRequestListenEventAccess() }

    /// 开始监听；没有权限时返回 false（系统会提示用户授权）
    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        guard Self.hasPermission else {
            Self.requestPermission()
            return false
        }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .otherMouseDown, .otherMouseUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            if let refcon {
                Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
            }
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                          eventsOfInterest: mask, callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque())
        else { return false }
        self.tap = tap
        source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        set(false)
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard let b = binding else { return }
        switch (b.kind, type) {
        case (.key, .keyDown), (.key, .keyUp):
            if Int(event.getIntegerValueField(.keyboardEventKeycode)) == b.code {
                if type == .keyDown, event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
                set(type == .keyDown)
            }
        case (.modifier, .flagsChanged):
            if Int(event.getIntegerValueField(.keyboardEventKeycode)) == b.code { set(!pressed) }
        case (.mouse, .otherMouseDown), (.mouse, .otherMouseUp):
            if Int(event.getIntegerValueField(.mouseEventButtonNumber)) == b.code { set(type == .otherMouseDown) }
        default:
            break
        }
    }

    private func set(_ p: Bool) {
        guard p != pressed else { return }
        pressed = p
        onChange?(p) // 已在主线程（事件源在主 RunLoop 上）
    }

    /// 从 NSEvent 生成绑定（设置界面录入热键）
    static func binding(from e: NSEvent) -> HotkeyBinding? {
        switch e.type {
        case .keyDown:
            let label = e.charactersIgnoringModifiers.flatMap { $0.isEmpty || $0 == " " ? nil : $0.uppercased() } ?? (e.keyCode == 49 ? "Space" : "Key \(e.keyCode)")
            return HotkeyBinding(kind: .key, code: Int(e.keyCode), label: label)
        case .flagsChanged:
            let names: [UInt16: String] = [56: "Left ⇧", 60: "Right ⇧", 59: "Left ⌃", 62: "Right ⌃", 58: "Left ⌥", 61: "Right ⌥", 55: "Left ⌘", 54: "Right ⌘", 63: "fn"]
            guard let n = names[e.keyCode] else { return nil }
            return HotkeyBinding(kind: .modifier, code: Int(e.keyCode), label: n)
        case .otherMouseDown:
            return HotkeyBinding(kind: .mouse, code: e.buttonNumber, label: "Mouse \(e.buttonNumber + 1)")
        default:
            return nil
        }
    }
}
