import HaneCore
import SwiftUI

// 会议界面两个平台共用的小部件：舞台画面的底色、欢迎语卡片、居中换行布局、纯语音时的成员卡片、「你」标签。

/// 舞台画面的底色：带一点这个人头像颜色的渐变，没开摄像头时一眼能分清谁是谁
struct TileBackground: View {
    let uid: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let color = AvatarView.color(for: uid)
        ZStack {
            Rectangle().fill(.background.secondary)
            LinearGradient(colors: [color.opacity(scheme == .dark ? 0.32 : 0.2), color.opacity(scheme == .dark ? 0.1 : 0.05)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

/// 管理员设置的欢迎语：进入会议后显示在舞台上方，可以关掉
struct WelcomeCard: View {
    let message: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "megaphone.fill")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("关闭")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.accentColor.opacity(0.18)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }
}

/// 换行排列、每行居中（人少时不会都挤在左边）
struct CenteredFlowLayout: Layout {
    var spacing: CGFloat = 16

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX + (bounds.width - row.width) / 2
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            if !row.items.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append(i)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// 纯语音时舞台上的成员卡片：大头像（说话时外圈亮起）、昵称和状态
struct VoiceTile: View {
    @Environment(AppModel.self) private var model
    let p: Participant
    var isSelf = false

    var body: some View {
        let speaking = model.media.speaking.contains(p.mediaIdentity)
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        VStack(spacing: 10) {
            AvatarView(name: p.nickname, uid: p.uid, speaking: speaking, size: 76, dimmed: p.reconnecting)
                .padding(.top, 4)
            VStack(spacing: 4) {
                HStack(spacing: 4) {
                    Text(p.nickname).font(.callout.weight(.medium)).lineLimit(1)
                    RoleBadge(role: p.role).font(.caption)
                }
                HStack(spacing: 6) {
                    if isSelf { YouTag() }
                    StatusIcons(p: p)
                }
                .frame(minHeight: 16)
            }
            E2EEPending(p: p)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 16)
        .frame(width: 164)
        .background { TileBackground(uid: p.uid).clipShape(shape) }
        .overlay(shape.strokeBorder(speaking ? Color.green.opacity(0.7) : Color.primary.opacity(0.06), lineWidth: speaking ? 2 : 1))
        .animation(.easeOut(duration: 0.15), value: speaking)
        .accessibilityElement(children: .combine)
    }
}

/// 成员列表里自己那一行的「你」
struct YouTag: View {
    var body: some View {
        Text("你")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(Color.accentColor)
            .background(Color.accentColor.opacity(0.14), in: Capsule())
    }
}
