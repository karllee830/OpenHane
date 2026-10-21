// 预加载脚本：只暴露 DesktopBridge 定义的最小 API（沙盒中运行，只能使用 electron 的受限模块）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AppInfo, type DesktopBridge, type TofuMismatchMsg, type TrayActionMsg, type TrayStateMsg, type UpdateInfoMsg, type UpdateStateMsg } from '../shared/ipc';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
}

const bridge: DesktopBridge = {
  info: ipcRenderer.sendSync(IPC.appInfo) as AppInfo,
  getMasterSeed: () => ipcRenderer.invoke(IPC.identitySeed),
  seenSpki: (hostPort: string) => ipcRenderer.invoke(IPC.tofuSeen, hostPort),
  onTofuMismatch: (cb: (m: TofuMismatchMsg) => void) => subscribe(IPC.tofuMismatch, cb),
  acceptFingerprint: (host: string, fp: string) => ipcRenderer.invoke(IPC.tofuAccept, host, fp),
  beforeConnect: (hostPort: string) => ipcRenderer.invoke(IPC.tofuBefore, hostPort),
  checkFingerprint: (hostPort: string) => ipcRenderer.invoke(IPC.tofuCheck, hostPort),
  registerPtt: (code: string) => ipcRenderer.invoke(IPC.pttRegister, code),
  onPtt: (cb: (pressed: boolean) => void) => subscribe(IPC.pttChange, cb),
  setTrayState: (s: TrayStateMsg) => ipcRenderer.send(IPC.trayState, s),
  onTrayAction: (cb: (a: TrayActionMsg) => void) => subscribe(IPC.trayAction, cb),
  listShareSources: () => ipcRenderer.invoke(IPC.shareSources),
  selectShareSource: (id: string) => ipcRenderer.invoke(IPC.shareSelect, id),
  setSharing: (active: boolean) => ipcRenderer.send(IPC.shareActive, active),
  getUpdateInfo: () => ipcRenderer.sendSync(IPC.updateGet) as UpdateInfoMsg,
  onUpdateState: (cb: (s: UpdateStateMsg) => void) => subscribe(IPC.updateState, cb),
  setUpdateBeta: (on: boolean) => ipcRenderer.send(IPC.updateSetBeta, on),
  checkForUpdates: () => ipcRenderer.send(IPC.updateCheck),
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),
  onDeepLink: (cb: (url: string) => void) => {
    const off = subscribe(IPC.deepLink, cb);
    // 启动时就带着的链接：渲染进程订阅后再取
    void ipcRenderer.invoke(IPC.deepLinkReady).then((url: string | null) => url && cb(url));
    return off;
  },
};

contextBridge.exposeInMainWorld('haneDesktop', bridge);
