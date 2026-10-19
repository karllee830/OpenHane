import HaneCore
import SwiftUI

// 主页两个平台共用的部分：品牌标识、服务器列表的一行（名称、昵称、在线人数、信号）、连接和编辑对话框、错误和邀请提示。
// 与网页版的主页保持同样的信息结构。

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

/// 连接页左上角：小号的标识和字标
struct BrandBar: View {
    var markSize: CGFloat = 26

    var body: some View {
        HStack(spacing: 8) {
            BrandMark(size: markSize)
            BrandWordmark()
                .font(.system(size: markSize * 0.66, weight: .semibold))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
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

/// 信号格：四格表示延迟由低到高，连不上时显示叉号。还没测完时四格都是灰色
struct SignalBars: View {
    let status: ServerStatus?
    #if os(macOS)
    @State private var hovering = false
    #endif

    var body: some View {
        let bars = status?.bars ?? -1
        let color: Color = bars >= 3 ? .green : bars == 2 ? .orange : .red
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1 ... 4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(i <= bars ? color : Color.secondary.opacity(0.3))
                    .frame(width: 3, height: CGFloat(i) * 3.5)
            }
        }
        .frame(height: 14, alignment: .bottom)
        .overlay(alignment: .bottomTrailing) {
            if bars == 0 {
                Image(systemName: "xmark")
                    .font(.system(size: 7, weight: .heavy))
                    .foregroundStyle(.red)
                    .offset(x: 4, y: 3)
            }
        }
        .padding(.trailing, 3)
        #if os(macOS)
        // 悬停立即在上方显示延迟（系统的 help 提示要停顿一秒左右才出现，而且会被整行的提示盖住）
        .padding(4)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .overlay(alignment: .top) {
            if hovering {
                Text(verbatim: Self.shortLabel(status))
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.primary.opacity(0.85), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .fixedSize()
                    .offset(y: -24)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: hovering)
        #endif
        .accessibilityElement()
        .accessibilityLabel(Text(Self.label(status)))
    }

    /// 悬停气泡里的文字：连得上时只显示「42 ms」
    static func shortLabel(_ status: ServerStatus?) -> String {
        if let ms = status?.latencyMs { return "\(ms) ms" }
        return label(status)
    }

    /// 读屏用的完整说法：「延迟 42 ms」「无法连接」「正在检测…」
    static func label(_ status: ServerStatus?) -> String {
        guard let status else { return L("正在检测…") }
        guard let ms = status.latencyMs else { return L("无法连接") }
        return L("延迟 \(ms) ms")
    }
}

/// 服务器列表的一行：备注或名称、地址、在这台服务器上的昵称，右侧是在线人数和信号
struct ServerRowLabel: View {
    let server: RecentServer
    let nickname: String
    let status: ServerStatus?
    var connecting = false
    var tileSize: CGFloat = 36
    /// 显示上次连接时间（手机竖屏上放不下，省略）
    var showsTime = true

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                if connecting {
                    RoundedRectangle(cornerRadius: tileSize * 0.26, style: .continuous).fill(Color.accentColor.opacity(0.14))
                    ProgressView().controlSize(.small)
                } else {
                    ServerTile(name: server.title == server.address ? "" : server.title, size: tileSize)
                }
            }
            .frame(width: tileSize, height: tileSize)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.title)
                    .fontWeight(.medium)
                    .lineLimit(1)
                detail
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if let online = status?.online, status?.latencyMs != nil {
                HStack(spacing: 3) {
                    Image(systemName: "person.2")
                    Text(verbatim: "\(online)").monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("\(online) 人在线"))
                #if os(macOS)
                .help(Text("\(online) 人在线"))
                #endif
            }
            SignalBars(status: status)
        }
        .contentShape(Rectangle())
    }

    /// 地址 · 昵称 · 上次连接时间（名称就是地址时不重复地址）
    private var detail: some View {
        HStack(spacing: 4) {
            if server.title != server.address { Text(verbatim: server.displayAddress) }
            if !nickname.isEmpty {
                if server.title != server.address { Text(verbatim: "·") }
                Image(systemName: "person").imageScale(.small)
                Text(verbatim: nickname)
                    .accessibilityLabel(Text("昵称 \(nickname)"))
            }
            if showsTime, let date = server.lastUsed {
                Text(verbatim: "·")
                Text(date, format: .relative(presentation: .named))
            }
        }
    }
}

extension RecentServer {
    /// 显示用的地址：省略协议和默认端口（9800，以及 https 的 443、http 的 80）
    var displayAddress: String {
        guard let a = try? ServerAddress.parse(address) else { return address }
        let host = a.host.contains(":") ? "[\(a.host)]" : a.host
        return a.port == ServerAddress.defaultPort || a.port == (a.secure ? 443 : 80) ? host : "\(host):\(a.port)"
    }

    /// 菜单里收藏 / 取消收藏的文字和图标
    var favoriteAction: LocalizedStringKey { favorite ? "取消收藏" : "加入收藏" }
    var favoriteIcon: String { favorite ? "star.slash" : "star" }
}

/// 行内的收藏按钮：收藏过的是实心的黄色星星，其余的是淡淡的空心星星，点一下切换
struct FavoriteStar: View {
    let favorite: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            Image(systemName: favorite ? "star.fill" : "star")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(favorite ? Color.yellow : Color.secondary.opacity(0.55))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(favorite ? "取消收藏" : "加入收藏"))
        .accessibilityAddTraits(favorite ? .isSelected : [])
        #if os(macOS)
        .help(Text(favorite ? "取消收藏" : "加入收藏"))
        #endif
        .accessibilityIdentifier("server-star")
    }
}

