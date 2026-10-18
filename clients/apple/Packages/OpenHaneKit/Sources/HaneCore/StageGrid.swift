import Foundation

/// 舞台宫格布局。
public struct StageGrid: Equatable, Sendable {
    public var columns: Int
    public var rows: Int
    /// 每个画面的宽高（点）
    public var width: Double
    public var height: Double

    public init(columns: Int, rows: Int, width: Double, height: Double) {
        self.columns = columns
        self.rows = rows
        self.width = width
        self.height = height
    }

    /// 在给定区域内为 n 个固定宽高比的画面选择列数，使每个画面尽可能大（与 Web 客户端 ui/src/grid.ts 相同）
    public static func best(count n: Int, width: Double, height: Double, gap: Double = 12, aspect: Double = 16.0 / 9) -> StageGrid {
        guard n > 0, width > 0, height > 0 else { return StageGrid(columns: 1, rows: 1, width: 0, height: 0) }
        var best = StageGrid(columns: 1, rows: n, width: 0, height: 0)
        for columns in 1 ... n {
            let rows = (n + columns - 1) / columns
            // 先按宽度算，再受高度限制
            var w = (width - gap * Double(columns - 1)) / Double(columns)
            var h = w / aspect
            let maxH = (height - gap * Double(rows - 1)) / Double(rows)
            if h > maxH {
                h = maxH
                w = h * aspect
            }
            if w > best.width { best = StageGrid(columns: columns, rows: rows, width: w.rounded(.down), height: h.rounded(.down)) }
        }
        return best
    }

    /// 手机的铺满布局：列数按竖屏 3:4、横屏 1:1 的画面选，再把画面拉伸到铺满整个舞台；
    /// 人多到画面矮于 minHeight（横屏舞台很矮时放宽到舞台高度的三分之一）时返回 nil，由调用方改为可滚动的两列。
    public static func fill(count n: Int, width: Double, height: Double, gap: Double = 10, minHeight: Double = 120) -> StageGrid? {
        let g = best(count: n, width: width, height: height, gap: gap, aspect: width > height ? 1 : 3.0 / 4)
        guard g.width > 0 else { return nil }
        let w = (width - gap * Double(g.columns - 1)) / Double(g.columns)
        let h = (height - gap * Double(g.rows - 1)) / Double(g.rows)
        guard h >= min(minHeight, height / 3) else { return nil }
        return StageGrid(columns: g.columns, rows: g.rows, width: w.rounded(.down), height: h.rounded(.down))
    }
}
