// 羽见桌面版主进程（Windows / Linux 正式发布；macOS 只用于开发调试，正式版是原生客户端）。
//
// 安全配置：渲染进程开启沙盒和上下文隔离，不集成 Node；页面通过 app:// 协议加载；
// 只允许麦克风 / 摄像头等必要权限；禁止导航到其他页面、禁止打开新窗口（外部链接交给系统浏览器）。

import { realpathSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, ipcMain, nativeTheme, net, protocol, screen, session, shell, type TitleBarOverlayOptions } from 'electron';
import { IPC, type AppInfo, type TrayActionMsg, type TrayStateMsg } from '../shared/ipc';
import { PushToTalkHost } from './hotkeys';
import { loadOrCreateSeed } from './identity';
import { SharePicker } from './share';
import { PinStore, Tofu } from './tofu';
import { AppTray } from './tray';
import { WindowSizes } from './window-size';
import { setupUpdater } from './updater';

const APP_ORIGIN = 'app://openhane';
const DIST = __dirname; // 打包后的 dist/
const RENDERER = join(DIST, 'renderer');
const RESOURCES = join(DIST, '..', 'resources');
const E2E = process.env.HANE_E2E === '1';
const MAC = process.platform === 'darwin';
/** 窗口按钮区域的高度：与页面顶部各栏（侧栏标题、舞台标题、聊天标题）的高度一致 */
const TITLEBAR_HEIGHT = 48;

const log = (msg: string) => console.log(`[hane] ${msg}`);

// 测试隔离：独立的用户数据目录、模拟设备和钥匙串
if (process.env.HANE_USER_DATA) app.setPath('userData', process.env.HANE_USER_DATA);
if (E2E) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-mock-keychain');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// 单实例：第二次启动（例如点击 openhane:// 链接）时把参数交给已运行的实例
if (!E2E && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;
let pendingLink: string | null = null;
const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args);

function handleLink(url: string | undefined) {
  if (!url?.toLowerCase().startsWith('openhane://')) return;
  pendingLink = url;
  send(IPC.deepLink, url);
  win?.show();
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleLink(url);
});
app.on('second-instance', (_e, argv) => {
  handleLink(argv.find((a) => a.toLowerCase().startsWith('openhane://')));
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
if (!E2E) app.setAsDefaultProtocolClient('openhane');

function registerAppProtocol() {
  const root = realpathSync(RENDERER);
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'openhane') return new Response('not found', { status: 404 });
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root + sep)) return new Response('forbidden', { status: 403 }); // 防止路径穿越
    return net.fetch(pathToFileURL(file).toString());
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(details.requestingUrl.startsWith(APP_ORIGIN) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => origin.startsWith(APP_ORIGIN) && allowed.has(permission));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

/** 与页面的设计令牌一致（apps/web/src/index.css）：窗口背景，以及系统窗口按钮的图标颜色 */
const themeColors = () => (nativeTheme.shouldUseDarkColors ? { bg: '#111317', fg: '#e6e8eb' } : { bg: '#f6f7f9', fg: '#1b1f24' });
/** 窗口按钮的底色透明：直接画在页面上，看起来与页面是一体的 */
const titleBarOverlay = (): TitleBarOverlayOptions => ({ color: '#00000000', symbolColor: themeColors().fg, height: TITLEBAR_HEIGHT });

/** 菜单栏去掉后，缩放快捷键（Ctrl + = / - / 0）由这里处理 */
function handleZoomKeys(w: BrowserWindow) {
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const wc = w.webContents;
    if (input.key === '=' || input.key === '+') wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3));
    else if (input.key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    else if (input.key === '0') wc.setZoomLevel(0);
    else return;
    e.preventDefault();
  });
}

/** 主窗口的大小：主页和会议页各一套，见 window-size.ts */
let sizes: WindowSizes;

