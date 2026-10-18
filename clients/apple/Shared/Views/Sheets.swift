import HaneCore
import SwiftUI

/// 使用权限令牌
struct RedeemView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var initialToken: String
    @State private var token = ""
    @State private var result: (ok: Bool, text: String)?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("使用权限令牌").font(.title3.weight(.semibold))
            Text(initialToken.isEmpty ? L("粘贴服务器管理员给你的权限令牌（HANE-…）。") : L("链接中包含一个权限令牌，是否使用它？"))
                .foregroundStyle(.secondary)
            TextField("HANE-XXXX-XXXX-XXXX-XXXX-XXXX", text: $token)
                .font(.body.monospaced())
                .textFieldStyle(.roundedBorder)
            if let result {
                Text(result.text).foregroundStyle(result.ok ? .green : .red)
            }
            HStack {
                Spacer()
                Button("关闭") {
                    model.linkToken = nil
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("兑换") { Task { await redeem() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || token.trimmingCharacters(in: .whitespaces).count < 20)
            }
        }
        .padding(20)
        .sheetWidth(420)
        .onAppear { token = initialToken }
    }

    private func redeem() async {
        busy = true
        defer { busy = false }
        let before = model.session.state.me?.role
        do {
            let role = try await model.session.redeemToken(token)
            model.linkToken = nil
            if role == before {
                result = (true, String(localized: "你的角色没有变化（令牌的角色不高于你当前的角色）。"))
            } else {
                result = (true, role == .admin ? String(localized: "已成为管理员。") : String(localized: "已成为主持人。"))
            }
            token = ""
        } catch let e as HaneError {
            result = (false, describe(e))
        } catch {}
    }
}

struct ConnectionInfoView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let s = model.session
        VStack(alignment: .leading, spacing: 12) {
            Text("连接信息").font(.title3.weight(.semibold))
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow { Text("服务器").foregroundStyle(.secondary); Text("\(s.state.serverInfo.name) · \(s.address?.display ?? "")") }
                GridRow { Text("版本").foregroundStyle(.secondary); Text(s.state.serverInfo.version) }
                GridRow { Text("证书指纹").foregroundStyle(.secondary); Text(s.address.flatMap { s.trust.pinned(hostPort: $0.hostPort) } ?? "—").font(.caption.monospaced()).textSelection(.enabled) }
                GridRow { Text("你的身份").foregroundStyle(.secondary); Text(s.state.me.map { "\(Identity.shortUID($0.uid)) (\($0.uid))" } ?? "").textSelection(.enabled) }
                GridRow { Text("控制连接延迟").foregroundStyle(.secondary); Text(s.rttMs.map { "\($0) ms" } ?? "—") }
            }
            HStack { Spacer(); Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .sheetWidth(520)
    }
}

/// 证书指纹变化的警告：主按钮是「取消连接」
struct TofuWarningView: View {
    @Environment(AppModel.self) private var model
    let mismatch: TrustStore.Mismatch

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("服务器的身份发生了变化", systemImage: "exclamationmark.shield.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.red)
            Text("\(mismatch.hostPort) 出示的证书与你上次连接时记住的不同。可能的原因：服务器重装或更换了证书；也可能有人正在拦截你的连接。如果不确定，请先联系服务器管理员核对指纹。")
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("上次记住的指纹").font(.caption).foregroundStyle(.secondary)
                Text(mismatch.expected).font(.caption.monospaced()).textSelection(.enabled)
                Text("本次看到的指纹").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
                Text(mismatch.actual).font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                Button("我确认这是正常的变化", role: .destructive) { Task { await model.acceptFingerprint() } }
                Spacer()
                Button("取消连接") { model.cancelFingerprint() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .sheetWidth(520)
    }
}

extension View {
    /// macOS 的面板需要固定宽度；iOS 的面板由系统决定大小
    @ViewBuilder func sheetWidth(_ w: CGFloat) -> some View {
        #if os(macOS)
        frame(width: w)
        #else
        frame(maxWidth: .infinity, alignment: .leading)
        #endif
    }
}
