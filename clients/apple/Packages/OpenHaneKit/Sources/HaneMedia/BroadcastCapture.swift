#if os(iOS)
import Foundation
import LiveKit
import HaneCore
import UIKit

/// iOS 屏幕共享：广播上传扩展（SDK 的 LKSampleHandler）采集整个屏幕，
/// 帧经过应用组里的套接字传给主应用，由主应用编码和发布。共享声音同样由 SDK 混入麦克风轨道。
///
/// 使用 SDK 自带的方案：没有变化信号（智能模式保持清晰），分辨率不能在采集端调整（只调码率、帧率和降级偏好）。
@MainActor
final class BroadcastCapture: ShareCapture {
    private var track: LocalVideoTrack?

    func start(withAudio: Bool, onStop _: @escaping @Sendable () -> Void) async throws -> (track: LocalVideoTrack, size: SourceSize) {
        // 广播停止由 MediaSession 通过 BroadcastManager 感知
        let track = await LocalVideoTrack.createBroadcastScreenCapturerTrack(
            options: ScreenShareCaptureOptions(appAudio: withAudio), reportStatistics: true
        )
        try await track.start()
        self.track = track
        let px = UIScreen.main.nativeBounds.size // 竖屏的物理像素
        return (track, SourceSize(width: Int(px.width), height: Int(px.height)))
    }

    func apply(width _: Int, height _: Int, fps _: Int) async {}

    func signals() -> (area: Double, fps: Double)? { nil }

    func stop() async {
        try? await track?.stop()
        track = nil
    }
}
#endif
