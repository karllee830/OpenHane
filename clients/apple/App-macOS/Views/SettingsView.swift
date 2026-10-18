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
    @State private var devicesTick = 0

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("输入设备", selection: Binding(get: { model.media.inputDevices.first { $0.deviceId == AudioDeviceSelection.input }?.deviceId ?? "" },
                                                   set: { id in if let d = model.media.inputDevices.first(where: { $0.deviceId == id }) { model.media.selectInput(d); AudioDeviceSelection.input = id; devicesTick += 1 } })) {
                    Text("系统默认").tag("")
                    ForEach(model.media.inputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
                Picker("输出设备", selection: Binding(get: { model.media.outputDevices.first { $0.deviceId == AudioDeviceSelection.output }?.deviceId ?? "" },
                                                    set: { id in if let d = model.media.outputDevices.first(where: { $0.deviceId == id }) { model.media.selectOutput(d); AudioDeviceSelection.output = id; devicesTick += 1 } })) {
                    Text("系统默认").tag("")
                    ForEach(model.media.outputDevices, id: \.deviceId) { Text($0.name).tag($0.deviceId) }
                }
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

/// 选中的设备（重启后由系统默认重新选择；这里只记住 ID 供界面显示）
enum AudioDeviceSelection {
    static var input: String {
        get { UserDefaults.standard.string(forKey: "inputDevice") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "inputDevice") }
    }

    static var output: String {
        get { UserDefaults.standard.string(forKey: "outputDevice") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "outputDevice") }
    }
}

/// 电平表的容器：电平每 50 ms 更新一次，只让这一小块重算（直接写在设置表单里会让整个表单跟着重算，打开设置时很卡）
private struct LiveLevelMeter: View {
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
