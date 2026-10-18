import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import LiveKit
import HaneCore

/// 用户在系统选择器中取消
public struct ShareCancelled: Error {}

/// 采集到的一帧：像素数据 + 相对上一帧的变化面积（0–1）
public struct ShareFrame: @unchecked Sendable {
    public var sampleBuffer: CMSampleBuffer?
    public var pixelBuffer: CVPixelBuffer?
    public var changedArea: Double
    public init(sampleBuffer: CMSampleBuffer? = nil, pixelBuffer: CVPixelBuffer? = nil, changedArea: Double) {
        self.sampleBuffer = sampleBuffer
        self.pixelBuffer = pixelBuffer
        self.changedArea = changedArea
    }
}

public struct ShareCallbacks: Sendable {
    public var onFrame: @Sendable (ShareFrame) -> Void
    /// 共享声音（48 kHz 浮点 PCM）；不共享声音时为 nil
    public var onAudio: (@Sendable (AVAudioPCMBuffer) -> Void)?
    /// 采集被外部停止（例如用户在系统菜单栏点了「停止共享」）
    public var onStop: @Sendable () -> Void
}

/// 屏幕采集源。真实使用 SCKFrameSource（macOS），测试使用 SyntheticFrameSource。
@MainActor
public protocol ShareFrameSource: AnyObject {
    /// 让用户选择要共享的内容并开始采集，返回源的像素尺寸；用户取消时抛出 ShareCancelled。
    func start(withAudio: Bool, callbacks: ShareCallbacks) async throws -> SourceSize
    /// 调整输出分辨率和采样帧率（在采集端缩放，比编码器缩放省）
    func update(width: Int, height: Int, sampleFps: Int) async
    func stop() async
}

/// 共享的采集方式：macOS 为 FrameSourceCapture（SCK / 合成画面 → BufferCapturer），iOS 为 BroadcastCapture（广播扩展）。
@MainActor
protocol ShareCapture: AnyObject {
    /// 开始采集，返回已创建的视频轨道和源的像素尺寸；onStop 在采集被外部停止时调用。
    func start(withAudio: Bool, onStop: @escaping @Sendable () -> Void) async throws -> (track: LocalVideoTrack, size: SourceSize)
    /// 应用引擎给出的分辨率和帧率（能在采集端调整时）
    func apply(width: Int, height: Int, fps: Int) async
    /// 最近 500 ms 的变化信号；无法检测变化时返回 nil
    func signals() -> (area: Double, fps: Double)?
    func stop() async
}

/// macOS / 测试：帧源（SCK 或合成画面）→ 帧接收（变化信号 + 抽稀）→ BufferCapturer 轨道
@MainActor
final class FrameSourceCapture: ShareCapture {
    private let source: ShareFrameSource
    private let onAudio: (@Sendable (AVAudioPCMBuffer) -> Void)?
    private var sink: FrameSink?

    init(source: ShareFrameSource, onAudio: (@Sendable (AVAudioPCMBuffer) -> Void)?) {
        self.source = source
        self.onAudio = onAudio
    }

    func start(withAudio: Bool, onStop: @escaping @Sendable () -> Void) async throws -> (track: LocalVideoTrack, size: SourceSize) {
        let track = await LocalVideoTrack.createBufferTrack(source: .screenShareVideo, reportStatistics: true)
        guard let capturer = track.capturer as? BufferCapturer else { throw HaneError.protocolViolation("no buffer capturer") }
        let sink = FrameSink(capturer: capturer)
        self.sink = sink
        let size = try await source.start(withAudio: withAudio, callbacks: ShareCallbacks(
            onFrame: { [sink] f in sink.receive(f) },
            onAudio: withAudio ? onAudio : nil,
            onStop: onStop
        ))
        return (track, size)
    }

    func apply(width: Int, height: Int, fps: Int) async {
        await source.update(width: width, height: height, sampleFps: fps)
        sink?.setForwardFps(fps)
    }

    func signals() -> (area: Double, fps: Double)? { sink?.signals() }

    func stop() async {
        await source.stop()
        sink = nil
    }
}

