import HaneCore
import HaneMedia
import SwiftUI

/// 自定义共享参数：分辨率、帧率、码率（留空为自动），都不超过服务器设的上限；
/// 编码器只列出本机能硬件编码的（苹果设备是 H.265 / H.264）。
/// iPhone 的广播采集不能调整分辨率（始终是整个屏幕），只设帧率、码率和编码器。
struct ShareCustomForm: View {
    @Environment(AppModel.self) private var model
    @Binding var custom: CustomShare
    var showsResolution = true
    @State private var kbpsText = ""

    var body: some View {
        let limits = Self.limits(model.session.state.media?.policy.screen)
        let codecs = model.media.shareCodecOptions
        let others = roomOthers
        // 记住的编码器现在不可用（例如进了加密房间）时显示为「自动」，共享时也按自动选
        let selected = custom.codec.flatMap { codecs.contains($0) ? $0 : nil }
        let fpsList = Array(Set([5, 10, 15, 24, 30, 60].filter { $0 <= limits.maxFps } + [limits.maxFps])).sorted()
        Group {
            if showsResolution {
                Picker("分辨率", selection: $custom.height) {
                    Text("原始分辨率").tag(Int?.none)
                    ForEach([2160, 1440, 1080, 720, 480].filter { $0 <= limits.maxHeight }, id: \.self) { h in
                        Text(verbatim: h == 2160 ? "4K" : "\(h)p").tag(Optional(h))
                    }
                }
            }
            #if os(iOS)
            // iPhone 的表单里分段控件不显示标题：标题单独一行
            VStack(alignment: .leading, spacing: 8) {
                Text("帧率（fps）")
                fpsPicker(fpsList)
            }
            #else
            fpsPicker(fpsList)
            #endif
            // 24 fps 及以上按动态画面处理：随帧率实时变化
            Self.caption(custom.mode == .motion ? "按动态画面处理：网络不好时先降清晰度，保证流畅" : "按文字处理：网络不好时先降帧率，保证字清楚",
                         icon: custom.mode == .motion ? "film" : "doc.text")
            LabeledContent("码率") {
                HStack(spacing: 6) {
                    TextField("码率", text: $kbpsText, prompt: Text("自动"))
                        .labelsHidden()
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                    #if os(iOS)
                        .keyboardType(.numberPad)
                    #endif
                    Text(verbatim: "kbps").foregroundStyle(.secondary)
                }
            }
            Self.caption("留空按分辨率和帧率自动选择，最高 \(String(limits.maxKbps))")
            if !codecs.isEmpty {
                Picker("编码", selection: Binding(get: { selected }, set: { custom.codec = $0 })) {
                    Text("自动").tag(ShareCodec?.none)
                    ForEach(codecs, id: \.self) { c in
                        // 有人不能硬件解码：选项里只写人数，完整说明在下面
                        Text(Self.optionLabel(c, others)).tag(Optional(c))
                    }
                }
                if let selected, case let note = Self.decodeNote(selected, others), !note.isEmpty {
                    Self.callout(note)
                } else {
                    Self.caption("只列出这台设备能硬件编码的格式。共享中更换编码，对方画面会中断约一秒。")
                }
            }
            Self.caption("服务器上限：\(String(limits.maxHeight))p · \(String(limits.maxFps)) fps · \(String(limits.maxKbps)) kbps", icon: "info.circle")
                .padding(.top, 4)
        }
        .onAppear { kbpsText = custom.kbps.map(String.init) ?? "" }
        .onChange(of: kbpsText) { _, text in
            let n = Int(text.trimmingCharacters(in: .whitespaces))
            custom.kbps = n.flatMap { $0 > 0 ? min(max($0, 100), limits.maxKbps) : nil }
        }
    }

