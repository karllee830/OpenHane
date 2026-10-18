// 屏幕共享发送端：许可 → 浏览器选择共享内容 → 选编码器并发布 → 自适应引擎实时调参 → 停止时收回许可。
import type { OpenHaneClient } from '@hane/core';
import { CodecMode, ShareIntent, type ScreenShareGrant } from '@hane/protocol';
import { LocalAudioTrack, LocalVideoTrack, RoomEvent, Track, TrackEvent, type Room, type ScreenShareCaptureOptions, type VideoCodec } from 'livekit-client';
import { ChangeAnalyzer } from './analyzer';
import { chooseShareCodec, detectEncodeCaps, type CodecChoice, type EncodeCaps } from './codec';
import { ScreenShareEngine, customMode, type CustomShare, type EngineCodec, type EngineIntent, type QualityLimitation, type ShareParams } from './engine';

export type ShareIntentName = 'smart' | 'clarity' | 'smoothness' | 'custom';

export interface ShareStatus {
  intent: ShareIntentName;
  /** 自定义档的参数（用户设置的值，实际值见 params） */
  custom?: CustomShare;
  withAudio: boolean;
  codec: EngineCodec;
  backupCodec?: string;
  /** 采集源的分辨率 */
  source: { width: number; height: number };
  /** 引擎当前的参数（模式、分辨率、帧率、码率上限） */
  params: ShareParams;
  /** 最近一次的内容变化信号（诊断用） */
  signals?: { changedAreaRatio: number; changeFps: number; uplinkKbps: number; qualityLimitation: string };
  /** 实际发送的分辨率和帧率（来自发送统计） */
  sent?: { width: number; height: number; fps: number; kbps: number };
}

export class ShareCancelled extends Error {}

/** 本机不能编码屏幕共享可用的任何编码器（连 H.264 都没有，例如没有 OpenH264 插件的 Firefox） */
export class ShareUnsupported extends Error {}

/** 屏幕共享用硬件 AV1 / H.265，或者 H.264 兜底（唯一允许软件编码的）：不能编码 H.264 的浏览器不能共享 */
export function canEncodeScreenShare(): boolean {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return caps.some((c) => c.mimeType.toLowerCase() === 'video/h264');
}

const INTENT: Record<ShareIntentName, { proto: ShareIntent; engine: EngineIntent }> = {
  smart: { proto: ShareIntent.SMART, engine: 'smart' },
  clarity: { proto: ShareIntent.CLARITY, engine: 'text' },
  smoothness: { proto: ShareIntent.SMOOTHNESS, engine: 'motion' },
  custom: { proto: ShareIntent.CUSTOM, engine: 'custom' },
};

/** 自定义档按帧率决定按清晰还是流畅处理（选编码器、内容提示） */
function effectiveIntent(intent: ShareIntentName, custom?: CustomShare): 'smart' | 'clarity' | 'smoothness' {
  if (intent !== 'custom') return intent;
  return custom && customMode(custom) === 'motion' ? 'smoothness' : 'clarity';
}

let encodeCaps: Promise<EncodeCaps> | null = null;

export class ShareController {
  private grant: ScreenShareGrant | null = null;
  private video: LocalVideoTrack | null = null;
  private audio: LocalAudioTrack | null = null;
  private engine: ScreenShareEngine | null = null;
  private analyzer: ChangeAnalyzer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private applied: ShareParams | null = null;
  private status: ShareStatus | null = null;
  private lastBytes = 0;
  private lastStatsAt = 0;
  private stopping = false;
  private caps: EncodeCaps | null = null;
  /** 正在换编码器（取消发布 → 重新发布）：这期间不调整发送参数 */
  private republishing = false;

  constructor(
    private readonly client: OpenHaneClient,
    private readonly room: Room,
    private readonly onStatus: (s: ShareStatus | null) => void,
    /** 端到端测试用：覆盖采集参数（例如 preferCurrentTab） */
    private readonly captureOverrides: Partial<ScreenShareCaptureOptions> = {},
    /** 端到端测试用：用给定的视频轨道代替浏览器的屏幕采集（无头浏览器无法采集真实画面） */
    private readonly trackFactory?: () => Promise<MediaStreamTrack>,
  ) {}

