import LiveKit
import HaneCore
import SwiftUI

@main
struct OpenHaneApp: App {
    @State private var model = AppModel.shared

    init() {
        // 端到端检查：手动渲染模式，不访问真实的音频设备
        if ProcessInfo.processInfo.environment["HANE_E2E"] == "1" {
            try? AudioManager.shared.setManualRenderingMode(true)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.handle(url: $0) }
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
            ScrollView { TofuWarningView(mismatch: item.m) }
                .environment(model)
                .interactiveDismissDisabled()
                .presentationDetents([.medium, .large])
        }
        .task { await autoconnect() }
    }

    /// 开发检查：HANE_AUTOCONNECT=地址|昵称 自动连接（模拟器用 SIMCTL_CHILD_HANE_AUTOCONNECT 传入）
    private func autoconnect() async {
        guard let spec = DevHooks.environment["HANE_AUTOCONNECT"] else { return }
        let parts = spec.split(separator: "|", maxSplits: 1).map(String.init)
        if parts.count == 2 { model.nickname = parts[1] }
        await model.connect(address: parts[0], password: "")
    }
}

private struct MismatchItem: Identifiable {
    let m: TrustStore.Mismatch
    var id: String { m.hostPort + m.actual }
}
