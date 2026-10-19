// 主进程与渲染进程之间的 IPC 通道和消息类型（preload 只暴露这些）。

export const IPC = {
  identitySeed: 'identity:seed',
  tofuSeen: 'tofu:seen',
  tofuMismatch: 'tofu:mismatch',
  tofuAccept: 'tofu:accept',
  tofuBefore: 'tofu:before',
  pttRegister: 'ptt:register',
  pttChange: 'ptt:change',
  hotkeyStatus: 'hotkeys:status',
  trayState: 'tray:state',
  trayAction: 'tray:action',
  deepLink: 'deeplink',
  deepLinkReady: 'deeplink:ready',
  appInfo: 'app:info',
  shareSources: 'share:sources',
  shareSelect: 'share:select',
  shareActive: 'share:active',
  updateState: 'update:state',
  updateGet: 'update:get',
  updateSetBeta: 'update:set-beta',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
} as const;

export interface TofuMismatchMsg {
  host: string;
  expected: string;
  actual: string;
}

export interface TrayStateMsg {
  connected: boolean;
  muted: boolean;
  deafened: boolean;
  serverName?: string;
}

export type TrayActionMsg = 'toggle-mute' | 'toggle-deafen' | 'leave';

export interface AppInfo {
  version: string;
  platform: string;
  /** 全局热键不可用的原因；可用时为 null */
  hotkeyUnavailable: string | null;
}

export interface ShareSourceMsg {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  appIcon?: string;
}

/** preload 暴露给渲染进程的 API（window.haneDesktop） */
export interface DesktopBridge {
  info: AppInfo;
  getMasterSeed(): Promise<Uint8Array>;
  seenSpki(hostPort: string): Promise<Uint8Array | null>;
  onTofuMismatch(cb: (m: TofuMismatchMsg) => void): () => void;
  acceptFingerprint(host: string, fingerprint: string): Promise<void>;
  /** 建立连接前的证书预检；false 表示指纹不一致、已拦下（同时会收到 onTofuMismatch） */
  beforeConnect(hostPort: string): Promise<boolean>;
  /** 注册按键说话热键（KeyboardEvent.code 或 Mouse4 / Mouse5）；空字符串表示取消 */
  registerPtt(code: string): Promise<void>;
  onPtt(cb: (pressed: boolean) => void): () => void;
  setTrayState(s: TrayStateMsg): void;
  onTrayAction(cb: (a: TrayActionMsg) => void): () => void;
  onDeepLink(cb: (url: string) => void): () => void;
  listShareSources(): Promise<ShareSourceMsg[]>;
  selectShareSource(id: string): Promise<void>;
  setSharing(active: boolean): void;
  getUpdateInfo(): UpdateInfoMsg;
  onUpdateState(cb: (s: UpdateStateMsg) => void): () => void;
  setUpdateBeta(on: boolean): void;
  checkForUpdates(): void;
  installUpdate(): void;
}

export interface UpdateStateMsg {
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
}

export interface UpdateInfoMsg {
  /** 这个安装方式能否自动更新（Windows 安装版、AppImage 可以；deb、Dev 版、未打包的开发环境不行） */
  automatic: boolean;
  /** Microsoft Store 版：由商店负责更新，应用里不显示更新设置 */
  store: boolean;
  beta: boolean;
  state: UpdateStateMsg;
}
