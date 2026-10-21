// 媒体会话：音频设置、界面状态，以及会议里的媒体操作（麦克风、摄像头、屏幕共享、每人音量）。
// 连接 SFU 的部分（live.ts，依赖 livekit-client）进入会议时才加载，首屏只有这里的状态和设置。

import type { OpenHaneClient } from '@hane/core';
import { aiNoiseAvailable, defaultNoiseSuppression, type NoiseSuppression, type VoiceMode, type VoiceStatus } from '@hane/audio-dsp';
import type { ScreenShareCaptureOptions, Track } from 'livekit-client';
import { createStore } from 'zustand/vanilla';
import type { E2EEKeys, E2EEState } from './e2ee';
import type { LiveMedia } from './live';
import type { ShareIntentName, ShareStatus } from './share/controller';
import type { CustomShare } from './share/engine';
import type { TrafficState } from './traffic';

export type MediaStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface AudioPrefs {
  ns: NoiseSuppression;
  /** 用户在设置里手动选过降噪档位（没选过的人跟随默认档位，默认值变了也会跟着变） */
  nsChosen?: boolean;
  mode: VoiceMode;
  threshold: 'auto' | number;
  inputDeviceId: string;
  outputDeviceId: string;
  /** 摄像头；旧版本保存的设置里没有 */
  cameraDeviceId?: string;
  /** 麦克风音量（0–2，1 为原始音量）；旧版本保存的设置里没有 */
  inputVolume?: number;
  /** 所有人声音的总音量（0–2，再乘上每个人单独的音量）；旧版本保存的设置里没有 */
  outputVolume?: number;
  /** 戴耳机时可以关闭回声消除，音质更自然 */
  headphones: boolean;
}

export const defaultAudioPrefs: AudioPrefs = {
  ns: defaultNoiseSuppression(),
  mode: 'voice',
  threshold: 'auto',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  headphones: false,
};

export interface MediaState {
  status: MediaStatus;
  error: string | null;
  micMuted: boolean;
  deafened: boolean;
  /** 浏览器阻止了自动播放，需要用户点击一次 */
  needsAudioUnlock: boolean;
  /** 麦克风权限被拒绝或没有设备 */
  micError: string | null;
  prefs: AudioPrefs;
  /** 每人音量（按媒体 identity），0–2，默认 1 */
  volumes: Record<string, number>;
  cameraOn: boolean;
  cameraError: string | null;
  /** 自己正在进行的屏幕共享（null 表示没有） */
  share: ShareStatus | null;
  /** 视频轨道变化时加一（界面据此重新取 videoTracks） */
  videoVersion: number;
  /** 最近一次切换房间的耗时 */
  lastSwitch: { totalMs: number; gapMs: number; shareStopped: boolean } | null;
  /** 当前房间的端到端加密状态（未加密时为 null） */
  e2ee: E2EEState | null;
  /** 媒体连接走的协议；UDP 不稳定被切到 TCP 时 switched 记下原因（界面提示一次） */
  transport: { protocol: 'udp' | 'tcp' | null; switched: 'loss' | 'rtt' | 'always' | null };
  /** 流量优先级的当前判断（诊断和测试用；没有媒体连接时为 null） */
  traffic: TrafficState | null;
}

/** 某个参与者某一路视频（摄像头或屏幕）的轨道 */
export interface TrackRef {
  identity: string;
  source: 'camera' | 'screen';
  track: Track;
  local: boolean;
  /** SFU 因为带宽不足暂停了这路远端视频（连最低的一层也放不下） */
  paused: boolean;
}

/** 高频状态（说话指示、电平），单独存放，避免成员列表频繁重渲染。 */
export interface LevelState {
  /** 媒体 identity → 是否在说话 */
  speaking: Record<string, boolean>;
  local: VoiceStatus | null;
}

let liveModule: Promise<typeof import('./live')> | null = null;
/** 下载会议部分（只下载一次） */
const loadLive = () => (liveModule ??= import('./live'));

export class MediaSession {
  readonly state = createStore<MediaState>()(() => ({
    status: 'idle',
    error: null,
    micMuted: false,
    deafened: false,
    needsAudioUnlock: false,
    micError: null,
    prefs: { ...defaultAudioPrefs },
    volumes: {},
    cameraOn: false,
    cameraError: null,
    share: null,
    videoVersion: 0,
    lastSwitch: null,
    e2ee: null,
    transport: { protocol: null, switched: null },
    traffic: null,
  }));
  readonly levels = createStore<LevelState>()(() => ({ speaking: {}, local: null }));

