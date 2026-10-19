#if os(iOS)
import ActivityKit
import Foundation
import HaneCore

/// 会议的实时活动（锁屏、灵动岛）：进入会议时开始，每秒检查一次状态、有变化才更新，离开会议时结束。
/// 锁屏上的静音按钮经 LiveActivityBridge 回到这里。
@MainActor
final class LiveActivityController {
    private weak var model: AppModel?
    private var activity: Activity<MeetingActivityAttributes>?
    private var last: MeetingActivityAttributes.ContentState?
    private var task: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model
        LiveActivityBridge.toggleMute = { [weak model] in
            guard let model, model.isInMeeting else { return }
            Task { await model.setMuted(!model.media.micMuted) }
        }
        task = Task { [weak self] in
            // 上次异常退出时留下的活动
            for a in Activity<MeetingActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func tick() {
        guard let model else { return }
        guard model.isInMeeting else {
            end()
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            end()
            return
        }
        let state = Self.state(of: model)
        if let a = activity, a.activityState == .active {
            guard state != last else { return }
            last = state
            let id = a.id
            Task.detached { await Self.find(id)?.update(ActivityContent(state: state, staleDate: nil)) }
        } else {
            let attributes = MeetingActivityAttributes(serverName: model.meetingTitle)
            do {
                activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil))
            } catch {
                NSLog("OpenHane: live activity request failed: %@", String(describing: error))
            }
            last = state
        }
    }

    private func end() {
        guard let a = activity else { return }
        activity = nil
        last = nil
        let id = a.id
        Task.detached { await Self.find(id)?.end(nil, dismissalPolicy: .immediate) }
    }

    /// Activity 不是 Sendable：跨任务只传 id，在任务里重新取
    nonisolated private static func find(_ id: String) -> Activity<MeetingActivityAttributes>? {
        Activity<MeetingActivityAttributes>.activities.first { $0.id == id }
    }

    static func state(of model: AppModel) -> MeetingActivityAttributes.ContentState {
        let s = model.session.state
        let roomID = s.media?.roomID ?? "main"
        let members = s.members(of: roomID)
        let speaking = members.filter { model.media.speaking.contains($0.mediaIdentity) }.map(\.nickname)
        return .init(roomName: s.roomName(roomID), muted: model.media.micMuted, deafened: model.media.deafened,
                     participants: members.count, speaking: Array(speaking.prefix(3)))
    }
}
#endif
