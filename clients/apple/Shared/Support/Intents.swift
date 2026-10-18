import AppIntents
import Foundation

// 快捷指令 / App Intents：Siri、「快捷指令」App、聚焦搜索和（macOS）键盘快捷键都能调用。

/// 切换静音
struct ToggleMuteIntent: AppIntent {
    static let title: LocalizedStringResource = "切换静音"
    static let description = IntentDescription("在羽见的会议中静音或取消静音。")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        guard model.isInMeeting else {
            return .result(dialog: "当前不在会议中")
        }
        let muted = !model.media.micMuted
        await model.setMuted(muted)
        return .result(dialog: muted ? "已静音" : "已取消静音")
    }
}

/// 离开会议
struct LeaveMeetingIntent: AppIntent {
    static let title: LocalizedStringResource = "离开会议"
    static let description = IntentDescription("断开与羽见服务器的连接。")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        guard model.isInMeeting else {
            return .result(dialog: "当前不在会议中")
        }
        await model.leave()
        return .result(dialog: "已离开会议")
    }
}

/// 加入服务器（打开应用并连接）
struct JoinServerIntent: AppIntent {
    static let title: LocalizedStringResource = "加入服务器"
    static let description = IntentDescription("打开羽见并连接到指定的服务器。")
    static let openAppWhenRun = true

    @Parameter(title: "服务器地址", description: "例如 meet.example.com 或 203.0.113.10:9800")
    var address: String

    static var parameterSummary: some ParameterSummary {
        Summary("加入 \(\.$address)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        if model.isInMeeting { await model.leave() }
        await model.connect(address: address, password: "")
        if model.isInMeeting { return .result(dialog: "已加入 \(model.session.state.serverInfo.name)") }
        return .result(dialog: "无法连接到 \(address)")
    }
}

struct OpenHaneShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ToggleMuteIntent(),
            phrases: ["在\(.applicationName)中切换静音", "\(.applicationName)静音", "Toggle mute in \(.applicationName)"],
            shortTitle: "切换静音",
            systemImageName: "mic.slash"
        )
        AppShortcut(
            intent: LeaveMeetingIntent(),
            phrases: ["离开\(.applicationName)会议", "Leave the \(.applicationName) meeting"],
            shortTitle: "离开会议",
            systemImageName: "phone.down"
        )
        AppShortcut(
            intent: JoinServerIntent(),
            phrases: ["用\(.applicationName)加入服务器", "Join a server in \(.applicationName)"],
            shortTitle: "加入服务器",
            systemImageName: "person.2.wave.2"
        )
    }
}
