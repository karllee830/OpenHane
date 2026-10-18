import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct OpenHaneWidgets: WidgetBundle {
    var body: some Widget {
        MeetingLiveActivity()
    }
}

/// 锁屏和灵动岛上的会议状态
struct MeetingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MeetingActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .padding(16)
                .activityBackgroundTint(Color(.systemBackground).opacity(0.85))
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("\(s.participants)", systemImage: "person.2.fill")
                        .font(.caption)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    MuteButton(muted: s.muted).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(s.roomName).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    SpeakingLine(speaking: s.speaking)
                }
            } compactLeading: {
                Image(systemName: s.muted ? "mic.slash.fill" : "mic.fill")
                    .foregroundStyle(s.muted ? .red : .green)
            } compactTrailing: {
                Text("\(s.participants)").font(.caption.monospacedDigit())
            } minimal: {
                Image(systemName: s.muted ? "mic.slash.fill" : "mic.fill")
                    .foregroundStyle(s.muted ? .red : .green)
            }
        }
    }
}

private struct LockScreenView: View {
    let attributes: MeetingActivityAttributes
    let state: MeetingActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.2.wave.2.fill")
                .font(.title2)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.roomName).font(.headline).lineLimit(1)
                Text("\(attributes.serverName) · \(state.participants) 人").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                SpeakingLine(speaking: state.speaking)
            }
            Spacer(minLength: 8)
            MuteButton(muted: state.muted)
        }
    }
}

private struct SpeakingLine: View {
    let speaking: [String]

    var body: some View {
        if speaking.isEmpty {
            Text("没有人在说话").font(.caption).foregroundStyle(.secondary)
        } else {
            Label(speaking.joined(separator: "、"), systemImage: "waveform")
                .font(.caption)
                .foregroundStyle(.green)
                .lineLimit(1)
        }
    }
}

private struct MuteButton: View {
    let muted: Bool

    var body: some View {
        Button(intent: ToggleMuteLiveIntent()) {
            Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                .font(.title3)
                .frame(width: 44, height: 44)
                .background(Circle().fill(muted ? Color.red.opacity(0.85) : Color.secondary.opacity(0.25)))
                .foregroundStyle(muted ? .white : .primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(muted ? Text("取消静音") : Text("静音"))
    }
}
