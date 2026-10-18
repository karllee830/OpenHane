#if os(iOS)
import ActivityKit
import AppIntents
import Foundation

/// 会议的实时活动（Live Activity / 灵动岛）：服务器、房间、静音状态、谁在说话。
/// 主应用和小组件扩展共用这个文件。
struct MeetingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var roomName: String
        var muted: Bool
        var deafened: Bool
        var participants: Int
        /// 正在说话的人（最多 3 个昵称）
        var speaking: [String]
    }

    var serverName: String
}

/// 实时活动上的静音按钮。系统在主应用进程中执行（扩展里只有声明）。
struct ToggleMuteLiveIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "切换静音"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        #if !HANE_WIDGET
        await MainActor.run { LiveActivityBridge.toggleMute?() }
        #endif
        return .result()
    }
}

#if !HANE_WIDGET
/// 主应用注册的回调（扩展中不存在）
@MainActor
enum LiveActivityBridge {
    static var toggleMute: (() -> Void)?
}
#endif
#endif
