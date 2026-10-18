// 控制协议客户端：握手鉴权、请求 / 响应、事件归并到状态、心跳、断线自动恢复。
// 不依赖任何 UI 和平台 API（WebSocket 由调用方注入，默认使用全局 WebSocket），可在 Node 中测试。

import {
  SignedPublicKeySchema,
  AddBanSchema,
  CloseRoomSchema,
  CreateInviteSchema,
  CreateRoomSchema,
  GetAuditLogSchema,
  ListBansSchema,
  ListIdentitiesSchema,
  ListInvitesSchema,
  ModerateSchema,
  ModerationAction,
  MoveParticipantSchema,
  MuteAllSchema,
  RecallAllSchema,
  RemoveBanSchema,
  RevokeInviteSchema,
  RoomOverridesSchema,
  SetRoleSchema,
  UpdateRoomSchema,
  type AuditEntry,
  type BanInfo,
  type CreateRoomResult,
  type Identity,
  type InviteInfo,
  type KeyPackage,
  type Room,
  type RoomOverrides,
  CapabilitiesSchema,
  ClientAuthSchema,
  CodecCapabilitySchema,
  ReleaseScreenShareSchema,
  JoinShareMediaSchema,
  ShareTransport,
  RequestScreenShareSchema,
  ShareIntent,
  CreateTokenSchema,
  ListTokensSchema,
  RevokeTokenSchema,
  ClientHelloSchema,
  ClientInfoSchema,
  ErrorCode,
  EnvelopeSchema,
  GetChatHistorySchema,
  GetSettingsSchema,
  JoinRoomSchema,
  RedeemTokenSchema,
  SendChatSchema,
  UpdateSelfSchema,
  UpdateSettingsSchema,
  PingSchema,
  Platform,
  PROTOCOL_VERSION,
  RequestSchema,
  Role,
  SUBPROTOCOL,
  create,
  fromBinary,
  toBinary,
  type ChatMessage,
  type Envelope,
  type Event,
  type JoinRoomResult,
  type MediaGrant,
  type Request,
  type Response,
  type ScreenShareGrant,
  type ServerChallenge,
  type TokenInfo,
  type Welcome,
} from '@hane/protocol';
import type { IdentityStore, TrustStore } from '@hane/platform';
import { controlUrl, hostPort, mediaUrl, parseAddress, type ServerAddress } from './address';
import { LocalErrorCode, HaneError, isFatal } from './errors';
import { e2eeKeySigInput, generateKeyExchange, type KeyExchange } from './e2ee';
import { authSigInput, deriveIdentity, sign, toHex, type ServerIdentity } from './identity';
import { createClientStore, initialState, mergeChat, snapshotState, type ClientStore } from './state';

type RequestBody = Request['body'];
type ResponseBody = Response['body'];
type ResultOf<C extends NonNullable<RequestBody['case']>> = Extract<ResponseBody, { case: C }>['value'];

export interface ClientOptions {
  identity: IdentityStore;
  trust?: TrustStore;
  appVersion: string;
  platform: Platform;
  osVersion?: string;
  deviceName?: string;
  /**
   * 本机能解码的视频编码器（mime）和能否硬件解码，上报给服务端计算房间可解码集合，
   * 以及在自定义共享选编码器时提示谁不能硬件解码。hardware 未知（还没探测完）时为 undefined
   */
  videoDecodeCaps?: () => { mime: string; hardware?: boolean }[];
  /** 媒体层是否支持端到端加密（由 @hane/media 提供） */
  e2eeSupported?: () => boolean;
  /** 默认使用全局 WebSocket */
  webSocket?: (url: string, protocols: string[]) => WebSocket;
  /** 时间与定时器（测试时可替换） */
  now?: () => number;
  log?: (msg: string, ...args: unknown[]) => void;
}

export interface ConnectParams {
  address: string;
  nickname: string;
  password?: string;
  /** 通过邀请链接进入（免服务器密码、可附带角色） */
  inviteCode?: string;
}

/** 创建 / 修改房间的选项 */
export interface RoomOptions {
  name?: string;
  /** 空字符串表示取消密码 */
  password?: string;
  locked?: boolean;
  capacity?: number;
  overrides?: Partial<Pick<RoomOverrides, 'screenModeratorOnly' | 'cameraModeratorOnly' | 'e2ee' | 'audioMaxKbps'>>;
  emptyTimeoutSec?: number;
}

