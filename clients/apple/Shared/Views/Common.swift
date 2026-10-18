import HaneCore
import SwiftUI

/// 头像：昵称首字 + 由 UID 决定的颜色；说话时外圈亮起。
struct AvatarView: View {
    let name: String
    let uid: String
    var speaking = false
    var size: CGFloat = 28
    var dimmed = false

    private static let palette: [Color] = [.red, .pink, .purple, .indigo, .blue, .teal, .green, .orange, .brown, .gray]

    /// 这个人的头像颜色（舞台画面的底色也用它）
    static func color(for uid: String) -> Color {
        // hashValue 每次启动随机化，这里用稳定的哈希保证同一个人颜色不变
        var h: UInt32 = 0
        for u in uid.unicodeScalars { h = h &* 31 &+ u.value }
        return palette[Int(h % UInt32(palette.count))]
    }

    var body: some View {
        let color = Self.color(for: uid)
        Text(String(name.trimmingCharacters(in: .whitespaces).first ?? "?").uppercased())
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(color.gradient))
            .overlay(Circle().stroke(Color.green, lineWidth: speaking ? max(2, size / 14) : 0).padding(-max(2, size / 14) - 1))
            .opacity(dimmed ? 0.5 : 1)
            .animation(.easeOut(duration: 0.1), value: speaking)
            .accessibilityHidden(true)
    }
}

/// 成员的状态图标：举手、静音 / 关闭声音、重连中、语音未连接
struct StatusIcons: View {
    let p: Participant
    var body: some View {
        HStack(spacing: 4) {
            if p.state.handRaised { Image(systemName: "hand.raised.fill").foregroundStyle(.orange).help("举手") }
            if p.state.deafened {
                Image(systemName: "speaker.slash.fill").help("已关闭声音")
            } else if p.forceMuted {
                // 被主持人静音：红色，与自己静音区分
                Image(systemName: "mic.slash.fill").foregroundStyle(.red).help("已静音")
            } else if p.state.micMuted {
                Image(systemName: "mic.slash.fill").help("已静音")
            }
            if p.reconnecting {
                Image(systemName: "arrow.triangle.2.circlepath").help("重连中")
            } else if !p.mediaConnected {
                Image(systemName: "bolt.horizontal.circle").help("语音未连接")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct RoleBadge: View {
    let role: Role
    var body: some View {
        switch role {
        case .admin: Image(systemName: "checkmark.shield.fill").foregroundStyle(.tint).help("管理员")
        case .moderator: Image(systemName: "shield.fill").foregroundStyle(.tint).help("主持人")
        default: EmptyView()
        }
    }
}

/// 本地化字符串（用于三元表达式等无法自动推断为 LocalizedStringKey 的地方）
func L(_ key: String.LocalizationValue) -> String { String(localized: key) }

/// 把连接 / 请求错误转换成给用户看的说明（给出原因和建议）
func describe(_ err: HaneError) -> String {
    switch err {
    case .unreachable: return String(localized: "无法连接到服务器，请检查地址和端口，以及服务器是否在运行。")
    case .timeout: return String(localized: "连接超时，请稍后重试。")
    case .connectionLost: return String(localized: "与服务器的连接已断开。")
    case .protocolViolation: return String(localized: "服务器返回了无法识别的数据，请确认地址指向的是羽见服务器。")
    case .fingerprintChanged: return String(localized: "服务器证书与上次记住的不一致，已停止连接。")
    case let .server(code, message, detail):
        switch code {
        case .protocolVersionUnsupported: return String(localized: "服务器与客户端版本不兼容，请更新。")
        case .authFailed: return String(localized: "身份验证失败。请检查设备时间是否准确。")
        case .tlsMitmSuspected: return String(localized: "服务器证书与预期不一致，可能有人在拦截你的连接。已停止连接。")
        case .banned:
            var text = String(localized: "你已被禁止进入该服务器。")
            if let r = detail?.banReason, !r.isEmpty { text = String(localized: "你已被禁止进入该服务器：\(r)") }
            if let until = detail?.banExpiresAtMs, until > 0 {
                text += String(localized: "（\(Date(timeIntervalSince1970: Double(until) / 1000).formatted(date: .abbreviated, time: .shortened)) 解除）")
            }
            if let by = detail?.byName, !by.isEmpty { text += String(localized: "（操作者：\(by)）") }
            return text
        case .passwordRequired: return String(localized: "该服务器需要密码。")
        case .passwordInvalid: return String(localized: "密码不正确。")
        case .serverFull: return String(localized: "服务器人数已满。")
        case .nicknameInvalid: return String(localized: "昵称不可用：需要 1–32 个字符，且不能包含不可见字符。")
        case .kicked:
            let by = detail?.byName ?? ""
            let reason = detail?.reason ?? ""
            return (by.isEmpty ? String(localized: "你已被移出服务器。") : String(localized: "你已被 \(by) 移出服务器。")) + (reason.isEmpty ? "" : String(localized: "：\(reason)"))
        case .roomNotFound: return String(localized: "房间不存在或已关闭。")
        case .roomFull: return String(localized: "房间人数已满。")
        case .roomLocked: return String(localized: "房间已锁定，只有主持人可以进入或拉人进入。")
        case .roomPasswordInvalid: return String(localized: "房间密码不正确。")
        case .e2EeUnsupported: return String(localized: "该房间开启了端到端加密，当前客户端不支持。")
        case .shareLimitReached: return String(localized: "同时共享的人数已达上限。")
        case .sessionReplaced: return String(localized: "你在另一处连接了同一身份，本连接已断开。")
        case .rateLimited: return String(localized: "操作过于频繁，请稍后再试。")
        case .permissionDenied: return String(localized: "没有权限执行该操作。")
        case .tokenInvalid: return String(localized: "令牌无效或已被吊销。")
        case .tokenExpired: return String(localized: "令牌已过期。")
        case .tokenUsedUp: return String(localized: "令牌已被用完。")
        default: return String(localized: "出错了：\(message)")
        }
    }
}
