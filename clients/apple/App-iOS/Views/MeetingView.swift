import HaneCore
import HaneMedia
import SwiftUI

/// iOS 会议主界面：舞台 + 底部控制栏；成员、聊天、设置以底部面板展示。
struct MeetingView: View {
    @Environment(AppModel.self) private var model
    @State private var sheet: Sheet?
    @State private var welcomeDismissed = false

    enum Sheet: String, Identifiable {
        case members, chat, settings, redeem, info, share
        var id: String { rawValue }
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            VStack(spacing: 0) {
                if model.media.isSharing { LivePhoneShareBar() }
                if !welcomeDismissed, !model.session.state.serverInfo.welcomeMessage.isEmpty {
                    WelcomeCard(message: model.session.state.serverInfo.welcomeMessage) {
                        withAnimation(.snappy(duration: 0.25)) { welcomeDismissed = true }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
                PhoneStageView()
                    .background(PiPAnchor())
                    .overlay(alignment: .top) { StatusBanner() }
                ControlBar(sheet: $sheet)
            }
            // 顶栏显示的是下面的自定义标题；这里的标题用于 iPad 的窗口和应用切换器
            .navigationTitle(model.meetingTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        sheet = .members
                    } label: {
                        Label("成员", systemImage: "person.2")
                    }
                    .accessibilityIdentifier("members")
                }
                // 顶栏：当前房间名，点按弹出房间和成员；下面一行是服务器名称
                ToolbarItem(placement: .principal) {
                    let state = model.session.state
                    Button { sheet = .members } label: {
                        VStack(spacing: 1) {
                            HStack(spacing: 3) {
                                Text(state.roomName(state.media?.roomID ?? "main")).font(.headline).lineLimit(1)
                                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                            }
                            Text(verbatim: model.meetingTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel([state.roomName(state.media?.roomID ?? "main"), model.meetingTitle].joined(separator: ", "))
                    .accessibilityHint("房间与成员")
                }
                ToolbarItem(placement: .topBarTrailing) { E2EEBadge() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { Task { await model.leave() } } label: {
                        Label("离开", systemImage: "phone.down.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .accessibilityIdentifier("leave")
                }
            }
        }
        .sheet(item: $sheet) { s in
            Group {
                switch s {
                case .members: MembersSheet()
                case .chat: NavigationStack { ChatView().navigationTitle("聊天").navigationBarTitleDisplayMode(.inline) }
                case .settings: SettingsSheet(sheet: $sheet)
                case .redeem: ScrollView { RedeemView(initialToken: model.linkToken ?? "") }
                case .info: ScrollView { ConnectionInfoView() }
                case .share: ShareOptionsSheet()
                }
            }
            .environment(model)
            .presentationDetents(s == .share || s == .redeem || s == .info ? [.medium] : [.medium, .large])
        }
        .onAppear { if model.linkToken != nil { sheet = .redeem } }
        .onChange(of: model.linkToken) { _, t in if t != nil { sheet = .redeem } }
        .onChange(of: sheet) { _, s in if s == .chat { model.unread = 0 } }
        .onChange(of: model.media.shareFailure) { _, f in
            guard let f else { return }
            model.notice = f.code == .permissionDenied ? L("服务器不允许你共享屏幕") : f.code == .shareLimitReached ? L("同时共享的人数已达上限") : describe(f)
            model.media.shareFailure = nil
        }
        .onAppear {
            model.chatOpen = false
            // 开发检查：HANE_OPEN_SHEET=members 等，进入会议后直接打开对应面板（模拟器截图用）
            if let name = DevHooks.environment["HANE_OPEN_SHEET"], let s = Sheet(rawValue: name) { sheet = s }
        }
        .onChange(of: model.media.lastSwitch) { _, sw in if sw?.shareStopped == true { model.notice = L("切换房间后屏幕共享已停止") } }
    }
}

/// 舞台：有人共享时以共享画面为焦点；否则成员画面铺满舞台，
/// 人多到画面太小时改为可滚动的两列。
struct PhoneStageView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let state = model.session.state
        let roomID = state.media?.roomID ?? "main"
        let shares = state.rooms[roomID]?.shares ?? []
        if shares.isEmpty {
            let members = state.members(of: roomID)
            GeometryReader { geo in
                let pad: CGFloat = 12
                let gap: CGFloat = 10
                if members.count <= 1 {
                    alone(members.first)
                } else if let g = StageGrid.fill(count: members.count, width: geo.size.width - pad * 2, height: geo.size.height - pad * 2, gap: gap) {
                    let rows = stride(from: 0, to: members.count, by: g.columns).map { Array(members[$0 ..< min($0 + g.columns, members.count)]) }
                    VStack(spacing: gap) {
                        ForEach(rows.indices, id: \.self) { r in
                            HStack(spacing: gap) {
                                ForEach(rows[r], id: \.sessionID) { p in
                                    ParticipantTile(p: p).frame(width: g.width, height: g.height)
                                }
                            }
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: gap), GridItem(.flexible(), spacing: gap)], spacing: gap) {
                            ForEach(members, id: \.sessionID) { p in
                                ParticipantTile(p: p).frame(height: 160)
                            }
                        }
                        .padding(pad)
                    }
                }
            }
        } else {
            PhoneShareStage(shares: shares)
        }
    }

