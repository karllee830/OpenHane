import AppKit
import HaneCore
import SwiftUI

/// 连接页：输入地址 → 输入昵称 → 连接。
/// 有最近连接、窗口又够宽时分成两栏（与 Xcode 的欢迎窗口相同：左边是操作，右边是最近项目）。
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var password = ""
    @State private var showPassword = false
    @FocusState private var focus: Field?
    private enum Field { case address, nickname, password }

    private var busy: Bool { model.session.status == .connecting }
    private var needsPassword: Bool {
        showPassword || model.connectError?.code == .passwordRequired || model.connectError?.code == .passwordInvalid
            // 已知需要密码的服务器直接显示密码框，不必先失败一次；邀请链接免密码
            || (model.linkInvite == nil && model.recentServer(for: address)?.needsPassword == true)
    }
    private var canConnect: Bool {
        !busy && !address.trimmingCharacters(in: .whitespaces).isEmpty && !model.nickname.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                let twoColumns = geo.size.width >= 860 && !model.recentServers.isEmpty
                VStack(spacing: 28) {
                    BrandHeader()
                    if twoColumns {
                        HStack(alignment: .top, spacing: 20) {
                            form.frame(width: 400)
                            recents.frame(width: 340)
                        }
                    } else {
                        VStack(spacing: 16) {
                            form
                            if !model.recentServers.isEmpty { recents }
                        }
                        .frame(maxWidth: 420)
                    }
                    Label("你的身份保存在钥匙串中，并通过 iCloud 钥匙串在你的设备之间同步。", systemImage: "checkmark.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 32)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
                .animation(.snappy(duration: 0.25), value: needsPassword)
                .animation(.snappy(duration: 0.25), value: model.connectError)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Backdrop())
        .onChange(of: model.linkAddress) { _, a in if let a { address = a } }
        .onAppear {
            if let a = model.linkAddress { address = a }
            if address.isEmpty { address = model.recentServers.first?.address ?? "" }
            focus = address.isEmpty ? .address : model.nickname.trimmingCharacters(in: .whitespaces).isEmpty ? .nickname : needsPassword ? .password : .nickname
        }
        .onChange(of: model.connectError) { _, err in
            if err?.code == .passwordRequired || err?.code == .passwordInvalid {
                showPassword = true
                focus = .password
            }
        }
    }

    // MARK: 连接表单

    private var form: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text("连接到服务器")
                    .font(.title3.weight(.semibold))
                Text("填写服务器地址和昵称即可加入，不需要注册。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.linkInvite != nil { InviteBanner() }

            labeled("服务器地址") {
                InputBox(focused: focus == .address) {
                    Image(systemName: "server.rack").foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
                    TextField("服务器地址", text: $address, prompt: Text("例如 meet.example.com 或 203.0.113.10:9800"))
                        .focused($focus, equals: .address)
                        .accessibilityIdentifier("address")
                    if let a = try? ServerAddress.parse(address) {
                        Image(systemName: a.secure ? "lock.fill" : "lock.open.fill")
                            .foregroundStyle(a.secure ? Color.green : Color.orange)
                            .help(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
                            .accessibilityLabel(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
                    }
                }
            }
            if ServerAddress.isInsecure(address) {
                Text("未加密的连接（http://），只建议在本机或内网测试时使用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, -8)
            }

            labeled("昵称") {
                InputBox(focused: focus == .nickname) {
                    NicknameAvatar(name: model.nickname).frame(width: 20)
                    TextField("昵称", text: $model.nickname, prompt: Text("其他人看到的名字"))
                        .focused($focus, equals: .nickname)
                        .accessibilityIdentifier("nickname")
                }
            }

            if needsPassword {
                labeled("服务器密码") {
                    InputBox(focused: focus == .password) {
                        Image(systemName: "key.fill").foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
                        SecureField("服务器密码", text: $password, prompt: Text("向服务器管理员索取"))
                            .focused($focus, equals: .password)
                            .accessibilityIdentifier("password")
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if let err = model.connectError {
                ConnectErrorView(error: err)
                    .transition(.opacity)
            }

            Button { connect() } label: {
                HStack(spacing: 6) {
                    if busy {
                        ProgressView().controlSize(.small)
                        Text("正在连接…")
                    } else {
                        Text("连接")
                        Image(systemName: "arrow.right")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.extraLarge)
            .keyboardShortcut(.defaultAction)
            .disabled(!canConnect)
            .accessibilityIdentifier("connect")
        }
        .textFieldStyle(.plain)
        .onSubmit { connect() }
        .padding(24)
        .background(Card())
    }

    private func labeled(_ title: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout.weight(.medium))
            content()
        }
    }

    // MARK: 最近连接

    private var recents: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("最近连接", systemImage: "clock.arrow.circlepath")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 4)
            ForEach(model.recentServers) { server in
                RecentServerRow(server: server, disabled: busy, connect: { pick(server) }, forget: { model.forget(server) })
            }
        }
        .padding(12)
        .background(Card())
    }

    /// 点一下最近连接直接连接；还缺昵称或密码时先补上
    private func pick(_ server: RecentServer) {
        address = server.address
        if model.nickname.trimmingCharacters(in: .whitespaces).isEmpty {
            focus = .nickname
        } else if server.needsPassword, model.linkInvite == nil, password.isEmpty {
            focus = .password
        } else {
            connect(to: server.address)
        }
    }

    private func connect(to target: String? = nil) {
        let a = (target ?? address).trimmingCharacters(in: .whitespaces)
        guard !busy, !a.isEmpty, !model.nickname.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        Task { await model.connect(address: a, password: password) }
    }
}

/// 带图标的输入框：图标在框内左侧，获得焦点时描边变成强调色
private struct InputBox<Content: View>: View {
    var focused: Bool
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 8) { content }
            .focusEffectDisabled()
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: focused ? 1.5 : 1)
            }
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(Color.accentColor.opacity(focused ? 0.25 : 0), lineWidth: 3.5)
                    .padding(-2)
            }
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}

/// 最近连接的一行：悬停时高亮并显示「移除」，右键菜单可以拷贝地址
private struct RecentServerRow: View {
    let server: RecentServer
    let disabled: Bool
    let connect: () -> Void
    let forget: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: connect) {
            RecentServerLabel(server: server)
                .padding(.vertical, 6)
                .padding(.leading, 8)
                .padding(.trailing, 32)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(hovering && !disabled ? 0.1 : 0))
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .overlay(alignment: .trailing) {
            if hovering {
                Button(action: forget) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .padding(.trailing, 8)
                .help("从最近连接中移除")
                .accessibilityLabel("从最近连接中移除")
            }
        }
        .onHover { hovering = $0 }
        .help(server.address)
        .contextMenu {
            Button("连接", action: connect).disabled(disabled)
            Button("复制地址") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(server.address, forType: .string)
            }
            Divider()
            Button("从最近连接中移除", role: .destructive, action: forget)
        }
        .accessibilityAction(named: Text("从最近连接中移除"), forget)
        .accessibilityIdentifier("recent-server")
    }
}

/// 卡片背景：比窗口背景略亮（深色模式下略浅），带细描边和柔和的阴影
private struct Card: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        shape
            .fill(scheme == .dark ? Color.white.opacity(0.05) : Color(nsColor: .controlBackgroundColor))
            .overlay(shape.strokeBorder(Color.primary.opacity(scheme == .dark ? 0.1 : 0.08)))
            .shadow(color: .black.opacity(scheme == .dark ? 0.25 : 0.06), radius: 14, y: 6)
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
