import HaneCore
import HaneMedia
import SwiftUI

/// 观看共享：共享画面为焦点，双指缩放 / 平移看小字，可全屏横屏观看；多人同时共享时切换。
struct PhoneShareStage: View {
    @Environment(AppModel.self) private var model
    let shares: [Openhane_V1_ShareInfo]
    @State private var selected: String?
    @State private var fullscreen = false

    var body: some View {
        let state = model.session.state
        let current = shares.first { $0.sessionID == selected } ?? shares.first { $0.sessionID != state.me?.sessionID } ?? shares[0]
        let sharer = state.participants[current.sessionID]
        let isSelf = current.sessionID == state.me?.sessionID
        let ref = model.media.videoTracks.first { $0.isScreen && $0.sessionID == current.sessionID }
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if isSelf {
                    VStack(spacing: 8) {
                        Image(systemName: "rectangle.inset.filled.and.person.filled").font(.system(size: 36))
                        Text("你正在共享屏幕").multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.white.opacity(0.8))
                } else if let ref {
                    ZoomableVideo(ref: ref)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            // 谁在共享、共享模式、全屏按钮浮在画面上方
            .overlay(alignment: .top) {
                HStack(spacing: 8) {
                    if shares.count > 1 {
                        Picker("共享", selection: Binding(get: { current.sessionID }, set: { selected = $0 })) {
                            ForEach(shares, id: \.sessionID) { s in Text(state.participants[s.sessionID]?.nickname ?? "?").tag(s.sessionID) }
                        }
                        .pickerStyle(.segmented)
                        .fixedSize()
                    } else {
                        HStack(spacing: 6) {
                            if let sharer { AvatarView(name: sharer.nickname, uid: sharer.uid, size: 20) }
                            Text(L("\(sharer?.nickname ?? "?") 正在共享屏幕")).lineLimit(1)
                            Text(ShareIntentName(current.intent).label).foregroundStyle(.white.opacity(0.7))
                        }
                        .font(.caption.weight(.medium))
                        .padding(.leading, 5)
                        .padding(.trailing, 10)
                        .padding(.vertical, 5)
                        .background(.ultraThinMaterial, in: Capsule())
                    }
                    Spacer(minLength: 0)
                    if ref != nil, !isSelf {
                        Button { fullscreen = true } label: {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.footnote.weight(.semibold))
                                .frame(width: 32, height: 32)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("全屏")
                    }
                }
                .foregroundStyle(.white)
                .environment(\.colorScheme, .dark)
                .padding(10)
            }
            MemberStrip()
        }
        .fullScreenCover(isPresented: $fullscreen) {
            ZStack(alignment: .topTrailing) {
                Color.black.ignoresSafeArea()
                if let ref { ZoomableVideo(ref: ref).ignoresSafeArea() }
                Button { fullscreen = false } label: {
                    Image(systemName: "xmark.circle.fill").font(.title).symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.5))
                }
                .padding()
                .accessibilityLabel("退出全屏")
            }
            .statusBarHidden()
        }
    }
}

/// 可缩放的共享画面：双指缩放（1–4 倍）后可以拖动查看，双击在 1 倍和 2.5 倍之间切换
struct ZoomableVideo: View {
    let ref: VideoTrackRef
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1

    var body: some View {
        GeometryReader { geo in
            ScrollView([.horizontal, .vertical], showsIndicators: false) {
                VideoSurface(ref, fit: true)
                    .frame(width: geo.size.width * scale, height: geo.size.height * scale)
            }
            .scrollDisabled(scale <= 1)
            .defaultScrollAnchor(.center)
            .gesture(MagnifyGesture()
                .onChanged { scale = min(4, max(1, base * $0.magnification)) }
                .onEnded { _ in base = scale })
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.2)) { scale = scale > 1 ? 1 : 2.5 }
                base = scale
            }
        }
    }
}

/// 共享控制条的容器：只有它读每 500 ms 更新一次的共享统计（MediaSession.share），统计变化时只重算这一块
struct LivePhoneShareBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let status = model.media.share { PhoneShareBar(status: status) }
    }
}

/// 自己在共享时的控制条：模式和停止
struct PhoneShareBar: View {
    @Environment(AppModel.self) private var model
    let status: ShareStatus
    @State private var editingCustom = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "record.circle").foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 1) {
                Text("正在共享屏幕").font(.subheadline.weight(.medium))
                Text("\(status.params.width)×\(status.params.height) · \(status.params.fps) fps · \(status.codec.rawValue.uppercased())")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                Picker("模式", selection: Binding(get: { status.intent }, set: { i in
                    Task { await model.media.setShareIntent(i, custom: i == .custom ? model.shareCustom : nil) }
                })) {
                    ForEach([ShareIntentName.clarity, .smoothness, .custom], id: \.self) { Text($0.label).tag($0) }
                }
                Button("自定义参数…", systemImage: "slider.horizontal.3") { editingCustom = true }
            } label: {
                Text(status.intent.label).font(.caption)
            }
            Button("停止") { Task { await model.media.stopScreenShare() } }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.red.opacity(0.2)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .sheet(isPresented: $editingCustom) { ShareCustomEditor(showsResolution: false).presentationDetents([.medium]) }
    }
}

/// 开始共享前的选项；随后弹出系统的广播选择器（选择「羽见」后开始直播）
struct ShareOptionsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("shareIntent.ios") private var intent: ShareIntentName = .clarity
    @AppStorage("shareAudio") private var withAudio = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("模式", selection: $intent) {
                        ForEach([ShareIntentName.clarity, .smoothness, .custom], id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    switch intent {
                    case .smoothness: Text("动作最流畅，适合视频、游戏。")
                    case .custom: Text("自己设定帧率、码率和编码（分辨率始终是整个屏幕）。")
                    default: Text("文字最清楚，适合文档、网页、聊天记录。")
                    }
                }
                if intent == .custom {
                    @Bindable var model = model
                    Section { ShareCustomForm(custom: $model.shareCustom, showsResolution: false) }
                }
                Section {
                    Toggle("同时共享声音", isOn: $withAudio)
                } footer: {
                    Text("共享整个手机屏幕。点「开始」后在系统弹出的面板中选择羽见，再点「开始直播」。通知等内容也会被共享，建议先开启勿扰模式。")
                }
                Section {
                    Button {
                        dismiss()
                        Task { await model.startShare(intent: intent, withAudio: withAudio) }
                    } label: {
                        HStack { Spacer(); Text("开始").fontWeight(.semibold); Spacer() }
                    }
                }
            }
            .navigationTitle("共享屏幕")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