    /// 只有自己：大头像（开了摄像头时是自己的画面）和提示，不用一整块画面
    private func alone(_ p: Participant?) -> some View {
        VStack(spacing: 16) {
            if let p {
                if model.media.videoTracks.contains(where: { !$0.isScreen && $0.identity == p.mediaIdentity }) {
                    ParticipantTile(p: p).aspectRatio(3 / 4, contentMode: .fit).frame(maxWidth: 260)
                } else {
                    AvatarView(name: p.nickname, uid: p.uid, speaking: model.media.speaking.contains(p.mediaIdentity), size: 96)
                }
            }
            Text("只有你在这里。把服务器地址发给其他人吧。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 底部控制栏：麦克风、摄像头、共享、聊天、更多。圆形按钮，状态一眼可见：静音是红色，
/// 摄像头开着 / 正在共享时高亮，正在说话时麦克风外圈变绿；按键说话模式下上方是一个大的「按住说话」按钮。
struct ControlBar: View {
    @Environment(AppModel.self) private var model
    @Binding var sheet: MeetingView.Sheet?
    @State private var pttPressed = false

    var body: some View {
        VStack(spacing: 12) {
            if model.voiceMode == .ptt { pttButton }
            HStack(alignment: .top, spacing: 0) {
                let muted = model.media.micMuted
                CircleControl(title: muted ? L("取消静音") : L("静音"), icon: muted ? "mic.slash.fill" : "mic.fill",
                              fill: muted ? .red : nil,
                              ring: !muted && model.media.transmitting && model.voiceMode != .open ? .green : nil) {
                    Task { await model.setMuted(!muted) }
                }
                .accessibilityIdentifier("mute")
                let camOn = model.media.cameraOn
                CircleControl(title: camOn ? L("关闭摄像头") : L("开启摄像头"), caption: L("摄像头"), icon: camOn ? "video.fill" : "video.slash.fill",
                              fill: camOn ? .accentColor : nil) {
                    Task { await model.media.setCameraEnabled(!camOn) }
                }
                let sharing = model.media.isSharing
                CircleControl(title: sharing ? L("停止共享") : L("共享屏幕"), caption: sharing ? L("停止共享") : L("共享"),
                              icon: sharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle", fill: sharing ? .red : nil) {
                    if sharing { Task { await model.media.stopScreenShare() } } else { sheet = .share }
                }
                .accessibilityIdentifier("share")
                CircleControl(title: L("聊天"), icon: "bubble.left.and.bubble.right.fill", badge: model.unread) {
                    sheet = .chat
                }
                CircleControl(title: L("更多"), icon: "ellipsis") { sheet = .settings }
            }
            .padding(.horizontal, 6)
        }
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private var pttButton: some View {
        Text(pttPressed ? "正在说话…" : "按住说话")
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .foregroundStyle(pttPressed ? .white : .primary)
            .background {
                if pttPressed {
                    Capsule().fill(Color.green)
                } else if #available(iOS 26.0, *) {
                    Color.clear.glassEffect(.regular.interactive(), in: .capsule)
                } else {
                    Capsule().fill(.thinMaterial)
                }
            }
            .scaleEffect(pttPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.15), value: pttPressed)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pttPressed { pttPressed = true; model.media.setPushToTalk(true) }
                }
                .onEnded { _ in
                    pttPressed = false
                    model.media.setPushToTalk(false)
                })
            .sensoryFeedback(.impact, trigger: pttPressed)
            .accessibilityAddTraits(.isButton)
            .padding(.horizontal, 16)
    }
}

/// 控制栏上的圆形按钮：图标在圆里，下面是简短的名称（caption，不填时用 title；读屏读 title）。
/// fill 是开启 / 警示状态的底色（图标随之变白），ring 是外圈
private struct CircleControl: View {
    let title: String
    var caption: String?
    let icon: String
    var fill: Color?
    var ring: Color?
    var badge = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(fill == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
                    .frame(width: 54, height: 54)
                    .background { circle }
                    .overlay {
                        if let ring { Circle().strokeBorder(ring, lineWidth: 2.5) }
                    }
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text(badge > 99 ? "99+" : "\(badge)")
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .frame(minWidth: 18, minHeight: 18)
                                .background(Capsule().fill(.red))
                                .offset(x: 4, y: -2)
                        }
                    }
                    .contentTransition(.symbolEffect(.replace))
                Text(caption ?? title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .animation(.snappy(duration: 0.2), value: fill)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(badge > 0 ? Text(verbatim: "\(badge)") : Text(verbatim: ""))
    }