  get active(): boolean {
    return this.status !== null;
  }

  /** 开始共享。用户在浏览器选择框中取消时抛出 ShareCancelled。 */
  async start(intent: ShareIntentName, withAudio: boolean, custom?: CustomShare): Promise<void> {
    if (intent === 'custom' && !custom) throw new Error('custom share needs parameters');
    if (!this.trackFactory && !canEncodeScreenShare()) throw new ShareUnsupported();
    const grant = await this.client.requestScreenShare(INTENT[intent].proto, withAudio);
    this.grant = grant;
    const limits = grant.limits;
    let tracks: (LocalVideoTrack | LocalAudioTrack)[];
    try {
      tracks = this.trackFactory
        ? [new LocalVideoTrack(await this.trackFactory(), undefined, true)]
        : (await this.room.localParticipant.createScreenTracks({
        audio: grant.withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        resolution: { width: 0, height: 0 }, // 0 表示不设上限：按源的原始分辨率采集（livekit 默认会以 1080p 为理想值，可能放大）
        contentHint: effectiveIntent(intent, custom) === 'smoothness' ? 'motion' : 'detail',
        selfBrowserSurface: 'exclude', // 选择列表中不出现会议页面自己
        surfaceSwitching: 'include', // 共享中可以切换共享的标签页
        systemAudio: 'include',
        ...this.captureOverrides,
      })) as (LocalVideoTrack | LocalAudioTrack)[];
    } catch (e) {
      await this.release();
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') throw new ShareCancelled();
      throw e;
    }
    const video = tracks.find((t): t is LocalVideoTrack => t.kind === Track.Kind.Video);
    const audio = tracks.find((t): t is LocalAudioTrack => t.kind === Track.Kind.Audio);
    if (!video) {
      tracks.forEach((t) => t.stop());
      await this.release();
      throw new Error('no video track');
    }
    this.video = video;
    this.audio = audio ?? null;

    // 按原始分辨率采集后，只在超过上限时等比缩小（不放大）
    const native = video.mediaStreamTrack.getSettings();
    const maxW = limits?.maxWidth || 3840;
    const maxH = limits?.maxHeight || 2160;
    if (native.width && native.height && (native.width > maxW || native.height > maxH)) {
      const k = Math.min(maxW / native.width, maxH / native.height);
      const w = Math.round((native.width * k) / 2) * 2;
      const h = Math.round((native.height * k) / 2) * 2;
      await video.mediaStreamTrack.applyConstraints({ width: { ideal: w, max: w }, height: { ideal: h, max: h } }).catch(() => undefined);
    }
    const settings = video.mediaStreamTrack.getSettings();
    const source = { width: settings.width ?? 1920, height: settings.height ?? 1080 };
    encodeCaps ??= detectEncodeCaps(source.width, source.height);
    this.caps = await encodeCaps;
    const choice = this.chooseCodec(intent, custom);
    if (!choice) {
      tracks.forEach((t) => t.stop());
      this.video = this.audio = null;
      await this.release();
      throw new ShareUnsupported();
    }
    this.engine = new ScreenShareEngine({
      intent: INTENT[intent].engine,
      caps: {
        maxHeight: limits?.maxHeight || source.height,
        maxFps: limits?.maxFps || 60,
        maxKbps: limits?.maxBitrateBps ? limits.maxBitrateBps / 1000 : 8000,
      },
      source,
      codec: choice.codec,
      custom,
    });
    const p0 = this.engine.update({ t: performance.now(), changedAreaRatio: 0, changeFps: 0, uplinkKbps: 50_000, qualityLimitation: 'none' });

    video.mediaStreamTrack.contentHint = p0.contentHint;
    // 获得共享许可后，服务端异步把发布权限同步到 SFU：等权限生效再发布，否则画面已经就绪时会报「权限不足」
    await this.waitForScreenPermission();
    await this.publishVideo(video, choice, p0);
    if (audio) {
      // 共享声音：独立轨道，立体声音乐码率，关闭降噪和回声消除，不受麦克风静音影响
      await this.room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: false, red: false, audioPreset: { maxBitrate: 128_000 } });
    }
    video.on(TrackEvent.Ended, () => void this.stop()); // 浏览器自带的「停止共享」
    this.applied = null;
    await this.apply(p0);
    this.status = { intent, custom, withAudio: !!audio, codec: choice.codec, backupCodec: choice.backup, source, params: p0 };
    this.onStatus(this.status);
    this.analyzer = new ChangeAnalyzer(video.mediaStreamTrack);
    this.timer = setInterval(() => void this.tick(), 500);
  }

  /**
   * 共享中切换意图（切到自定义时给出参数）：引擎立即切换，并通知服务端（观众端显示）。
   * 自定义里指定的编码器与当前的不同时（或从自定义切回其他模式）换编码器：重新发布视频轨道，对方的画面会中断一下
   */
  async setIntent(intent: ShareIntentName, custom?: CustomShare): Promise<void> {
    if (!this.engine || !this.status) return;
    custom ??= this.status.custom;
    if (intent === 'custom' && !custom) return;
    const changedIntent = intent !== this.status.intent;
    this.engine.setIntent(INTENT[intent].engine, performance.now(), custom);
    this.status = { ...this.status, intent, custom };
    this.onStatus(this.status);
    if (changedIntent) await this.client.requestScreenShare(INTENT[intent].proto, this.status.withAudio).catch(() => undefined);
    const next = this.chooseCodec(intent, custom);
    if (next && next.codec !== this.status.codec) await this.republish(next);
    await this.tick();
  }

  private async waitForScreenPermission(timeoutMs = 5000) {
    const lp = this.room.localParticipant;
    const allowed = () => (lp.permissions?.canPublishSources ?? []).includes(3 /* TrackSource.SCREEN_SHARE */);
    if (allowed()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.room.off(RoomEvent.ParticipantPermissionsChanged, check);
        resolve();
      };
      const check = () => allowed() && done();
      const timer = setTimeout(done, timeoutMs); // 超时也继续：发布失败会按原来的方式报错
      this.room.on(RoomEvent.ParticipantPermissionsChanged, check);
    });
  }

  /** 按共享开始时的许可（房间可解码集合、策略、是否加密）选编码器；自定义时优先用用户指定的 */
  private chooseCodec(intent: ShareIntentName, custom?: CustomShare): CodecChoice | null {
    const grant = this.grant;
    if (!grant || !this.caps) return null;
    return chooseShareCodec({
      caps: this.caps,
      roomDecodable: grant.roomDecodable.length ? grant.roomDecodable : ['video/h264', 'video/vp8'],
      policy: grant.codecMode === CodecMode.COMPAT ? 'compat' : 'auto', // 旧服务器的 QUALITY 按自动处理
      e2ee: grant.e2ee,
      prefer: intent === 'custom' ? custom?.codec : null,
    });
  }

  private async publishVideo(video: LocalVideoTrack, choice: CodecChoice, p: ShareParams) {
    await this.room.localParticipant.publishTrack(video, {
      source: Track.Source.ScreenShare,
      videoCodec: choice.codec as VideoCodec,
      backupCodec: choice.backup ? { codec: choice.backup } : false,
      simulcast: false,
      screenShareEncoding: { maxBitrate: p.maxKbps * 1000, maxFramerate: p.fps },
      degradationPreference: p.degradationPreference,
      // AV1 / VP9：时间分层，SFU 可以只给带宽不足的观众转发部分帧（分辨率不变、只降帧率，对文字最友好）
      scalabilityMode: choice.codec === 'av1' || choice.codec === 'vp9' ? 'L1T3' : undefined,
    });
  }

  /** 换编码器：取消发布（不停止采集）→ 用新编码器重新发布同一条轨道 */
  private async republish(choice: CodecChoice) {
    const video = this.video;
    const engine = this.engine;
    if (!video || !engine || !this.status || this.republishing) return;
    this.republishing = true;
    try {
      await this.room.localParticipant.unpublishTrack(video, false);
      engine.codec = choice.codec;
      await this.publishVideo(video, choice, this.status.params);
      this.applied = null;
      this.lastStatsAt = 0;
      this.status = { ...this.status, codec: choice.codec, backupCodec: choice.backup };
      this.onStatus(this.status);
    } finally {
      this.republishing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.analyzer?.stop();
    this.analyzer = null;
    for (const t of [this.video, this.audio]) {
      if (!t) continue;
      await this.room.localParticipant.unpublishTrack(t, true).catch(() => undefined);
      t.stop();
    }
    this.video = this.audio = null;
    this.engine = null;
    this.status = null;
    this.onStatus(null);
    await this.release();
    this.stopping = false;
  }

  private async release() {
    const g = this.grant;
    this.grant = null;
    if (g) await this.client.releaseScreenShare(g.grantId).catch(() => undefined);
  }

  private async tick() {
    const engine = this.engine;
    const video = this.video;
    if (!engine || !video || !this.analyzer || this.republishing) return;
    let limitation: QualityLimitation = 'none';
    let uplinkKbps = 50_000;
    let sent: ShareStatus['sent'];
    let rttMs: number | undefined;
    let targetKbps: number | undefined;
    let availKbps: number | undefined;
    try {
      const report = await video.sender?.getStats();
      // 选中的候选地址对：优先按 transport 的 selectedCandidatePairId 找（有的候选对没有 nominated 标记）
      let selectedPair: string | undefined;
      report?.forEach((s: Record<string, unknown>) => {
        if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') selectedPair = s.selectedCandidatePairId;
      });
      report?.forEach((s: Record<string, unknown>) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          const r = s.qualityLimitationReason as string | undefined;
          if (r === 'cpu' || r === 'bandwidth' || r === 'other') limitation = r;
          const now = performance.now();
          const bytes = Number(s.bytesSent ?? 0);
          const kbps = this.lastStatsAt ? ((bytes - this.lastBytes) * 8) / (now - this.lastStatsAt) : 0;
          this.lastBytes = bytes;
          this.lastStatsAt = now;
          sent = { width: Number(s.frameWidth ?? 0), height: Number(s.frameHeight ?? 0), fps: Number(s.framesPerSecond ?? 0), kbps: Math.round(kbps) };
          if (typeof s.targetBitrate === 'number') targetKbps = s.targetBitrate / 1000;
        }
        if (s.type === 'candidate-pair' && (selectedPair ? s.id === selectedPair : s.nominated) && typeof s.availableOutgoingBitrate === 'number') {
          availKbps = s.availableOutgoingBitrate / 1000;
        }
        // 往返时间用接收报告（约每秒一次）里的值：候选地址对的往返时间要 5 秒左右才更新一次
        if (s.type === 'remote-inbound-rtp' && s.kind === 'video' && typeof s.roundTripTime === 'number') rttMs = s.roundTripTime * 1000;
      });
    } catch {
      // 统计不可用：按无限制处理
    }
    // 带宽估计：优先用可用上行带宽；拿不到时用编码器的目标码率（WebRTC 按带宽估计设定，受带宽限制时就是估计值）
    uplinkKbps = availKbps ?? targetKbps ?? uplinkKbps;
    const signals = { ...this.analyzer.signals(), uplinkKbps, qualityLimitation: limitation, rttMs, sentKbps: sent?.kbps };
    const p = engine.update({ t: performance.now(), ...signals });
    await this.apply(p);
    if (this.status) {
      this.status = { ...this.status, params: p, sent, signals };
      this.onStatus(this.status);
    }
  }

  /** 把引擎参数应用到发送端：码率、帧率、缩放、降级偏好、内容提示（不重新协商、不中断画面） */
  private async apply(p: ShareParams) {
    const a = this.applied;
    if (a && a.width === p.width && a.height === p.height && a.fps === p.fps && a.maxKbps === p.maxKbps && a.degradationPreference === p.degradationPreference) return;
    const video = this.video;
    const sender = video?.sender;
    if (!video || !sender) return;
    const srcH = video.mediaStreamTrack.getSettings().height ?? p.height;
    const params = sender.getParameters();
    for (const enc of params.encodings ?? []) {
      enc.maxBitrate = p.maxKbps * 1000;
      enc.maxFramerate = p.fps;
      enc.scaleResolutionDownBy = Math.max(1, srcH / p.height);
    }
    (params as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = p.degradationPreference;
    try {
      await sender.setParameters(params);
      video.mediaStreamTrack.contentHint = p.contentHint;
      this.applied = p;
    } catch {
      // 参数暂时不可用（例如协商中）：下个周期再试
    }
  }
}
