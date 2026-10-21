// 媒体会话：封装 livekit-client。负责连接 SFU、发布经过降噪和门控的麦克风、播放远端声音、
// 每人音量、关闭声音、说话指示，以及媒体断开后用新令牌自动重连。
// 媒体令牌和策略来自控制协议（core 的 MediaTarget）。

import type { OpenHaneClient, MediaTarget } from '@hane/core';
import { VoiceProcessorNode, aiNoiseAvailable, defaultNoiseSuppression, type NoiseSuppression, type VoiceMode, type VoiceStatus } from '@hane/audio-dsp';
import { E2EEKeys, type E2EEState } from './e2ee';
import { ShareTransport } from '@hane/protocol';
import { TransportMonitor, sampleTransport, type TcpFallbackMode } from './transport';
import { TrafficPacer, TrafficPolicy, newTrafficCounters, sampleTraffic, type TrafficState } from './traffic';
import { ShareController, type ShareIntentName, type ShareStatus } from './share/controller';
import type { CustomShare } from './share/engine';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import {
  ConnectionState,
  LocalAudioTrack,
  VideoPresets,
  type LocalTrackPublication,
  type ScreenShareCaptureOptions,
  type TrackPublication,
  type RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  createLocalAudioTrack,
  type AudioProcessorOptions,
  type Participant,
  type TrackProcessor,
} from 'livekit-client';
import { createStore } from 'zustand/vanilla';

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

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

/** 共享连接只走 TCP 时的连接超时：超时后改用 UDP */
const SHARE_TCP_TIMEOUT_MS = 8000;

/** 共享连接的身份 = 主连接身份 + 这个后缀（服务端约定） */
export const SHARE_SUFFIX = '#s';
/** 共享连接的身份换回主连接的身份（界面和音量都按主连接身份找成员） */
const mainIdentity = (identity: string) => (identity.endsWith(SHARE_SUFFIX) ? identity.slice(0, -SHARE_SUFFIX.length) : identity);

