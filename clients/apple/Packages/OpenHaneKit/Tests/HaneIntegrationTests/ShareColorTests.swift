import CoreVideo
import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 屏幕共享的颜色：发送端是和 ScreenCaptureKit 一样的 420v 帧（sRGB、BT.709 矩阵、视频范围），
/// 画面左边黑、中间白、右边纯红；接收端解码后的帧要保持同样的范围和颜色（没有被当成全范围而发灰、没有偏色），
/// 并且标记为 BT.709，接收端按 sRGB 显示。
/// 发现过的问题：SCK 默认按显示器色彩空间（Display P3）输出，P3 标记在 WebRTC 里丢掉，接收端把 P3 的数值当 sRGB 显示，画面发灰。
@Suite(.serialized) @MainActor struct ShareColorTests {
    /// 和 SCK 输出一样的 420v 帧（视频范围 16–235）：BT.709 下 黑 (16,128,128)、白 (235,128,128)、sRGB 纯红 (63,102,240)
    final class ColorBarsSource: ShareFrameSource {
        let width = 1280, height = 720
        let primaries: String
        private var task: Task<Void, Never>?
        init(primaries: CFString) { self.primaries = primaries as String }

        func start(withAudio _: Bool, callbacks: ShareCallbacks) async throws -> SourceSize {
            let (w, h, primaries) = (width, height, primaries)
            task = Task.detached {
                while !Task.isCancelled {
                    if let pb = Self.frame(width: w, height: h, primaries: primaries) {
                        callbacks.onFrame(ShareFrame(pixelBuffer: pb, changedArea: 0.5))
                    }
                    try? await Task.sleep(for: .milliseconds(66))
                }
            }
            return SourceSize(width: w, height: h)
        }

        func update(width _: Int, height _: Int, sampleFps _: Int) async {}
        func stop() async { task?.cancel() }

