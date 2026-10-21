import AVKit
import HaneCore
import HaneMedia
import SwiftUI

/// 主页：上方是地址栏（连接按钮在框内右侧），下面是服务器列表，点一下即可连接。
/// 收藏的排在最前面；点星星收藏，左滑移除，长按可以改备注和昵称。还缺昵称或服务器密码时先弹出对话框补上。右上角是设置。
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var address = ""
    @State private var connectingTo = ""
    @State private var join: JoinTarget?
    @State private var editing: RecentServer?
    @State private var showSettings = false
    @FocusState private var addressFocused: Bool

    private var busy: Bool { model.session.status == .connecting }
    private var query: AddressQuery { AddressQuery(address, model: model) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    addressBar
                } header: {
                    HStack {
                        BrandBar(markSize: 30)
                        Spacer()
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape")
                                .font(.title3)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("设置")
                        .accessibilityIdentifier("home-settings")
                    }
                    .textCase(nil)
                    .foregroundStyle(.primary)
                    .padding(.trailing, -10)
                    .padding(.bottom, 6)
                } footer: {
                    if query.isAddress, ServerAddress.isInsecure(address) {
                        Text("未加密的连接（http://），只建议在本机或内网测试时使用。")
                    }
                }

                if model.linkInvite != nil || (model.connectError != nil && join == nil) {
                    Section {
                        if model.linkInvite != nil { InviteBanner() }
                        if let err = model.connectError, join == nil { ConnectErrorView(error: err) }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }

                if !model.recentServers.isEmpty {
                    if query.shown.isEmpty {
                        Section {
                        } footer: {
                            Text("列表里没有匹配的服务器，按回车连接这个地址。")
                        }
                    } else {
                        Section("服务器列表") { rows(query.shown) }
                    }
                }
                if model.recentServers.isEmpty {
                    Section {
                        VStack(spacing: 8) {
                            Image(systemName: "server.rack")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            Text("还没有服务器").font(.callout.weight(.medium))
                            Text("在上方输入服务器地址开始连接；连接过的服务器会显示在这里，可以收藏和加备注。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                        .accessibilityElement(children: .combine)
                    }
                }

                Section {
                } footer: {
                    Label("你的身份保存在钥匙串中，并通过 iCloud 钥匙串在你的设备之间同步。", systemImage: "checkmark.shield")
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            // iPad 上列表不必铺满整个宽度
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
            .background(Backdrop())
            .toolbar(.hidden, for: .navigationBar)
            .animation(.snappy(duration: 0.25), value: model.connectError)
            .animation(.snappy(duration: 0.25), value: model.recentServers)
        }
        .sheet(item: $join) { JoinSheet(target: $0) }
        .sheet(item: $editing) { EditServerSheet(server: $0) }
        .sheet(isPresented: $showSettings) { HomeSettingsSheet() }
        .task { await model.watchServerStatus() }
        .onChange(of: model.linkAddress) { _, a in if let a { address = a } }
        .onAppear {
            if let a = model.linkAddress {
                address = a
                addressFocused = true
            }
        }
    }

    // MARK: 地址栏

    private var addressBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "server.rack")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("搜索或输入服务器地址", text: $address, prompt: Text("搜索或输入服务器地址"))
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($addressFocused)
                .onSubmit { open(query.target) }
                .accessibilityIdentifier("address")
            if query.isAddress, let a = try? ServerAddress.parse(address) {
                Image(systemName: a.secure ? "lock.fill" : "lock.open.fill")
                    .font(.footnote)
                    .foregroundStyle(a.secure ? Color.green : Color.orange)
                    .accessibilityLabel(a.secure ? L("加密连接") : L("未加密的连接（http://），只建议在本机或内网测试时使用。"))
            }
            Button { open(query.target) } label: {
                if busy, connectingTo == query.target {
                    ProgressView()
                } else {
                    Text("连接").fontWeight(.semibold)
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("connect")
        }
        .padding(.vertical, 2)
    }

    // MARK: 服务器列表

    private func rows(_ servers: [RecentServer]) -> some View {
        ForEach(servers) { server in
            let status = model.serverStatus[server.address]
            // 两个按钮都用 borderless：列表行里点哪个就只触发哪个
            HStack(spacing: 4) {
                Button { open(server.address) } label: {
                    ServerRowLabel(server: server, nickname: model.nickname(for: server.address), status: status,
                                   logo: model.serverLogos[server.address],
                                   connecting: busy && connectingTo == server.address, showsTime: sizeClass != .compact)
                }
                .buttonStyle(.borderless)
                .tint(.primary)
                .disabled(busy)
                FavoriteStar(favorite: server.favorite) { model.toggleFavorite(server) }
                    .padding(.trailing, -6)
            }
            .swipeActions(edge: .trailing) {
                Button("移除", role: .destructive) { model.forget(server) }
            }
            .swipeActions(edge: .leading) {
                Button(server.favoriteAction, systemImage: server.favoriteIcon) { model.toggleFavorite(server) }
                    .tint(.yellow)
            }
            .contextMenu {
                Section(SignalBars.label(status)) {
                    Button("连接", systemImage: "arrow.right.circle") { open(server.address) }
                    Button(server.favoriteAction, systemImage: server.favoriteIcon) { model.toggleFavorite(server) }
                    Button("备注和昵称…", systemImage: "square.and.pencil") { editing = server }
                    Button("复制地址", systemImage: "doc.on.doc") { UIPasteboard.general.string = server.address }
                }
                Button("从列表中移除", systemImage: "trash", role: .destructive) { model.forget(server) }
            }
            .accessibilityIdentifier("recent-server")
        }
    }

    private func open(_ target: String) {
        let a = target.trimmingCharacters(in: .whitespaces)
        guard !busy, !a.isEmpty else { return }
        addressFocused = false
        connectingTo = a
        Task {
            join = await model.open(a)
            connectingTo = ""
        }
    }
}

/// 主页的设置：发言方式、降噪、回声消除、音频输出（进入会议前就能调好）
private struct HomeSettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    Picker("发言方式", selection: $model.voiceMode) {
                        Text("语音激活").tag(VoiceMode.voice)
                        Text("按住说话").tag(VoiceMode.ptt)
                        Text("常开").tag(VoiceMode.open)
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text("语音激活：说话时自动发送，并过滤键盘声等噪声。")
                }
                if MediaSession.aiNoiseAvailable {
                    Section {
                        Picker("降噪", selection: $model.noiseSuppression) {
                            ForEach(NoiseSuppression.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                    } footer: {
                        Text(model.noiseSuppression.detail)
                    }
                }
                Section {
                    Picker("回声消除", selection: $model.echoProcessing) {
                        ForEach(EchoProcessing.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                } footer: {
                    Text(model.echoProcessing.detail)
                }
                Section {
                    HStack {
                        Text("音频输出")
                        Spacer()
                        RoutePicker().frame(width: 32, height: 32)
                    }
                    Button { model.showMicrophoneModes() } label: {
                        Label("麦克风模式（语音突显）…", systemImage: "waveform")
                    }
                } footer: {
                    Text("麦克风和扬声器跟随系统：接上耳机或连上蓝牙设备后自动切换。")
                }
                Section {
                    NavigationLink { AboutView() } label: { Label("关于羽见", systemImage: "questionmark.circle") }
                        .accessibilityIdentifier("about-open")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
    }
}

/// 系统的音频输出选择按钮（扬声器、耳机、AirPlay）
private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context _: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.prioritizesVideoDevices = false
        return v
    }

    func updateUIView(_: AVRoutePickerView, context _: Context) {}
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