/** livekit-client 的音频处理器：MediaStreamTrack → 发言处理 AudioWorklet → 处理后的轨道。 */
class VoiceTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'hane-voice';
  processedTrack?: MediaStreamTrack;
  voice: VoiceProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** 麦克风音量：放在发言处理之前，电平和语音激活都按调整后的音量算 */
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  /** 第一次 init 拿到的音频上下文：完整重连后 SDK 重新发布轨道时调用 restart / init 不一定带上它 */
  private ctx: AudioContext | null = null;

  constructor(
    private prefs: () => AudioPrefs,
    private onVoice: (v: VoiceProcessorNode) => void,
  ) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = (this.ctx = opts.audioContext ?? this.ctx);
    if (!ctx) throw new Error('voice processor: no audio context');
    const p = this.prefs();
    this.voice ??= await VoiceProcessorNode.create(ctx, { ns: p.ns, mode: p.mode, threshold: p.threshold });
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.dest = ctx.createMediaStreamDestination();
    this.gain ??= ctx.createGain();
    this.gain.gain.value = p.inputVolume ?? 1;
    this.source.connect(this.gain).connect(this.voice.node).connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    this.onVoice(this.voice);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    // 切换输入设备时 livekit 会用新轨道调用 restart：保留处理节点，只换输入
    this.source?.disconnect();
    const ctx = (this.ctx = opts.audioContext ?? this.ctx);
    if (!ctx || !this.voice) return this.init(opts);
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.source.connect(this.gain ?? this.voice.node);
  }

  setInputVolume(v: number): void {
    if (this.gain) this.gain.gain.value = v;
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.voice?.dispose();
    this.voice = null;
    this.gain?.disconnect();
    this.gain = null;
    this.source = this.dest = null;
  }
}

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

  private room: Room | null = null;
  /** 屏幕共享单独的媒体连接：麦克风和摄像头在主连接上（始终 UDP），共享画面和共享声音在这里（UDP 不稳定时自动改走 TCP） */
  private shareRoom: Room | null = null;
  private shareRoomFor: string | null = null;
  private shareJoining: Promise<Room> | null = null;
  private shareIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前媒体连接所在的控制面房间 */
  private roomId: string | null = null;
  /** 当前媒体连接是否端到端加密，以及对应的密钥管理 */
  private roomE2EE = false;
  private keys: E2EEKeys | null = null;
  private unsubKeys: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private processor: VoiceTrackProcessor | null = null;
  private voice: VoiceProcessorNode | null = null;
  private audioEls = new Map<string, HTMLAudioElement>(); // track sid → 元素
  private target: MediaTarget | null = null;
  private stopped = true;
  /** 这次会议里共享连接已经从 UDP 切到过 TCP：之后的共享连接直接请求 TCP，不再来回切 */
  private preferTcp = false;
  /** 这次会议里共享连接走 TCP 连不上（ICE-TCP 端口被拦等）：之后的共享连接直接请求 UDP */
  private shareUdp = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private grantVersion = -1; // 最近一次连接使用的令牌版本
  private unsubClient: (() => void) | null = null;
  private sink = document.createElement('div');
  private shareCtl: ShareController | null = null;
  /** 端到端测试用：覆盖屏幕采集参数 */
  shareCaptureOverrides: Partial<ScreenShareCaptureOptions> = {};
  /** 端到端测试用：用给定的视频轨道代替屏幕采集 */
  shareTrackFactory?: () => Promise<MediaStreamTrack>;

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
    this.sink.style.display = 'none';
  }

  /** 开始跟随控制连接的媒体目标：有令牌就连接，令牌更新后在需要时重连。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    document.body.appendChild(this.sink);
    const follow = () => {
      const s = this.client.store.getState();
      const t = s.media;
      if (!t?.grant?.token || s.status !== 'connected') return;
      // 房间开启 / 关闭了端到端加密：重新连接（加密配置在建立连接时确定）
      const e2eeChanged = this.room !== null && !!t.policy?.e2ee?.roomEnabled !== this.roomE2EE;
      const changedRoom = (this.target !== null && this.target.roomId !== t.roomId) || e2eeChanged;
      const policyChanged = this.target?.policy !== t.policy;
      this.target = t;
      if (policyChanged) void this.applyPolicy();
      if (this.connecting) return;
      const live = this.room !== null && this.room.state !== ConnectionState.Disconnected;
      // 只在拿到新令牌（版本变化）且当前没有在线的房间时连接；退避等待期间不抢跑
      if (changedRoom || (!live && !this.retryTimer && t.version !== this.grantVersion)) void this.connect();
      this.followShare();
    };
    this.unsubClient = this.client.store.subscribe(follow);
    follow();
    navigator.mediaDevices?.addEventListener('devicechange', this.onDeviceChange);
  }

  /** 插上麦克风：之前因为没有设备而没能发布麦克风的，现在补发布 */
  private readonly onDeviceChange = () => {
    const room = this.room;
    if (this.state.getState().micError !== 'no-device' || !room || room.state !== ConnectionState.Connected) return;
    if (!room.localParticipant.getTrackPublication(Track.Source.Microphone)) void this.publishMic(room);
  };

  /** 离开：断开媒体，释放麦克风和音频上下文。 */
  async stop(): Promise<void> {
    await this.stopScreenShare().catch(() => undefined);
    this.stopped = true;
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.unsubClient?.();
    this.unsubClient = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.grantVersion = -1;
    this.retry = 0;
    const room = this.room;
    this.room = null;
    this.roomId = null;
    this.attachKeys(null);
    await room?.disconnect();
    await this.micTrack?.stopProcessor();
    this.micTrack?.stop();
    this.micTrack = null;
    this.voice = null;
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.sink.remove();
    await this.ctx?.close();
    this.ctx = null;
    this.target = null;
    this.preferTcp = false;
    this.shareUdp = false;
    await this.closeShareRoom();
    this.state.setState({ status: 'idle', error: null, cameraOn: false, share: null, transport: { protocol: null, switched: null } });
    this.levels.setState({ speaking: {}, local: null });
  }

  private async connect(): Promise<void> {
    const t = this.target;
    if (!t?.grant || this.stopped || this.connecting) return;
    this.connecting = true;
    this.grantVersion = t.version;
    const started = performance.now();
    try {
      const old = this.room;
      // 共享连接属于原来的房间：断开（换房间时共享许可也已收回）
      if (this.shareRoomFor !== null && this.shareRoomFor !== t.roomId) void this.closeShareRoom();
      // 切换房间：先连新房间、再把麦克风转过去、最后断开旧房间（「先连后断」）
      const switching = old !== null && old.state === ConnectionState.Connected && this.roomId !== null && this.roomId !== t.roomId;
      if (!switching) {
        this.room = null;
        await old?.disconnect(false);
      }
      if (!switching) this.state.setState({ status: this.retry > 0 ? 'reconnecting' : 'connecting', error: null });
      // 端到端加密的房间：每个人一把发送者密钥，经控制面中转的 HPKE 密钥包分发
      const e2ee = !!t.policy?.e2ee?.roomEnabled;
      const keys = e2ee ? new E2EEKeys(this.client) : null;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        encryption: keys ? { keyProvider: keys.provider, worker: new E2EEWorker() } : undefined,
      });
      try {
        this.wireRoom(room);
        // 弱网测试：globalThis.__haneRtcConfig 指定 ICE 配置（例如只走 server/cmd/hanenetem 的 TURN 中继）
        const rtcConfig = (globalThis as { __haneRtcConfig?: RTCConfiguration }).__haneRtcConfig;
        await room.connect(t.url, t.grant.token, { autoSubscribe: true, ...(rtcConfig ? { rtcConfig } : {}) });
      } catch (e) {
        if (switching) {
          // 新房间连不上：旧房间也已不属于我们（服务端稍后会移除），一并断开后按普通重连处理
          this.room = null;
          await old?.disconnect(false);
        }
        if (this.room === room || this.room === null) {
          this.room = null;
          this.state.setState({ status: 'reconnecting', error: String(e) });
          this.scheduleReconnect();
        }
        return;
      }
      if (this.stopped || (this.room !== old && this.room !== null)) {
        await room.disconnect();
        return;
      }
      this.room = room;
      this.watchIce(room);
      this.watchTraffic(room);
      this.roomId = t.roomId;
      this.roomE2EE = e2ee;
      // 加密房间每次连接都换一套密钥：共享连接用的是旧密钥，重新连接（不加密时共享连接不受主连接重连影响）
      if (this.shareRoom && (keys || this.keys)) {
        await this.closeShareRoom();
        queueMicrotask(() => this.followShare());
      }
      this.attachKeys(keys);
      if (keys) {
        // 先设置并分发自己的密钥，再开启加密、发布轨道
        await keys.start(t.roomId, room.localParticipant.identity);
        await room.setE2EEEnabled(true);
      }
      this.retry = 0;
      this.state.setState({ status: 'connected', error: null, needsAudioUnlock: !room.canPlaybackAudio });
      if (switching && old) {
        await this.handOver(old, room, started);
      } else {
        await this.publishMic(room);
      }
      // 房间里已经有人在共享：连上共享连接
      this.followShare();
    } finally {
      this.connecting = false;
      // 连接期间又切换了房间（例如连续点了两个房间）：接着切到最新的房间
      const latest = this.target;
      if (!this.stopped && latest?.grant && this.roomId !== null && latest.roomId !== this.roomId) queueMicrotask(() => void this.connect());
    }
  }

  private attachKeys(keys: E2EEKeys | null) {
    this.unsubKeys?.();
    this.unsubKeys = null;
    this.keys?.stop();
    this.keys = keys;
    if (keys) {
      this.unsubKeys = keys.state.subscribe((s) => this.state.setState({ e2ee: s }));
      this.state.setState({ e2ee: keys.state.getState() });
    } else {
      this.state.setState({ e2ee: null });
    }
  }

  /** 当前房间的密钥管理（未加密时为 null；端到端测试用） */
  get e2eeKeys(): E2EEKeys | null {
    return this.keys;
  }

  /** 把本地媒体从旧房间转到新房间：麦克风同一条轨道直接转过去（处理链不重建），摄像头重新开启，屏幕共享结束。 */
  private async handOver(old: Room, room: Room, started: number) {
    const shareStopped = this.shareCtl !== null;
    if (shareStopped) {
      // 共享许可绑定在房间上，服务端已经收回
      await this.shareCtl?.stop().catch(() => undefined);
      this.shareCtl = null;
    }
    const cameraOn = this.state.getState().cameraOn;
    const oldCamera = old.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const gapStart = performance.now();
    if (this.micTrack) await old.localParticipant.unpublishTrack(this.micTrack, false).catch(() => undefined);
    await this.publishMic(room);
    const gapMs = performance.now() - gapStart;
    await old.disconnect(false);
    oldCamera?.stop();
    if (cameraOn) {
      this.state.setState({ cameraOn: false });
      await this.setCameraEnabled(true);
    }
    this.bumpVideo();
    this.state.setState({ lastSwitch: { totalMs: Math.round(performance.now() - started), gapMs: Math.round(gapMs), shareStopped } });
  }

  /**
   * 媒体断开或连接失败（例如服务器重启后旧令牌失效）：退避后向控制面要新令牌，
   * 新令牌经 follow() 触发连接。控制连接未恢复时什么也不做——恢复后 Welcome 自带新令牌。
   */
  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this.retry, RECONNECT_DELAYS.length - 1)]!;
    this.retry++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.stopped || this.client.store.getState().status !== 'connected') return;
      try {
        await this.client.refreshMedia();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private wireRoom(room: Room) {
    room
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room || this.stopped) return;
        this.room = null;
        this.levels.setState({ speaking: {} });
        this.state.setState({ status: 'reconnecting' });
        this.scheduleReconnect();
      })
      .on(RoomEvent.Reconnecting, () => this.room === room && this.state.setState({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => this.room === room && this.state.setState({ status: 'connected' }))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.state.setState({ needsAudioUnlock: !room.canPlaybackAudio }))
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === Track.Kind.Video) {
          this.bumpVideo();
          return;
        }
        const el = track.attach() as HTMLAudioElement;
        el.muted = this.state.getState().deafened;
        this.sink.appendChild(el);
        this.audioEls.set(pub.trackSid, el);
        this.applyVolume(participant);
        void this.applyOutputDevice(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Video) {
          this.bumpVideo();
          return;
        }
        track.detach().forEach((el) => el.remove());
        this.audioEls.delete(pub.trackSid);
      })
      .on(RoomEvent.LocalTrackPublished, () => this.bumpVideo())
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        this.bumpVideo();
        // 主持人关闭了摄像头（SFU 收回权限后取消发布）：同步本地状态并释放摄像头
        if (this.room === room && pub.source === Track.Source.Camera && this.state.getState().cameraOn) {
          pub.track?.stop();
          this.state.setState({ cameraOn: false });
        }
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
        // 强制静音解除后 SFU 重新允许发布麦克风：把原来的轨道重新发布（保持静音，由用户自己开麦）。
        // 连接中途 LiveKit 也会通知一次权限，这时还不能发布（连接完成后的发布由 connect 负责）
        if (this.room !== room || participant !== room.localParticipant || !this.micTrack || room.state !== ConnectionState.Connected) return;
        const allowed = room.localParticipant.permissions?.canPublishSources ?? [];
        const micAllowed = allowed.length === 0 || allowed.includes(2 /* TrackSource.MICROPHONE */);
        if (micAllowed && !room.localParticipant.getTrackPublication(Track.Source.Microphone)) void this.publishMic(room);
      })
      .on(RoomEvent.TrackStreamStateChanged, () => this.bumpVideo())
      .on(RoomEvent.TrackMuted, () => this.bumpVideo())
      .on(RoomEvent.TrackUnmuted, () => this.bumpVideo())
      // 用房间级事件：加入时已在房间里的人不会触发 ParticipantConnected，逐个监听会漏掉他们
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const local = room.localParticipant.identity;
        const next: Record<string, boolean> = {};
        for (const p of speakers) if (p.identity !== local) next[p.identity] = true;
        // 自己的说话状态来自本地门控（更及时），保留
        const cur = this.levels.getState().speaking;
        if (cur[local]) next[local] = true;
        this.levels.setState({ speaking: next });
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => this.setSpeaking(p.identity, false));
  }

  private setSpeaking(identity: string, speaking: boolean) {
    const cur = this.levels.getState().speaking;
    if (!!cur[identity] === speaking) return;
    this.levels.setState({ speaking: { ...cur, [identity]: speaking } });
  }

  /** 等待媒体连接就绪（刚进入会议时用户可能立刻点击摄像头或共享） */
  private async connectedRoom(timeoutMs = 10_000): Promise<Room> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = this.room;
      if (r && r.state === ConnectionState.Connected && !this.connecting) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('media not connected');
  }

  /**
   * 媒体路径断开（换网、NAT 映射失效）时：浏览器约 3 秒后报告 ICE disconnected，再过约 10 秒才报告 failed，而 SDK 只在 failed 时
   * 发起 ICE 重启。disconnected 持续 2 秒就提前让 SDK 恢复（ICE 重启本身约 0.1 秒），换网后的恢复时间从约 16 秒缩短到约 6 秒。
   * 使用的是 SDK 引擎的内部方法（livekit-client 2.22），升级 SDK 时由 netem 端到端测试覆盖。
   */
  private watchIce(room: Room) {
    let since = 0;
    const timer = setInterval(() => {
      if (this.room !== room) {
        clearInterval(timer);
        return;
      }
      const engine = (room as unknown as { engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } }; handleDisconnect?: (c: string, r?: unknown) => void } }).engine;
      const pcs = [engine?.pcManager?.publisher?.pc, engine?.pcManager?.subscriber?.pc].filter((pc): pc is RTCPeerConnection => !!pc);
      if (room.state !== ConnectionState.Connected || !pcs.some((pc) => pc.iceConnectionState === 'disconnected')) {
        since = 0;
        return;
      }
      since ||= Date.now();
      if (Date.now() - since >= 2000 && typeof engine?.handleDisconnect === 'function') {
        since = 0;
        engine.handleDisconnect('ice disconnected');
      }
    }, 500);
  }

  /**
   * 流量优先级（见 traffic.ts）：每秒取一次主连接和共享连接的统计，更新聊天图片的传输速度，并告诉屏幕共享要不要让路。
   * 媒体连接期间才给客户端设置传输节奏，断开后图片传输不再限速
   */
  private watchTraffic(room: Room) {
    const policy = new TrafficPolicy();
    const counters = newTrafficCounters();
    const pacer = new TrafficPacer();
    this.client.setTransferPacer(pacer);
    type Pcs = { engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } } };
    const pcs = (r: Room | null) => (r as unknown as Pcs | null)?.engine?.pcManager;
    const stats = (pc?: RTCPeerConnection) => (pc ? pc.getStats().catch(() => null) : Promise.resolve(null));
    const some = (xs: (RTCStatsReport | null)[]) => xs.filter((x): x is RTCStatsReport => !!x);
    const timer = setInterval(async () => {
      if (this.room !== room) {
        clearInterval(timer);
        if (!this.room) {
          this.client.setTransferPacer(null);
          this.state.setState({ traffic: null });
        }
        return;
      }
      if (room.state !== ConnectionState.Connected) return;
      const main = pcs(room);
      const share = pcs(this.shareRoom);
      const [camera, mainDown, shareUp, shareDown] = await Promise.all([
        stats(main?.publisher?.pc),
        stats(main?.subscriber?.pc),
        stats(share?.publisher?.pc),
        stats(share?.subscriber?.pc),
      ]);
      if (this.room !== room) return;
      const sample = sampleTraffic(performance.now(), { camera: some([camera]), share: some([shareUp]), down: some([mainDown, shareDown]) }, counters);
      const active = pacer.takeActivity();
      const st = policy.update({ ...sample, upActive: active.up, downActive: active.down });
      pacer.set(st.upBps, st.downBps);
      this.shareCtl?.setYield(st.shareYield);
      this.state.setState({ traffic: st });
    }, 1000);
  }

  /** 共享连接要请求的传输方式：TCP 连不上过就要 UDP，从 UDP 切到过 TCP 就要 TCP，否则按服务器设置 */
  private shareTransport(): ShareTransport {
    if (this.shareUdp) return ShareTransport.UDP;
    if (this.preferTcp) return ShareTransport.TCP;
    return ShareTransport.UNSPECIFIED;
  }

  /** 只有 UDP 优先、走的是 UDP、服务器开放了 ICE-TCP 时才需要检测 UDP 是否稳定 */
  private shareMonitorMode(tcp: boolean): TcpFallbackMode {
    const t = this.target?.policy?.transport;
    return !tcp && !this.shareUdp && t?.tcpAvailable && t.shareTransport === ShareTransport.UDP ? 'auto' : 'off';
  }

  /**
   * 共享连接的传输状态（主连接的语音和摄像头始终走 UDP）：每 2 秒取两个 PeerConnection 的统计，更新当前协议。
   * UDP 优先时交给 TransportMonitor 判断，需要切换时通过 LiveKit 的「切换候选协议」让服务端改为只提供 TCP 候选，
   * 客户端 ICE 重启后恢复，轨道（包括屏幕共享）保留。
   */
  private watchTransport(room: Room, tcp: boolean) {
    const monitor = new TransportMonitor(this.shareMonitorMode(tcp), performance.now());
    const prev = { lost: 0, received: 0 };
    const timer = setInterval(async () => {
      if (this.shareRoom !== room) {
        clearInterval(timer);
        return;
      }
      const pcm = (room as unknown as { engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } } }).engine?.pcManager;
      const pcs = [pcm?.publisher?.pc, pcm?.subscriber?.pc].filter((pc): pc is RTCPeerConnection => !!pc);
      if (room.state !== ConnectionState.Connected || !pcs.length) return;
      const sample = sampleTransport(await Promise.all(pcs.map((pc) => pc.getStats())), prev);
      const cur = this.state.getState().transport;
      if (sample.protocol !== cur.protocol) this.state.setState({ transport: { ...cur, protocol: sample.protocol } });
      if (!monitor.update(performance.now(), sample)) return;
      this.preferTcp = true;
      this.state.setState({ transport: { protocol: sample.protocol, switched: monitor.reason as 'loss' | 'rtt' | 'always' } });
      await room.simulateScenario('force-tcp').catch(() => undefined);
    }, 2000);
  }

  private bumpVideo() {
    this.state.setState({ videoVersion: this.state.getState().videoVersion + 1 });
  }

  /** 所有正在发布的视频轨道（自己和远端），供宫格和共享视图使用 */
  videoTracks(): TrackRef[] {
    const room = this.room;
    if (!room) return [];
    const out: TrackRef[] = [];
    const add = (identity: string, pub: TrackPublication, local: boolean) => {
      if (!pub.track || pub.isMuted || pub.kind !== Track.Kind.Video) return;
      const source = pub.source === Track.Source.ScreenShare ? 'screen' : pub.source === Track.Source.Camera ? 'camera' : null;
      if (source) out.push({ identity, source, track: pub.track, local, paused: !local && pub.track.streamState === Track.StreamState.Paused });
    };
    for (const pub of room.localParticipant.trackPublications.values()) add(room.localParticipant.identity, pub as LocalTrackPublication, true);
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) add(p.identity, pub, false);
    const share = this.shareRoom;
    if (share) {
      for (const pub of share.localParticipant.trackPublications.values()) add(room.localParticipant.identity, pub as LocalTrackPublication, true);
      for (const p of share.remoteParticipants.values()) for (const pub of p.trackPublications.values()) add(mainIdentity(p.identity), pub, false);
    }
    return out;
  }

  // ---------- 摄像头 ----------

  /** getUserMedia 的错误 → 界面显示用的代码 */
  private static deviceError(e: unknown): string {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError') return 'permission-denied';
    if (name === 'NotFoundError') return 'no-device';
    // 设备被别的程序占用，或者驱动出错
    if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
    return String(e);
  }

  /** 开关摄像头：分辨率和帧率受服务器策略限制；≥ 540p 时三层 simulcast（避开两层） */
  async setCameraEnabled(on: boolean): Promise<void> {
    const room = await this.connectedRoom();
    const cam = this.target?.policy?.camera;
    if (on && cam && !cam.allowed) {
      this.state.setState({ cameraError: 'not-allowed' });
      return;
    }
    const maxH = cam?.maxHeight || 720;
    const preset = maxH >= 720 ? VideoPresets.h720 : maxH >= 540 ? VideoPresets.h540 : VideoPresets.h360;
    try {
      const deviceId = this.state.getState().prefs.cameraDeviceId;
      await room.localParticipant.setCameraEnabled(
        on,
        { deviceId: deviceId && deviceId !== 'default' ? deviceId : undefined, resolution: { ...preset.resolution, frameRate: Math.min(cam?.maxFps || 30, 30) } },
        { videoCodec: 'vp8', simulcast: maxH >= 540, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360] },
      );
      this.state.setState({ cameraOn: on, cameraError: null });
      // 摄像头的优先级低于语音（语音默认最高）、高于屏幕共享
      if (on) await setPriority(room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.sender, 'medium');
      // 摄像头在会议中被拔掉：轨道结束后不会再有画面，关掉并提示
      const track = on ? room.localParticipant.getTrackPublication(Track.Source.Camera)?.track : undefined;
      track?.once(TrackEvent.Ended, () => {
        if (!this.state.getState().cameraOn) return;
        void this.setCameraEnabled(false).then(() => this.state.setState({ cameraError: 'disconnected' }));
      });
    } catch (e) {
      this.state.setState({ cameraOn: false, cameraError: MediaSession.deviceError(e) });
    }
  }

  // ---------- 屏幕共享 ----------

  /** 开始屏幕共享；用户在浏览器选择框中取消时抛出 ShareCancelled */
  async startScreenShare(intent: ShareIntentName, withAudio: boolean, custom?: CustomShare): Promise<void> {
    if (this.shareCtl?.active) return;
    await this.connectedRoom();
    const room = await this.ensureShareRoom();
    const ctl = new ShareController(
      this.client,
      room,
      (s) => {
        this.state.setState({ share: s });
        if (!s) this.followShare();
      },
      this.shareCaptureOverrides,
      this.shareTrackFactory,
    );
    this.shareCtl = ctl;
    try {
      await ctl.start(intent, withAudio, custom);
    } catch (e) {
      this.shareCtl = null;
      this.followShare();
      throw e;
    }
  }

  async stopScreenShare(): Promise<void> {
    await this.shareCtl?.stop();
    this.shareCtl = null;
    this.followShare();
  }

  /** 需要共享连接：自己在共享，或者房间里有别人在共享 */
  private shareNeeded(): boolean {
    if (this.shareCtl) return true;
    const s = this.client.store.getState();
    const roomId = this.roomId ?? s.media?.roomId;
    const self = s.self?.sessionId;
    return !!roomId && (s.rooms[roomId]?.shares ?? []).some((sh) => sh.sessionId !== self);
  }

  /** 按需连接 / 断开共享连接；没人共享 15 秒后断开（共享常常停了又开） */
  private followShare() {
    if (this.stopped || !this.room) return;
    if (this.shareNeeded()) {
      if (this.shareIdleTimer) clearTimeout(this.shareIdleTimer);
      this.shareIdleTimer = null;
      if (!this.shareRoom && !this.shareJoining) void this.ensureShareRoom().catch(() => setTimeout(() => this.followShare(), 2000));
    } else if (this.shareRoom && !this.shareIdleTimer) {
      this.shareIdleTimer = setTimeout(() => {
        this.shareIdleTimer = null;
        if (!this.shareNeeded()) void this.closeShareRoom();
      }, 15_000);
    }
  }

  /** 连接共享连接（已连上时直接返回）：向控制面要令牌，和主连接共用端到端加密的密钥 */
  private ensureShareRoom(): Promise<Room> {
    const roomId = this.roomId;
    if (this.shareRoom && this.shareRoomFor === roomId && this.shareRoom.state !== ConnectionState.Disconnected) return Promise.resolve(this.shareRoom);
    this.shareJoining ??= (async () => {
      try {
        let grant: { url: string; token: string; tcp: boolean };
        let room: Room;
        const keys = this.keys;
        for (;;) {
          grant = await this.client.joinShareMedia(this.shareTransport());
          room = new Room({
            adaptiveStream: true,
            dynacast: true,
            disconnectOnPageLeave: true,
            encryption: keys ? { keyProvider: keys.provider, worker: new E2EEWorker() } : undefined,
          });
          this.wireShareRoom(room);
          const g = globalThis as { __haneRtcConfig?: RTCConfiguration; __haneShareTcpTimeoutMs?: number };
          // 只走 TCP 时等不了太久：端口被防火墙拦住时连通性检查会一直挂着，超时后改用 UDP
          const timeout = grant.tcp ? { peerConnectionTimeout: g.__haneShareTcpTimeoutMs ?? SHARE_TCP_TIMEOUT_MS } : {};
          try {
            await room.connect(grant.url, grant.token, { autoSubscribe: true, ...timeout, ...(g.__haneRtcConfig ? { rtcConfig: g.__haneRtcConfig } : {}) });
            break;
          } catch (e) {
            await room.disconnect().catch(() => undefined);
            if (!grant.tcp || this.stopped || this.roomId !== roomId) throw e;
            this.shareUdp = true;
          }
        }
        if (keys) await room.setE2EEEnabled(true);
        if (this.stopped || this.roomId !== roomId) {
          await room.disconnect();
          throw new Error('media room changed');
        }
        this.shareRoom = room;
        this.shareRoomFor = roomId;
        this.watchTransport(room, grant.tcp);
        this.bumpVideo();
        return room;
      } finally {
        this.shareJoining = null;
      }
    })();
    return this.shareJoining;
  }

  private async closeShareRoom() {
    if (this.shareIdleTimer) clearTimeout(this.shareIdleTimer);
    this.shareIdleTimer = null;
    const room = this.shareRoom;
    this.shareRoom = null;
    this.shareRoomFor = null;
    if (room) {
      await room.disconnect().catch(() => undefined);
      this.bumpVideo();
    }
  }

  private wireShareRoom(room: Room) {
    room
      .on(RoomEvent.Disconnected, () => {
        if (this.shareRoom !== room) return;
        this.shareRoom = null;
        this.shareRoomFor = null;
        this.bumpVideo();
        // 还需要的话稍后重连（例如令牌过期、SFU 重启）
        setTimeout(() => this.followShare(), 1000);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.state.setState({ needsAudioUnlock: !room.canPlaybackAudio }))
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === Track.Kind.Video) {
          this.bumpVideo();
          return;
        }
        // 共享的声音
        const el = track.attach() as HTMLAudioElement;
        el.muted = this.state.getState().deafened;
        this.sink.appendChild(el);
        this.audioEls.set(pub.trackSid, el);
        this.applyVolume(participant);
        void this.applyOutputDevice(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Video) {
          this.bumpVideo();
          return;
        }
        track.detach().forEach((el) => el.remove());
        this.audioEls.delete(pub.trackSid);
      })
      .on(RoomEvent.LocalTrackPublished, () => this.bumpVideo())
      .on(RoomEvent.LocalTrackUnpublished, () => this.bumpVideo())
      .on(RoomEvent.TrackStreamStateChanged, () => this.bumpVideo())
      .on(RoomEvent.TrackMuted, () => this.bumpVideo())
      .on(RoomEvent.TrackUnmuted, () => this.bumpVideo());
  }

  /** 共享中切换模式；切到自定义时给出参数（已经是自定义时也可以只改参数） */
  async setShareIntent(intent: ShareIntentName, custom?: CustomShare): Promise<void> {
    await this.shareCtl?.setIntent(intent, custom);
  }

  // ---------- 麦克风 ----------

  private async publishMic(room: Room) {
    const prefs = this.state.getState().prefs;
    try {
      this.ctx ??= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
      if (!this.micTrack) {
        this.micTrack = await createLocalAudioTrack({
          deviceId: prefs.inputDeviceId === 'default' ? undefined : prefs.inputDeviceId,
          echoCancellation: !prefs.headphones,
          // 启用我们自己的降噪时关闭浏览器降噪，避免两道降噪叠加造成失真
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        });
        this.micTrack.setAudioContext(this.ctx);
        const track = this.micTrack;
        track.on(TrackEvent.Ended, () => void this.onMicEnded(room, track));
        this.processor = new VoiceTrackProcessor(
          () => this.state.getState().prefs,
          (v) => this.attachVoice(v),
        );
        await this.micTrack.setProcessor(this.processor);
      }
      if (this.state.getState().micMuted) await this.micTrack.mute();
      const audio = this.target?.policy?.audio;
      await room.localParticipant.publishTrack(this.micTrack, {
        source: Track.Source.Microphone,
        dtx: audio?.dtx ?? true,
        red: audio?.red ?? true,
        audioPreset: { maxBitrate: audio?.maxBitrateBps || 32000 },
      });
      this.state.setState({ micError: null });
    } catch (e) {
      this.state.setState({ micError: MediaSession.deviceError(e) });
    }
  }

  /** 麦克风轨道结束（设备被拔掉）：还有别的麦克风就换到默认设备；一个都没有了就取消发布，接上后由 devicechange 补发布 */
  private async onMicEnded(room: Room, track: LocalAudioTrack) {
    if (this.micTrack !== track || this.room !== room) return;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (devices.some((d) => d.kind === 'audioinput')) {
      try {
        await track.restartTrack({ deviceId: 'default' });
        return;
      } catch {
        // 换设备也失败：按没有麦克风处理
      }
    }
    if (this.micTrack !== track) return;
    this.micTrack = null;
    await room.localParticipant.unpublishTrack(track).catch(() => undefined);
    await track.stopProcessor().catch(() => undefined);
    track.stop();
    this.state.setState({ micError: 'no-device' });
  }

  private attachVoice(v: VoiceProcessorNode) {
    if (this.voice === v) return;
    this.voice = v;
    v.onStatus((s) => {
      this.levels.setState({ local: s });
      const self = this.client.store.getState().participants[this.client.store.getState().self?.sessionId ?? ''];
      const id = self?.mediaIdentity;
      if (id) this.setSpeaking(id, s.speaking && !this.state.getState().micMuted);
    });
  }

  /** 服务器策略变化（管理员改了码率）：实时调整，不需要重新连接。 */
  private async applyPolicy() {
    const bps = this.target?.policy?.audio?.maxBitrateBps;
    const sender = this.micTrack?.sender;
    if (!bps || !sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0]!.maxBitrate = bps;
    await sender.setParameters(params).catch(() => undefined);
  }

  async setMicMuted(muted: boolean): Promise<void> {
    this.state.setState({ micMuted: muted });
    if (muted) await this.micTrack?.mute();
    else await this.micTrack?.unmute();
  }

  /** 关闭声音：所有远端声音静音（调用方同时静音麦克风）。 */
  setDeafened(deafened: boolean): void {
    this.state.setState({ deafened });
    for (const el of this.audioEls.values()) el.muted = deafened;
  }

  setPushToTalk(pressed: boolean): void {
    this.voice?.setPushToTalk(pressed);
  }

  async setPrefs(patch: Partial<AudioPrefs>): Promise<void> {
    const prefs = { ...this.state.getState().prefs, ...patch };
    this.state.setState({ prefs });
    this.voice?.setOptions({ ns: prefs.ns, mode: prefs.mode, threshold: prefs.threshold });
    if (patch.inputDeviceId !== undefined && this.room) {
      await this.room.switchActiveDevice('audioinput', prefs.inputDeviceId).catch(() => undefined);
    }
    if (patch.outputDeviceId !== undefined) for (const el of this.audioEls.values()) await this.applyOutputDevice(el);
    if (patch.inputVolume !== undefined) this.processor?.setInputVolume(prefs.inputVolume ?? 1);
    if (patch.outputVolume !== undefined) {
      for (const r of [this.room, this.shareRoom]) for (const p of r?.remoteParticipants.values() ?? []) this.applyVolume(p);
    }
    if (patch.cameraDeviceId !== undefined && this.room && this.state.getState().cameraOn) {
      await this.room.switchActiveDevice('videoinput', prefs.cameraDeviceId || 'default').catch(() => undefined);
    }
    if (patch.headphones !== undefined && this.micTrack) {
      await this.micTrack.restartTrack({ echoCancellation: !prefs.headphones, noiseSuppression: false, autoGainControl: true });
    }
  }

  private async applyOutputDevice(el: HTMLAudioElement) {
    const id = this.state.getState().prefs.outputDeviceId;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (withSink.setSinkId) await withSink.setSinkId(id === 'default' ? '' : id).catch(() => undefined);
  }

  /** 每人音量（0–2）。 */
  setVolume(identity: string, volume: number): void {
    this.state.setState({ volumes: { ...this.state.getState().volumes, [identity]: volume } });
    const p = this.room?.remoteParticipants.get(identity);
    if (p) this.applyVolume(p);
    const sp = this.shareRoom?.remoteParticipants.get(identity + SHARE_SUFFIX);
    if (sp) this.applyVolume(sp);
  }

  private applyVolume(p: Participant) {
    if (!(p instanceof RemoteParticipant)) return;
    const s = this.state.getState();
    p.setVolume((s.volumes[mainIdentity(p.identity)] ?? 1) * (s.prefs.outputVolume ?? 1));
  }

  /** 浏览器阻止自动播放时，在用户点击后调用。 */
  async unlockAudio(): Promise<void> {
    await this.room?.startAudio();
    await this.shareRoom?.startAudio();
    await this.ctx?.resume();
    this.state.setState({ needsAudioUnlock: !(this.room?.canPlaybackAudio ?? true) });
  }

  /** 列出音频设备（需要已获得麦克风权限才有设备名称）。 */
  static async devices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput'), cameras: all.filter((d) => d.kind === 'videoinput') };
  }

  /** 用于诊断：当前的 Room（测试和连接信息页）。 */
  get liveRoom(): Room | null {
    return this.room;
  }

  /** 用于诊断：共享连接的 Room（没人共享时为 null） */
  get liveShareRoom(): Room | null {
    return this.shareRoom;
  }
}

export type { RemoteAudioTrack };

/** 发送轨道的优先级：同一条连接里带宽不够时按它分配码率，并据此标记网络优先级（DSCP，局域网和部分 Wi-Fi 会照做） */
export async function setPriority(sender: RTCRtpSender | undefined, priority: RTCPriorityType): Promise<void> {
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings?.length) return;
  for (const e of p.encodings) {
    e.priority = priority;
    e.networkPriority = priority;
  }
  await sender.setParameters(p).catch(() => undefined);
}