    @ViewBuilder private var circle: some View {
        if let fill {
            Circle().fill(fill)
        } else if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular.interactive(), in: .circle)
        } else {
            Circle().fill(Color(.secondarySystemFill))
        }
    }
}

/// 成员面板：按房间分组。点按房间标题进入（有密码时输入密码），点按成员调整音量，长按成员是主持操作；
/// 主持人可以新建房间、全员召回，长按房间标题是房间设置 / 全员静音 / 关闭。
struct MembersSheet: View {
    @Environment(AppModel.self) private var model
    @State private var expanded: String?
    @State private var editing: RoomEditTarget?
    @State private var passwordRoom: Room?
    @State private var password = ""
    @State private var moderating: ModerationTarget?

    struct RoomEditTarget: Identifiable {
        let room: Room?
        var id: String { room?.id ?? "new" }
    }

    struct ModerationTarget: Identifiable {
        let p: Participant
        let kind: ModerationSheet.Kind
        var id: String { p.sessionID + "\(kind)" }
    }

    var body: some View {
        let state = model.session.state
        let perms = state.permissions
        let current = state.media?.roomID ?? "main"
        NavigationStack {
            List {
                ForEach(state.sortedRooms, id: \.id) { room in
                    let members = state.members(of: room.id)
                    Section {
                        ForEach(members, id: \.sessionID) { p in memberRow(p, isSelf: p.sessionID == state.me?.sessionID) }
                    } header: {
                        roomHeader(room, count: members.count, current: room.id == current, manage: perms.canManage(room))
                    }
                }
            }
            .navigationTitle("成员")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if perms.isModerator, state.rooms.values.contains(where: { $0.kind == .temporary }) {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { run { _ = try await model.session.recallAll() } } label: { Label("全员返回主会议", systemImage: "arrow.uturn.backward") }
                    }
                }
                if perms.canCreateRoom {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { editing = RoomEditTarget(room: nil) } label: { Label("新建房间", systemImage: "plus") }
                    }
                }
            }
            .sheet(item: $editing) { t in NavigationStack { RoomEditorView(room: t.room) }.environment(model) }
            .sheet(item: $moderating) { t in NavigationStack { ModerationSheet(target: t.p, kind: t.kind) }.environment(model).presentationDetents([.medium]) }
            .alert(L("进入「\(passwordRoom?.name ?? "")」"), isPresented: Binding(get: { passwordRoom != nil }, set: { if !$0 { passwordRoom = nil } })) {
                SecureField("密码", text: $password)
                Button("进入") {
                    let id = passwordRoom?.id ?? ""
                    let pw = password
                    password = ""
                    run { try await model.session.joinRoom(id, password: pw) }
                }
                Button("取消", role: .cancel) { password = "" }
            }
        }
    }

    private func roomHeader(_ room: Room, count: Int, current: Bool, manage: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: current ? "speaker.wave.2.fill" : room.kind == .main ? "house" : "rectangle.3.group")
                .foregroundStyle(current ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
            Text(model.session.state.roomName(room.id))
                .foregroundStyle(current ? .primary : .secondary)
            if room.hasPassword_p { Image(systemName: "key.fill") }
            if room.locked { Image(systemName: "lock.fill") }
            if room.e2Ee { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green) }
            Text(room.capacity > 0 ? "· \(count)/\(room.capacity)" : L("· \(count) 人"))
            Spacer()
            if !current {
                Button("进入") { enter(room, manage: manage) }.font(.caption.weight(.semibold)).buttonStyle(.bordered).controlSize(.mini)
            }
        }
        .contextMenu {
            if manage {
                Button { editing = RoomEditTarget(room: room) } label: { Label("房间设置…", systemImage: "slider.horizontal.3") }
                Button { run { let n = try await model.session.muteAll(room.id); model.notice = L("已静音 \(n) 人") } } label: { Label("全员静音", systemImage: "speaker.slash") }
                if room.kind == .temporary {
                    Button(role: .destructive) { run { try await model.session.closeRoom(room.id) } } label: { Label("关闭房间", systemImage: "trash") }
                }
            }
        }
    }

    private func memberRow(_ p: Participant, isSelf: Bool) -> some View {
        VStack(alignment: .leading) {
            HStack(spacing: 10) {
                AvatarView(name: p.nickname, uid: p.uid, speaking: model.media.speaking.contains(p.mediaIdentity), size: 32, dimmed: p.reconnecting)
                Text(p.nickname).lineLimit(1)
                if isSelf { YouTag() }
                Spacer()
                RoleBadge(role: p.role)
                StatusIcons(p: p)
            }
            if expanded == p.sessionID, !isSelf {
                let v = model.media.volumes[p.mediaIdentity] ?? 1
                HStack {
                    Image(systemName: "speaker.wave.1")
                    Slider(value: Binding(get: { v }, set: { model.media.setVolume($0, for: p.mediaIdentity) }), in: 0 ... 2, step: 0.05)
                    Text("\(Int(v * 100))%").font(.caption.monospacedDigit()).frame(width: 44)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if !isSelf { withAnimation { expanded = expanded == p.sessionID ? nil : p.sessionID } } }
        .contextMenu { ModerationMenuItems(p: p) { kind in moderating = ModerationTarget(p: p, kind: kind) } }
    }

    private func enter(_ room: Room, manage: Bool) {
        if room.hasPassword_p, !manage { passwordRoom = room } else { run { try await model.session.joinRoom(room.id) } }
    }

    private func run(_ f: @escaping () async throws -> Void) {
        Task {
            do { try await f() } catch let e as HaneError { model.notice = describe(e) } catch {}
        }
    }
}

/// 更多：自己的信息、发言方式、麦克风模式、权限令牌、连接信息
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Binding var sheet: MeetingView.Sheet?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                if let me = model.session.state.selfParticipant {
                    Section {
                        HStack(spacing: 12) {
                            AvatarView(name: me.nickname, uid: me.uid, speaking: model.media.transmitting && !model.media.micMuted, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 4) {
                                    Text(me.nickname).font(.headline).lineLimit(1)
                                    RoleBadge(role: me.role).font(.subheadline)
                                }
                                Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
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
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.noiseSuppression.detail)
                            Text(model.media.noiseState.label).foregroundStyle(model.media.noiseState.isWarning ? .orange : .secondary)
                        }
                    }
                }
                Section {
                    Button { model.showMicrophoneModes() } label: {
                        Label("麦克风模式（语音突显）…", systemImage: "waveform")
                    }
                    let deaf = model.media.deafened
                    Toggle(isOn: Binding(get: { deaf }, set: { v in Task { await model.setDeafened(v) } })) {
                        Label("关闭声音", systemImage: deaf ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    }
                    let raised = model.session.state.selfParticipant?.state.handRaised ?? false
                    Toggle(isOn: Binding(get: { raised }, set: { v in Task { try? await model.session.updateSelf(handRaised: v) } })) {
                        Label("举手", systemImage: raised ? "hand.raised.fill" : "hand.raised")
                    }
                }
                Section {
                    Button { sheet = .redeem } label: { Label("使用权限令牌…", systemImage: "key") }
                    Button { sheet = .info } label: { Label("连接信息", systemImage: "info.circle") }
                    NavigationLink { AboutView() } label: { Label("关于羽见", systemImage: "questionmark.circle") }
                }
            }
            .navigationTitle("更多")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    /// 服务器名称和控制连接延迟
    private var detail: String {
        let name = model.meetingTitle
        guard let rtt = model.session.rttMs else { return name }
        return "\(name) · \(rtt) ms"
    }
}
