import { join } from 'node:path';
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import type { TrayActionMsg, TrayStateMsg } from '../shared/ipc';

/** 托盘 / 菜单栏图标：静音、关闭声音、显示主窗口、离开、退出。 */
export class AppTray {
  private tray: Tray;
  private state: TrayStateMsg = { connected: false, muted: false, deafened: false };

  constructor(
    private readonly resources: string,
    private readonly win: () => BrowserWindow | null,
    private readonly onAction: (a: TrayActionMsg) => void,
    private readonly quit: () => void,
  ) {
    this.tray = new Tray(this.icon());
    this.tray.on('click', () => this.show());
    this.render();
  }

  /** Windows / Linux：彩色的应用图标（深浅色任务栏上都看得清）；macOS 菜单栏：纸鹤剪影的模板图标，由系统按外观着色 */
  private icon() {
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(join(this.resources, 'trayTemplate.png'));
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createFromPath(join(this.resources, 'tray.png'));
  }

  private show() {
    const w = this.win();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  setState(s: TrayStateMsg): void {
    this.state = s;
    this.render();
  }

  private render() {
    const s = this.state;
    const zh = (process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale).toLowerCase().startsWith('zh');
    const L = zh
      ? { app: '羽见', show: '显示羽见', mute: '静音', deafen: '关闭声音', leave: '离开', quit: '退出', off: '未连接' }
      : { app: 'OpenHane', show: 'Show OpenHane', mute: 'Mute', deafen: 'Turn off sound', leave: 'Leave', quit: 'Quit', off: 'Not connected' };
    this.tray.setToolTip(s.connected ? `${L.app} · ${s.serverName ?? ''}${s.muted ? ` · ${L.mute}` : ''}` : `${L.app} · ${L.off}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: L.show, click: () => this.show() },
        { type: 'separator' },
        { label: L.mute, type: 'checkbox', checked: s.muted, enabled: s.connected, click: () => this.onAction('toggle-mute') },
        { label: L.deafen, type: 'checkbox', checked: s.deafened, enabled: s.connected, click: () => this.onAction('toggle-deafen') },
        { label: L.leave, enabled: s.connected, click: () => this.onAction('leave') },
        { type: 'separator' },
        { label: L.quit, click: () => this.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
