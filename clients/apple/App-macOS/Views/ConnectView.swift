import AppKit
import HaneCore
import SwiftUI

/// 主页：上方是地址栏（连接按钮在框内右侧），下面是服务器列表（收藏的置顶），点一下即可连接。
/// 每台服务器记住自己的昵称；还缺昵称或服务器密码时先弹出对话框补上。右上角是设置。
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @State private var address = ""
    @State private var connectingTo = ""
    @State private var join: JoinTarget?
    @State private var editing: RecentServer?
    @FocusState private var addressFocused: Bool

    private var busy: Bool { model.session.status == .connecting }
    private var query: AddressQuery { AddressQuery(address, model: model) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                BrandBar(markSize: 22)
                Spacer()
                SettingsLink {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14))
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .help("设置")
                .accessibilityLabel("设置")
                .accessibilityIdentifier("home-settings")
            }
            .padding(.leading, 20)
            .padding(.trailing, 14)
            .padding(.top, 4)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    addressBar
                    hints
                    if model.recentServers.isEmpty {
                        empty
                    } else if query.shown.isEmpty {
                        Text("列表里没有匹配的服务器，按回车连接这个地址。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.top, 22)
                            .padding(.horizontal, 4)
                    } else {
                        section("服务器列表", systemImage: "server.rack", servers: query.shown)
                    }
                }
                .frame(maxWidth: 600)
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)

            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Label("你的身份保存在钥匙串中，并通过 iCloud 钥匙串在你的设备之间同步。", systemImage: "checkmark.shield")
                    .lineLimit(2)
                Spacer(minLength: 0)
                Button("关于羽见") { openWindow(id: "about") }
                    .buttonStyle(.link)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .accessibilityIdentifier("about-open")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .background(Backdrop())
        .hideWindowTitle()
        .animation(.snappy(duration: 0.25), value: model.connectError)
        .animation(.snappy(duration: 0.25), value: model.recentServers)
        .sheet(item: $join) { JoinSheet(target: $0) }
        .sheet(item: $editing) { EditServerSheet(server: $0) }
        .task { await model.watchServerStatus() }
        .onChange(of: model.linkAddress) { _, a in if let a { address = a } }
        .onAppear {
            if let a = model.linkAddress { address = a }
            if model.recentServers.isEmpty || model.linkAddress != nil { addressFocused = true }
        }
    }

    // MARK: 地址栏

    private var addressBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "server.rack")
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            // 占位文字自己画：plain 样式的 prompt 在这里显示成正文颜色
            TextField("搜索或输入服务器地址", text: $address, prompt: Text(verbatim: ""))
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($addressFocused)
                .onSubmit { open(query.target) }
                .onExitCommand { address = "" }
                .background(alignment: .leading) {
                    if address.isEmpty {
                        Text("搜索或输入服务器地址")
                            .font(.system(size: 13))
                            .foregroundStyle(.tertiary)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityIdentifier("address")
            if query.isAddress, let a = try? ServerAddress.parse(address) {
                Image(systemName: a.secure ? "lock.fill" : "lock.open.fill")
                    .foregroundStyle(a.secure ? Color.green : Color.orange)
                    .help(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
                    .accessibilityLabel(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
            }
            Button { open(query.target) } label: {
                HStack(spacing: 5) {
                    if busy, connectingTo == query.target {
                        ProgressView().controlSize(.small)
                    }
                    Text("连接")
                    Image(systemName: "arrow.right")
                }
                .padding(.horizontal, 4)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("connect")
        }
        .focusEffectDisabled()
        .padding(.leading, 12)
        .padding(.trailing, 5)
        .frame(height: 40)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(addressFocused ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: addressFocused ? 1.5 : 1)
        }
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.accentColor.opacity(addressFocused ? 0.25 : 0), lineWidth: 3.5)
                .padding(-2)
        }
        .shadow(color: .black.opacity(0.05), radius: 8, y: 3)
        .animation(.easeOut(duration: 0.15), value: addressFocused)
    }

    /// 地址栏下面：未加密提示、邀请提示、连接失败的原因（补填对话框打开时显示在对话框里）
    @ViewBuilder private var hints: some View {
        VStack(alignment: .leading, spacing: 10) {
            if query.isAddress, ServerAddress.isInsecure(address) {
                Text("未加密的连接（http://），只建议在本机或内网测试时使用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if model.linkInvite != nil { InviteBanner() }
            if let err = model.connectError, join == nil {
                ConnectErrorView(error: err).transition(.opacity)
            }
        }
        .padding(.top, 10)
        .padding(.horizontal, 2)
    }

    // MARK: 服务器列表

    private func section(_ title: LocalizedStringKey, systemImage: String, servers: [RecentServer]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
            VStack(spacing: 2) {
                ForEach(servers) { server in
                    ServerRow(server: server,
                              nickname: model.nickname(for: server.address),
                              status: model.serverStatus[server.address],
                              connecting: busy && connectingTo == server.address,
                              disabled: busy,
                              highlighted: server.address == query.target,
                              connect: { open(server.address) },
                              favorite: { model.toggleFavorite(server) },
                              edit: { editing = server },
                              forget: { model.forget(server) })
                }
            }
            .padding(6)
            .background(Card())
        }
        .padding(.top, 22)
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "server.rack")
                .font(.title2)
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Color.primary.opacity(0.06), in: Circle())
                .padding(.bottom, 2)
            Text("还没有服务器")
                .font(.callout.weight(.medium))
            Text("在上方输入服务器地址开始连接；连接过的服务器会显示在这里，可以收藏和加备注。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(.vertical, 36)
        .frame(maxWidth: .infinity)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
        }
        .padding(.top, 24)
        .accessibilityElement(children: .combine)
    }

    private func open(_ target: String) {
        let a = target.trimmingCharacters(in: .whitespaces)
        guard !busy, !a.isEmpty else { return }
        connectingTo = a
        Task {
            join = await model.open(a)
            connectingTo = ""
        }
    }
}

