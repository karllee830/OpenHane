import AppKit
import HaneCore
import SwiftUI

/// 服务器管理面板：左侧分区列表（与「系统设置」相同的布局），右侧是分区内容。
/// 只有「常规」和「音频」需要点「保存」；其他分区的操作立即生效。
struct AdminView: View {
    enum Pane: String, CaseIterable, Identifiable {
        case general, audio, tokens, users, bans, invites, audit
        var id: String { rawValue }

        var title: String {
            switch self {
            case .general: L("常规")
            case .audio: L("音频")
            case .tokens: L("权限令牌")
            case .users: L("用户")
            case .bans: L("封禁")
            case .invites: L("邀请码")
            case .audit: L("审计日志")
            }
        }

        var icon: String {
            switch self {
            case .general: "gearshape"
            case .audio: "waveform"
            case .tokens: "key"
            case .users: "person.2"
            case .bans: "hand.raised"
            case .invites: "link"
            case .audit: "list.bullet.rectangle"
            }
        }

        /// 需要「保存」按钮的分区
        var hasSettings: Bool { self == .general || self == .audio }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// HANE_SNAPSHOT_ADMIN=分区：截图检查时直接打开某个分区
    @State private var section: Pane? = Pane(rawValue: DevHooks.environment["HANE_SNAPSHOT_ADMIN"] ?? "") ?? .general
    @State private var values: [String: String] = [:]
    @State private var name = ""
    @State private var welcome = ""
    @State private var password = ""
    @State private var maxClients = 100
    @State private var forceMute = false
    @State private var preset = "standard"
    @State private var message: (ok: Bool, text: String)?
    @State private var tokens: [Openhane_V1_TokenInfo] = []
    @State private var newRole: Role = .moderator
    @State private var newUses = 1
    @State private var created: String?