/// 连接前还要补填的内容：昵称（第一次使用）或服务器密码
struct JoinTarget: Identifiable, Equatable {
    var address: String
    var title: String
    var nickname: String
    var needsPassword: Bool
    var id: String { address }
}

/// 补填昵称和服务器密码后连接
struct JoinSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: JoinTarget
    @State private var nickname = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case nickname, password }

    private var busy: Bool { model.session.status == .connecting }
    private var canConnect: Bool { !busy && !nickname.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 10) {
                        NicknameAvatar(name: nickname, size: 22).frame(width: 24)
                        TextField("昵称", text: $nickname, prompt: Text("其他人看到的名字"))
                            .focused($focus, equals: .nickname)
                            #if os(iOS)
                            .textContentType(.nickname)
                            .submitLabel(target.needsPassword ? .next : .go)
                            #endif
                            .accessibilityIdentifier("nickname")
                    }
                    if target.needsPassword {
                        HStack(spacing: 10) {
                            Image(systemName: "key.fill").foregroundStyle(.secondary).frame(width: 24).accessibilityHidden(true)
                            SecureField("服务器密码", text: $password, prompt: Text("向服务器管理员索取"))
                                .focused($focus, equals: .password)
                                #if os(iOS)
                                .submitLabel(.go)
                                #endif
                                .accessibilityIdentifier("password")
                        }
                    }
                } footer: {
                    if target.title != target.address { Text(verbatim: target.address) }
                }
                if let err = model.connectError {
                    Section {
                        ConnectErrorView(error: err)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("连接到 \(target.title)"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { connect() } label: {
                        if busy { ProgressView().controlSize(.small) } else { Text("连接") }
                    }
                    .disabled(!canConnect)
                    .accessibilityIdentifier("join-submit")
                }
            }
            .onSubmit {
                if focus == .nickname, target.needsPassword, password.isEmpty { focus = .password } else { connect() }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 220)
        #endif
        .onAppear {
            nickname = target.nickname
            focus = target.nickname.isEmpty || !target.needsPassword ? .nickname : .password
        }
    }

    private func connect() {
        guard canConnect else { return }
        let nick = nickname.trimmingCharacters(in: .whitespaces)
        Task {
            await model.connect(address: target.address, password: password, nickname: nick)
            if model.isInMeeting { dismiss() }
        }
    }
}

/// 编辑一台服务器：备注和在这台服务器上用的昵称
struct EditServerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: RecentServer
    @State private var note = ""
    @State private var nickname = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("备注", text: $note, prompt: Text(server.name.isEmpty ? L("代替服务器名称显示") : server.name))
                        .accessibilityIdentifier("edit-note")
                    TextField("昵称", text: $nickname, prompt: Text(model.nickname.isEmpty ? L("其他人看到的名字") : L("默认：\(model.nickname)")))
                        .accessibilityIdentifier("edit-nickname")
                } footer: {
                    Text(verbatim: server.address)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("备注和昵称")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        model.edit(server, note: note, nickname: nickname)
                        dismiss()
                    }
                    .accessibilityIdentifier("edit-save")
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 220)
        #endif
        .onAppear {
            note = server.note
            nickname = server.nickname
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

/// 主页两个平台共用的状态与操作
extension AppModel {
    /// 地址对应的列表记录
    func recentServer(for address: String) -> RecentServer? {
        RecentServers.find(address, in: recentServers)
    }

    /// 主页的列表：收藏的排在最前面，其余按最近连接的时间
    var sortedServers: [RecentServer] { recentServers.filter(\.favorite) + recentServers.filter { !$0.favorite } }

    /// 地址栏兼作搜索框：列表里与输入匹配的服务器（没有输入时是整个列表）
    func servers(matching query: String) -> [RecentServer] {
        sortedServers.filter { RecentServers.matches($0, query, defaultNickname: nickname) }
    }

    /// 连接列表里或地址栏里的一台服务器。还缺昵称或服务器密码时返回要补填的内容（由界面弹出对话框）
    func open(_ address: String) async -> JoinTarget? {
        let r = recentServer(for: address)
        let nick = nickname(for: address)
        let needsPassword = linkInvite == nil && r?.needsPassword == true
        if nick.isEmpty || needsPassword {
            connectError = nil
            return JoinTarget(address: address, title: r?.title ?? address, nickname: nick, needsPassword: needsPassword)
        }
        await connect(address: address, password: "")
        if connectError?.code == .passwordRequired || connectError?.code == .passwordInvalid {
            return JoinTarget(address: address, title: r?.title ?? address, nickname: nick, needsPassword: true)
        }
        return nil
    }
}

/// 地址栏的状态：输入的内容既是要连接的地址，也是列表的搜索词
struct AddressQuery {
    let text: String
    /// 列表里显示的服务器
    let shown: [RecentServer]
    /// 按回车或点「连接」时要连的地址（输入为空时为空）
    let target: String
    /// 输入的是地址（不是搜索词）：显示加密状态
    let isAddress: Bool

    @MainActor init(_ text: String, model: AppModel) {
        let q = text.trimmingCharacters(in: .whitespaces)
        self.text = q
        shown = model.servers(matching: q)
        target = q.isEmpty ? "" : RecentServers.connectTarget(in: model.recentServers, matches: shown, text: q)
        isAddress = RecentServers.looksLikeAddress(q)
    }
}

extension ServerAddress {
    /// 未加密的地址（http:// / ws://）：只建议本机或内网测试时使用
    static func isInsecure(_ input: String) -> Bool {
        (try? parse(input))?.secure == false
    }
}
