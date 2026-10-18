@testable import HaneCore
import Testing

@Suite struct StageGridTests {
    /// 与 Web 客户端 ui/src/grid.test.ts 相同的用例
    @Test func matchesWebGrid() {
        #expect(StageGrid.best(count: 1, width: 1600, height: 900, gap: 0) == StageGrid(columns: 1, rows: 1, width: 1600, height: 900))
        #expect(StageGrid.best(count: 2, width: 1600, height: 600, gap: 0).columns == 2)
        #expect(StageGrid.best(count: 2, width: 700, height: 1000, gap: 0).columns == 1)
        // 6 人在 1200×700：2 列 × 3 行（受高度限制，每格约 400×225）略大于 3 列 × 2 行（392×220）
        let g = StageGrid.best(count: 6, width: 1200, height: 700, gap: 12)
        #expect([g.columns, g.rows] == [2, 3])
        #expect(g.width == 400)
        #expect(StageGrid.best(count: 6, width: 1600, height: 700, gap: 12).columns == 3)
        #expect(StageGrid.best(count: 0, width: 100, height: 100).width == 0)
        #expect(StageGrid.best(count: 3, width: 0, height: 100).width == 0)
    }

    @Test func phoneFillsTheStage() {
        // 两个人上下排，四个人 2×2，五个人 2 列 3 行，每格都拉伸到铺满
        #expect(StageGrid.fill(count: 2, width: 366, height: 600) == StageGrid(columns: 1, rows: 2, width: 366, height: 295))
        #expect(StageGrid.fill(count: 4, width: 366, height: 600) == StageGrid(columns: 2, rows: 2, width: 178, height: 295))
        let five = StageGrid.fill(count: 5, width: 366, height: 600)
        #expect(five?.columns == 2 && five?.rows == 3)
        // 横屏：并排；舞台很矮时四个人排成一行，不改为滚动
        #expect(StageGrid.fill(count: 2, width: 800, height: 340)?.columns == 2)
        #expect(StageGrid.fill(count: 4, width: 776, height: 226) == StageGrid(columns: 4, rows: 1, width: 186, height: 226))
        // 人太多：画面会矮于 120 点，改为滚动
        #expect(StageGrid.fill(count: 20, width: 366, height: 600) == nil)
        #expect(StageGrid.fill(count: 0, width: 366, height: 600) == nil)
    }
}
