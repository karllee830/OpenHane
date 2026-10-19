import HaneCore
import HaneMedia
import SwiftUI

/// 会议主界面：侧栏成员 | 舞台 | 聊天（检查器），工具栏是控制栏。
struct MeetingView: View {
    @Environment(AppModel.self) private var model
    @State private var sheet: Sheet?
    @State private var welcomeDismissed = false

    enum Sheet: String, Identifiable {
        case redeem, admin, info
        var id: String { rawValue }
    }

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            VStack(spacing: 0) {
                if model.media.isSharing { LiveShareBar() }
                if !welcomeDismissed, !model.session.state.serverInfo.welcomeMessage.isEmpty {
                    WelcomeCard(message: model.session.state.serverInfo.welcomeMessage) {
                        withAnimation(.snappy(duration: 0.25)) { welcomeDismissed = true }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
                StageView()
                    .overlay(alignment: .top) { StatusBanner() }
                if model.voiceMode == .ptt {
                    Text(model.hotkeyAvailable ? L("按住 \(model.pttBinding.label) 说话") : L("全局按键说话需要「输入监控」权限：系统设置 → 隐私与安全性 → 输入监控"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 8)
                }
            }
            .inspector(isPresented: $model.chatOpen) {
                ChatView().inspectorColumnWidth(min: 260, ideal: 320, max: 480)
            }
        }
        .navigationTitle(model.session.state.serverInfo.name)
        .toolbar { ControlBar(sheet: $sheet) }
        .sheet(item: $sheet) { s in
            switch s {
            case .redeem: RedeemView(initialToken: model.linkToken ?? "")
            case .admin: AdminView()
            case .info: ConnectionInfoView()
            }
        }
        .onAppear { if model.linkToken != nil { sheet = .redeem } }
        .task { await model.media.refreshAudioDevices() }
        .task {
            // 截图检查：HANE_SNAPSHOT_SHEET=admin|info|redeem 进入会议 4 秒后（截图工具兑换完权限令牌之后）打开对应的面板
            guard let s = DevHooks.environment["HANE_SNAPSHOT_SHEET"].flatMap(Sheet.init(rawValue:)) else { return }
            try? await Task.sleep(for: .seconds(4))
            sheet = s
        }
        .onChange(of: model.linkToken) { _, t in if t != nil { sheet = .redeem } }
        .onChange(of: model.chatOpen) { _, open in if open { model.unread = 0 } }
        .onChange(of: model.media.lastSwitch) { _, sw in if sw?.shareStopped == true { model.notice = L("切换房间后屏幕共享已停止") } }
    }
}

/// 侧栏：服务器名称、房间与成员。点击房间进入；把成员拖到房间即可移动（主持人）；
/// 右键房间是编辑 / 全员静音 / 关闭，右键成员是音量和主持操作。
struct SidebarView: View {
    @Environment(AppModel.self) private var model
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
        List {
            ForEach(state.sortedRooms, id: \.id) { room in
                let members = state.members(of: room.id)
                Section {
                    ForEach(members, id: \.sessionID) { p in
                        MemberRow(p: p, isSelf: p.sessionID == state.me?.sessionID) { kind in moderating = ModerationTarget(p: p, kind: kind) }
                    }
                } header: {
                    roomHeader(room, members: members.count, current: room.id == current, manage: perms.canManage(room))
                        .dropDestination(for: String.self) { ids, _ in
                            for id in ids { drop(sessionID: id, on: room) }
                            return true
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) { SelfCard() }
        .safeAreaInset(edge: .top) {
            HStack(spacing: 6) {
                Image(systemName: model.session.address?.secure == false ? "lock.open" : "lock.fill")
                    .foregroundStyle(model.session.address?.secure == false ? .orange : .green)
                Text(state.serverInfo.name).font(.headline).lineLimit(1)
                Spacer()
                if perms.isModerator, state.rooms.values.contains(where: { $0.kind == .temporary }) {
                    Button { run { _ = try await model.session.recallAll() } } label: { Image(systemName: "arrow.uturn.backward") }
                        .buttonStyle(.borderless)
                        .help("全员返回主会议")
                }
                if perms.canCreateRoom {
                    Button { editing = RoomEditTarget(room: nil) } label: { Image(systemName: "plus") }
                        .buttonStyle(.borderless)
                        .help("新建房间")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .sheet(item: $editing) { t in RoomEditorView(room: t.room).frame(width: 440, height: 520) }
        .sheet(item: $moderating) { t in ModerationSheet(target: t.p, kind: t.kind).frame(width: 400, height: 280) }
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

    private func roomHeader(_ room: Room, members: Int, current: Bool, manage: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: current ? "speaker.wave.2.fill" : room.kind == .main ? "house" : "rectangle.3.group")
                .foregroundStyle(current ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                .frame(width: 16)
            Text(model.session.state.roomName(room.id))
                .fontWeight(current ? .semibold : .regular)
                .foregroundStyle(current ? .primary : .secondary)
                .lineLimit(1)
            if room.hasPassword_p { Image(systemName: "key.fill").help("需要密码") }
            if room.locked { Image(systemName: "lock.fill").help("已锁定") }
            if room.e2Ee { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green).help("端到端加密") }
            Spacer()
            Text(room.capacity > 0 ? "\(members)/\(room.capacity)" : L("\(members) 人"))
                .font(.caption.monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(.quaternary))
        }
        .padding(.trailing, 6)
        .contentShape(Rectangle())
        .onTapGesture { enter(room, current: current, manage: manage) }
        .help(current ? "" : L("进入"))
        .contextMenu {
            if !current { Button("进入") { enter(room, current: current, manage: manage) } }
            if manage {
                Button("房间设置…") { editing = RoomEditTarget(room: room) }
                Button("全员静音") { run { let n = try await model.session.muteAll(room.id); model.notice = L("已静音 \(n) 人") } }
                if room.kind == .temporary {
                    Divider()
                    Button("关闭房间", role: .destructive) { run { try await model.session.closeRoom(room.id) } }
                }
            }
        }
    }

    private func enter(_ room: Room, current: Bool, manage: Bool) {
        guard !current else { return }
        if room.hasPassword_p, !manage { passwordRoom = room } else { run { try await model.session.joinRoom(room.id) } }
    }

    private func drop(sessionID id: String, on room: Room) {
        let state = model.session.state
        guard let p = state.participants[id], p.roomID != room.id else { return }
        if id == state.me?.sessionID {
            enter(room, current: false, manage: state.permissions.canManage(room))
        } else if state.permissions.canKick(p) {
            run { try await model.session.moveParticipant(id, to: room.id) }
        }
    }

    private func run(_ f: @escaping () async throws -> Void) {
        Task {
            do { try await f() } catch let e as HaneError { model.notice = describe(e) } catch {}
        }
    }
}

struct MemberRow: View {
    @Environment(AppModel.self) private var model
    let p: Participant
    let isSelf: Bool
    let onKickBan: (ModerationSheet.Kind) -> Void
    @State private var showMenu = false
    @State private var showGeoAlert = false

    var body: some View {
        let perms = model.session.state.permissions
        let row = HStack(spacing: 8) {
            AvatarView(name: p.nickname, uid: p.uid, speaking: model.media.speaking.contains(p.mediaIdentity), size: 26, dimmed: p.reconnecting)
            HStack(spacing: 6) {
                Text(p.nickname).lineLimit(1)
                if isSelf { YouTag() }
            }
            Spacer(minLength: 4)
            RoleBadge(role: p.role)
            StatusIcons(p: p)
        }
        .contentShape(Rectangle())
        // 左键、右键都打开同一个弹出框
        .onTapGesture { if !isSelf { showMenu = true } }
        .overlay { if !isSelf { RightClickCatcher { showMenu = true } } }
        .popover(isPresented: $showMenu, arrowEdge: .trailing) {
            MemberPopover(p: p, onKickBan: onKickBan, onDownloadV6: { showMenu = false; showGeoAlert = true })
        }
        .ipv6GeoAlert(isPresented: $showGeoAlert, model: model)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: Text("成员菜单")) { if !isSelf { showMenu = true } }
        // 自己可以拖到别的房间（等同于进入）；主持人可以拖动角色更低的人
        if isSelf || perms.canKick(p) {
            row.draggable(p.sessionID)
        } else {
            row
        }
    }
}

/// 成员弹出框：音量、主持和管理员操作、连接信息（仅管理员）
struct MemberPopover: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let p: Participant
    let onKickBan: (ModerationSheet.Kind) -> Void
    let onDownloadV6: () -> Void

    var body: some View {
        let v = model.media.volumes[p.mediaIdentity] ?? 1
        VStack(alignment: .leading, spacing: 6) {
            // 和下面的菜单项一样左右缩进，左右两边都对齐
            VStack(alignment: .leading, spacing: 6) {
                Text(p.nickname).font(.headline).lineLimit(1).truncationMode(.tail).help(p.nickname)
                Text("音量 \(Int(v * 100))%").font(.caption).foregroundStyle(.secondary)
                Slider(value: Binding(get: { v }, set: { model.media.setVolume($0, for: p.mediaIdentity) }), in: 0 ... 2, step: 0.05)
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 6)
            VStack(alignment: .leading, spacing: 2) {
                ModerationMenuItems(p: p, onKickBan: onKickBan, onAction: { dismiss() }, dividers: false)
                    .buttonStyle(PopoverRowButtonStyle())
                    // 「移动到」子菜单也用整行按钮的样式，和其他行对齐
                    .menuStyle(.button)
                    .menuIndicator(.hidden)
                if model.session.state.permissions.role == .admin {
                    // 和菜单项相同的内边距，文字左边对齐
                    MemberInfoView(p: p, onDownloadV6: onDownloadV6)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                }
            }
        }
        .padding(12)
        .frame(width: 240)
    }
}

/// 弹出框里像菜单项一样的整行按钮
private struct PopoverRowButtonStyle: ButtonStyle {
    @State private var hover = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(PopoverRowLabelStyle())
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(configuration.isPressed ? 0.12 : hover ? 0.06 : 0)))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .foregroundStyle(configuration.role == .destructive ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
    }
}

/// 图标放在固定宽度的格子里：各图标宽窄不一，文字的起点仍然对齐
private struct PopoverRowLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.icon.frame(width: 20)
            configuration.title
        }
    }
}

