import HaneMedia
import SwiftUI

/// 画中画的源视图：铺在舞台下面（透明、不接收触摸），并按当前画面选择画中画里显示的轨道
struct PiPAnchor: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        PiPSourceView(pip: model.pip, ref: Self.pick(model))
    }

    /// 优先显示别人的屏幕共享；其次是正在说话的人的摄像头；再其次是任意一路别人的摄像头
    @MainActor static func pick(_ model: AppModel) -> VideoTrackRef? {
        let remote = model.media.videoTracks.filter { !$0.isLocal }
        if let share = remote.first(where: \.isScreen) { return share }
        let cams = remote.filter { !$0.isScreen }
        return cams.first { model.media.speaking.contains($0.identity) } ?? cams.first
    }
}

private struct PiPSourceView: UIViewRepresentable {
    let pip: PictureInPicture
    let ref: VideoTrackRef?

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ view: UIView, context: Context) {
        pip.attach(sourceView: view)
        pip.show(ref)
    }
}
