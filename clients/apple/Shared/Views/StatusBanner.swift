import HaneCore
import SwiftUI

/// 舞台顶部的状态提示：控制连接重连、语音通道状态、麦克风 / 摄像头错误、短暂提示。
/// 以胶囊浮在舞台上方，出现和消失时不会把舞台挤上挤下。
struct StatusBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 6) {
            if case let .reconnecting(n) = model.session.status {
                pill("连接中断，正在重连（第 \(n) 次）…", icon: "wifi.exclamationmark", tint: .orange, busy: true)
            } else if model.media.status == .reconnecting {
                pill("语音通道中断，正在重连…", icon: "waveform.badge.exclamationmark", tint: .orange, busy: true)
            } else if model.media.status == .connecting {
                pill("正在建立语音通道…", icon: "waveform", tint: .secondary, busy: true)
            }
            if model.media.micUnavailable {
                pill("没有找到麦克风，只能收听", icon: "mic.slash.fill", tint: .orange)
            }
            if let e = model.media.micError {
                pill("麦克风出错：\(e)", icon: "mic.slash.fill", tint: .red)
            }
            if let e = model.media.cameraError {
                pill("摄像头出错：\(e)", icon: "video.slash.fill", tint: .red)
            }
            switch model.media.cameraUnavailable {
            case .suspended:
                pill("内置摄像头不可用：笔记本合上了屏幕。打开屏幕或连接外接摄像头后再试", icon: "video.slash.fill", tint: .orange)
            case .none?:
                pill("没有找到摄像头", icon: "video.slash.fill", tint: .orange)
            case nil:
                EmptyView()
            }
            if let n = model.notice {
                pill("\(n)", icon: "info.circle.fill", tint: .accentColor)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .animation(.snappy(duration: 0.25), value: model.notice)
    }

    private func pill(_ text: LocalizedStringKey, icon: String, tint: Color, busy: Bool = false) -> some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: icon).foregroundStyle(tint)
            }
            Text(text)
                .font(.callout)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.35)))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
    }
}
