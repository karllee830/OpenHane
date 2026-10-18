// 自定义共享选择器：列出屏幕和窗口的缩略图供渲染进程的选择面板使用；
// 用户选定后，渲染进程调用 getDisplayMedia，由 setDisplayMediaRequestHandler 返回选定的来源。
// 共享期间对本应用的所有窗口开启内容保护，会议窗口不会出现在共享画面中。

import { BrowserWindow, desktopCapturer, type DesktopCapturerSource, type Session } from 'electron';
import type { ShareSourceMsg } from '../shared/ipc';

export class SharePicker {
  private selected: DesktopCapturerSource | null = null;
  private cache = new Map<string, DesktopCapturerSource>();

  constructor(private readonly ses: Session, private readonly log: (m: string) => void) {}

  install(): void {
    this.ses.setDisplayMediaRequestHandler((_req, callback) => {
      const source = this.selected;
      this.selected = null;
      if (!source) {
        // 没有经过我们的选择面板（不应发生）：拒绝
        callback({});
        return;
      }
      // 共享声音：Windows 上需要进程环回扩展排除本应用的声音，在此之前不提供，避免把会议声音共享出去
      callback({ video: source });
    });
  }

  async list(): Promise<ShareSourceMsg[]> {
    // 端到端测试：macOS 上调用 desktopCapturer 会弹出系统录屏授权，测试中返回一个假来源（画面由渲染进程的测试采集源提供）
    if (process.env.HANE_E2E === '1') return [{ id: 'screen:e2e', name: 'E2E Screen', kind: 'screen', thumbnail: '' }];
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    const ownTitles = new Set(BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    this.cache.clear();
    const out: ShareSourceMsg[] = [];
    for (const s of sources) {
      if (s.id.startsWith('window:') && ownTitles.has(s.name)) continue; // 不列出本应用自己的窗口
      this.cache.set(s.id, s);
      out.push({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
      });
    }
    return out;
  }

  select(id: string): void {
    if (process.env.HANE_E2E === '1' && id === 'screen:e2e') return;
    const s = this.cache.get(id);
    if (!s) throw new Error(`unknown share source ${id}`);
    this.selected = s;
    this.log(`share source selected: ${s.name}`);
  }

  /** 共享期间本应用窗口不进入共享画面（Windows：WDA_EXCLUDEFROMCAPTURE；macOS：NSWindowSharingNone） */
  setSharing(active: boolean): void {
    for (const w of BrowserWindow.getAllWindows()) w.setContentProtection(active);
    // 诊断用：macOS 上关闭内容保护后 isContentProtected() 仍可能返回 true，以我们请求的状态为准
    (globalThis as { __haneContentProtection?: boolean }).__haneContentProtection = active;
  }
}