  /** 端到端测试用：覆盖屏幕采集参数 */
  shareCaptureOverrides: Partial<ScreenShareCaptureOptions> = {};
  /** 端到端测试用：用给定的视频轨道代替屏幕采集 */
  shareTrackFactory?: () => Promise<MediaStreamTrack>;

  /** 会议部分：第一次 start 或会议操作时创建 */
  private live: LiveMedia | null = null;
  private liveLoading: Promise<LiveMedia> | null = null;
  private wantStarted = false;

  constructor(
    private readonly client: OpenHaneClient,
    prefs?: Partial<AudioPrefs>,
  ) {
    const p = { ...defaultAudioPrefs, ...prefs };
    // 以前只有「标准 / 关闭」两档，保存下来的 'standard' 多半是当时的默认值：没有手动选过的人改用现在的默认档位
    if (p.ns === 'standard' && !p.nsChosen) p.ns = defaultAudioPrefs.ns;
    // 这次构建没有 AI 降噪（构建机没装 Rust）
    if (p.ns === 'ai' && !aiNoiseAvailable) p.ns = 'standard';
    this.state.setState({ prefs: p });
  }

  /** 预先下载会议部分（首屏空闲时调用，进入会议时不用再等） */
  static preload(): Promise<unknown> {
    return loadLive();
  }

  private liveMedia(): Promise<LiveMedia> {
    this.liveLoading ??= loadLive().then(({ LiveMedia }) => (this.live = new LiveMedia(this.client, this.state, this.levels, this)));
    return this.liveLoading;
  }

  /** 开始跟随控制连接的媒体目标：有令牌就连接，令牌更新后在需要时重连。 */
  start(): void {
    this.wantStarted = true;
    void this.liveMedia().then((live) => {
      if (this.wantStarted) live.start();
    });
  }

  /** 离开：断开媒体，释放麦克风和音频上下文。 */
  async stop(): Promise<void> {
    this.wantStarted = false;
    await this.live?.stop();
  }

  /** 开关摄像头：分辨率和帧率受服务器策略限制 */
  async setCameraEnabled(on: boolean): Promise<void> {
    await (await this.liveMedia()).setCameraEnabled(on);
  }

  /** 开始屏幕共享；用户在浏览器选择框中取消时抛出 ShareCancelled */
  async startScreenShare(intent: ShareIntentName, withAudio: boolean, custom?: CustomShare): Promise<void> {
    await (await this.liveMedia()).startScreenShare(intent, withAudio, custom);
  }

  async stopScreenShare(): Promise<void> {
    await this.live?.stopScreenShare();
  }

  /** 共享中切换模式；切到自定义时给出参数（已经是自定义时也可以只改参数） */
  async setShareIntent(intent: ShareIntentName, custom?: CustomShare): Promise<void> {
    await this.live?.setShareIntent(intent, custom);
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (this.live) await this.live.setMicMuted(muted);
    else this.state.setState({ micMuted: muted });
  }

  /** 关闭声音：所有远端声音静音（调用方同时静音麦克风）。 */
  setDeafened(deafened: boolean): void {
    if (this.live) this.live.setDeafened(deafened);
    else this.state.setState({ deafened });
  }

  setPushToTalk(pressed: boolean): void {
    this.live?.setPushToTalk(pressed);
  }

  async setPrefs(patch: Partial<AudioPrefs>): Promise<void> {
    if (this.live) await this.live.setPrefs(patch);
    else this.state.setState({ prefs: { ...this.state.getState().prefs, ...patch } });
  }

  /** 每人音量（0–2）。 */
  setVolume(identity: string, volume: number): void {
    if (this.live) this.live.setVolume(identity, volume);
    else this.state.setState({ volumes: { ...this.state.getState().volumes, [identity]: volume } });
  }

  /** 浏览器阻止自动播放时，在用户点击后调用。 */
  async unlockAudio(): Promise<void> {
    await this.live?.unlockAudio();
  }

  /** 所有正在发布的视频轨道（自己和远端），供宫格和共享视图使用 */
  videoTracks(): TrackRef[] {
    return this.live?.videoTracks() ?? [];
  }

  /** 列出音频设备（需要已获得麦克风权限才有设备名称）。 */
  static async devices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput'), cameras: all.filter((d) => d.kind === 'videoinput') };
  }

  /** 当前房间的密钥管理（未加密时为 null；端到端测试用） */
  get e2eeKeys(): E2EEKeys | null {
    return this.live?.e2eeKeys ?? null;
  }

  /** 用于诊断：当前的 Room（测试和连接信息页）。 */
  get liveRoom() {
    return this.live?.liveRoom ?? null;
  }

  /** 用于诊断：共享连接的 Room（没人共享时为 null） */
  get liveShareRoom() {
    return this.live?.liveShareRoom ?? null;
  }
}
