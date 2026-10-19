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
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1100, height: 720)
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

    var body: some View {
        Group {
            if model.isInMeeting { MeetingView() } else { ConnectView() }
        }
        .sheet(item: Binding(get: { model.tofuMismatch.map(MismatchItem.init) }, set: { if $0 == nil { model.tofuMismatch = nil } })) { item in
            TofuWarningView(mismatch: item.m).environment(model).interactiveDismissDisabled()
        }
        .task { await SnapshotHarness.runIfRequested(model) }
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
            Text(model.session.state.serverInfo.name)
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
