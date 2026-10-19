import AppKit
import AVFoundation
import HaneCore
import HaneMedia
import SwiftUI

/// 个人音频设置
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var recording = false
    @State private var monitor: Any?
    @State private var cameras: [AVCaptureDevice] = []

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("输入设备", selection: model.inputDeviceBinding) {
                    Text("系统默认").tag("")
                    ForEach(model.media.inputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
                Picker("输出设备", selection: model.outputDeviceBinding) {
                    Text("系统默认").tag("")
                    ForEach(model.media.outputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
                VolumeSlider(title: "麦克风音量", value: $model.inputVolume)
                VolumeSlider(title: "输出音量", value: $model.outputVolume)
            }
            Section {
                Picker("摄像头", selection: $model.cameraID) {
                    Text("系统默认").tag("")
                    ForEach(cameras, id: \.uniqueID) { Text($0.localizedName).tag($0.uniqueID) }
                    // 选过的摄像头现在没接上：仍然显示，不让选择框变成空白
                    if !model.cameraID.isEmpty, !cameras.contains(where: { $0.uniqueID == model.cameraID }) {
                        Text("未连接的摄像头").tag(model.cameraID)
                    }
                }
                .accessibilityIdentifier("camera-select")
            }
            Section("回声消除") {
                Picker("回声消除", selection: $model.echoProcessing) {
                    ForEach(EchoProcessing.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Text(model.echoProcessing.detail).font(.caption).foregroundStyle(.secondary)
            }
            Section("降噪") {
                if MediaSession.aiNoiseAvailable {
                    Picker("降噪", selection: $model.noiseSuppression) {
                        ForEach(NoiseSuppression.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.noiseSuppression.detail).foregroundStyle(.secondary)
                        Text(model.media.noiseState.label).foregroundStyle(model.media.noiseState.isWarning ? .orange : .secondary)
                    }
                    .font(.caption)
                } else if model.echoProcessing == .system {
                    LabeledContent("系统语音处理") {
                        Text("已开启（回声消除、降噪、自动增益）").foregroundStyle(.secondary)
                    }
                }
                // 「语音突显」等麦克风模式只在系统语音处理下生效
                if model.echoProcessing == .system {
                    LabeledContent("麦克风模式") {
                        HStack {
                            Text(modeName(model.activeMicrophoneMode)).foregroundStyle(.secondary)
                            Button("更改…") { model.showMicrophoneModes() }
                        }
                    }
                    Text("也可以在控制中心选择「语音突显」，由系统进行 AI 降噪。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("发言模式") {
                Picker("模式", selection: $model.voiceMode) {
                    Text("语音激活").tag(VoiceMode.voice)
                    Text("按键说话").tag(VoiceMode.ptt)
                    Text("常开").tag(VoiceMode.open)
                }
                .pickerStyle(.segmented)
                if model.voiceMode == .ptt {
                    LabeledContent("按键") {
                        Button(recording ? "请按下一个键…" : model.pttBinding.label) { startRecording() }
                            .font(.body.monospaced())
                    }
                    if !model.hotkeyAvailable {
                        HStack {
                            Text("全局按键说话需要「输入监控」权限。").font(.caption).foregroundStyle(.orange)
                            Button("打开系统设置") {
                                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
                            }
                            .controlSize(.small)
                        }
                    }
                }
                if model.voiceMode == .voice {
                    Toggle("自动灵敏度", isOn: Binding(get: { model.manualThreshold == nil }, set: { model.manualThreshold = $0 ? nil : -50 }))
                    if let t = model.manualThreshold {
                        Slider(value: Binding(get: { t }, set: { model.manualThreshold = $0 }), in: -80 ... 0) { Text("灵敏度") }
                    }
                }
                LiveLevelMeter()
            }
            if AppUpdater.shared.enabled {
                UpdateSettingsSection()
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .task { await model.media.refreshAudioDevices() }
        // 摄像头列表：打开设置时读一次，插拔时更新
        .onAppear { cameras = Self.videoDevices() }
        .onReceive(NotificationCenter.default.publisher(for: AVCaptureDevice.wasConnectedNotification)) { _ in cameras = Self.videoDevices() }
        .onReceive(NotificationCenter.default.publisher(for: AVCaptureDevice.wasDisconnectedNotification)) { _ in cameras = Self.videoDevices() }
        .onDisappear(perform: stopRecording)
    }

    private func modeName(_ m: AVCaptureDevice.MicrophoneMode) -> LocalizedStringKey {
        switch m {
        case .voiceIsolation: return "语音突显"
        case .wideSpectrum: return "宽频谱"
        default: return "标准"
        }
    }

    private func startRecording() {
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged, .otherMouseDown]) { e in
            if let b = HotkeyMonitor.binding(from: e) {
                model.pttBinding = b
                stopRecording()
                return nil
            }
            return e
        }
    }

    private func stopRecording() {
        recording = false
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}

/// 输入电平条（门限线为红色）
struct LevelMeter: View {
    let level: Double
    let threshold: Double
    let active: Bool

    var body: some View {
        GeometryReader { geo in
            let pct = { (db: Double) in max(0, min(1, (db + 80) / 80)) }
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(.quaternary)
                RoundedRectangle(cornerRadius: 3).fill(active ? Color.green : Color.secondary.opacity(0.5))
                    .frame(width: geo.size.width * pct(level))
                Rectangle().fill(.red).frame(width: 2).offset(x: geo.size.width * pct(threshold))
            }
        }
        .frame(height: 10)
        .accessibilityLabel(Text("输入电平"))
    }
}

extension SettingsView {
    /// 可选的摄像头：内置、外接和连续互通相机
    static func videoDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video, position: .unspecified).devices
    }
}

extension AppModel {
    /// 设置和会议里的菜单共用：选中的输入 / 输出设备（空表示系统默认）。选中的设备拔掉后显示为系统默认
    var inputDeviceBinding: Binding<String> {
        Binding(get: { self.media.inputDevices.contains { $0.deviceId == self.inputDeviceID } ? self.inputDeviceID : "" },
                set: { id in
                    if id.isEmpty { self.media.selectDefaultInput() } else if let d = self.media.inputDevices.first(where: { $0.deviceId == id }) { self.media.selectInput(d) } else { return }
                    self.inputDeviceID = id
                })
    }

    var outputDeviceBinding: Binding<String> {
        Binding(get: { self.media.outputDevices.contains { $0.deviceId == self.outputDeviceID } ? self.outputDeviceID : "" },
                set: { id in
                    if id.isEmpty { self.media.selectDefaultOutput() } else if let d = self.media.outputDevices.first(where: { $0.deviceId == id }) { self.media.selectOutput(d) } else { return }
                    self.outputDeviceID = id
                })
    }
}

/// 音量滑块（0–200%），右边显示百分比
struct VolumeSlider: View {
    let title: LocalizedStringKey
    @Binding var value: Double

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 8) {
                // 不设步长（步长会画出一排刻度），取整到 5%
                Slider(value: Binding(get: { value }, set: { value = ($0 * 20).rounded() / 20 }), in: 0 ... 2)
                    .frame(minWidth: 120)
                Text(verbatim: "\(Int((value * 100).rounded()))%")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 40, alignment: .trailing)
            }
        }
    }
}

/// 电平表的容器：电平每 50 ms 更新一次，只让这一小块重算（直接写在设置表单里会让整个表单跟着重算，打开设置时很卡）
struct LiveLevelMeter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        LevelMeter(level: model.media.localLevelDb, threshold: model.media.localThresholdDb, active: model.media.transmitting)
    }
}

/// 自动更新的设置（Sparkle）
private struct UpdateSettingsSection: View {
    @State private var updater = AppUpdater.shared
    @State private var automatic = AppUpdater.shared.automaticChecks

    var body: some View {
        Section("更新") {
            Toggle("自动检查更新", isOn: $automatic)
                .onChange(of: automatic) { _, v in updater.automaticChecks = v }
            Toggle("接收公测版", isOn: $updater.beta)
            Button("检查更新…") { updater.checkForUpdates() }
                .disabled(!updater.canCheck)
        }
    }
}
