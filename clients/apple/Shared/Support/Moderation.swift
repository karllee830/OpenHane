import HaneCore
import SwiftUI

/// 当前用户的权限（与服务端的规则一致；服务端仍会再次裁决）
struct Permissions {
    let state: SessionState

    var role: Role { state.me?.role ?? .member }
    var isModerator: Bool { role.rawValue >= Role.moderator.rawValue }
    private var myRoomID: String { state.media?.roomID ?? "main" }

    func isHost(of room: Room?) -> Bool {
        guard let room, let uid = state.me?.uid else { return false }
        return room.kind == .temporary && room.createdBy == uid
    }

    func canManage(_ room: Room) -> Bool { isModerator || isHost(of: room) }

    var canCreateRoom: Bool {
        let need = state.serverInfo.roomCreateMinRole
        return role.rawValue >= (need == .unspecified ? Role.moderator : need).rawValue
    }

    /// 能否对 p 执行（非服务器级的）主持操作：主持人对角色更低的人；房间主持对自己房间里的普通成员
    func canModerate(_ p: Participant) -> Bool {
        guard p.sessionID != state.me?.sessionID else { return false }
        if isModerator { return p.role.rawValue < role.rawValue }
        return isHost(of: state.rooms[myRoomID]) && p.roomID == myRoomID && p.role.rawValue < Role.moderator.rawValue
    }

    /// 踢出、封禁、移动到其他房间：服务器级操作，只看服务器角色
    func canKick(_ p: Participant) -> Bool {
        p.sessionID != state.me?.sessionID && isModerator && p.role.rawValue < role.rawValue
    }
}

extension SessionState {
    var permissions: Permissions { Permissions(state: self) }

    /// 房间列表：主会议在前，临时房间按创建时间
    var sortedRooms: [Room] {
        rooms.values.sorted { a, b in a.kind == .main ? true : b.kind == .main ? false : a.createdAtMs < b.createdAtMs }
    }

    func roomName(_ id: String) -> String {
        let n = rooms[id]?.name ?? ""
        return n.isEmpty ? L("主会议") : n
    }
}

/// 主持操作和被移动的提示文案
enum NoticeText {
    static func moderation(_ n: Openhane_V1_ModerationNotice) -> String {
        let by = n.byName.isEmpty ? L("主持人") : n.byName
        let reason = n.reason.isEmpty ? "" : L("：\(n.reason)")
        switch n.action {
        case .forceMute: return L("你已被 \(by) 静音，可以举手申请发言") + reason
        case .unmute: return L("\(by) 已允许你发言")
        case .stopShare: return L("你的屏幕共享已被 \(by) 停止") + reason
        case .cameraOff: return L("\(by) 关闭了你的摄像头") + reason
        default: return reason
        }
    }

    static func moved(_ m: Openhane_V1_YouWereMoved, state: SessionState) -> String {
        let to = state.roomName(m.roomID)
        let from = m.fromRoomName.isEmpty ? L("主会议") : m.fromRoomName
        let by = m.byName.isEmpty ? L("主持人") : m.byName
        switch m.reason {
        case .removed: return L("你已被 \(by) 移出「\(from)」")
        case .roomClosed: return L("「\(from)」已关闭，已回到\(to)")
        case .recalled: return L("\(by) 让所有人回到了\(to)")
        case .e2EeUnsupported: return L("「\(from)」开启了端到端加密，当前客户端不支持，已回到\(to)")
        default: return L("你已被 \(by) 移动到「\(to)」")
        }
    }
}

