import HaneCore
import HaneMedia
import SwiftUI

extension ShareIntentName {
    var label: String {
        switch self {
        case .smart: L("智能")
        case .clarity: L("清晰优先")
        case .smoothness: L("流畅优先")
        case .custom: L("自定义")
        }
    }

    init(_ proto: Openhane_V1_ShareIntent) {
        switch proto {
        case .clarity: self = .clarity
        case .smoothness: self = .smoothness
        case .custom: self = .custom
        default: self = .smart
        }
    }
}

/// 按原始像素显示（1 个画面像素 = 1 个屏幕像素），画面比窗口大时可以滚动
struct ActualSizeVideo: View {
    let ref: VideoTrackRef
    @Environment(\.displayScale) private var scale

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let px = ref.pixelSize ?? CGSize(width: 1920, height: 1080)
            ScrollView([.horizontal, .vertical]) {
                VideoSurface(ref, fit: true)
                    .frame(width: px.width / scale, height: px.height / scale)
            }
        }
    }
}

/// 共享时舞台底部的成员条：摄像头画面或头像
struct MemberStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let state = model.session.state
        let members = state.members(of: state.media?.roomID ?? "main")
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(members, id: \.sessionID) { p in
                    ParticipantTile(p: p, compact: true)
                        .frame(width: 128, height: 72)
                }
            }
            .padding(8)
        }
        .frame(height: 88)
    }
}

/// 一个成员：开了摄像头显示画面，否则在带头像颜色的底色上显示头像；名字在左下角的标签里，说话时描边并发光
struct ParticipantTile: View {
    @Environment(AppModel.self) private var model
    let p: Participant
    var compact = false

    var body: some View {
        let speaking = model.media.speaking.contains(p.mediaIdentity)
        let camera = model.media.videoTracks.first { !$0.isScreen && $0.identity == p.mediaIdentity }
        let shape = RoundedRectangle(cornerRadius: compact ? 10 : 16, style: .continuous)
        GeometryReader { geo in
            ZStack {
                TileBackground(uid: p.uid)
                if let camera {
                    VideoSurface(camera, fit: false)
                } else {
                    AvatarView(name: p.nickname, uid: p.uid, size: avatarSize(geo.size), dimmed: p.reconnecting)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .clipShape(shape)
        .overlay(alignment: .bottomLeading) { nameChip(onVideo: camera != nil).padding(compact ? 4 : 8) }
        .overlay(alignment: .topTrailing) {
            if !compact, model.media.e2ee?.missing.contains(p.sessionID) == true {
                Label("正在建立加密…", systemImage: "lock.rotation")
                    .font(.caption2)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.thinMaterial, in: Capsule())
                    .padding(8)
                    .accessibilityIdentifier("e2ee-pending")
            }
        }
        .overlay { shape.strokeBorder(speaking ? Color.green : Color.primary.opacity(0.06), lineWidth: speaking ? (compact ? 2 : 3) : 1) }
        .shadow(color: .green.opacity(speaking ? 0.35 : 0), radius: compact ? 4 : 10)
        .animation(.easeOut(duration: 0.15), value: speaking)
        .accessibilityElement(children: .combine)
    }

    /// 头像随画面大小缩放
    private func avatarSize(_ s: CGSize) -> CGFloat {
        min(max(min(s.width, s.height) * 0.38, compact ? 26 : 40), compact ? 40 : 104)
    }

    private func nameChip(onVideo: Bool) -> some View {
        HStack(spacing: 4) {
            Text(p.nickname).lineLimit(1)
            StatusIcons(p: p)
        }
        .font(compact ? .caption2 : .caption.weight(.medium))
        .padding(.horizontal, compact ? 6 : 8)
        .padding(.vertical, compact ? 2 : 4)
        .foregroundStyle(onVideo ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
        .background(onVideo ? AnyShapeStyle(.black.opacity(0.45)) : AnyShapeStyle(.thinMaterial), in: Capsule())
    }
}