        nonisolated static func frame(width: Int, height: Int, primaries: String) -> CVPixelBuffer? {
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
            guard let pb else { return nil }
            CVPixelBufferLockBaseAddress(pb, [])
            let bars: [(UInt8, UInt8, UInt8)] = [(16, 128, 128), (235, 128, 128), (63, 102, 240)]
            let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
            let ys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
            for row in 0 ..< height { for x in 0 ..< width { y[row * ys + x] = bars[min(2, x * 3 / width)].0 } }
            let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
            let uvs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
            for row in 0 ..< height / 2 { for x in 0 ..< width / 2 {
                let b = bars[min(2, x * 2 * 3 / width)]
                uv[row * uvs + x * 2] = b.1
                uv[row * uvs + x * 2 + 1] = b.2
            } }
            CVPixelBufferUnlockBaseAddress(pb, [])
            CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, primaries as CFString, .shouldPropagate)
            CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
            return pb
        }
    }

    /// 接收端解码出的一帧
    struct Received: Sendable {
        var desc: String
        var fullRange = false
        var primaries = "", matrix = ""
        var bars: [(Int, Int, Int)] = []
    }

    /// 接收端：记下最近一帧解码结果（像素格式、色彩标记、三个色块中心的 YUV）
    final class Probe: NSObject, VideoRenderer, @unchecked Sendable {
        private let lock = NSLock()
        private var _last: Received?
        var last: Received? { lock.withLock { _last } }
        @MainActor var isAdaptiveStreamEnabled: Bool { false }
        @MainActor var adaptiveStreamSize: CGSize { .zero }

        func render(frame: VideoFrame) {
            var desc = "\(frame.dimensions.width)x\(frame.dimensions.height) "
            var r = Received(desc: "")
            let w = Int(frame.dimensions.width), h = Int(frame.dimensions.height)
            if let b = frame.buffer as? CVPixelVideoBuffer {
                let pb = b.pixelBuffer
                let fmt = CVPixelBufferGetPixelFormatType(pb)
                let att = CVBufferCopyAttachments(pb, .shouldPropagate) as? [String: Any] ?? [:]
                r.fullRange = fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                r.primaries = att[kCVImageBufferColorPrimariesKey as String] as? String ?? ""
                r.matrix = att[kCVImageBufferYCbCrMatrixKey as String] as? String ?? ""
                desc += "pixelBuffer \(Self.fourcc(fmt)) primaries=\(att[kCVImageBufferColorPrimariesKey as String] ?? "-") matrix=\(att[kCVImageBufferYCbCrMatrixKey as String] ?? "-") transfer=\(att[kCVImageBufferTransferFunctionKey as String] ?? "-")"
                if fmt == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange {
                    CVPixelBufferLockBaseAddress(pb, .readOnly)
                    let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
                    let ys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
                    let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
                    let uvs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
                    for i in 0 ..< 3 {
                        let x = w * (2 * i + 1) / 6, row = h / 2
                        let v = (Int(y[row * ys + x]), Int(uv[row / 2 * uvs + x / 2 * 2]), Int(uv[row / 2 * uvs + x / 2 * 2 + 1]))
                        r.bars.append(v)
                        desc += " bar\(i)=\(v)"
                    }
                    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
                }
            } else if let b = frame.buffer as? I420VideoBuffer {
                desc += "I420"
                for i in 0 ..< 3 {
                    let x = w * (2 * i + 1) / 6, row = h / 2
                    desc += " bar\(i)=(\(b.dataY[row * Int(b.strideY) + x]),\(b.dataU[row / 2 * Int(b.strideU) + x / 2]),\(b.dataV[row / 2 * Int(b.strideV) + x / 2]))"
                }
            }
            r.desc = desc
            lock.withLock { _last = r }
        }

        static func fourcc(_ t: OSType) -> String {
            String(bytes: [UInt8(t >> 24 & 0xFF), UInt8(t >> 16 & 0xFF), UInt8(t >> 8 & 0xFF), UInt8(t & 0xFF)], encoding: .ascii) ?? "\(t)"
        }
    }

    @Test(arguments: ["h264", "h265"]) func colorsSurviveTheRoundTrip(codec: String) async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 91, pins: tempPins())
        let bob = makeSession(seed: 92, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        let source = ColorBarsSource(primaries: kCVImageBufferColorPrimaries_ITU_R_709_2)
        am.shareSourceFactory = { source }
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }
        try await am.startScreenShare(intent: .custom, withAudio: false,
                                      custom: CustomShare(height: nil, fps: 15, kbps: 2000, codec: ShareCodec(rawValue: codec)))
        let aliceID = alice.state.me!.sessionID
        try await eventually(20) { bm.videoTracks.contains { $0.isScreen && $0.sessionID == aliceID && $0.pixelSize != nil } }
        let track = try #require(bm.videoTracks.first { $0.isScreen && $0.sessionID == aliceID }?.track as? RemoteVideoTrack)
        let probe = Probe()
        track.add(videoRenderer: probe)
        try await eventually(10) { probe.last != nil }
        try await Task.sleep(for: .seconds(2))
        let got = try #require(probe.last)
        print("COLOR \(codec): \(got.desc)")
        // 视频范围解码后应该还原成黑 / 白 / 纯红（全范围时 0 / 255 / (54,98,255)，视频范围时 16 / 235 / (63,102,240)）
        let want: [(Int, Int, Int)] = got.fullRange ? [(0, 128, 128), (255, 128, 128), (54, 98, 255)] : [(16, 128, 128), (235, 128, 128), (63, 102, 240)]
        #expect(got.bars.count == 3)
        for (g, w) in zip(got.bars, want) {
            #expect(abs(g.0 - w.0) <= 4 && abs(g.1 - w.1) <= 4 && abs(g.2 - w.2) <= 4, "got \(g), want \(w)")
        }
        #expect(got.primaries == kCVImageBufferColorPrimaries_ITU_R_709_2 as String)
        #expect(got.matrix == kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String)
        track.remove(videoRenderer: probe)
        await am.stopScreenShare()
        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }

    /// SCK 的采集配置：输出 sRGB + BT.709（不设置时按显示器的 P3 输出，共享出去发灰）
    @Test func screenCaptureOutputsSRGB() {
        let c = SCKFrameSource.configuration(width: 1920, height: 1080, fps: 30, withAudio: false)
        #expect(c.colorSpaceName == CGColorSpace.sRGB)
        #expect(c.colorMatrix == CGDisplayStream.yCbCrMatrix_ITU_R_709_2)
        #expect(c.pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    }
}