/// 帧接收：记录变化面积用于计算信号，并按目标帧率抽稀后交给编码器（采样帧率与编码帧率分开，S3 发现）。
final class FrameSink: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [(t: Double, area: Double)] = []
    private var lastForward = -Double.infinity
    private var forwardFps = 15.0
    private(set) var received = 0
    let capturer: BufferCapturer
    private let clock = ContinuousClock()
    private let start: ContinuousClock.Instant

    init(capturer: BufferCapturer) {
        self.capturer = capturer
        start = clock.now
    }

    func nowMs() -> Double {
        let d = clock.now - start
        return Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
    }

    func setForwardFps(_ fps: Int) { lock.withLock { forwardFps = Double(max(1, fps)) } }

    func receive(_ f: ShareFrame) {
        let t = nowMs()
        let forward: Bool = lock.withLock {
            received += 1
            frames.append((t, f.changedArea))
            frames.removeAll { t - $0.t > 2000 }
            // 留 10% 余量，避免采样抖动导致少送一帧
            guard t - lastForward >= 900 / forwardFps else { return false }
            lastForward = t
            return true
        }
        guard forward else { return }
        if let sb = f.sampleBuffer { capturer.capture(sb) } else if let pb = f.pixelBuffer { capturer.capture(pb) }
    }

    /// 最近 500 ms 的信号
    func signals() -> (area: Double, fps: Double) {
        let now = nowMs()
        let recent = lock.withLock { frames.filter { now - $0.t <= 500 && $0.area > 0.002 } }
        let area = recent.isEmpty ? 0 : recent.map(\.area).reduce(0, +) / Double(recent.count)
        return (area, Double(recent.count) * 2)
    }

    var count: Int { lock.withLock { received } }
}

/// 测试用采集源：按 30 fps 生成画面；motion 为 true 时整屏变化（模拟视频），否则静止（模拟文档）。
/// 和 SCK 一样在独立线程上产生帧（不占主线程）。
@MainActor
public final class SyntheticFrameSource: ShareFrameSource {
    public var motion: Bool {
        get { state.withLock { $0.motion } }
        set { state.withLock { $0.motion = newValue } }
    }

    public let size: SourceSize
    private let state: Mutex
    private var task: Task<Void, Never>?

    public init(width: Int = 1920, height: Int = 1080) {
        size = SourceSize(width: width, height: height)
        state = Mutex(State(width: width, height: height))
    }

    public func start(withAudio _: Bool, callbacks: ShareCallbacks) async throws -> SourceSize {
        let state = state
        task = Task.detached {
            // 按截止时间排程（不累积误差），保持稳定的 30 fps
            let clock = ContinuousClock()
            var next = clock.now
            var n: UInt8 = 0
            while !Task.isCancelled {
                n &+= 37
                let s = state.withLock { $0 }
                if let pb = Self.makeFrame(width: s.width, height: s.height, value: s.motion ? n : 200) {
                    callbacks.onFrame(ShareFrame(pixelBuffer: pb, changedArea: s.motion ? 0.9 : 0))
                }
                next += .milliseconds(33)
                try? await Task.sleep(until: next, clock: clock)
            }
        }
        return size
    }

    public func update(width: Int, height: Int, sampleFps _: Int) async {
        state.withLock {
            $0.width = width
            $0.height = height
        }
    }

    public func stop() async {
        task?.cancel()
        task = nil
    }

    struct State: Sendable {
        var width: Int
        var height: Int
        var motion = false
    }

    final class Mutex: @unchecked Sendable {
        private let lock = NSLock()
        private var value: State
        init(_ v: State) { value = v }
        func withLock<T>(_ f: (inout State) -> T) -> T { lock.withLock { f(&value) } }
    }

    nonisolated private static func makeFrame(width: Int, height: Int, value: UInt8) -> CVPixelBuffer? {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        guard let pb else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        if let base = CVPixelBufferGetBaseAddress(pb) {
            // 8 条灰度竖条（value 变化时整屏都变），便于肉眼确认画面在显示
            let stride = CVPixelBufferGetBytesPerRow(pb)
            let bar = width / 8
            for y in 0 ..< height {
                let row = base + y * stride
                for i in 0 ..< 8 {
                    memset(row + i * bar * 4, Int32(value &+ UInt8(i * 28)), (i == 7 ? width - 7 * bar : bar) * 4)
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        return pb
    }
}