/// 列表的一行：悬停时高亮；右侧的星星收藏，「…」和右键菜单里可以改备注和昵称、复制地址、移除
private struct ServerRow: View {
    let server: RecentServer
    let nickname: String
    let status: ServerStatus?
    let connecting: Bool
    let disabled: Bool
    /// 在地址栏按回车会连这一台（搜索时高亮）
    let highlighted: Bool
    let connect: () -> Void
    let favorite: () -> Void
    let edit: () -> Void
    let forget: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 4) {
            Button(action: connect) {
                ServerRowLabel(server: server, nickname: nickname, status: status, connecting: connecting, tileSize: 32)
                    .padding(.vertical, 4)
                    .padding(.leading, 8)
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            FavoriteStar(favorite: server.favorite, toggle: favorite)
            Menu {
                actions
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .foregroundStyle(.secondary)
            .padding(.trailing, 6)
            .help("更多操作")
            .accessibilityLabel("更多操作")
            .accessibilityIdentifier("server-menu")
        }
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.accentColor.opacity(highlighted ? 0.12 : hovering && !disabled ? 0.08 : 0))
        }
        .onHover { hovering = $0 }
        .help(server.address)
        .contextMenu {
            Button("连接", action: connect).disabled(disabled)
            Divider()
            actions
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: Text(server.favoriteAction), favorite)
        .accessibilityAction(named: Text("备注和昵称…"), edit)
        .accessibilityAction(named: Text("从列表中移除"), forget)
        .accessibilityIdentifier("recent-server")
    }

    @ViewBuilder private var actions: some View {
        Button("备注和昵称…", systemImage: "square.and.pencil", action: edit)
        Button("复制地址", systemImage: "doc.on.doc") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(server.address, forType: .string)
        }
        Divider()
        Button("从列表中移除", systemImage: "trash", role: .destructive, action: forget)
    }
}

/// 卡片背景：比窗口背景略亮（深色模式下略浅），带细描边和柔和的阴影
private struct Card: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        shape
            .fill(scheme == .dark ? Color.white.opacity(0.05) : Color(nsColor: .controlBackgroundColor))
            .overlay(shape.strokeBorder(Color.primary.opacity(scheme == .dark ? 0.1 : 0.08)))
            .shadow(color: .black.opacity(scheme == .dark ? 0.2 : 0.04), radius: 10, y: 4)
    }
}

/// 窗口背景：顶部一层淡淡的品牌色光晕
private struct Backdrop: View {
    var body: some View {
        ZStack(alignment: .top) {
            Color(nsColor: .windowBackgroundColor)
            RadialGradient(colors: [Color.accentColor.opacity(0.16), .clear], center: .top, startRadius: 0, endRadius: 420)
                .scaleEffect(x: 2.2, y: 1, anchor: .top)
                .frame(height: 420)
        }
        .ignoresSafeArea()
    }
}

private extension View {
    /// 主页左上角已经有标识，不再显示窗口标题，标题栏透明（背景延伸上去）。macOS 14 没有这些接口，保留标题
    @ViewBuilder func hideWindowTitle() -> some View {
        if #available(macOS 15.0, *) {
            toolbar(removing: .title)
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        } else {
            self
        }
    }
}
