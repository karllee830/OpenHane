// 主窗口的大小：主页和会议页各用一套（会议页更大），与 macOS 版一致。
// 默认值按屏幕可用宽度的比例计算（DIP，与缩放倍数无关）；用户调整过的大小分别记住，保存在 userData/window.json。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, Rectangle, Size } from 'electron';

export type WindowMode = 'home' | 'meeting';

/** 最小尺寸：再小会议页的三栏放不下，主页也会显得局促 */
export const MIN_SIZE: Record<WindowMode, Size> = { home: { width: 720, height: 480 }, meeting: { width: 960, height: 600 } };
/** 默认宽度占屏幕可用宽度的比例，以及宽高比 */
const DEFAULTS: Record<WindowMode, { ratio: number; aspect: number }> = { home: { ratio: 0.4, aspect: 3 / 2 }, meeting: { ratio: 0.6, aspect: 16 / 10 } };

/** 某种模式下的窗口大小：记住的大小优先，否则按比例计算；都不小于最小尺寸、不超出屏幕 */
export function sizeFor(mode: WindowMode, area: Size, saved?: Size): Size {
  const min = MIN_SIZE[mode];
  const d = DEFAULTS[mode];
  const width = saved?.width ?? Math.round(area.width * d.ratio);
  const height = saved?.height ?? Math.round(Math.max(width, min.width) / d.aspect);
  return {
    width: Math.min(area.width, Math.max(min.width, width)),
    height: Math.min(area.height, Math.max(min.height, height)),
  };
}

/** 保持窗口中心不动换成新的大小，并留在屏幕可用区域内 */
export function centeredBounds(current: Rectangle, size: Size, area: Rectangle): Rectangle {
  const x = Math.round(current.x + (current.width - size.width) / 2);
  const y = Math.round(current.y + (current.height - size.height) / 2);
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - size.height),
    ...size,
  };
}

export class WindowSizes {
  private saved: Partial<Record<WindowMode, Size>> = {};
  private mode: WindowMode = 'home';
  /** 程序自己改大小时产生的 resized 事件不当作用户调整 */
  private applyingUntil = 0;

  constructor(private readonly file: string) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<WindowMode, Size>>;
      for (const m of ['home', 'meeting'] as const) {
        const s = j[m];
        if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) this.saved[m] = { width: s.width, height: s.height };
      }
    } catch {
      // 第一次运行或文件损坏：用默认大小
    }
  }

  /** 新窗口的大小（主页） */
  initial(area: Size): Size {
    return sizeFor('home', area, this.saved.home);
  }

  /** 跟踪用户调整窗口大小，分别记到当前模式下 */
  attach(win: BrowserWindow): void {
    win.setMinimumSize(MIN_SIZE.home.width, MIN_SIZE.home.height);
    win.on('resized', () => {
      if (Date.now() < this.applyingUntil || win.isMaximized() || win.isFullScreen()) return;
      const [width, height] = win.getSize();
      this.saved[this.mode] = { width: width!, height: height! };
      this.save();
    });
  }

  /** 进入或离开会议：换成那种模式的最小尺寸和大小（最大化、全屏时只换最小尺寸） */
  apply(win: BrowserWindow, mode: WindowMode, area: Rectangle): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyingUntil = Date.now() + 1000;
    const min = MIN_SIZE[mode];
    // 先放宽最小尺寸再缩小窗口；进入会议时先把窗口放大再提高最小尺寸
    if (mode === 'home') win.setMinimumSize(min.width, min.height);
    if (!win.isMaximized() && !win.isFullScreen()) {
      win.setBounds(centeredBounds(win.getBounds(), sizeFor(mode, area, this.saved[mode]), area));
    }
    if (mode === 'meeting') win.setMinimumSize(min.width, min.height);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved));
      renameSync(tmp, this.file);
    } catch {
      // 保存失败不影响使用
    }
  }
}
