#if os(macOS)
import AVFoundation
import CoreMedia
import Foundation
import HaneCore
@preconcurrency import ScreenCaptureKit

/// macOS 屏幕采集：
/// - 用系统的 SCContentSharingPicker 选择共享内容（屏幕 / 窗口 / 应用），按次授权，不需要预先授予录屏权限；
///   选择器中排除本应用。系统菜单栏的「停止共享」通过 SCStreamDelegate 回调同步到界面。
/// - SCK 输出 420v，在 GPU 上缩放到目标分辨率；每帧附带的脏区直接给出变化面积，画面不变时只有空闲帧（零开销的变化检测）。
/// - 颜色：SCK 默认按显示器的色彩空间输出（Mac 屏幕多是 Display P3），而 WebRTC 编码和各端接收都按 sRGB / BT.709 解释，
///   P3 的数值当成 sRGB 显示会变淡发灰。所以要求 SCK 输出 sRGB + BT.709 矩阵，由系统在采集时做色域转换。
/// - 共享声音：capturesAudio + excludesCurrentProcessAudio（不会把会议里其他人的声音共享出去）。
@MainActor
public final class SCKFrameSource: NSObject, ShareFrameSource {
    private var stream: SCStream?
    private var output: StreamOutput?
    private var filter: SCContentFilter?
    private var pickerContinuation: CheckedContinuation<SCContentFilter, Error>?
    private var withAudio = false
    private static let sampleFps = 30

    override public init() {}

    public func start(withAudio: Bool, callbacks: ShareCallbacks) async throws -> SourceSize {
        self.withAudio = withAudio
        let picker = SCContentSharingPicker.shared
        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleDisplay, .singleWindow, .singleApplication]
        if let id = Bundle.main.bundleIdentifier { config.excludedBundleIDs = [id] }
        picker.defaultConfiguration = config
        picker.add(self)
        picker.isActive = true
        let filter: SCContentFilter
        do {
            filter = try await withCheckedThrowingContinuation { cont in
                pickerContinuation = cont
                picker.present()
            }
        } catch {
            picker.remove(self)
            picker.isActive = false
            throw error
        }
        self.filter = filter
        let scale = Double(filter.pointPixelScale)
        let size = SourceSize(width: Int(filter.contentRect.width * scale), height: Int(filter.contentRect.height * scale))
        let out = StreamOutput(callbacks: callbacks, size: size)
        output = out
        let s = SCStream(filter: filter, configuration: Self.configuration(width: size.width, height: size.height, fps: 15, withAudio: withAudio), delegate: out)
        try s.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "hane.share.screen", qos: .userInteractive))
        if withAudio {
            try s.addStreamOutput(out, type: .audio, sampleHandlerQueue: DispatchQueue(label: "hane.share.audio", qos: .userInteractive))
        }
        try await s.startCapture()
        stream = s
        return size
    }

    static func configuration(width: Int, height: Int, fps: Int, withAudio: Bool) -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        c.width = width
        c.height = height
        c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange // 420v：直接交给 VideoToolbox，免颜色转换
        // sRGB + BT.709（见文件开头）：不设置时输出显示器的色彩空间，P3 屏幕上共享出去的画面发灰
        c.colorSpaceName = CGColorSpace.sRGB
        c.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        // 采样帧率不低于 30 fps：画面不变时只有空闲帧，几乎没有额外开销；否则文字模式下测不到 ≥ 20 fps 的变化
        c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(fps, sampleFps)))
        c.queueDepth = 5
        c.showsCursor = true
        c.capturesAudio = withAudio
        c.excludesCurrentProcessAudio = true
        c.sampleRate = 48000
        c.channelCount = 2
        return c
    }

    public func update(width: Int, height: Int, sampleFps fps: Int) async {
        output?.setOutputSize(width: width, height: height)
        try? await stream?.updateConfiguration(Self.configuration(width: width, height: height, fps: fps, withAudio: withAudio))
    }

    public func stop() async {
        try? await stream?.stopCapture()
        stream = nil
        output = nil
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        picker.isActive = false
    }
}

extension SCKFrameSource: SCContentSharingPickerObserver {
    nonisolated public func contentSharingPicker(_: SCContentSharingPicker, didCancelFor _: SCStream?) {
        Task { @MainActor in
            self.pickerContinuation?.resume(throwing: ShareCancelled())
            self.pickerContinuation = nil
        }
    }

    nonisolated public func contentSharingPicker(_: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for _: SCStream?) {
        Task { @MainActor in
            if let cont = self.pickerContinuation {
                self.pickerContinuation = nil
                cont.resume(returning: filter)
            } else if let s = self.stream {
                // 共享中用系统选择器换了内容：直接切换，不中断共享
                try? await s.updateContentFilter(filter)
            }
        }
    }

    nonisolated public func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in
            self.pickerContinuation?.resume(throwing: error)
            self.pickerContinuation = nil
        }
    }
}

/// SCK 回调（在采集队列上）：脏区 → 变化面积；音频 → PCM
private final class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let callbacks: ShareCallbacks
    private let lock = NSLock()
    private var outputPixels: Double

    init(callbacks: ShareCallbacks, size: SourceSize) {
        self.callbacks = callbacks
        outputPixels = Double(size.width * size.height)
    }

    func setOutputSize(width: Int, height: Int) { lock.withLock { outputPixels = Double(width * height) } }

    func stream(_: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let info = attachments.first, let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
            else { return } // 画面没变化时 SCK 只发「空闲」帧
            var area = 0.0
            if let rects = info[.dirtyRects] as? [NSDictionary] {
                for d in rects { if let r = CGRect(dictionaryRepresentation: d) { area += Double(r.width * r.height) } }
            }
            let total = lock.withLock { outputPixels }
            callbacks.onFrame(ShareFrame(sampleBuffer: sb, changedArea: min(1, area / max(total, 1))))
        case .audio:
            guard let onAudio = callbacks.onAudio, let pcm = Self.pcm(from: sb) else { return }
            onAudio(pcm)
        default:
            break
        }
    }

    func stream(_: SCStream, didStopWithError _: Error) {
        callbacks.onStop() // 用户在系统菜单栏停止了共享，或者共享的窗口关闭了
    }

    static func pcm(from sb: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee,
              let format = AVAudioFormat(streamDescription: [asbd]),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sb)))
        else { return nil }
        buffer.frameLength = buffer.frameCapacity
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(buffer.frameLength), into: buffer.mutableAudioBufferList)
        return status == noErr ? buffer : nil
    }
}
#endif
