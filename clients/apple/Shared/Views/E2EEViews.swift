import HaneCore
import HaneMedia
import SwiftUI

/// 端到端加密标识：点击查看安全码（8 个 emoji 和名称，方便在会议里念出来核对）。所有人看到的安全码相同，就说明大家看到的成员列表一致，
/// 服务器没有偷偷塞进一个人。HANE_OPEN_E2EE=1 时进入加密房间后自动打开（截图检查用）
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
                E2EEDetails(e2ee: e2ee)
                    .presentationCompactAdaptation(.popover)
            }
            .task {
                guard DevHooks.environment["HANE_OPEN_E2EE"] == "1" else { return }
                try? await Task.sleep(for: .seconds(1))
                open = true
            }
        }
    }
}

/// 加密标识弹出的说明和安全码
struct E2EEDetails: View {
    let e2ee: E2EEKeys

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("端到端加密").font(.headline)
            Text("本房间已开启端到端加密，对话无法被窃听，即使是服务器也无法获取。")
                .foregroundStyle(.secondary)
            Text("与他人核对安全码，如一致说明未被窃听。")
                .foregroundStyle(.secondary)
            Text("安全码")
                .font(.caption).foregroundStyle(.secondary)
            SafetyCodeGrid(code: e2ee.safetyCode)
                .accessibilityIdentifier("safety-code")
            if !e2ee.missing.isEmpty {
                Text("还有 \(e2ee.missing.count) 人的密钥没有收到").font(.caption).foregroundStyle(.orange)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 300, alignment: .leading)
        .padding()
    }
}

/// 安全码：8 个 emoji，每个下面是名称（4 个一行）；计算中显示「…」
private struct SafetyCodeGrid: View {
    let code: [Int]?

    var body: some View {
        if let code {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 8) {
                ForEach(Array(code.enumerated()), id: \.offset) { _, n in
                    let e = SafetyEmoji.all[n]
                    VStack(spacing: 2) {
                        Text(e.emoji).font(.title).accessibilityHidden(true)
                        Text(LocalizedStringKey(e.name)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        } else {
            Text("…").font(.title3).foregroundStyle(.secondary)
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
