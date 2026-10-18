/** 视频宫格布局：在给定区域内为 n 个 16:9 画面选择列数，使每个画面尽可能大。 */
export interface GridLayout {
  columns: number;
  rows: number;
  /** 每个画面的宽高（像素） */
  width: number;
  height: number;
}

export function bestGrid(n: number, width: number, height: number, gap = 12, aspect = 16 / 9): GridLayout {
  if (n <= 0 || width <= 0 || height <= 0) return { columns: 1, rows: 1, width: 0, height: 0 };
  let best: GridLayout = { columns: 1, rows: n, width: 0, height: 0 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    // 先按宽度算，再受高度限制
    let w = (width - gap * (columns - 1)) / columns;
    let h = w / aspect;
    const maxH = (height - gap * (rows - 1)) / rows;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    if (w > best.width) best = { columns, rows, width: Math.floor(w), height: Math.floor(h) };
  }
  return best;
}
