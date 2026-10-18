import HaneCore
import SwiftUI

/// 连接页：输入地址 → 输入昵称 → 连接。最近连接在下方，点一下即可连接，左滑移除。
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var showAbout = false
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
        @Bindable var model = model
        Form {
            Section {
            } header: {
                BrandHeader(markSize: 72)
                    .textCase(nil)
                    .foregroundStyle(.primary)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
            }

            if model.linkInvite != nil {
                Section {
                    InviteBanner()
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            Section {
                HStack(spacing: 12) {
                    Image(systemName: "server.rack")
                        .foregroundStyle(.secondary)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    TextField("服务器地址", text: $address, prompt: Text("例如 meet.example.com 或 203.0.113.10:9800"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .address)
                        .submitLabel(.next)
                        .accessibilityIdentifier("address")
                    if let a = try? ServerAddress.parse(address) {
                        Image(systemName: a.secure ? "lock.fill" : "lock.open.fill")
                            .font(.footnote)
                            .foregroundStyle(a.secure ? Color.green : Color.orange)
                            .accessibilityLabel(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
                    }
                }
                HStack(spacing: 12) {
                    NicknameAvatar(name: model.nickname, size: 24)
                        .frame(width: 24)
                    TextField("昵称", text: $model.nickname, prompt: Text("其他人看到的名字"))
                        .textContentType(.nickname)
                        .focused($focus, equals: .nickname)
                        .submitLabel(needsPassword ? .next : .go)
                        .accessibilityIdentifier("nickname")
                }
                if needsPassword {
                    HStack(spacing: 12) {
                        Image(systemName: "key.fill")
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                            .accessibilityHidden(true)
                        SecureField("服务器密码", text: $password, prompt: Text("向服务器管理员索取"))
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .accessibilityIdentifier("password")
                    }
                }
            } header: {
                Text("连接到服务器")
            } footer: {
                if ServerAddress.isInsecure(address) {
                    Text("未加密的连接（http://），只建议在本机或内网测试时使用。")
                }
            }

            if let err = model.connectError {
                Section {
                    ConnectErrorView(error: err)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            Section {
                Button { connect() } label: {
                    HStack(spacing: 8) {
                        if busy {
                            ProgressView()
                            Text("正在连接…")
                        } else {
                            Text("连接")
                            Image(systemName: "arrow.right")
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canConnect)
                .accessibilityIdentifier("connect")
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            if !model.recentServers.isEmpty {
                Section("最近连接") {
                    ForEach(model.recentServers) { server in
                        Button { pick(server) } label: {
                            RecentServerLabel(server: server)
                        }
                        .tint(.primary)
                        .disabled(busy)
                        .swipeActions {
                            Button("移除", role: .destructive) { model.forget(server) }
                        }
                        .contextMenu {
                            Button("连接", systemImage: "arrow.right.circle") { pick(server) }
                            Button("复制地址", systemImage: "doc.on.doc") { UIPasteboard.general.string = server.address }
                            Button("从最近连接中移除", systemImage: "trash", role: .destructive) { model.forget(server) }
                        }
                        .accessibilityIdentifier("recent-server")
                    }
                }
            }

            Section {
            } footer: {
                VStack(spacing: 10) {
                    Label("你的身份保存在钥匙串中，并通过 iCloud 钥匙串在你的设备之间同步。", systemImage: "checkmark.shield")
                    Button("关于羽见") { showAbout = true }
                        .accessibilityIdentifier("about-open")
                }
                .font(.footnote)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
            }
        }
        .sheet(isPresented: $showAbout) {
            NavigationStack {
                AboutView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showAbout = false } } }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        // iPad 上表单不必铺满整个宽度
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .background(Backdrop())
        .animation(.snappy(duration: 0.25), value: needsPassword)
        .animation(.snappy(duration: 0.25), value: model.connectError)
        .onSubmit {
            switch focus {
            case .address: focus = .nickname
            case .nickname where needsPassword && password.isEmpty: focus = .password
            default: connect()
            }
        }
        .onChange(of: model.linkAddress) { _, a in if let a { address = a } }
        .onAppear {
            if let a = model.linkAddress { address = a }
            if address.isEmpty { address = model.recentServers.first?.address ?? "" }
        }
        .onChange(of: model.connectError) { _, err in
            if err?.code == .passwordRequired || err?.code == .passwordInvalid {
                showPassword = true
                focus = .password
            }
        }
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
        focus = nil
        Task { await model.connect(address: a, password: password) }
    }
}

/// 背景：分组背景色，顶部一层淡淡的品牌色光晕
private struct Backdrop: View {
    var body: some View {
        ZStack(alignment: .top) {
            Color(.systemGroupedBackground)
            RadialGradient(colors: [Color.accentColor.opacity(0.18), .clear], center: .top, startRadius: 0, endRadius: 360)
                .scaleEffect(x: 1.6, y: 1, anchor: .top)
                .frame(height: 360)
        }
        .ignoresSafeArea()
    }
}
