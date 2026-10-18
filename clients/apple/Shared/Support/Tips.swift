import Foundation
import SwiftUI
import TipKit

/// 新用户引导：用系统的 TipKit 在相应控件旁给出上手提示。每条只显示一次（关闭或做过对应操作后不再出现），
/// 全局每小时最多出现一条，避免一次弹出一堆。
enum OnboardingTips {
    static func configure() {
        let env = DevHooks.environment
        if env["HANE_SHOW_TIPS"] == "1" {
            Tips.showAllTipsForTesting() // 截图检查用
        } else if ProcessInfo.processInfo.environment["HANE_E2E"] == "1" || env["HANE_SNAPSHOT_DIR"] != nil {
            Tips.hideAllTipsForTesting() // 自动化测试和截图时不显示
        }
        try? Tips.configure([.displayFrequency(.hourly)])
    }
}

/// 麦克风：静音快捷键、说话方式
struct VoiceTip: Tip {
    var title: Text { Text("说话方式") }
    var message: Text? {
        #if os(macOS)
        Text("默认是语音激活。⌘⇧M 静音；在设置里可以改用按键说话（支持鼠标侧键）或常开。")
        #else
        Text("默认是语音激活。在「更多」里可以改用按键说话或常开。")
        #endif
    }
    var image: Image? { Image(systemName: "mic") }
}

/// 屏幕共享：选「智能」即可
struct ShareTip: Tip {
    var title: Text { Text("共享屏幕") }
    var message: Text? { Text("选「智能」模式就好：文档会保持清晰，视频和游戏会保持流畅。") }
    var image: Image? { Image(systemName: "rectangle.on.rectangle") }
}

/// 房间：点房间名进入
struct RoomsTip: Tip {
    var title: Text { Text("房间") }
    var message: Text? {
        #if os(macOS)
        Text("点击房间名即可进入，切换时声音几乎不中断。主持人可以把成员拖到其他房间。")
        #else
        Text("在成员列表里点房间名即可进入，切换时声音几乎不中断。")
        #endif
    }
    var image: Image? { Image(systemName: "person.3") }
}

#if os(macOS)
/// 菜单栏：关掉主窗口也能留在会议里
struct MenuBarTip: Tip {
    var title: Text { Text("菜单栏") }
    var message: Text? { Text("关掉主窗口也能留在会议里：菜单栏的麦克风图标可以静音、打开主窗口或离开。") }
    var image: Image? { Image(systemName: "menubar.rectangle") }
}
#endif