    var body: some View {
        let current = section ?? .general
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                List(Pane.allCases, selection: $section) { s in
                    Label(s.title, systemImage: s.icon).tag(s)
                }
                .listStyle(.sidebar)
                .scrollDisabled(true)
                .frame(width: 180)
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    Text(current.title)
                        .font(.title2.bold())
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                    content(current)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            Divider()
            HStack(spacing: 12) {
                if let message {
                    Label(message.text, systemImage: message.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(message.ok ? .green : .red)
                        .lineLimit(2)
                }
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
                if current.hasSettings {
                    Button("保存") { Task { await save(nil) } }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .frame(width: 780, height: 560)
        .task { await load() }
        .onChange(of: section) { message = nil }
    }

    @ViewBuilder
    private func content(_ s: Pane) -> some View {
        switch s {
        case .general: generalForm
        case .audio: audioForm
        case .tokens: tokensTab
        case .users: UsersTab()
        case .bans: BansTab()
        case .invites: InvitesTab()
        case .audit: AuditTab()
        }
    }

    private var hasPassword: Bool { values["server.password"].map { $0 != "null" } ?? false }

    private var generalForm: some View {
        Form {
            Section {
                TextField("服务器名称", text: $name, prompt: Text("留空则用默认名称（环境变量 HANE_SERVER_NAME）"))
                TextField("欢迎语", text: $welcome, prompt: Text("用户连接后显示在会议界面顶部"), axis: .vertical)
                    .lineLimit(2 ... 4)
            }
            Section {
                SecureField("服务器密码", text: $password, prompt: Text(hasPassword ? L("已设置，留空则保持不变") : L("未设置，任何人都可以连接")))
                if hasPassword {
                    LabeledContent("") {
                        Button("取消密码", role: .destructive) { Task { await save(["server.password": "null"]) } }
                    }
                }
            } footer: {
                Text("通过邀请链接进入的用户可以免输密码（在「邀请码」中设置）。").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("最大在线人数") {
                    HStack(spacing: 6) {
                        TextField("", value: $maxClients, format: .number)
                            .labelsHidden()
                            .multilineTextAlignment(.trailing)
                            .frame(width: 70)
                        Stepper("", value: $maxClients, in: 1 ... 10000).labelsHidden()
                    }
                }
                Toggle("加入时默认静音", isOn: $forceMute)
            }
        }
        .formStyle(.grouped)
    }

    private var audioForm: some View {
        Form {
            Section {
                Picker("语音码率", selection: $preset) {
                    Text("省流 16 kbps").tag("economy")
                    Text("标准 32 kbps").tag("standard")
                    Text("高清 64 kbps").tag("hd")
                    Text("音乐 128 kbps").tag("music")
                }
            } footer: {
                Text("所有房间的默认语音码率，保存后立即应用到所有在线用户；单个房间还可以在房间设置中设置码率上限。").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private var tokensTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("角色", selection: $newRole) {
                    Text("主持人").tag(Role.moderator)
                    Text("管理员").tag(Role.admin)
                }
                .fixedSize()
                Stepper(newUses == 0 ? L("可用次数：不限") : L("可用次数：\(newUses)"), value: $newUses, in: 0 ... 100)
                Spacer()
                Button("创建令牌") {
                    Task {
                        do {
                            created = try await model.session.createToken(role: newRole, maxUses: UInt32(newUses)).token
                            tokens = try await model.session.listTokens()
                        } catch let e as HaneError { message = (false, describe(e)) } catch {}
                    }
                }
            }
            if let created {
                GroupBox("新令牌（只显示这一次）") {
                    HStack {
                        Text(created).font(.body.monospaced()).textSelection(.enabled)
                        Spacer()
                        Button("复制") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(created, forType: .string)
                        }
                    }
                }
            }
            Table(tokens) {
                TableColumn("ID") { Text($0.id).font(.caption.monospaced()) }
                TableColumn("角色") { Text($0.role == .admin ? L("管理员") : L("主持人")) }
                TableColumn("已用") { t in Text("\(t.usedCount)/\(t.maxUses == 0 ? "∞" : "\(t.maxUses)")") }
                TableColumn("") { t in
                    if t.revokedAtMs != 0 {
                        Text("已吊销").foregroundStyle(.secondary)
                    } else {
                        Button("吊销") {
                            Task {
                                try? await model.session.revokeToken(id: t.id)
                                tokens = (try? await model.session.listTokens()) ?? tokens
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func load() async {
        do {
            values = try await model.session.getSettings()
            name = decode(values["server.name"]) ?? ""
            welcome = decode(values["server.welcome_message"]) ?? ""
            maxClients = decode(values["server.max_clients"]) ?? 100
            forceMute = decode(values["join.force_mute"]) ?? false
            preset = decode(values["audio.preset"]) ?? "standard"
            tokens = try await model.session.listTokens()
        } catch let e as HaneError { message = (false, describe(e)) } catch {}
    }

    private func save(_ override: [String: String]?) async {
        var patch = override ?? [
            // 服务器名称留空：恢复默认名称（HANE_SERVER_NAME，没有设置时是 OpenHane）
            "server.name": name.trimmingCharacters(in: .whitespaces).isEmpty ? "null" : encode(name), "server.welcome_message": encode(welcome),
            "server.max_clients": encode(maxClients), "join.force_mute": encode(forceMute), "audio.preset": encode(preset),
        ]
        if override == nil, !password.isEmpty { patch["server.password"] = encode(password) }
        do {
            values = try await model.session.updateSettings(patch)
            password = ""
            message = (true, String(localized: "已保存，已实时应用到所有在线用户。"))
        } catch let e as HaneError { message = (false, describe(e)) } catch {}
    }

    private func decode<T: Decodable>(_ s: String?) -> T? { s.flatMap { try? JSONDecoder().decode(T.self, from: Data($0.utf8)) } }
    private func encode<T: Encodable>(_ v: T) -> String { String(decoding: (try? JSONEncoder().encode(v)) ?? Data(), as: UTF8.self) }
}

extension Openhane_V1_TokenInfo: @retroactive Identifiable {}

// MARK: - 用户、封禁、邀请码、审计

private func timeText(_ ms: Int64) -> String {
    ms == 0 ? "" : Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .numeric, time: .shortened)
}

extension Openhane_V1_Identity: @retroactive Identifiable {
    public var id: String { uid }
}

extension Openhane_V1_BanInfo: @retroactive Identifiable {}
extension Openhane_V1_InviteInfo: @retroactive Identifiable {
    public var id: String { code }
}
extension Openhane_V1_AuditEntry: @retroactive Identifiable {}

struct UsersTab: View {
    @Environment(AppModel.self) private var model
    @State private var users: [Openhane_V1_Identity] = []
    @State private var total: UInt32 = 0
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading) {
            Text("共 \(total) 人").foregroundStyle(.secondary)
            Table(users) {
                TableColumn("昵称") { Text($0.lastNickname) }
                TableColumn("UID") { Text(Identity.shortUID($0.uid)).font(.caption.monospaced()) }.width(90)
                TableColumn("最近") { Text(timeText($0.lastSeenAtMs)).foregroundStyle(.secondary) }.width(min: 150)
                TableColumn("角色") { u in
                    Picker("", selection: Binding(get: { u.role }, set: { r in Task { await setRole(u.uid, r) } })) {
                        Text("成员").tag(Role.member)
                        Text("主持人").tag(Role.moderator)
                        Text("管理员").tag(Role.admin)
                    }
                    .labelsHidden()
                    .disabled(u.uid == model.session.state.me?.uid)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .task { await reload() }
    }

    private func reload() async {
        do { (users, total) = try await model.session.listIdentities() } catch let e as HaneError { error = describe(e) } catch {}
    }

    private func setRole(_ uid: String, _ role: Role) async {
        do { try await model.session.setRole(uid: uid, role: role) } catch let e as HaneError { error = describe(e) } catch {}
        await reload()
    }
}

struct BansTab: View {
    @Environment(AppModel.self) private var model
    @State private var bans: [Openhane_V1_BanInfo] = []
    @State private var target = ""
    @State private var duration: UInt32 = 86400
    @State private var reason = ""
    @State private var message: (ok: Bool, text: String)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("UID 或 IP / IP 段", text: $target).frame(width: 200)
                Picker("", selection: $duration) {
                    ForEach([600, 3600, 86400, 604_800, 0] as [UInt32], id: \.self) { Text(ModerationSheet.label($0)).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
                TextField("原因", text: $reason)
                Button("添加封禁") { Task { await add() } }.disabled(target.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let message { Text(message.text).foregroundStyle(message.ok ? .green : .red) }
            Table(bans) {
                TableColumn("对象") { b in Text(b.nickname.isEmpty ? (b.uid.isEmpty ? b.ipCidr : Identity.shortUID(b.uid)) : b.nickname) }
                TableColumn("IP") { Text($0.ipCidr) }
                TableColumn("原因") { Text($0.reason) }
                TableColumn("到期") { b in Text(b.expiresAtMs == 0 ? L("永久") : timeText(b.expiresAtMs)) }.width(min: 150)
                TableColumn("") { b in
                    Button("解除") { Task { await remove(b.id) } }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .task { await reload() }
    }

    private func reload() async {
        bans = (try? await model.session.listBans()) ?? bans
    }

    private func add() async {
        let v = target.trimmingCharacters(in: .whitespaces)
        let isIP = v.contains(".") || v.contains(":")
        do {
            try await model.session.addBan(uid: isIP ? "" : v, ipCIDR: isIP ? v : "", durationSec: duration, reason: reason)
            message = (true, L("已封禁"))
            target = ""
            reason = ""
        } catch let e as HaneError { message = (false, describe(e)) } catch {}
        await reload()
    }

    private func remove(_ id: Int64) async {
        do { try await model.session.removeBan(id: id) } catch let e as HaneError { message = (false, describe(e)) } catch {}
        await reload()
    }
}

struct InvitesTab: View {
    @Environment(AppModel.self) private var model
    @State private var invites: [Openhane_V1_InviteInfo] = []
    @State private var uses = 0
    @State private var expires: UInt32 = 604_800
    @State private var bypass = true
    @State private var role: Role = .member
    @State private var created: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 16) {
                Stepper(uses == 0 ? L("次数：不限") : L("次数：\(uses)"), value: $uses, in: 0 ... 1000).fixedSize()
                Picker("有效期", selection: $expires) {
                    Text("1 天").tag(UInt32(86400))
                    Text("7 天").tag(UInt32(604_800))
                    Text("30 天").tag(UInt32(2_592_000))
                    Text("不过期").tag(UInt32(0))
                }
                .fixedSize()
                Picker("角色", selection: $role) {
                    Text("不改变").tag(Role.member)
                    Text("主持人").tag(Role.moderator)
                }
                .fixedSize()
            }
            HStack {
                Toggle("免服务器密码", isOn: $bypass).fixedSize()
                Spacer()
                Button("生成邀请链接") { Task { await create() } }
            }
            if let created {
                GroupBox("邀请链接（发给对方即可直接进入）") {
                    HStack {
                        Text(created).font(.body.monospaced()).textSelection(.enabled)
                        Spacer()
                        Button("复制") { copy(created) }
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            Table(invites) {
                TableColumn("邀请码") { Text($0.code).font(.caption.monospaced()) }
                TableColumn("已用") { i in Text("\(i.usedCount)/\(i.maxUses == 0 ? "∞" : "\(i.maxUses)")") }
                TableColumn("到期") { i in Text(i.expiresAtMs == 0 ? L("不过期") : timeText(i.expiresAtMs)) }.width(min: 150)
                TableColumn("") { i in
                    HStack {
                        Button("复制链接") { copy(model.session.inviteLink(i.code)) }
                        Button("吊销") { Task { await revoke(i.code) } }
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .task { await reload() }
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    private func reload() async {
        invites = (try? await model.session.listInvites()) ?? invites
    }

    private func create() async {
        do {
            let inv = try await model.session.createInvite(maxUses: UInt32(uses), expiresInSec: expires, bypassPassword: bypass, role: role)
            created = model.session.inviteLink(inv.code)
        } catch let e as HaneError { error = describe(e) } catch {}
        await reload()
    }

    private func revoke(_ code: String) async {
        do { try await model.session.revokeInvite(code) } catch let e as HaneError { error = describe(e) } catch {}
        await reload()
    }
}

struct AuditTab: View {
    @Environment(AppModel.self) private var model
    @State private var prefix = ""
    @State private var entries: [Openhane_V1_AuditEntry] = []
    @State private var hasMore = false

    var body: some View {
        VStack(alignment: .leading) {
            Picker("筛选", selection: $prefix) {
                Text("全部操作").tag("")
                Text("主持操作").tag("moderate.")
                Text("房间").tag("room.")
                Text("封禁").tag("ban.")
                Text("设置").tag("settings.")
                Text("权限令牌").tag("token.")
                Text("邀请码").tag("invite.")
                Text("角色").tag("user.")
                Text("安全").tag("security.")
            }
            .fixedSize()
            Table(entries) {
                TableColumn("时间") { Text(timeText($0.atMs)).foregroundStyle(.secondary) }.width(min: 150)
                TableColumn("操作") { Text($0.action).font(.caption.monospaced()) }
                TableColumn("操作者") { e in Text(e.actorName.isEmpty ? (e.actorUid.isEmpty ? L("系统") : Identity.shortUID(e.actorUid)) : e.actorName) }
                TableColumn("详情") { e in Text("\(e.target) \(e.detail)").font(.caption.monospaced()).lineLimit(1).help(e.detail) }
            }
            if hasMore { Button("加载更多") { Task { await load(more: true) } } }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .task(id: prefix) { await load(more: false) }
    }

    private func load(more: Bool) async {
        guard let r = try? await model.session.auditLog(before: more ? (entries.last?.id ?? 0) : 0, actionPrefix: prefix) else { return }
        entries = more ? entries + r.entries : r.entries
        hasMore = r.hasMore
    }
}