/// SwiftUI 没有右键手势：透明的 NSView 只在右键时接收点击，左键和拖动照常交给下面的视图
private struct RightClickCatcher: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> CatcherView { CatcherView(action: action) }
    func updateNSView(_ view: CatcherView, context: Context) { view.action = action }

    final class CatcherView: NSView {
        var action: () -> Void
        init(action: @escaping () -> Void) {
            self.action = action
            super.init(frame: .zero)
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        override func hitTest(_ point: NSPoint) -> NSView? {
            switch NSApp.currentEvent?.type {
            case .rightMouseDown, .rightMouseUp: super.hitTest(point)
            default: nil
            }
        }

        override func rightMouseDown(with event: NSEvent) { action() }
    }
}

/// 舞台：有人共享屏幕时以共享画面为焦点；纯语音时是居中的成员卡片；
/// 有人开摄像头时是按人数和舞台大小铺满的 16:9 画面（与网页版相同）。说话者高亮。
struct StageView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let state = model.session.state
        let roomID = state.media?.roomID ?? "main"
        let shares = state.rooms[roomID]?.shares ?? []
        let members = state.members(of: roomID)
        if !shares.isEmpty {
            ShareStageView(shares: shares)
        } else if model.media.videoTracks.contains(where: { !$0.isScreen }) {
            videoGrid(members)
        } else {
            voiceGrid(members)
        }
    }

    private func voiceGrid(_ members: [Participant]) -> some View {
        let me = model.session.state.me?.sessionID
        return GeometryReader { geo in
            ScrollView {
                VStack(spacing: 20) {
                    CenteredFlowLayout(spacing: 16) {
                        ForEach(members, id: \.sessionID) { p in VoiceTile(p: p, isSelf: p.sessionID == me) }
                    }
                    if members.count <= 1 {
                        Text("只有你在这里。把服务器地址发给其他人吧。").foregroundStyle(.secondary)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
        }
    }

    private func videoGrid(_ members: [Participant]) -> some View {
        GeometryReader { geo in
            let gap: CGFloat = 12
            let g = StageGrid.best(count: members.count, width: geo.size.width - 32, height: geo.size.height - 32, gap: gap)
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
        }
    }
}

/// 侧栏底部的个人卡片：自己的昵称、发言方式和网络延迟；齿轮打开设置
struct SelfCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let me = model.session.state.selfParticipant {
            HStack(spacing: 10) {
                AvatarView(name: me.nickname, uid: me.uid, speaking: model.media.transmitting && !model.media.micMuted, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(me.nickname).font(.callout.weight(.semibold)).lineLimit(1)
                        RoleBadge(role: me.role).font(.caption)
                    }
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .help("音视频设置…")
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.05)))
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
    }

    private var detail: String {
        let mode = switch model.voiceMode {
        case .voice: L("语音激活")
        case .ptt: L("按键说话")
        case .open: L("常开")
        }
        guard let rtt = model.session.rttMs else { return mode }
        return "\(mode) · \(rtt) ms"
    }
}

