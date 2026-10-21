// 应用自动更新：从 GitHub Releases 检查并在后台下载，下载完成后由用户决定何时重启安装（退出时也会自动安装）。
// Windows 安装版和 AppImage 自动安装；deb、Dev 版和未打包的开发环境只报告状态，不下载。
// Microsoft Store 版由商店更新，这里什么都不做。
import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC, type UpdateInfoMsg, type UpdateStateMsg } from '../shared/ipc';

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function setupUpdater(getWindow: () => BrowserWindow | null, log: (msg: string) => void): void {
  const version = app.getVersion();
  const store = !!process.windowsStore;
  const automatic = !store && app.isPackaged && !version.includes('-dev') && (process.platform === 'win32' || !!process.env.APPIMAGE);
  const prefsFile = join(app.getPath('userData'), 'updates.json');
  let beta = readBeta(prefsFile) ?? version.includes('-beta');
  let state: UpdateStateMsg = { status: 'idle' };

  const send = (s: UpdateStateMsg) => {
    state = s;
    getWindow()?.webContents.send(IPC.updateState, s);
  };

  ipcMain.on(IPC.updateGet, (e) => {
    e.returnValue = { automatic, store, beta, state } satisfies UpdateInfoMsg;
  });
  ipcMain.on(IPC.updateSetBeta, (_e, on: boolean) => {
    beta = !!on;
    writeFileSync(prefsFile, JSON.stringify({ beta }));
    autoUpdater.allowPrerelease = beta;
    if (automatic) void check();
  });
  ipcMain.on(IPC.updateCheck, () => void check());
  ipcMain.on(IPC.updateInstall, () => {
    if (state.status === 'ready') autoUpdater.quitAndInstall();
  });

  if (!automatic) return;

  autoUpdater.logger = { info: (m: unknown) => log(`updater: ${m}`), warn: (m: unknown) => log(`updater: ${m}`), error: (m: unknown) => log(`updater: ${m}`), debug: () => {} };
  autoUpdater.allowPrerelease = beta;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => state.status !== 'ready' && send({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => send({ status: 'up-to-date' }));
  autoUpdater.on('update-available', (info) => send({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => send({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => state.status !== 'ready' && send({ status: 'error', error: err.message }));

  async function check() {
    if (!automatic || state.status === 'ready' || state.status === 'downloading') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  setTimeout(() => void check(), 15_000);
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}

function readBeta(file: string): boolean | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { beta?: unknown };
    return typeof v.beta === 'boolean' ? v.beta : null;
  } catch {
    return null;
  }
}