    private func fpsPicker(_ list: [Int]) -> some View {
        Picker("帧率（fps）", selection: $custom.fps) {
            ForEach(list, id: \.self) { f in Text(verbatim: "\(f)").tag(f) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("share-custom-fps")
    }

    private static func caption(_ text: LocalizedStringKey, icon: String? = nil) -> some View {
        Group {
            if let icon { Label(text, systemImage: icon) } else { Text(text) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// 选中的编码器有人不能硬件解码时的提示框
    private static func callout(_ note: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            Text(verbatim: note).fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.orange.opacity(0.35)))
        .accessibilityIdentifier("share-custom-codec-note")
    }

    /// 同一房间里的其他成员
    private var roomOthers: [Openhane_V1_Participant] {
        let state = model.session.state
        guard let me = state.me?.sessionID, let room = state.participants[me]?.roomID else { return [] }
        return state.participants.values.filter { $0.sessionID != me && $0.roomID == room }.sorted { $0.nickname < $1.nickname }
    }

    /// 下拉选项的文字：有人受影响时只加人数，完整说明显示在下拉框下面（与 Web 版 codecNote.ts 一致）
    static func optionLabel(_ c: ShareCodec, _ others: [Openhane_V1_Participant]) -> String {
        let g = decodeGap(codec: c, others: others)
        let n = g.unsupported.count + g.softwareOnly.count
        return n == 0 ? codecName(c) : L("\(codecName(c))（\(n) 人受影响）")
    }

    /// 选中编码器后显示在下拉框下面的完整说明：谁不能硬件解码、谁完全解不了；没有问题时为空
    static func decodeNote(_ c: ShareCodec, _ others: [Openhane_V1_Participant]) -> String {
        let g = decodeGap(codec: c, others: others)
        let name = codecName(c)
        func who(_ names: [String]) -> String {
            let head = names.prefix(2).joined(separator: L("、"))
            return names.count > 2 ? L("\(head) 等 \(names.count) 人") : head
        }
        var parts: [String] = []
        if !g.unsupported.isEmpty {
            parts.append(c == .h264 ? L("\(who(g.unsupported)) 无法解码 \(name)，看不到画面") : L("\(who(g.unsupported)) 无法解码 \(name)，会看 H.264 画面"))
        }
        if !g.softwareOnly.isEmpty { parts.append(L("\(who(g.softwareOnly)) 不支持 \(name) 硬件解码，会用软件解码（更费电，可能卡顿）")) }
        // 中文：名字是汉字时去掉模板里留给拉丁字母名字的空格（「等 4 人 不支持」→「等 4 人不支持」）
        return parts.joined(separator: L("；")).replacingOccurrences(of: "(\\p{Han}) (?=\\p{Han})", with: "$1", options: .regularExpression)
    }

    static func codecName(_ c: ShareCodec) -> String {
        switch c {
        case .av1: "AV1"
        case .h265: "H.265"
        case .h264: "H.264"
        case .vp9: "VP9"
        case .vp8: "VP8"
        }
    }

    /// 服务器（管理员 / 房间）的上限；没有设置时与引擎的默认值一致
    static func limits(_ s: Openhane_V1_ScreenPolicy?) -> (maxHeight: Int, maxFps: Int, maxKbps: Int) {
        (s.map { Int($0.maxHeight) }.flatMap { $0 > 0 ? $0 : nil } ?? 2160,
         s.map { Int($0.maxFps) }.flatMap { $0 > 0 ? $0 : nil } ?? 60,
         s.map { Int($0.maxBitrateBps) / 1000 }.flatMap { $0 > 0 ? $0 : nil } ?? 8000)
    }
}

/// 共享中调整自定义参数：编辑副本，点「应用」才生效并记住
struct ShareCustomEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var showsResolution = true
    @State private var custom = CustomShare.default

    var body: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 14) {
            Text("自定义共享参数").font(.headline)
            Form { ShareCustomForm(custom: $custom, showsResolution: showsResolution) }
                .formStyle(.columns)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("应用", action: apply)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("share-custom-apply")
            }
        }
        .padding()
        .frame(width: 380)
        .onAppear { custom = model.shareCustom }
        #else
        NavigationStack {
            Form { ShareCustomForm(custom: $custom, showsResolution: showsResolution) }
                .navigationTitle("自定义共享参数")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("应用", action: apply) }
                }
        }
        .onAppear { custom = model.shareCustom }
        #endif
    }

    private func apply() {
        model.shareCustom = custom
        dismiss()
        Task { await model.media.setShareIntent(.custom, custom: custom) }
    }
}
