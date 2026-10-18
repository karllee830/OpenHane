// 平台抽象层：core / media 只依赖这里的接口，各 app 注入对应平台的实现。

/** 主种子（32 字节）的存储；没有时生成并保存。 */
export interface IdentityStore {
  getMasterSeed(): Promise<Uint8Array>;
}

/** 证书指纹不一致（TOFU 警告）的详情；指纹格式为 SHA256:<base64>。 */
export interface FingerprintMismatch {
  host: string;
  expected: string;
  actual: string;
}

/** TOFU 证书指纹。浏览器拿不到证书指纹，Web 版不提供。 */
export interface TrustStore {
  /** 本次连接 host:port 时 TLS 层实际看到的 SPKI SHA-256（已由平台按 TOFU 校验过）。 */
  seenSpki(hostPort: string): Promise<Uint8Array | null>;
  /** 指纹与记住的不一致、连接已被拒绝时通知（界面显示全屏警告）。返回取消订阅的函数。 */
  onMismatch(cb: (m: FingerprintMismatch) => void): () => void;
  /** 用户确认这是正常变化：改为信任新指纹。 */
  acceptFingerprint(host: string, fingerprint: string): Promise<void>;
  /**
   * 建立连接前的证书预检。返回 false 表示指纹与记住的不一致、这次连接被拦下（同时触发 onMismatch），
   * 客户端不应继续连接。
   */
  beforeConnect?(hostPort: string): Promise<boolean>;
}

/** 小型键值存储（书签、个人设置）。读写失败时静默降级。 */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

/** 全局热键（Electron）。Web 版只能在页面获得焦点时监听按键。 */
export interface GlobalHotkeys {
  /**
   * 注册按键说话热键（KeyboardEvent.code，如 Backquote、KeyV；鼠标侧键为 Mouse4 / Mouse5）。
   * 回调在按下 / 松开时触发，窗口不在前台时也有效。返回取消注册的函数。
   */
  registerPushToTalk(code: string, onChange: (pressed: boolean) => void): () => void;
  /** 热键不可用的原因（例如 macOS 未授予「输入监控」权限）；可用时为 null。 */
  /** 不可用的原因代码（例如 'macos-accessibility'），null 表示可用 */
  readonly unavailableReason?: string | null;
}

/** 可共享的屏幕或窗口（自定义共享选择器） */
export interface ShareSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** 缩略图（data URL） */
  thumbnail: string;
  /** 窗口所属应用的图标（data URL，可能为空） */
  appIcon?: string;
}

/** 自定义共享选择器（Electron）。浏览器用自带的选择框，不提供。 */
export interface ScreenSourcePicker {
  listSources(): Promise<ShareSource[]>;
  /** 选定来源；随后调用 getDisplayMedia 时使用它 */
  select(id: string): Promise<void>;
  /** 共享开始 / 结束：共享期间本应用窗口不进入共享画面 */
  setSharing(active: boolean): void;
  /** 能否共享系统声音（Windows 需要进程环回扩展） */
  readonly audioSupported: boolean;
}

export type TrayAction = 'toggle-mute' | 'toggle-deafen' | 'leave';

/** 托盘 / 菜单栏图标（Electron）。 */
export interface TrayService {
  setState(state: { connected: boolean; muted: boolean; deafened: boolean; serverName?: string }): void;
  onAction(cb: (a: TrayAction) => void): () => void;
}

/** openhane:// 链接（Electron）。 */
export interface DeepLinkSource {
  onLink(cb: (url: string) => void): () => void;
}

/** 应用自身的更新状态（桌面版）。 */
export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  /** 可用或已下载的新版本号 */
  version?: string;
  /** 下载进度（0–100） */
  percent?: number;
  error?: string;
}

export interface AppUpdates {
  /** false：这个安装方式不支持自动更新（例如 deb 包），只能手动下载新版本 */
  automatic: boolean;
  state(): UpdateState;
  onChange(cb: (s: UpdateState) => void): () => void;
  /** 是否接收公测版 */
  beta(): boolean;
  setBeta(on: boolean): void;
  check(): void;
  /** 退出并安装已下载的更新 */
  install(): void;
  /** 发布页面，用于手动下载 */
  releasesUrl: string;
}

export type PlatformKind = 'web' | 'electron' | 'android';

export interface PlatformServices {
  kind: PlatformKind;
  identity: IdentityStore;
  storage: KeyValueStore;
  trust?: TrustStore;
  hotkeys?: GlobalHotkeys;
  tray?: TrayService;
  screenPicker?: ScreenSourcePicker;
  deepLinks?: DeepLinkSource;
  updates?: AppUpdates;
}

export { createWebPlatform } from './web';
export { MemoryIdentityStore, MemoryKeyValueStore } from './memory';