function createWindow() {
  win = new BrowserWindow({
    ...sizes.initial(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize),
    show: false,
    title: 'OpenHane',
    // 任务栏和窗口图标（Windows 打包后取 exe 里的图标；开发运行和 Linux 用这张）
    ...(MAC ? {} : { icon: join(RESOURCES, 'icon.png') }),
    // 不要系统标题栏：页面铺满整个窗口，顶部各栏兼作标题栏；最小化 / 最大化 / 关闭按钮由系统画在页面右上角
    // （Window Controls Overlay，页面用 env(titlebar-area-*) 给它们让出位置）。macOS 只用于开发调试，红绿灯在左上角
    titleBarStyle: MAC ? 'hiddenInset' : 'hidden',
    titleBarOverlay: MAC ? true : titleBarOverlay(),
    ...(MAC ? { trafficLightPosition: { x: 18, y: 17 } } : {}), // 红绿灯在 48 像素高的顶栏里垂直居中
    backgroundColor: themeColors().bg,
    webPreferences: {
      preload: join(DIST, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 会议中切到后台也不能节流（心跳、音频处理）
      spellcheck: false,
    },
  });
  // 没有菜单栏（Windows / Linux 上按 Alt 也不会出现）；顺带去掉了刷新快捷键，免得误按后掉出会议
  if (!MAC) win.removeMenu();
  handleZoomKeys(win);
  sizes.attach(win);
  win.once('ready-to-show', () => win?.show());
  // 通话中关闭窗口时留在托盘；未连接时直接退出
  win.on('close', (e) => {
    if (!quitting && trayState.connected && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = null));
  void win.loadURL(`${APP_ORIGIN}/index.html`);
}

// 系统切换浅色 / 深色时，窗口按钮的颜色和窗口背景跟着变
nativeTheme.on('updated', () => {
  if (!win) return;
  if (!MAC) win.setTitleBarOverlay(titleBarOverlay());
  win.setBackgroundColor(themeColors().bg);
});

let trayState: TrayStateMsg = { connected: false, meeting: false, muted: false, deafened: false };

app.whenReady().then(() => {
  registerAppProtocol();
  hardenSession();

  const userData = app.getPath('userData');
  sizes = new WindowSizes(join(userData, 'window.json'));
  const tofu = new Tofu(session.defaultSession, new PinStore(join(userData, 'pins.json')), (host, expected, actual) => {
    log(`certificate fingerprint mismatch for ${host}`);
    send(IPC.tofuMismatch, { host, expected, actual });
  });
  tofu.install();

  let seed: Uint8Array | null = null;
  ipcMain.handle(IPC.identitySeed, () => (seed ??= loadOrCreateSeed(join(userData, 'identity.json'), log)));
  ipcMain.handle(IPC.tofuSeen, (_e, hostPort: string) => {
    const s = tofu.seenSpki(String(hostPort));
    return s ? new Uint8Array(s) : null;
  });
  ipcMain.handle(IPC.tofuAccept, (_e, host: string, fp: string) => tofu.accept(String(host), String(fp)));
  ipcMain.handle(IPC.tofuBefore, async (_e, hostPort: string) => (await tofu.beforeConnect(String(hostPort))).allowed);

  const picker = new SharePicker(session.defaultSession, log);
  picker.install();
  ipcMain.handle(IPC.shareSources, () => picker.list());
  ipcMain.handle(IPC.shareSelect, (_e, id: string) => picker.select(String(id)));
  ipcMain.on(IPC.shareActive, (_e, active: boolean) => picker.setSharing(!!active));

  const ptt = new PushToTalkHost(DIST, (pressed) => send(IPC.pttChange, pressed), log);
  ipcMain.handle(IPC.pttRegister, (_e, code: string) => ptt.register(String(code)));
  ipcMain.on(IPC.appInfo, (e) => {
    e.returnValue = { version: app.getVersion(), platform: process.platform, hotkeyUnavailable: PushToTalkHost.unavailableReason() } satisfies AppInfo;
  });

  tray = new AppTray(RESOURCES, () => win, (a: TrayActionMsg) => send(IPC.trayAction, a), () => {
    quitting = true;
    app.quit();
  });
  ipcMain.on(IPC.trayState, (_e, s: TrayStateMsg) => {
    trayState = s;
    tray?.setState(s);
    // 进入会议时窗口换成会议页的大小（更大），离开时换回主页的大小
    if (win) sizes.apply(win, s.meeting ? 'meeting' : 'home', screen.getDisplayMatching(win.getBounds()).workArea);
  });
  ipcMain.handle(IPC.deepLinkReady, () => {
    const l = pendingLink;
    pendingLink = null;
    return l;
  });
  handleLink(process.argv.find((a) => a.toLowerCase().startsWith('openhane://')));
  setupUpdater(() => win, log);

  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
  app.on('before-quit', () => {
    quitting = true;
    ptt.dispose();
    tray?.destroy();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
