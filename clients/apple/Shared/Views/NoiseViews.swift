import HaneCore
import HaneMedia
import SwiftUI

/// 降噪档位的说明和实际状态（macOS 设置、iOS「更多」里共用）
extension NoiseSuppression {
    var title: LocalizedStringKey {
        switch self {
        case .ai: "AI 降噪（推荐）"
        case .system: "标准"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .ai: "能去掉键盘声、狗叫、旁人说话等各种噪声，在回声消除之后再处理一遍。"
        case .system: "只用基本的降噪，主要去掉风扇、空调这类平稳的噪声。"
        }
    }
}

extension MediaSession.NoiseState {
    var label: LocalizedStringKey {
        switch self {
        case .system: "系统语音处理已开启（回声消除、降噪、自动增益）"
        case .software: "软件回声消除和基本降噪已开启"
        case .unavailable: "AI 降噪不可用，只用基本的降噪"
        case .standby: "进入会议后启用"
        case .loading: "正在加载 AI 降噪模型…"
        case .active: "AI 降噪工作中"
        case .pausedForVoiceIsolation: "系统「语音突显」已开启，AI 降噪暂停（不重复降噪）"
        case .pausedForShare: "共享屏幕声音时 AI 降噪暂停"
        case .unsupportedFormat: "当前音频设备不支持 AI 降噪（例如蓝牙耳机的通话模式）"
        }
    }

    var isWarning: Bool { self == .unavailable || self == .unsupportedFormat }
}

extension EchoProcessing {
    var title: LocalizedStringKey {
        switch self {
        case .software: "软件（推荐）"
        case .system: "系统语音处理"
        }
    }

    var detail: LocalizedStringKey {
        switch self {
        case .software: "和浏览器里的会议一样，不会压低其他应用的声音。"
        case .system: "外放时回声消除效果更好，可以用「语音突显」，但会压低其他应用（音乐、视频）的声音。"
        }
    }
}