const HANDSHAKE_TIMEOUT = 10_000;
const REQUEST_TIMEOUT = 10_000;
const PING_INTERVAL = 15_000;
const IDLE_TIMEOUT = 45_000;
const ZERO_SPKI = new Uint8Array(32);

/** 重连退避：0.5、1、2、4……最长 30 秒，叠加 ±20% 抖动 */
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: HaneError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OpenHaneClient {
  readonly store: ClientStore = createClientStore();

  private ws: WebSocket | null = null;
  private params: ConnectParams | null = null;
  private address: ServerAddress | null = null;
  private identity: ServerIdentity | null = null;
  private resumeTicket: Uint8Array | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRx = 0;
  private closedByUser = false;
  private generation = 0; // 每次新建连接加一，旧连接的回调据此忽略
  private listeners = new Set<(ev: Event) => void>();
  /** 端到端加密的密钥包：密钥管理器开始接收之前到达的先存起来（见 setKeyPackageSink） */
  private keyInbox: KeyPackage[] = [];
  private keySink: ((k: KeyPackage) => void) | null = null;

  constructor(private readonly opt: ClientOptions) {}

  private get now(): number {
    return (this.opt.now ?? Date.now)();
  }

  private log(msg: string, ...args: unknown[]) {
    this.opt.log?.(msg, ...args);
  }

  /** 订阅原始事件（UI 用于提示音、通知等；状态更新请订阅 store）。 */
  onEvent(fn: (ev: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 接收发给自己的 E2EE 密钥包。新成员进入加密房间时，其他人立即发出的密钥包可能在本地媒体连接建立、
   * 密钥管理器开始接收之前就到了：这些包先存起来，设置接收者时按房间交给它。返回取消函数。
   */
  setKeyPackageSink(roomId: string, fn: (k: KeyPackage) => void): () => void {
    this.keySink = fn;
    const held = this.keyInbox.filter((k) => k.roomId === roomId);
    this.keyInbox = [];
    for (const k of held) fn(k);
    return () => {
      if (this.keySink === fn) this.keySink = null;
    };
  }

  /** 连接服务器。成功收到 Welcome 后 resolve；被拒绝时 reject（HaneError）。 */
  async connect(params: ConnectParams): Promise<void> {
    this.disconnect();
    this.closedByUser = false;
    this.params = params;
    this.address = parseAddress(params.address);
    this.identity = null;
    this.resumeTicket = null;
    this.store.setState({ ...initialState, status: 'connecting', address: this.address });
    // 每次连接一把新的密钥交换密钥；运行环境不支持 X25519（旧浏览器）时不声明 E2EE 能力
    this.keyExchange = await generateKeyExchange().catch(() => null);
    this.keyInbox = [];
    try {
      await this.open();
    } catch (e) {
      const err = e instanceof HaneError ? e : new HaneError(LocalErrorCode.UNREACHABLE, String(e));
      if (!this.closedByUser) this.store.setState({ status: 'failed', error: err });
      throw err;
    }
  }

  /** 用上一次的参数重新连接（例如用户确认了新的证书指纹之后）。 */
  async reconnect(): Promise<void> {
    if (!this.params) throw new HaneError(LocalErrorCode.UNREACHABLE, 'never connected');
    await this.connect(this.params);
  }

  /** 应用版本（上报给服务端，连接页也会显示）。 */
  get appVersion(): string {
    return this.opt.appVersion;
  }

  /** 上一次连接使用的参数（不含密码）。 */
  get lastParams(): Omit<ConnectParams, 'password'> | null {
    return this.params ? { address: this.params.address, nickname: this.params.nickname } : null;
  }

  /** 主动断开（离开）。 */
  disconnect(): void {
    this.closedByUser = true;
    this.generation++;
    this.clearTimers();
    this.failPending(new HaneError(LocalErrorCode.CONNECTION_LOST, 'disconnected'));
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    if (this.store.getState().status !== 'idle') this.store.setState({ ...initialState });
  }

  // ---------- 连接与握手 ----------

  private async open(): Promise<Welcome> {
    const allowed = (await this.opt.trust?.beforeConnect?.(hostPort(this.address!))) ?? true;
    if (!allowed) throw new HaneError(LocalErrorCode.FINGERPRINT_CHANGED, 'certificate fingerprint changed');
    return this.openSocket();
  }

  private openSocket(): Promise<Welcome> {
    const gen = ++this.generation;
    const address = this.address!;
    const url = controlUrl(address);
    const factory = this.opt.webSocket ?? ((u: string, p: string[]) => new WebSocket(u, p));
    return new Promise<Welcome>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = factory(url, [SUBPROTOCOL]);
      } catch (e) {
        reject(new HaneError(LocalErrorCode.UNREACHABLE, String(e)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let phase: 'hello' | 'auth' | 'ready' = 'hello';
      const timer = setTimeout(() => {
        reject(new HaneError(LocalErrorCode.TIMEOUT, 'handshake timeout'));
        ws.close();
      }, HANDSHAKE_TIMEOUT);

      ws.onopen = () => {
        const decodeCaps = this.opt.videoDecodeCaps?.() ?? [];
        this.send({
          case: 'clientHello',
          value: create(ClientHelloSchema, {
            protocolVersion: PROTOCOL_VERSION,
            client: create(ClientInfoSchema, {
              appVersion: this.opt.appVersion,
              platform: this.opt.platform,
              osVersion: this.opt.osVersion ?? '',
              deviceName: this.opt.deviceName ?? '',
            }),
            resumeTicket: this.resumeTicket ?? new Uint8Array(),
            inviteCode: this.params?.inviteCode ?? this.address?.invite ?? '',
            caps: create(CapabilitiesSchema, {
              codecs: decodeCaps.map((c) => create(CodecCapabilitySchema, { mime: c.mime, decode: true, hardware: c.hardware ?? false })),
              hardwareReported: decodeCaps.length > 0 && decodeCaps.every((c) => c.hardware !== undefined),
              // 能进入端到端加密的房间：有密钥交换密钥，且媒体层支持帧加密（Insertable Streams / RTCRtpScriptTransform）
              e2ee: !!this.keyExchange && (this.opt.e2eeSupported?.() ?? false),
            }),
          }),
        });
      };

      ws.onmessage = async (msg) => {
        if (gen !== this.generation) return;
        this.lastRx = this.now;
        let env: Envelope;
        try {
          env = fromBinary(EnvelopeSchema, new Uint8Array(msg.data as ArrayBuffer));
        } catch {
          return;
        }
        if (phase === 'ready') {
          this.dispatch(env);
          return;
        }
        const m = env.msg;
        if (m.case === 'goodbye') {
          clearTimeout(timer);
          reject(HaneError.fromProto(m.value.error));
          return;
        }
        if (phase === 'hello' && m.case === 'serverChallenge') {
          phase = 'auth';
          try {
            await this.answerChallenge(m.value);
          } catch (e) {
            clearTimeout(timer);
            reject(e instanceof HaneError ? e : new HaneError(LocalErrorCode.PROTOCOL, String(e)));
            ws.close();
          }
          return;
        }
        if (phase === 'auth' && m.case === 'welcome') {
          clearTimeout(timer);
          phase = 'ready';
          this.onWelcome(m.value);
          resolve(m.value);
          return;
        }
        clearTimeout(timer);
        reject(new HaneError(LocalErrorCode.PROTOCOL, `unexpected ${m.case} during handshake`));
        ws.close();
      };

      ws.onerror = () => {
        // 细节在 onclose 中处理
      };

      ws.onclose = (ev) => {
        if (gen !== this.generation) return;
        clearTimeout(timer);
        this.ws = null;
        if (phase !== 'ready') {
          reject(new HaneError(LocalErrorCode.UNREACHABLE, `connection closed (${ev.code})`));
          return;
        }
        this.onConnectionLost();
      };
    });
  }

  private async answerChallenge(ch: ServerChallenge): Promise<void> {
    const seed = await this.opt.identity.getMasterSeed();
    if (!this.identity || this.store.getState().serverId !== toHex(ch.serverId)) {
      this.identity = await deriveIdentity(seed, ch.serverId);
    }
    this.store.setState({ serverId: toHex(ch.serverId), serverInfo: ch.info ?? null });
    const seen = (await this.opt.trust?.seenSpki(hostPort(this.address!))) ?? ZERO_SPKI;
    const ts = BigInt(this.now);
    const signature = await sign(this.identity.privateKey, authSigInput(ch.serverId, ch.nonce, seen, ts));
    this.send({
      case: 'clientAuth',
      value: create(ClientAuthSchema, {
        publicKey: this.identity.publicKey,
        signature,
        seenSpkiSha256: seen,
        timestampMs: ts,
        nickname: this.params!.nickname,
        serverPassword: this.params!.password ?? '',
        e2eeKey: this.keyExchange
          ? create(SignedPublicKeySchema, { publicKey: this.keyExchange.publicKey, signature: await sign(this.identity.privateKey, e2eeKeySigInput(this.keyExchange.publicKey)) })
          : undefined,
      }),
    });
  }

  /** 本次连接的 X25519 密钥交换密钥（端到端加密）；运行环境不支持 X25519 时为 null */
  keyExchange: KeyExchange | null = null;

  private onWelcome(w: Welcome) {
    this.resumeTicket = w.resumeTicket;
    const prev = this.store.getState();
    const snap = snapshotState(w.snapshot);
    this.store.setState({
      status: 'connected',
      error: null,
      attempt: 0,
      ...snap,
      self: { sessionId: w.sessionId, uid: w.uid, nickname: w.nickname, role: w.role },
      // 恢复会话时保留已加载的聊天，随后补拉最新一页
      chat: w.resumed ? prev.chat : {},
      chatHasMore: w.resumed ? prev.chatHasMore : {},
    });
    this.applyJoin(w.autoJoin);
    this.startHeartbeat();
    const room = w.autoJoin?.roomId;
    if (room) void this.loadChatHistory(room).catch(() => undefined);
    this.log(w.resumed ? 'session resumed' : 'connected', w.sessionId);
  }

  private applyJoin(r: JoinRoomResult | undefined) {
    if (!r) return;
    const prev = this.store.getState().media;
    this.store.setState({
      media: {
        roomId: r.roomId,
        url: r.media?.url || mediaUrl(this.address!),
        grant: r.media,
        policy: r.policy ?? prev?.policy,
        version: (prev?.version ?? 0) + 1,
      },
    });
  }

  private onConnectionLost() {
    this.clearTimers();
    this.failPending(new HaneError(LocalErrorCode.CONNECTION_LOST, 'connection lost'));
    if (this.closedByUser) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const attempt = this.store.getState().attempt + 1;
    this.store.setState({ status: 'reconnecting', attempt });
    const delay = backoffMs(attempt);
    this.log('reconnecting', { attempt, delay });
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        await this.open();
      } catch (e) {
        const err = e instanceof HaneError ? e : new HaneError(LocalErrorCode.UNREACHABLE, String(e));
        if (this.closedByUser) return;
        if (isFatal(err.code)) {
          this.store.setState({ status: 'failed', error: err });
          return;
        }
        this.store.setState({ error: err });
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** 网络恢复时立即重试（例如浏览器 online 事件）。 */
  retryNow(): void {
    if (this.store.getState().status !== 'reconnecting' || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.store.setState({ attempt: 0 });
    void this.open().catch(() => this.scheduleReconnect());
  }

  private startHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lastRx = this.now;
    this.pingTimer = setInterval(() => {
      if (this.now - this.lastRx > IDLE_TIMEOUT) {
        this.log('control connection idle, reconnecting');
        this.ws?.close();
        return;
      }
      this.send({ case: 'ping', value: create(PingSchema, { clientTimeMs: BigInt(this.now) }) });
    }, PING_INTERVAL);
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.retryTimer = null;
  }

  private failPending(err: HaneError) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(msg: Envelope['msg']) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, { msg })));
    return true;
  }

  // ---------- 收到的消息 ----------

  private dispatch(env: Envelope) {
    const m = env.msg;
    switch (m.case) {
      case 'response': {
        const p = this.pending.get(m.value.id);
        if (!p) return;
        this.pending.delete(m.value.id);
        clearTimeout(p.timer);
        if (m.value.error) p.reject(HaneError.fromProto(m.value.error));
        else p.resolve(m.value);
        return;
      }
      case 'event':
        this.applyEvent(m.value);
        if (m.value.body.case === 'keyPackage') {
          const k = m.value.body.value;
          if (this.keySink) this.keySink(k);
          else this.keyInbox = [...this.keyInbox.slice(-63), k];
        }
        for (const fn of this.listeners) fn(m.value);
        return;
      case 'pong':
        this.store.setState({ rttMs: this.now - Number(m.value.clientTimeMs) });
        return;
      case 'goodbye': {
        const err = HaneError.fromProto(m.value.error);
        this.log('goodbye', err.code, err.message);
        if (!m.value.reconnect) {
          // 被踢、被封禁、会话被替换：不再重连
          this.closedByUser = true;
          this.generation++;
          this.clearTimers();
          this.failPending(err);
          this.ws?.close();
          this.ws = null;
          this.store.setState({ status: 'failed', error: err });
        } else {
          this.store.setState({ error: err }); // 例如服务器重启：随后的 onclose 触发自动重连
        }
        return;
      }
    }
  }

  private applyEvent(ev: Event) {
    const s = this.store.getState();
    const b = ev.body;
    switch (b.case) {
      case 'participantJoined':
      case 'participantUpdated': {
        const p = b.value.participant;
        if (!p) return;
        const patch: Partial<typeof s> = { participants: { ...s.participants, [p.sessionId]: p } };
        if (s.self && p.sessionId === s.self.sessionId) {
          patch.self = { ...s.self, nickname: p.nickname, role: p.role };
        }
        this.store.setState(patch);
        return;
      }
      case 'participantLeft': {
        const { [b.value.sessionId]: _gone, ...rest } = s.participants;
        this.store.setState({ participants: rest });
        return;
      }
      case 'roomCreated':
      case 'roomUpdated':
        if (b.value.room) this.store.setState({ rooms: { ...s.rooms, [b.value.room.id]: b.value.room } });
        return;
      case 'roomClosed': {
        const { [b.value.roomId]: _closed, ...rest } = s.rooms;
        this.store.setState({ rooms: rest });
        return;
      }
      case 'chatMessage':
        this.store.setState({ chat: { ...s.chat, [b.value.roomId]: mergeChat(s.chat[b.value.roomId], [b.value]) } });
        return;
      case 'roleChanged':
        if (s.self && b.value.uid === s.self.uid) this.store.setState({ self: { ...s.self, role: b.value.role } });
        return;
      case 'policyUpdated':
        if (s.media && b.value.roomId === s.media.roomId) this.store.setState({ media: { ...s.media, policy: b.value.policy } });
        return;
      case 'shareStateChanged': {
        const room = s.rooms[b.value.roomId];
        if (room) this.store.setState({ rooms: { ...s.rooms, [room.id]: { ...room, shares: b.value.shares } } });
        return;
      }
      case 'serverInfoUpdated':
        this.store.setState({ serverInfo: b.value.info ?? s.serverInfo });
        return;
      case 'youWereMoved':
        // 被移动、移出房间、房间关闭：事件附带新房间的媒体令牌，媒体会话据此直接切换
        this.applyJoin(b.value.joined);
        return;
    }
  }

  // ---------- 请求 ----------

  /** 发送请求并等待响应；失败时 reject HaneError。 */
  async request<C extends NonNullable<RequestBody['case']>>(
    body: Extract<RequestBody, { case: C }>,
  ): Promise<ResultOf<C>> {
    const id = this.nextId++;
    const resp = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaneError(LocalErrorCode.TIMEOUT, 'request timeout'));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ case: 'request', value: create(RequestSchema, { id, body }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HaneError(LocalErrorCode.CONNECTION_LOST, 'not connected'));
      }
    });
    return resp.body.value as ResultOf<C>;
  }

  /** 获取当前房间的新媒体令牌（媒体需要重连而令牌已过期时调用）。 */
  async refreshMedia(): Promise<MediaGrant | undefined> {
    const room = this.store.getState().media?.roomId ?? 'main';
    const r = await this.request({ case: 'joinRoom', value: create(JoinRoomSchema, { roomId: room }) });
    this.applyJoin(r);
    return r.media;
  }

  async updateSelf(patch: { micMuted?: boolean; deafened?: boolean; handRaised?: boolean; away?: boolean; nickname?: string }) {
    return this.request({ case: 'updateSelf', value: create(UpdateSelfSchema, patch) });
  }

  async sendChat(text: string, replyTo = 0n): Promise<ChatMessage | undefined> {
    const s = this.store.getState();
    const roomId = s.media?.roomId ?? 'main';
    const clientMsgId = crypto.randomUUID();
    const r = await this.request({
      case: 'sendChat',
      value: create(SendChatSchema, { roomId, text, clientMsgId, replyTo }),
    });
    if (r.message) {
      const st = this.store.getState();
      this.store.setState({ chat: { ...st.chat, [roomId]: mergeChat(st.chat[roomId], [r.message]) } });
    }
    return r.message;
  }

  /** 加载 beforeId 之前的一页聊天（0 表示最新一页），合并进状态。 */
  async loadChatHistory(roomId: string, beforeId = 0n, limit = 50): Promise<void> {
    const r = await this.request({
      case: 'getChatHistory',
      value: create(GetChatHistorySchema, { roomId, beforeId, limit }),
    });
    const s = this.store.getState();
    const patch: Partial<typeof s> = { chat: { ...s.chat, [roomId]: mergeChat(s.chat[roomId], r.messages) } };
    // 只有翻页（或首次加载）时更新「是否还有更早」
    if (beforeId !== 0n || s.chatHasMore[roomId] === undefined) patch.chatHasMore = { ...s.chatHasMore, [roomId]: r.hasMore };
    this.store.setState(patch);
  }

  async redeemToken(token: string): Promise<Role> {
    const r = await this.request({ case: 'redeemToken', value: create(RedeemTokenSchema, { token }) });
    return r.role;
  }

  async getSettings(): Promise<Record<string, string>> {
    return (await this.request({ case: 'getSettings', value: create(GetSettingsSchema) })).values;
  }

  async updateSettings(patch: Record<string, string>): Promise<Record<string, string>> {
    return (await this.request({ case: 'updateSettings', value: create(UpdateSettingsSchema, { patch }) })).values;
  }

  /** 申请屏幕共享许可（获得后 SFU 才允许发布屏幕轨道）；重复申请会更新意图并沿用同一个许可。 */
  async requestScreenShare(intent: ShareIntent, withAudio: boolean): Promise<ScreenShareGrant> {
    return this.request({ case: 'requestScreenShare', value: create(RequestScreenShareSchema, { intent, withAudio }) });
  }

  /**
   * 共享连接的媒体令牌：屏幕共享单独走一条媒体连接（<房间 ID>~share），自己要共享、或者房间里有人在共享时请求。
   * 获得共享许可之前只能订阅，获得许可后服务端把发布权限同步到 SFU
   */
  async joinShareMedia(transport: ShareTransport = ShareTransport.UNSPECIFIED): Promise<{ url: string; token: string; tcp: boolean }> {
    const g = await this.request({ case: 'joinShareMedia', value: create(JoinShareMediaSchema, { transport }) });
    return { url: g.url || mediaUrl(this.address!), token: g.token, tcp: g.tcp };
  }

  async releaseScreenShare(grantId: string): Promise<void> {
    await this.request({ case: 'releaseScreenShare', value: create(ReleaseScreenShareSchema, { grantId }) });
  }

  /** 创建权限令牌；返回的明文只出现这一次。 */
  async createToken(role: Role, maxUses: number, expiresInSec = 0, note = ''): Promise<{ token: string; info: TokenInfo | undefined }> {
    const r = await this.request({ case: 'createToken', value: create(CreateTokenSchema, { role, maxUses, expiresInSec, note }) });
    return { token: r.token, info: r.info };
  }

  async listTokens(): Promise<TokenInfo[]> {
    return (await this.request({ case: 'listTokens', value: create(ListTokensSchema) })).tokens;
  }

  async revokeToken(id: string): Promise<void> {
    await this.request({ case: 'revokeToken', value: create(RevokeTokenSchema, { id }) });
  }

  // ---------- 房间 ----------

  /** 进入或切换房间。有密码的房间需要密码（主持人以上免密）。 */
  async joinRoom(roomId: string, password = ''): Promise<void> {
    const r = await this.request({ case: 'joinRoom', value: create(JoinRoomSchema, { roomId, password }) });
    this.applyJoin(r);
  }

  async createRoom(o: RoomOptions & { name: string; join?: boolean }): Promise<CreateRoomResult> {
    const r = await this.request({
      case: 'createRoom',
      value: create(CreateRoomSchema, {
        name: o.name,
        password: o.password ?? '',
        locked: o.locked ?? false,
        capacity: o.capacity ?? 0,
        overrides: create(RoomOverridesSchema, o.overrides ?? {}),
        emptyTimeoutSec: o.emptyTimeoutSec,
        join: o.join ?? false,
      }),
    });
    if (r.joined) this.applyJoin(r.joined);
    return r;
  }

  async updateRoom(roomId: string, o: RoomOptions): Promise<Room | undefined> {
    const r = await this.request({
      case: 'updateRoom',
      value: create(UpdateRoomSchema, {
        roomId,
        name: o.name,
        password: o.password,
        locked: o.locked,
        capacity: o.capacity,
        overrides: o.overrides ? create(RoomOverridesSchema, o.overrides) : undefined,
        emptyTimeoutSec: o.emptyTimeoutSec,
      }),
    });
    return r.room;
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.request({ case: 'closeRoom', value: create(CloseRoomSchema, { roomId }) });
  }

  async moveParticipant(sessionId: string, roomId: string): Promise<void> {
    await this.request({ case: 'moveParticipant', value: create(MoveParticipantSchema, { sessionId, roomId }) });
  }

  async recallAll(): Promise<number> {
    return (await this.request({ case: 'recallAll', value: create(RecallAllSchema) })).moved;
  }

  // ---------- 主持操作 ----------

  async moderate(sessionId: string, action: ModerationAction, o: { reason?: string; durationSec?: number; banIp?: boolean } = {}): Promise<void> {
    await this.request({
      case: 'moderate',
      value: create(ModerateSchema, { sessionId, action, reason: o.reason ?? '', durationSec: o.durationSec ?? 0, banIp: o.banIp ?? false }),
    });
  }

  async muteAll(roomId: string): Promise<number> {
    return (await this.request({ case: 'muteAll', value: create(MuteAllSchema, { roomId }) })).muted;
  }

  // ---------- 管理员 ----------

  async listIdentities(role: Role = Role.UNSPECIFIED, limit = 100, offset = 0): Promise<{ identities: Identity[]; total: number }> {
    const r = await this.request({ case: 'listIdentities', value: create(ListIdentitiesSchema, { role, limit, offset }) });
    return { identities: r.identities, total: r.total };
  }

  async setRole(uid: string, role: Role): Promise<void> {
    await this.request({ case: 'setRole', value: create(SetRoleSchema, { uid, role }) });
  }

  async listBans(): Promise<BanInfo[]> {
    return (await this.request({ case: 'listBans', value: create(ListBansSchema) })).bans;
  }

  async addBan(o: { uid?: string; ipCidr?: string; durationSec?: number; reason?: string }): Promise<{ ban: BanInfo | undefined; kicked: number }> {
    const r = await this.request({ case: 'addBan', value: create(AddBanSchema, { uid: o.uid ?? '', ipCidr: o.ipCidr ?? '', durationSec: o.durationSec ?? 0, reason: o.reason ?? '' }) });
    return { ban: r.ban, kicked: r.kicked };
  }

  async removeBan(id: bigint): Promise<void> {
    await this.request({ case: 'removeBan', value: create(RemoveBanSchema, { id }) });
  }

  async auditLog(o: { beforeId?: bigint; limit?: number; actionPrefix?: string; actorUid?: string } = {}): Promise<{ entries: AuditEntry[]; hasMore: boolean }> {
    const r = await this.request({
      case: 'getAuditLog',
      value: create(GetAuditLogSchema, { beforeId: o.beforeId ?? 0n, limit: o.limit ?? 100, actionPrefix: o.actionPrefix ?? '', actorUid: o.actorUid ?? '' }),
    });
    return { entries: r.entries, hasMore: r.hasMore };
  }

  async createInvite(o: { maxUses?: number; expiresInSec?: number; bypassPassword?: boolean; role?: Role }): Promise<InviteInfo | undefined> {
    const r = await this.request({
      case: 'createInvite',
      value: create(CreateInviteSchema, { maxUses: o.maxUses ?? 0, expiresInSec: o.expiresInSec ?? 0, bypassPassword: o.bypassPassword ?? false, role: o.role ?? Role.MEMBER }),
    });
    return r.invite;
  }

  async listInvites(): Promise<InviteInfo[]> {
    return (await this.request({ case: 'listInvites', value: create(ListInvitesSchema) })).invites;
  }

  async revokeInvite(code: string): Promise<void> {
    await this.request({ case: 'revokeInvite', value: create(RevokeInviteSchema, { code }) });
  }
}
