import AppKit
import HaneCore
import HaneMedia
import SwiftUI

/// 有人共享屏幕时的舞台：共享画面为焦点，多人同时共享时用标签切换，底部是成员条。
struct ShareStageView: View {
    @Environment(AppModel.self) private var model
    let shares: [Openhane_V1_ShareInfo]
    @State private var selected: String?
    @State private var actualSize = false

    var body: some View {
        let state = model.session.state
        let current = shares.first { $0.sessionID == selected } ?? shares.first { $0.sessionID != state.me?.sessionID } ?? shares[0]
        let sharer = state.participants[current.sessionID]
        let isSelf = current.sessionID == state.me?.sessionID
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if shares.count > 1 {
                    Picker("共享", selection: Binding(get: { current.sessionID }, set: { selected = $0 })) {
                        ForEach(shares, id: \.sessionID) { s in
                            Text(state.participants[s.sessionID]?.nickname ?? "?").tag(s.sessionID)
                        }
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                    .labelsHidden()
                } else {
                    HStack(spacing: 6) {
                        if let sharer { AvatarView(name: sharer.nickname, uid: sharer.uid, size: 20) }
                        Text(L("\(sharer?.nickname ?? "?") 正在共享屏幕")).lineLimit(1).truncationMode(.middle)
                    }
                }
                Text(ShareIntentName(current.intent).label)
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.quaternary))
                if current.withAudio { Image(systemName: "speaker.wave.2").help("同时共享声音") }
                Spacer()
                if !isSelf {
                    Picker("显示", selection: $actualSize) {
                        Text("适应窗口").tag(false)
                        Text("1:1").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                    .labelsHidden()
                    .help("1:1 按原始像素显示，适合看小字")
                    Button { NSApp.keyWindow?.toggleFullScreen(nil) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .help("全屏")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minWidth: 0, maxWidth: .infinity)
            .clipped()
            .accessibilityIdentifier("share-stage-header")

            ZStack {
                Color.black
                if isSelf {
                    VStack(spacing: 8) {
                        Image(systemName: "rectangle.inset.filled.and.person.filled").font(.system(size: 40))
                        Text("你正在共享屏幕，其他人看到的是你选择的内容")
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                    }
                    .padding()
                    .foregroundStyle(.white.opacity(0.8))
                } else if let ref = model.media.videoTracks.first(where: { $0.isScreen && $0.sessionID == current.sessionID }) {
                    if actualSize {
                        ActualSizeVideo(ref: ref)
                    } else {
                        VideoSurface(ref, fit: true)
                    }
                } else {
                    ProgressView().controlSize(.large).tint(.white)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .clipped()

            MemberStrip()
        }
    }
}

/// 共享控制条的容器：只有它读每 500 ms 更新一次的共享统计（MediaSession.share），统计变化时只重算这一块
struct LiveShareBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let status = model.media.share { ShareBar(status: status) }
    }
}

/// 自己在共享时的控制条：当前参数、切换意图、停止
struct ShareBar: View {
    @Environment(AppModel.self) private var model
    let status: ShareStatus
    @State private var editingCustom = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "rectangle.on.rectangle").foregroundStyle(.red)
            Text("正在共享屏幕").fontWeight(.medium)
            Text(detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            // 选「自定义」时先在弹出的面板里确认参数，应用后才切换
            Picker("模式", selection: Binding(get: { status.intent }, set: { i in
                if i == .custom { editingCustom = true } else { Task { await model.media.setShareIntent(i) } }
            })) {
                ForEach(ShareIntentName.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.menu)
            .fixedSize()
            .labelsHidden()
            .help("智能：按画面内容自动在清晰和流畅之间切换；自定义：自己设定分辨率、帧率、码率和编码")
            if status.intent == .custom {
                Button { editingCustom = true } label: { Image(systemName: "slider.horizontal.3") }
                    .buttonStyle(.borderless)
                    .help("调整自定义参数")
                    .accessibilityIdentifier("share-custom-edit")
            }
            Button(role: .destructive) { Task { await model.media.stopScreenShare() } } label: {
                Text("停止共享")
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .accessibilityIdentifier("share-stop")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // 不向分栏视图报告最小宽度：统计文字每 500 ms 变化，否则会让 NSSplitView 反复重算约束（AppKit 会因此抛异常）
        .frame(minWidth: 0, maxWidth: .infinity)
        .clipped()
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.red.opacity(0.2)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .accessibilityIdentifier("share-bar")
        .popover(isPresented: $editingCustom, arrowEdge: .bottom) { ShareCustomEditor() }
    }

    private var detail: String {
        let p = status.params
        let mode = p.mode == .motion ? L("流畅") : L("清晰")
        var parts = ["\(mode)", "\(p.width)×\(p.height)", "\(p.fps) fps", status.codec.rawValue.uppercased()]
        if status.intent == .custom { parts.insert(L("上限 \(p.maxKbps) kbps"), at: 3) }
        if status.sentKbps > 0 { parts.append(String(format: "%.1f Mbps", Double(status.sentKbps) / 1000)) }
        if status.qualityLimitation != .none { parts.append(L("受限：\(status.qualityLimitation.rawValue)")) }
        return parts.joined(separator: " · ")
    }
}

/// 开始共享前的选项：模式和是否共享声音；内容由系统选择器选择
struct SharePopover: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("shareIntent") private var intent: ShareIntentName = .smart
    @AppStorage("shareAudio") private var withAudio = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("共享屏幕").font(.headline)
            Picker("模式", selection: $intent) {
                ForEach(ShareIntentName.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.radioGroup)
            Text(hint).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if intent == .custom {
                @Bindable var model = model
                Form { ShareCustomForm(custom: $model.shareCustom) }
                    .formStyle(.columns)
            }
            Toggle("同时共享声音", isOn: $withAudio)
            HStack {
                Spacer()
                Button("选择共享内容…") {
                    dismiss()
                    Task { await model.startShare(intent: intent, withAudio: withAudio) }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(width: 320)
    }

    private var hint: String {
        switch intent {
        case .smart: L("按画面内容自动切换：文档和代码保持清晰，播放视频时保持流畅。")
        case .clarity: L("文字最清楚，适合文档、代码、表格。")
        case .smoothness: L("动作最流畅，适合视频、游戏、动画。")
        case .custom: L("自己设定分辨率、帧率、码率和编码：24 fps 及以上按动态画面处理（网络不好时先降清晰度），以下按文字处理（先降帧率）。")
        }
    }
}
