import LiveKit
import HaneCore
import SwiftUI

@main
struct OpenHaneApp: App {
    @State private var model = AppModel.shared
    @Environment(\.openWindow) private var openWindow

    init() {
        // 端到端测试：手动渲染模式，不访问真实的音频设备
        if ProcessInfo.processInfo.environment["HANE_E2E"] == "1" {
            try? AudioManager.shared.setManualRenderingMode(true)
        }
    }

    var body: some Scene {
        Window("羽见", id: "main") {
            RootView()
                .environment(model)
                .onOpenURL { model.handle(url: $0) }
        }
        // 第一次打开时的大小（主页）；之后由 RootView 按主页 / 会议页分别调整
        .defaultSize(WindowSizes.size(.home, area: NSScreen.main?.visibleFrame.size ?? CGSize(width: 1920, height: 1050)))
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .appInfo) {
                Button("关于羽见") { openWindow(id: "about") }
            }
            CommandGroup(after: .appInfo) {
                if AppUpdater.shared.enabled {
                    Button("检查更新…") { AppUpdater.shared.checkForUpdates() }
                        .disabled(!AppUpdater.shared.canCheck)
                }
            }
        }

        // 关于羽见（含「开源许可」）
        Window("关于羽见", id: "about") {
            NavigationStack { AboutView() }
                .frame(minWidth: 460, idealWidth: 520, minHeight: 440, idealHeight: 560)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 520, height: 560)

        Settings {
            SettingsView().environment(model)
        }

        // 菜单栏常驻：关掉主窗口也能留在会议里
        MenuBarExtra {
            MenuBarContent(openMain: { openWindow(id: "main"); NSApp.activate() }).environment(model)
        } label: {
            Image(systemName: model.isInMeeting ? (model.media.micMuted ? "mic.slash.fill" : "mic.fill") : "mic")
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    /// 显示会议页：跟随 isInMeeting。进入会议时先把窗口换成会议页的大小再切换（会议页的三栏在太窄的窗口里会让 AppKit 布局死循环）
    @State private var showMeeting = false
    @State private var window: NSWindow?

    private var mode: WindowSizes.Mode { showMeeting ? .meeting : .home }

    var body: some View {
        Group {
            if showMeeting { MeetingView() } else { ConnectView() }
        }
        .frame(minWidth: WindowSizes.minSize(mode).width, minHeight: WindowSizes.minSize(mode).height)
        .background(WindowReader(window: $window))
        // 拿到窗口时换成当前页面的大小（上次可能是在会议页里退出的）
        .onChange(of: window) { _, w in
            guard let w else { return }
            if model.isInMeeting != showMeeting { setMeeting(model.isInMeeting) } else { WindowSizes.apply(mode, to: w) }
        }
        .onChange(of: model.isInMeeting) { _, inMeeting in setMeeting(inMeeting) }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didEndLiveResizeNotification)) { note in
            if let window, note.object as? NSWindow === window { WindowSizes.remember(mode, window: window) }
        }
        .sheet(item: Binding(get: { model.tofuMismatch.map(MismatchItem.init) }, set: { if $0 == nil { model.tofuMismatch = nil } })) { item in
            TofuWarningView(mismatch: item.m).environment(model).interactiveDismissDisabled()
        }
        .task { await SnapshotHarness.runIfRequested(model) }
    }

    /// 进入会议：先放大窗口再显示会议页；离开会议：先换回主页（放宽最小尺寸）再缩小窗口
    private func setMeeting(_ inMeeting: Bool) {
        guard inMeeting != showMeeting else { return }
        if inMeeting {
            if let window { WindowSizes.apply(.meeting, to: window) }
            showMeeting = true
        } else {
            showMeeting = false
            DispatchQueue.main.async { if let window { WindowSizes.apply(.home, to: window) } }
        }
    }
}

/// 取得视图所在的窗口
private struct WindowReader: NSViewRepresentable {
    @Binding var window: NSWindow?

    func makeNSView(context _: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { window = view.window }
        return view
    }

    func updateNSView(_ view: NSView, context _: Context) {
        if view.window !== window { DispatchQueue.main.async { window = view.window } }
    }
}

private struct MismatchItem: Identifiable {
    let m: TrustStore.Mismatch
    var id: String { m.hostPort + m.actual }
}

struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    let openMain: () -> Void

    var body: some View {
        if model.isInMeeting {
            Text(verbatim: model.meetingTitle)
            Divider()
            Toggle("静音", isOn: Binding(get: { model.media.micMuted }, set: { v in Task { await model.setMuted(v) } }))
            Toggle("关闭声音", isOn: Binding(get: { model.media.deafened }, set: { v in Task { await model.setDeafened(v) } }))
            Divider()
            Button("显示主窗口", action: openMain)
            Button("离开") { Task { await model.leave() } }
        } else {
            Text("未连接")
            Button("显示主窗口", action: openMain)
        }
        Divider()
        Button("退出羽见") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
