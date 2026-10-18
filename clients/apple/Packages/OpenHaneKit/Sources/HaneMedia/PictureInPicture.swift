#if os(iOS)
import AVKit
import LiveKit
import UIKit

/// iOS 画中画：切到其他应用时，在小窗里继续显示别人的屏幕共享（没有共享时显示正在说话的人的摄像头）。
/// 使用系统为视频通话提供的 AVPictureInPictureVideoCallViewController；画面用 LiveKit 的 VideoView 以 sampleBuffer 方式渲染。
@MainActor
public final class PictureInPicture {
    private var controller: AVPictureInPictureController?
    private let callVC = AVPictureInPictureVideoCallViewController()
    private let videoView = VideoView()
    private weak var sourceView: UIView?
    private var current: String?

    public static var isSupported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    public init() {
        videoView.renderMode = .sampleBuffer
        videoView.layoutMode = .fit
        videoView.translatesAutoresizingMaskIntoConstraints = false
        callVC.view.backgroundColor = .black
        callVC.view.addSubview(videoView)
        NSLayoutConstraint.activate([
            videoView.leadingAnchor.constraint(equalTo: callVC.view.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: callVC.view.trailingAnchor),
            videoView.topAnchor.constraint(equalTo: callVC.view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: callVC.view.bottomAnchor),
        ])
    }

    /// 画中画从这个视图（舞台）缩小出去 / 放大回来
    public func attach(sourceView view: UIView) {
        guard Self.isSupported, view !== sourceView else { return }
        sourceView = view
        let source = AVPictureInPictureController.ContentSource(activeVideoCallSourceView: view, contentViewController: callVC)
        let c = AVPictureInPictureController(contentSource: source)
        c.canStartPictureInPictureAutomaticallyFromInline = current != nil
        controller = c
    }

    /// 画中画里显示的轨道；nil 表示没有可显示的画面（不自动进入画中画，已在画中画时退出）
    public func show(_ ref: VideoTrackRef?) {
        guard ref?.sid != current else { return }
        current = ref?.sid
        videoView.track = ref?.track
        if let d = ref?.track.dimensions, d.width > 0, d.height > 0 {
            callVC.preferredContentSize = CGSize(width: Int(d.width), height: Int(d.height))
        } else {
            callVC.preferredContentSize = CGSize(width: 16, height: 9)
        }
        controller?.canStartPictureInPictureAutomaticallyFromInline = ref != nil
        if ref == nil, controller?.isPictureInPictureActive == true { controller?.stopPictureInPicture() }
    }

    public var isActive: Bool { controller?.isPictureInPictureActive ?? false }
}
#endif