/// 工具栏中的控制按钮
struct ControlBar: ToolbarContent {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Binding var sheet: MeetingView.Sheet?

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .principal) {
            MicButton()
            SpeakerButton()
            let raised = model.session.state.selfParticipant?.state.handRaised ?? false
            Button { Task { try? await model.session.updateSelf(handRaised: !raised) } } label: {
                Label(raised ? L("放下手") : L("举手"), systemImage: raised ? "hand.raised.fill" : "hand.raised")
                    .foregroundStyle(raised ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
            }
            .help(raised ? L("放下手") : L("举手"))
            let camOn = model.media.cameraOn
            Button { Task { await model.media.setCameraEnabled(!camOn) } } label: {
                Label(camOn ? L("关闭摄像头") : L("开启摄像头"), systemImage: camOn ? "video.fill" : "video.slash")
            }
            .help(camOn ? L("关闭摄像头") : L("开启摄像头"))
            .keyboardShortcut("v", modifiers: [.command, .shift])
            ShareButton()
        }
        // 加密标识单独一项放在标题旁（与按钮组放在一起时会和相邻按钮叠在一起）
        ToolbarItem(placement: .navigation) { E2EEBadge() }
        ToolbarItemGroup(placement: .primaryAction) {
            Menu {
                Button("使用权限令牌…") { sheet = .redeem }
                if model.session.state.me?.role == .admin { Button("服务器管理…") { sheet = .admin } }
                Button("连接信息") { sheet = .info }
                Button("关于羽见…") { openWindow(id: "about") }
                SettingsLink { Text("音视频设置…") }
            } label: {
                Label("更多", systemImage: "ellipsis.circle")
            }
            Button { model.chatOpen.toggle() } label: {
                Label("聊天", systemImage: model.unread > 0 ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.and.bubble.right")
            }
            .help("聊天")
            .badge(model.chatOpen ? 0 : model.unread)
            Button(role: .destructive) { Task { await model.leave() } } label: {
                Label("离开", systemImage: "phone.down.fill").foregroundStyle(.red)
            }
            .help("离开")
        }
    }
}

