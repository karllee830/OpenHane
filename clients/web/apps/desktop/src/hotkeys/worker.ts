// 全局热键进程（utilityProcess）：运行 libuiohook 低级键盘 / 鼠标钩子，把事件转给主进程。
// 原生扩展放在独立进程中：崩溃不会拖垮主进程，钩子回调也不会阻塞主进程。
import { uIOhook } from 'uiohook-napi';

type Msg = { t: 'down' | 'up'; k: number } | { t: 'mdown' | 'mup'; b: number };
const port = (process as unknown as { parentPort: { postMessage(m: Msg): void } }).parentPort;

uIOhook.on('keydown', (e) => port.postMessage({ t: 'down', k: e.keycode }));
uIOhook.on('keyup', (e) => port.postMessage({ t: 'up', k: e.keycode }));
uIOhook.on('mousedown', (e) => port.postMessage({ t: 'mdown', b: Number(e.button) }));
uIOhook.on('mouseup', (e) => port.postMessage({ t: 'mup', b: Number(e.button) }));
uIOhook.start();
