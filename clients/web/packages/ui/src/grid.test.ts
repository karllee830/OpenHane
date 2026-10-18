import { describe, expect, it } from 'vitest';
import { bestGrid } from './grid';

describe('bestGrid', () => {
  it('one person fills the area at 16:9', () => {
    const g = bestGrid(1, 1600, 900, 0);
    expect(g).toEqual({ columns: 1, rows: 1, width: 1600, height: 900 });
  });

  it('two people side by side in a wide area, stacked in a tall one', () => {
    expect(bestGrid(2, 1600, 600, 0).columns).toBe(2);
    expect(bestGrid(2, 700, 1000, 0).columns).toBe(1);
  });

  it('picks the column count that maximizes tile size', () => {
    // 6 人在 1200×700：2 列 × 3 行（受高度限制，每格约 400×225）略大于 3 列 × 2 行（392×220）
    const g = bestGrid(6, 1200, 700, 12);
    expect([g.columns, g.rows]).toEqual([2, 3]);
    expect(g.width).toBe(400);
    // 6 人在 1600×700：3 列 × 2 行
    expect(bestGrid(6, 1600, 700, 12).columns).toBe(3);
    // 每个画面都放得下
    expect(g.columns * g.width + (g.columns - 1) * 12).toBeLessThanOrEqual(1200);
    expect(g.rows * g.height + (g.rows - 1) * 12).toBeLessThanOrEqual(700);
  });

  it('handles empty input', () => {
    expect(bestGrid(0, 100, 100).width).toBe(0);
    expect(bestGrid(3, 0, 100).width).toBe(0);
  });
});
