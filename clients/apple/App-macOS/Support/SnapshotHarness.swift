import AppKit
import HaneCore
import HaneMedia
import SwiftUI

/// 开发与端到端检查用：HANE_AUTOCONNECT=地址|昵称 自动连接；HANE_SNAPSHOT_DIR=目录 时把主窗口渲染成 PNG 后退出；
/// HANE_SNAPSHOT_SHARE=1 时用合成画面共享屏幕；HANE_SNAPSHOT_SHEET=admin 时进入会议后打开管理面板并另存一张面板截图
/// （HANE_SNAPSHOT_ADMIN=分区 选择分区）；HANE_SNAPSHOT_CUSTOM=h265|h264 另存一张「自定义共享参数」面板的截图（选中这个编码器）；
/// HANE_SNAPSHOT_PANEL=mic|speaker 进入会议后模拟右键工具栏的麦克风 / 声音按钮，另存一张弹出面板的截图；
/// HANE_SEED_BYTE=n 让多个实例使用不同的身份；HANE_SNAPSHOT_APPEARANCE=light|dark 指定外观。
/// 应用只截取自己的窗口内容（cacheDisplay），不需要录屏权限。
@MainActor
enum SnapshotHarness {
    static func runIfRequested(_ model: AppModel) async {
        let env = DevHooks.environment
        guard let dir = env["HANE_SNAPSHOT_DIR"] else {
            if let auto = env["HANE_AUTOCONNECT"] {
                await autoconnect(model, auto)
                // HANE_SNAPSHOT_SHARE=1：用合成画面共享屏幕（另一个实例截取观看端）
                if env["HANE_SNAPSHOT_SHARE"] == "1" {
                    try? await Task.sleep(for: .seconds(2))
                    await startSyntheticShare(model)
                }
            }
            return
        }
        // HANE_SNAPSHOT_APPEARANCE=light|dark：不跟随系统外观（检查两种外观）
        if let a = env["HANE_SNAPSHOT_APPEARANCE"] { NSApp.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
        try? await Task.sleep(for: .seconds(1))
        snapshot(to: dir, name: "connect")
        if let auto = env["HANE_AUTOCONNECT"] {
            await autoconnect(model, auto)
            try? await Task.sleep(for: .seconds(3))
            if let msg = env["HANE_SNAPSHOT_CHAT"] { try? await model.session.sendChat(msg) }
            if env["HANE_SNAPSHOT_SHARE"] == "1" { await startSyntheticShare(model) }
            // HANE_SNAPSHOT_TOKEN：兑换权限令牌；HANE_SNAPSHOT_ROOM：新建一个临时房间（检查房间侧栏）
            if let token = env["HANE_SNAPSHOT_TOKEN"] { _ = try? await model.session.redeemToken(token) }
            // HANE_SNAPSHOT_INTENT=mute：执行「切换静音」快捷指令（检查 App Intents 的逻辑）
            if env["HANE_SNAPSHOT_INTENT"] == "mute" { _ = try? await ToggleMuteIntent().perform() }
            if let room = env["HANE_SNAPSHOT_ROOM"] {
                _ = try? await model.session.createRoom(name: room, options: RoomOptions(password: "pw", overrides: .with { $0.e2Ee = true }), join: false)
            }
            try? await Task.sleep(for: .seconds(Double(env["HANE_SNAPSHOT_WAIT"] ?? "1") ?? 1))
            snapshot(to: dir, name: "meeting")
            if let panel = env["HANE_SNAPSHOT_PANEL"] { await rightClickToolbar(panel == "speaker" ? 1 : 0, dir: dir, name: "panel-\(panel)") }
            if let codec = env["HANE_SNAPSHOT_CUSTOM"].flatMap(ShareCodec.init(rawValue:)) {
                model.shareCustom.codec = codec
                await snapshot(ShareCustomEditor().environment(model), to: dir, name: "custom-\(codec.rawValue)")
            }
            let shares = model.session.state.rooms.values.flatMap(\.shares).count
            let status = "session=\(model.session.status) media=\(model.media.status) participants=\(model.session.state.participants.count) shares=\(shares) sharing=\(model.media.share != nil) videoTracks=\(model.media.videoTracks.count) remoteScreen=\(model.media.videoTracks.first { $0.isScreen && !$0.isLocal }?.pixelSize.map { "\(Int($0.width))x\(Int($0.height))" } ?? "-") notice=\(model.notice ?? "") noise=\(model.media.noiseDiagnostics)"
                + e2eeStatus(model)
                + "\nmicMuted=\(model.media.micMuted)"
            try? status.write(toFile: dir + "/status.txt", atomically: true, encoding: .utf8)
        }
        NSApp.terminate(nil)
    }

    /// 端到端加密状态（互通检查用）：安全码、还没收到密钥的人数、能解密 / 解密失败的远端轨道数
    private static func e2eeStatus(_ model: AppModel) -> String {
        guard let e = model.media.e2ee else { return "\ne2ee=off" }
        let remote = e.tracks.values.filter(\.remote)
        return "\ne2ee=on\nsafetyCode=\(e.safetyCode ?? "-")\nmissing=\(e.missing.count)\nremoteOK=\(remote.filter { $0.state == .ok }.count)\ndecryptFailed=\(remote.filter { $0.state == .decryption_failed || $0.state == .missing_key }.count)\nkeyIndex=\(e.keyIndex)"
    }

    /// 合成画面代替系统选择器 + ScreenCaptureKit（自动检查无法操作系统选择器）
    private static func startSyntheticShare(_ model: AppModel) async {
        let source = SyntheticFrameSource(width: 1920, height: 1080)
        model.media.shareSourceFactory = { source }
        await model.startShare(intent: .smart, withAudio: false)
        FileHandle.standardError.write(Data("synthetic share: active=\(model.media.share != nil) notice=\(model.notice ?? "")\n".utf8))
    }

    private static func autoconnect(_ model: AppModel, _ spec: String) async {
        let parts = spec.split(separator: "|", maxSplits: 1).map(String.init)
        await model.connect(address: parts[0], password: "", nickname: parts.count == 2 ? parts[1] : nil)
    }

    /// 模拟右键工具栏里的第 index 个可右键的按钮（麦克风、声音），截下弹出的面板。
    /// 右键事件放进应用的事件队列，与真实点击走同样的路径
    private static func rightClickToolbar(_ index: Int, dir: String, name: String) async {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 400 }), let root = window.contentView?.superview else { return }
        var targets: [NSView] = []
        func walk(_ v: NSView) {
            if v is ToolbarRightClickView { targets.append(v) }
            v.subviews.forEach(walk)
        }
        walk(root)
        targets.sort { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
        guard index < targets.count else {
            FileHandle.standardError.write(Data("right-click target \(index) not found (\(targets.count) found)\n".utf8))
            return
        }
        let r = targets[index].convert(targets[index].bounds, to: nil)
        guard let event = NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: r.midX, y: r.midY), modifierFlags: [],
                                             timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                             context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        else { return }
        NSApp.postEvent(event, atStart: false)
        try? await Task.sleep(for: .seconds(1.5))
        // 弹出面板是单独的窗口
        let popovers = NSApp.windows.filter { $0.isVisible && $0 !== window && String(describing: type(of: $0)).contains("Popover") }
        FileHandle.standardError.write(Data("right-click \(index): \(popovers.count) popover(s)\n".utf8))
        guard let pw = popovers.first, let view = pw.contentView?.superview ?? pw.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    /// 单独渲染一个视图（popover 里的内容，主窗口截图里没有）：放进临时窗口后截取
    private static func snapshot(_ view: some View, to dir: String, name: String) async {
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        try? await Task.sleep(for: .seconds(1))
        window.setContentSize(host.fittingSize)
        try? await Task.sleep(for: .milliseconds(300))
        if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
        window.close()
    }

    private static func snapshot(to dir: String, name: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.identifier?.rawValue != "" && $0.frame.width > 400 }),
              let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
        else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        // 打开着的面板（sheet）单独截一张
        if let sheet = window.attachedSheet, let sv = sheet.contentView?.superview ?? sheet.contentView,
           let srep = sv.bitmapImageRepForCachingDisplay(in: sv.bounds) {
            sv.cacheDisplay(in: sv.bounds, to: srep)
            try? srep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-sheet.png"))
        }
    }
}
