import LiveKit
import SwiftUI

/// 显示一条视频轨道（应用层不直接依赖 LiveKit）
public struct VideoSurface: View {
    let ref: VideoTrackRef
    let fit: Bool

    /// fit 为 true 时完整显示（共享画面），否则填满（摄像头）
    public init(_ ref: VideoTrackRef, fit: Bool) {
        self.ref = ref
        self.fit = fit
    }

    /// 用系统的 AVSampleBufferDisplayLayer 渲染（renderMode: .sampleBuffer），不用 WebRTC 的 Metal 渲染器：
    /// 后者不看帧上的颜色标记，一律按 BT.601、全范围把 YUV 转成 RGB，也不做色彩管理。屏幕共享的帧是 BT.709，
    /// 本地预览还是视频范围（16–235），颜色会偏、发灰；在 HDR / EDR 显示器上画面还会过亮。
    /// AVSampleBufferDisplayLayer 按帧的范围、矩阵、色域和传递函数正确转换，并由系统映射到当前显示器（含 HDR）
    public var body: some View {
        SwiftUIVideoView(ref.track, layoutMode: fit ? .fit : .fill, mirrorMode: ref.isScreen ? .off : .auto, renderMode: .sampleBuffer)
    }
}

public extension VideoTrackRef {
    /// 当前收到的画面尺寸（像素）；还没有画面时为 nil
    var pixelSize: CGSize? {
        track.dimensions.map { CGSize(width: Int($0.width), height: Int($0.height)) }
    }
}
