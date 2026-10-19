import HaneCore
import SwiftUI

// 连接页两个平台共用的部分：品牌标识、昵称头像预览、最近连接、错误和邀请提示。
// 与网页版的连接页保持同样的信息结构。

/// 品牌标识：应用图标（Shared/OpenHane.icon）的渲染图，浅色 / 深色各一张（Assets.xcassets/BrandMark，与网页版一致）
struct BrandMark: View {
    var size: CGFloat = 64

    var body: some View {
        Image("BrandMark")
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.12), radius: size * 0.12, y: size * 0.05)
            .accessibilityHidden(true)
    }
}

/// 品牌字标：英文为「Open」+ 玻璃质感的「Hane」，中文为玻璃质感的「羽」+「见」（与网页版 index.css 的 brand-glass 一致）
struct BrandWordmark: View {
    @Environment(\.colorScheme) private var scheme

    /// 按纸鹤折面分段的斜向渐变：相邻的面明暗不同，交界处略带过渡（颜色取自图标）
    private var facets: LinearGradient {
        let hex: [(UInt32, Double)] = scheme == .dark
            ? [(0x58A9FE, 0), (0x66B0FD, 0.24), (0x79BAFB, 0.27), (0x9DCFFD, 0.46), (0xC4E2FF, 0.49), (0xCFE8FF, 0.62), (0x8CC5FC, 0.65), (0x6DB3FD, 1)]
            : [(0x2F86E8, 0), (0x3D93F2, 0.24), (0x5AA9FA, 0.27), (0x6FB4FB, 0.46), (0x88C1FC, 0.49), (0x9ACDFD, 0.62), (0x6DB2FA, 0.65), (0x4C9FF6, 1)]
        return LinearGradient(stops: hex.map { .init(color: Self.color($0.0), location: $0.1) },
                              startPoint: UnitPoint(x: 0, y: 0.2), endPoint: UnitPoint(x: 1, y: 0.8))
    }

    /// 自上而下的白色高光（玻璃的反光）
    private static let sheen = LinearGradient(stops: [.init(color: .white.opacity(0.45), location: 0),
                                                     .init(color: .white.opacity(0.08), location: 0.5),
                                                     .init(color: .white.opacity(0), location: 0.56)],
                                              startPoint: .top, endPoint: .bottom)

    private static func color(_ hex: UInt32) -> Color {
        Color(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// 字标分成三段：前缀、玻璃质感的部分、后缀。跟随应用实际使用的界面语言
    private static let parts: (lead: String, glass: String, trail: String) =
        Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true ? ("", "羽", "见") : ("Open", "Hane", "")

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: Self.parts.lead)
            Text(verbatim: Self.parts.glass)
                .foregroundStyle(facets)
                .overlay { Text(verbatim: Self.parts.glass).foregroundStyle(Self.sheen) }
                // 很细的深蓝边（浅色背景上也看得清）和淡淡的蓝色光晕
                .shadow(color: Self.color(0x176BCB).opacity(scheme == .dark ? 0 : 0.5), radius: 0.4)
                .shadow(color: Self.color(0x58A9FE).opacity(scheme == .dark ? 0.45 : 0.35), radius: 8, y: 4)
            Text(verbatim: Self.parts.trail)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: Self.parts.lead + Self.parts.glass + Self.parts.trail))
    }
}

/// 连接页顶部：标识、应用名称、一句话介绍
struct BrandHeader: View {
    var markSize: CGFloat = 64

    var body: some View {
        VStack(spacing: 14) {
            BrandMark(size: markSize)
            VStack(spacing: 4) {
                BrandWordmark()
                    .font(.title.weight(.semibold))
                Text("自托管的语音、视频与屏幕共享")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// 昵称输入框前的头像预览。进入会议后头像的颜色由 UID 决定（连接前还不知道），这里统一用强调色。
struct NicknameAvatar: View {
    let name: String
    var size: CGFloat = 22

    var body: some View {
        let initial = name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() }
        ZStack {
            if let initial {
                Circle().fill(Color.accentColor.gradient)
                Text(initial)
                    .font(.system(size: size * 0.48, weight: .semibold))
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.62))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .animation(.snappy(duration: 0.2), value: initial)
        .accessibilityHidden(true)
    }
}

/// 服务器的小图标：名称首字；没有名称时显示服务器图标
struct ServerTile: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(Color.accentColor.opacity(0.14))
            .overlay {
                if let ch = name.trimmingCharacters(in: .whitespaces).first {
                    Text(String(ch).uppercased())
                        .font(.system(size: size * 0.44, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                } else {
                    Image(systemName: "server.rack")
                        .font(.system(size: size * 0.4, weight: .medium))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// 最近连接的一行：服务器名称、地址和上次连接时间
struct RecentServerLabel: View {
    let server: RecentServer

    var body: some View {
        HStack(spacing: 12) {
            ServerTile(name: server.name)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name.isEmpty ? server.address : server.name)
                    .lineLimit(1)
                detail
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder private var detail: some View {
        switch (server.name.isEmpty, server.lastUsed) {
        case let (false, date?): Text("\(server.address) · \(date, format: .relative(presentation: .named))")
        case (false, nil): Text(server.address)
        case let (true, date?): Text(date, format: .relative(presentation: .named))
        case (true, nil): EmptyView()
        }
    }
}

/// 连接失败的原因和建议
struct ConnectErrorView: View {
    let error: HaneError

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
            Text(describe(error))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.red.opacity(0.25)))
        .accessibilityElement(children: .combine)
    }
}

/// 通过邀请链接打开时的提示（免服务器密码、可附带角色）
struct InviteBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "ticket")
                .foregroundStyle(Color.accentColor)
            Text("通过邀请链接加入")
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// 连接页两个平台共用的状态与操作
extension AppModel {
    /// 地址对应的最近连接记录（用于提前显示密码框）
    func recentServer(for address: String) -> RecentServer? {
        RecentServers.find(address, in: recentServers)
    }
}

extension ServerAddress {
    /// 未加密的地址（http:// / ws://）：只建议本机或内网测试时使用
    static func isInsecure(_ input: String) -> Bool {
        (try? parse(input))?.secure == false
    }
}