/// 麦克风按钮：点按静音；右键（或 Control+点按）弹出麦克风面板
struct MicButton: View {
    @Environment(AppModel.self) private var model
    @State private var showPanel = false

    var body: some View {
        let muted = model.media.micMuted
        Button { Task { await model.setMuted(!muted) } } label: {
            Label(muted ? L("取消静音") : L("静音"), systemImage: muted ? "mic.slash.fill" : "mic.fill")
                .foregroundStyle(muted ? AnyShapeStyle(.red) : model.media.transmitting && model.voiceMode != .open ? AnyShapeStyle(.green) : AnyShapeStyle(.primary))
        }
        .help(muted ? L("取消静音（右键：麦克风选项）") : L("静音（右键：麦克风选项）"))
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .background(ToolbarRightClick { showPanel = true })
        .popover(isPresented: $showPanel, arrowEdge: .bottom) { MicPanel() }
    }
}

/// 声音按钮：点按关闭 / 开启声音；右键（或 Control+点按）弹出声音面板
struct SpeakerButton: View {
    @Environment(AppModel.self) private var model
    @State private var showPanel = false

    var body: some View {
        let deaf = model.media.deafened
        Button { Task { await model.setDeafened(!deaf) } } label: {
            Label(deaf ? L("开启声音") : L("关闭声音"), systemImage: deaf ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .foregroundStyle(deaf ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
        }
        .help(deaf ? L("开启声音（右键：声音选项）") : L("关闭声音（右键：声音选项）"))
        .keyboardShortcut("d", modifiers: [.command, .shift])
        .background(ToolbarRightClick { showPanel = true })
        .popover(isPresented: $showPanel, arrowEdge: .bottom) { OutputPanel() }
    }
}

/// 麦克风面板：输入设备、麦克风音量（带电平），以及降噪、回声消除、发言模式这几项常用设置
struct MicPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("输入设备", selection: model.inputDeviceBinding) {
                    Text("系统默认").tag("")
                    ForEach(model.media.inputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
                VolumeSlider(title: "麦克风音量", value: $model.inputVolume)
                LiveLevelMeter()
            }
            Section {
                if MediaSession.aiNoiseAvailable {
                    Picker("降噪", selection: $model.noiseSuppression) {
                        ForEach(NoiseSuppression.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                }
                Picker("回声消除", selection: $model.echoProcessing) {
                    ForEach(EchoProcessing.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("发言模式", selection: $model.voiceMode) {
                    Text("语音激活").tag(VoiceMode.voice)
                    Text("按键说话").tag(VoiceMode.ptt)
                    Text("常开").tag(VoiceMode.open)
                }
            }
            SettingsLink { Text("音视频设置…") }
                .buttonStyle(.link)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .formStyle(.grouped)
        .frame(width: 340)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// 声音面板：输出设备和输出音量
struct OutputPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("输出设备", selection: model.outputDeviceBinding) {
                    Text("系统默认").tag("")
                    ForEach(model.media.outputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
                VolumeSlider(title: "输出音量", value: $model.outputVolume)
            }
            SettingsLink { Text("音视频设置…") }
                .buttonStyle(.link)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .formStyle(.grouped)
        .frame(width: 340)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// 工具栏按钮的右键：右键（或 Control+点按）点在这个视图的范围内时调用 action，并且不再弹出系统菜单。
/// 工具栏里右键默认是工具栏自己的菜单（「图标和文字 / 仅图标」），contextMenu 和普通的点按拦截都不起作用，所以在窗口层面拦截
private struct ToolbarRightClick: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context _: Context) -> ToolbarRightClickView {
        let v = ToolbarRightClickView()
        v.action = action
        return v
    }

    func updateNSView(_ view: ToolbarRightClickView, context _: Context) { view.action = action }
}

/// ToolbarRightClick 的视图：在窗口层面监听右键，命中自己的范围时调用 action
final class ToolbarRightClickView: NSView {
    var action: (() -> Void)?
    private var monitor: Any?

    /// 不参与普通的点按：左键照常交给按钮
    override func hitTest(_: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // 离开窗口（包括视图被销毁前）时移除监听
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { [weak self] event in
            guard let self, let window = self.window, event.window === window, !self.isHiddenOrHasHiddenAncestor,
                  event.type == .rightMouseDown || event.modifierFlags.contains(.control),
                  self.bounds.contains(self.convert(event.locationInWindow, from: nil))
            else { return event }
            self.action?()
            return nil
        }
    }
}

/// 共享按钮：未共享时弹出选项，共享中点击停止
struct ShareButton: View {
    @Environment(AppModel.self) private var model
    @State private var showOptions = false

    var body: some View {
        let sharing = model.media.isSharing
        Button {
            if sharing { Task { await model.media.stopScreenShare() } } else { showOptions = true }
        } label: {
            Label(sharing ? L("停止共享") : L("共享屏幕"), systemImage: sharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
                .foregroundStyle(sharing ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
        }
        .help(sharing ? L("停止共享") : L("共享屏幕"))
        .keyboardShortcut("s", modifiers: [.command, .shift])
        .popover(isPresented: $showOptions, arrowEdge: .bottom) { SharePopover() }
        .accessibilityIdentifier("share")
    }
}