/// 新建 / 编辑房间
struct RoomEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// nil 表示新建
    let room: Room?
    @State private var name = ""
    @State private var password = ""
    @State private var clearPassword = false
    @State private var locked = false
    @State private var capacity = 0
    @State private var timeout: UInt32 = 300
    @State private var screenModOnly = false
    @State private var cameraModOnly = false
    @State private var e2ee = false
    @State private var audioKbps: UInt32 = 0
    @State private var joinAfter = true
    @State private var error: String?
    @State private var busy = false

    private var isMain: Bool { room?.kind == .main }
    private var e2eeMode: Openhane_V1_E2EEMode { model.session.state.media?.policy.e2Ee.mode ?? .off }

    var body: some View {
        Form {
            if !isMain {
                Section {
                    TextField("名称", text: $name)
                    SecureField(room?.hasPassword_p == true ? L("密码（已设置，留空则保持不变）") : L("密码（可选）"), text: $password)
                        .disabled(clearPassword)
                    if room?.hasPassword_p == true { Toggle("取消密码", isOn: $clearPassword) }
                    Toggle("锁定（只有主持人可以进入或拉人进入）", isOn: $locked)
                }
            }
            Section {
                Stepper(capacity == 0 ? L("人数上限：不限") : L("人数上限：\(capacity)"), value: $capacity, in: 0 ... 500)
                if !isMain {
                    Picker("没人时自动关闭", selection: $timeout) {
                        Text("立即").tag(UInt32(0))
                        Text("5 分钟").tag(UInt32(300))
                        Text("30 分钟").tag(UInt32(1800))
                        Text("2 小时").tag(UInt32(7200))
                        Text("24 小时").tag(UInt32(86400))
                    }
                }
            }
            Section("房间规则（只能比服务器设置更严）") {
                Toggle("仅主持人可共享屏幕", isOn: $screenModOnly)
                Toggle("仅主持人可开摄像头", isOn: $cameraModOnly)
                Toggle(e2eeMode == .required ? L("端到端加密（服务器强制开启）") : e2eeMode == .optional ? L("端到端加密") : L("端到端加密（服务器未开启）"),
                       isOn: Binding(get: { e2eeMode == .required || e2ee }, set: { e2ee = $0 }))
                    .disabled(e2eeMode != .optional)
                Picker("语音码率上限", selection: $audioKbps) {
                    Text("不限制").tag(UInt32(0))
                    ForEach([16, 24, 32, 48] as [UInt32], id: \.self) { Text("\($0) kbps").tag($0) }
                }
            }
            if room == nil {
                Section { Toggle("创建后立即进入", isOn: $joinAfter) }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .formStyle(.grouped)
        .navigationTitle(room == nil ? L("新建临时房间") : L("「\(model.session.state.roomName(room!.id))」的设置"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(room == nil ? L("创建") : L("保存")) { Task { await submit() } }
                    .disabled(busy || (!isMain && name.trimmingCharacters(in: .whitespaces).isEmpty))
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard let room else { return }
        name = room.name
        locked = room.locked
        capacity = Int(room.capacity)
        timeout = room.emptyTimeoutSec
        screenModOnly = room.overrides.screenModeratorOnly
        cameraModOnly = room.overrides.cameraModeratorOnly
        e2ee = room.overrides.e2Ee
        audioKbps = room.overrides.audioMaxKbps
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        let overrides = Openhane_V1_RoomOverrides.with {
            $0.screenModeratorOnly = screenModOnly
            $0.cameraModeratorOnly = cameraModOnly
            $0.e2Ee = e2ee
            $0.audioMaxKbps = audioKbps
        }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        do {
            if let room {
                if isMain {
                    try await model.session.updateRoom(room.id, RoomOptions(capacity: UInt32(capacity), overrides: overrides))
                } else {
                    try await model.session.updateRoom(room.id, RoomOptions(
                        name: trimmed, password: clearPassword ? "" : (password.isEmpty ? nil : password), locked: locked,
                        capacity: UInt32(capacity), overrides: overrides, emptyTimeoutSec: timeout
                    ))
                }
                model.notice = L("房间设置已保存")
            } else {
                try await model.session.createRoom(name: trimmed, options: RoomOptions(
                    password: password, locked: locked, capacity: UInt32(capacity), overrides: overrides, emptyTimeoutSec: timeout
                ), join: joinAfter)
                model.notice = L("已创建「\(trimmed)」")
            }
            dismiss()
        } catch let e as HaneError {
            error = describe(e)
        } catch {}
    }
}

/// 踢出 / 封禁
struct ModerationSheet: View {
    enum Kind { case kick, ban }
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: Participant
    let kind: Kind
    @State private var reason = ""
    @State private var duration: UInt32 = 3600
    @State private var banIP = false
    @State private var error: String?

    private var durations: [UInt32] {
        let all: [UInt32] = [600, 3600, 86400, 604_800, 0]
        return model.session.state.permissions.role == .admin ? all : all.filter { $0 > 0 && $0 <= 86400 }
    }

    var body: some View {
        Form {
            TextField("原因（可选）", text: $reason)
            if kind == .ban {
                Picker("时长", selection: $duration) {
                    ForEach(durations, id: \.self) { d in Text(Self.label(d)).tag(d) }
                }
                Toggle("同时封禁 IP", isOn: $banIP)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .navigationTitle(kind == .kick ? L("踢出 \(target.nickname)") : L("封禁 \(target.nickname)"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(kind == .kick ? L("踢出") : L("封禁"), role: .destructive) { Task { await submit() } }
            }
        }
    }

    static func label(_ d: UInt32) -> String {
        switch d {
        case 0: L("永久")
        case ..<3600: L("\(d / 60) 分钟")
        case ..<86400: L("\(d / 3600) 小时")
        default: L("\(d / 86400) 天")
        }
    }

    private func submit() async {
        do {
            if kind == .kick {
                try await model.session.moderate(target.sessionID, .kick, reason: reason)
                model.notice = L("已踢出 \(target.nickname)")
            } else {
                try await model.session.moderate(target.sessionID, .ban, reason: reason, durationSec: duration, banIP: banIP)
                model.notice = L("已封禁 \(target.nickname)")
            }
            dismiss()
        } catch let e as HaneError {
            error = describe(e)
        } catch {}
    }
}

/// 成员的主持操作和管理员操作（macOS 成员弹出框、iOS 长按菜单共用）
struct ModerationMenuItems: View {
    @Environment(AppModel.self) private var model
    let p: Participant
    let onKickBan: (ModerationSheet.Kind) -> Void
    /// 每个操作执行后调用（弹出框里用来关闭弹出框）
    var onAction: () -> Void = {}
    /// 分组之间的分隔线（系统菜单里显示，macOS 的成员弹出框里不显示）
    var dividers = true

    var body: some View {
        let state = model.session.state
        let perms = state.permissions
        if perms.canModerate(p) {
            if p.forceMuted {
                Button { run { try await model.session.moderate(p.sessionID, .unmute) } } label: { Label("允许发言", systemImage: "mic") }
            } else {
                Button { run { try await model.session.moderate(p.sessionID, .forceMute) } } label: { Label("静音", systemImage: "mic.slash") }
            }
            if p.screenSharing {
                Button { run { try await model.session.moderate(p.sessionID, .stopShare) } } label: { Label("停止屏幕共享", systemImage: "rectangle.on.rectangle.slash") }
            }
            if p.cameraOn {
                Button { run { try await model.session.moderate(p.sessionID, .cameraOff) } } label: { Label("关闭摄像头", systemImage: "video.slash") }
            }
            // 只有一个房间时没有可以移动过去的地方，不显示（空菜单会是灰的、点不了）
            let targets = state.sortedRooms.filter { $0.id != p.roomID }
            if perms.canKick(p), !targets.isEmpty {
                Menu {
                    ForEach(targets, id: \.id) { r in
                        Button(state.roomName(r.id)) { run { try await model.session.moveParticipant(p.sessionID, to: r.id) } }
                    }
                } label: { Label("移动到", systemImage: "arrow.right.arrow.left") }
            }
            if p.roomID != "main" {
                Button { run { try await model.session.moderate(p.sessionID, .removeFromRoom) } } label: { Label("移出房间", systemImage: "rectangle.portrait.and.arrow.right") }
            }
            if perms.canKick(p) {
                if dividers { Divider() }
                Button(role: .destructive) { onAction(); onKickBan(.kick) } label: { Label("踢出服务器…", systemImage: "person.fill.xmark") }
                Button(role: .destructive) { onAction(); onKickBan(.ban) } label: { Label("封禁…", systemImage: "nosign") }
            }
        }
        if perms.role == .admin, p.sessionID != state.me?.sessionID {
            if dividers { Divider() }
            if p.role == .admin {
                Button { setRole(.member) } label: { Label("取消管理员", systemImage: "person.badge.minus") }
            } else {
                Button { setRole(.admin) } label: { Label("设为管理员", systemImage: "person.badge.shield.checkmark") }
            }
        }
    }

    private func setRole(_ role: Role) {
        let name = p.nickname
        run {
            try await model.session.setRole(uid: p.uid, role: role)
            model.notice = role == .admin ? L("已将 \(name) 设为管理员") : L("已取消 \(name) 的管理员")
        }
    }

    private func run(_ f: @escaping () async throws -> Void) {
        onAction()
        Task {
            do { try await f() } catch let e as HaneError { model.notice = describe(e) } catch {}
        }
    }
}

/// 成员的连接信息（仅管理员）：往返延迟、IP、归属地、客户端类型和版本。IPv6 地址在服务器没有 IPv6 库时提示下载
struct MemberInfoView: View {
    /// 延迟最多显示 4 位：再大已经没有区别
    static func latency(_ ms: UInt32) -> String { ms > 9999 ? "9999+ ms" : "\(ms) ms" }

    @Environment(AppModel.self) private var model
    let p: Participant
    let onDownloadV6: () -> Void
    @State private var info: Openhane_V1_GetSessionInfoResult?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error {
                Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            } else if let info {
                // 延迟和 IP 在同一行；IP 放不下时来回滚动，点击复制
                HStack(spacing: 0) {
                    if info.rttMs > 0 { Text(verbatim: "\(Self.latency(info.rttMs)) · ").fixedSize() }
                    if info.ip.isEmpty { Text("IP 未知") } else { CopyableIP(ip: info.ip) }
                }
                .font(.caption.monospaced())
                .foregroundStyle(.primary)
                let place = [info.country, info.province, info.city].filter { !$0.isEmpty }.joined(separator: " ")
                if info.ipv6DbMissing {
                    Button("IPv6 归属地需要下载数据库", action: onDownloadV6).buttonStyle(.borderless).font(.caption)
                } else {
                    let line = [place, info.isp].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !line.isEmpty {
                        let flag = flagEmoji(info.countryCode)
                        Text(verbatim: flag.isEmpty ? line : "\(flag) \(line)").lineLimit(1).truncationMode(.tail).help(line)
                    }
                }
                // 客户端类型和版本，例如 macOS (0.2.0)
                let client = [platformName(p.platform), info.appVersion.isEmpty ? "" : "(\(info.appVersion))"].filter { !$0.isEmpty }.joined(separator: " ")
                if !client.isEmpty { Text(verbatim: client).lineLimit(1).truncationMode(.tail).help(client) }
            } else {
                Text("正在获取连接信息…")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: p.sessionID) {
            do { info = try await model.session.sessionInfo(p.sessionID) } catch let e as HaneError { error = describe(e) } catch {}
        }
    }
}

extension View {
    /// 下载 IPv6 归属地库的确认弹窗
    func ipv6GeoAlert(isPresented: Binding<Bool>, model: AppModel) -> some View {
        alert("下载 IPv6 归属地库", isPresented: isPresented) {
            Button("下载") {
                model.notice = L("正在下载 IPv6 归属地库…")
                Task {
                    do {
                        try await model.session.downloadIPv6GeoDB()
                        model.notice = L("IPv6 归属地库已下载")
                    } catch let e as HaneError {
                        model.notice = L("下载失败：\(describe(e))。也可以手动把 ip2region_v6.xdb 放进服务器的数据目录，然后重启服务器。")
                    } catch {}
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("服务器内置的归属地库只包含 IPv4。IPv6 库约 37 MB，会从 GitHub 下载到服务器的数据目录，之后一直可用（Docker 部署时数据目录需要持久化，否则重建容器后要重新下载）。")
        }
    }
}

/// 点击复制的 IP 地址；放不下时来回滚动（系统设置了减少动态效果时不滚动，只截断）
private struct CopyableIP: View {
    let ip: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var textWidth: CGFloat = 0
    @State private var boxWidth: CGFloat = 0
    @State private var offset: CGFloat = 0
    @State private var copied = false

    var body: some View {
        // 行的大小只由占位文字（一个空格，决定行高）和可用宽度决定；IP 画在叠加层里，再长也不会把弹出框撑宽
        Text(verbatim: " ")
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { g in Color.clear.onAppear { boxWidth = g.size.width }.onChange(of: g.size.width) { _, w in boxWidth = w } })
            .overlay(alignment: .leading) {
                if copied {
                    Text("已复制").font(.caption).lineLimit(1)
                } else {
                    Text(verbatim: ip)
                        .lineLimit(1)
                        .fixedSize()
                        .background(GeometryReader { g in Color.clear.preference(key: WidthKey.self, value: g.size.width) })
                        .onPreferenceChange(WidthKey.self) { textWidth = $0 }
                        .offset(x: offset)
                }
            }
            .clipped()
        .contentShape(Rectangle())
        .onTapGesture { copy() }
        .help(L("点击复制 IP 地址"))
        .accessibilityAddTraits(.isButton)
        .task(id: max(0, textWidth - boxWidth)) { await scroll(over: max(0, textWidth - boxWidth)) }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }

    private func copy() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ip, forType: .string)
        #else
        UIPasteboard.general.string = ip
        #endif
        copied = true
    }

    /// 停一下 → 滚到末尾 → 停一下 → 滚回开头，循环；每秒约 20 pt
    private func scroll(over: CGFloat) async {
        offset = 0
        guard over > 1, !reduceMotion else { return }
        let duration = Double(over) / 20
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(1.5))
                withAnimation(.linear(duration: duration)) { offset = -over }
                try await Task.sleep(for: .seconds(duration + 1.5))
                withAnimation(.linear(duration: duration)) { offset = 0 }
                try await Task.sleep(for: .seconds(duration))
            } catch {
                return
            }
        }
    }

    private struct WidthKey: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }
}

/// 两位国家代码（如 CN）→ 国旗 emoji；格式不对时为空
func flagEmoji(_ code: String) -> String {
    guard code.count == 2, code.allSatisfy({ $0.isASCII && $0.isUppercase }) else { return "" }
    return String(String.UnicodeScalarView(code.unicodeScalars.compactMap { Unicode.Scalar(0x1F1E6 + $0.value - 65) }))
}
