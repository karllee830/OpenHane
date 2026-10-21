import AppKit

/// 主窗口的大小：主页和会议页各用一套（会议页更大），与桌面版（apps/desktop/src/main/window-size.ts）一致。
/// 默认值按屏幕可用宽度的比例计算（点，与缩放倍数无关）；用户调整过的大小分别记住。
@MainActor
enum WindowSizes {
    enum Mode: String { case home, meeting }

    /// 最小尺寸：再小会议页的三栏放不下（窗口比三栏的最小宽度之和还窄时 AppKit 会因布局死循环终止应用），主页也会显得局促
    static func minSize(_ mode: Mode) -> CGSize {
        switch mode {
        case .home: CGSize(width: 720, height: 480)
        case .meeting: CGSize(width: 960, height: 600)
        }
    }

    /// 默认宽度占屏幕可用宽度的比例，以及宽高比
    private static func defaults(_ mode: Mode) -> (ratio: CGFloat, aspect: CGFloat) {
        switch mode {
        case .home: (0.4, 3 / 2)
        case .meeting: (0.6, 16 / 10)
        }
    }

    /// 某种模式下的窗口大小：记住的大小优先，否则按比例计算；都不小于最小尺寸、不超出屏幕
    static func size(_ mode: Mode, area: CGSize) -> CGSize {
        let min = minSize(mode)
        let d = defaults(mode)
        let saved = UserDefaults.standard.array(forKey: key(mode)) as? [Double]
        let width = saved.map { CGFloat($0[0]) } ?? (area.width * d.ratio).rounded()
        let height = saved.map { CGFloat($0[1]) } ?? (Swift.max(width, min.width) / d.aspect).rounded()
        return CGSize(width: Swift.min(area.width, Swift.max(min.width, width)),
                      height: Swift.min(area.height, Swift.max(min.height, height)))
    }

    /// 用户调整完窗口大小后记下来（全屏、缩放到最大时不记）
    static func remember(_ mode: Mode, window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen), !window.isZoomed else { return }
        UserDefaults.standard.set([Double(window.frame.width), Double(window.frame.height)], forKey: key(mode))
    }

    /// 换成某种模式的大小：保持窗口中心不动，并留在屏幕可用区域内（全屏、缩放到最大时不动）
    static func apply(_ mode: Mode, to window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen), !window.isZoomed, let area = window.screen?.visibleFrame else { return }
        let size = size(mode, area: area.size)
        let old = window.frame
        var frame = CGRect(x: (old.midX - size.width / 2).rounded(), y: (old.midY - size.height / 2).rounded(), width: size.width, height: size.height)
        frame.origin.x = Swift.min(Swift.max(frame.minX, area.minX), area.maxX - frame.width)
        frame.origin.y = Swift.min(Swift.max(frame.minY, area.minY), area.maxY - frame.height)
        if frame != old { window.setFrame(frame, display: true) }
    }

    private static func key(_ mode: Mode) -> String { "windowSize.\(mode.rawValue)" }
}
