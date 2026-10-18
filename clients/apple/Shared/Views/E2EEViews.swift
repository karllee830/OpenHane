import HaneCore
import HaneMedia
import SwiftUI

/// 端到端加密标识：点击查看安全码。所有人看到的安全码相同，就说明大家看到的成员列表一致，
/// 服务器没有偷偷塞进一个人。
struct E2EEBadge: View {
    @Environment(AppModel.self) private var model
    @State private var open = false

    var body: some View {
        if let e2ee = model.media.e2ee, e2ee.enabled {
            Button { open.toggle() } label: {
                Label("加密", systemImage: "checkmark.shield.fill").foregroundStyle(.green)
            }
            .help("端到端加密")
            .accessibilityIdentifier("e2ee-badge")
            .popover(isPresented: $open) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("端到端加密").font(.headline)
                    Text("这个房间的声音、视频和屏幕共享只有房间里的人能解密，服务器也无法查看。")
                        .foregroundStyle(.secondary)
                    Text("安全码（与其他人核对：所有人看到的相同，就说明没有人被偷偷加进来）")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(e2ee.safetyCode ?? "…")
                        .font(.title3.monospacedDigit()).tracking(1.5)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("safety-code")
                    if !e2ee.missing.isEmpty {
                        Text("还有 \(e2ee.missing.count) 人的密钥没有收到").font(.caption).foregroundStyle(.orange)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 300, alignment: .leading)
                .padding()
                .presentationCompactAdaptation(.popover)
            }
        }
    }
}

/// 还没收到这个人的密钥：他的声音和画面暂时无法解密
struct E2EEPending: View {
    @Environment(AppModel.self) private var model
    let p: Participant

    var body: some View {
        if model.media.e2ee?.missing.contains(p.sessionID) == true {
            Label("正在建立加密…", systemImage: "lock.rotation")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("e2ee-pending")
        }
    }
}
