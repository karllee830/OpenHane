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
  GetSessionInfoSchema,
  DownloadIPv6GeoDBSchema,
  UpdateRoomSchema,
  type AuditEntry,
  type BanInfo,
  type GetSessionInfoResult,
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
  ChatPlaintextSchema,
  EncryptedImageKeySchema,
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
  type EncryptedChat,
  type EncryptedImageKey,
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
import { candidateAddresses, controlUrl, hostPort, httpBase, mediaUrl, parseAddress, type ServerAddress } from './address';
import { CHAT_IMAGE_FETCH_MAX, ChatImageError, downloadRanged, isImageId, isRoomId, sniffImage, uploadChunked, validSize, type TransferPacer } from './images';
import { firstByPriority } from './dial';
import { LocalErrorCode, HaneError, isFatal } from './errors';
import { e2eeKeySigInput, generateKeyExchange, openChatImage, sealChatImage, type KeyExchange } from './e2ee';
import { authSigInput, deriveIdentity, sign, toHex, type ServerIdentity } from './identity';
import { withCleanName } from './names';
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
/** 同时尝试多个端口时，排在后面的先连上后再等排在前面的多久 */
const PORT_GRACE = 500;
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

/**
 * 端到端加密房间里聊天的加解密，由媒体层的密钥管理器提供（它持有自己和各成员的媒体密钥）。
 * 正文是 ChatPlaintext 的编码，见 proto 的 EncryptedChat。
 */
export interface ChatCipher {
  readonly roomId: string;
  /** 用自己当前发送用的密钥加密；密钥还没准备好时返回 null */
  seal(plaintext: Uint8Array): Promise<EncryptedChat | null>;
  /** 解密一条消息；还没有发送者的这把密钥、或者解不开时返回 null */
  open(m: ChatMessage): Promise<Uint8Array | null>;
}

/** 每个房间最多暂存多少条还解不开的加密消息（收到密钥后重试） */
const HIDDEN_CHAT_KEEP = 300;
/** 最多记住多少张加密图片的密钥 */
const IMAGE_KEYS_KEEP = 500;

export class OpenHaneClient {
  readonly store: ClientStore = createClientStore();

  private ws: WebSocket | null = null;
  private params: ConnectParams | null = null;
  private address: ServerAddress | null = null;
  private identity: ServerIdentity | null = null;
  private resumeTicket: Uint8Array | null = null;
  /** HTTP 接口（聊天图片）的凭据，Welcome 里下发 */
  private apiToken = '';
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
  private chatCipher: ChatCipher | null = null;
  /** 还解不开的加密消息（房间 → 消息 ID → 消息），不显示；收到密钥后重试 */
  private hiddenChat = new Map<string, Map<bigint, ChatMessage>>();
  /** 每个房间收到过的最早的消息 ID（含解不开的），「加载更早的消息」从这里往前翻 */
  private oldestChat = new Map<string, bigint>();
  /** 加密图片的解密信息（图片 ID → 密钥），来自解密后的消息或自己的上传 */
  private imageKeys = new Map<string, EncryptedImageKey>();
  private pacer: TransferPacer | null = null;

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

  /** 设置聊天图片的传输节奏（媒体连接建立后由媒体层设置，断开时传 null） */
  setTransferPacer(p: TransferPacer | null): void {
    this.pacer = p;
  }

  /** 设置端到端加密聊天的加解密（进入加密房间、密钥管理器启动后），并重试还解不开的消息。返回取消函数 */
  setChatCipher(c: ChatCipher): () => void {
    this.chatCipher = c;
    void this.retryEncryptedChat();
    return () => {
      if (this.chatCipher === c) this.chatCipher = null;
    };
  }

  /** 重新尝试解密还解不开的消息（密钥管理器收到新密钥后调用） */
  async retryEncryptedChat(): Promise<void> {
    const roomId = this.chatCipher?.roomId;
    const held = roomId ? this.hiddenChat.get(roomId) : undefined;
    if (!roomId || !held?.size) return;
    await this.addChat(roomId, [...held.values()]);
  }

  /** 连接服务器。成功收到 Welcome 后 resolve；被拒绝时 reject（HaneError）。 */
  async connect(params: ConnectParams): Promise<void> {
    this.disconnect();
    this.closedByUser = false;
    this.params = params;
    this.address = parseAddress(params.address);
    this.identity = null;
    this.resumeTicket = null;
    this.apiToken = '';
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
    return this.openSocket(await this.dial());
  }

  /**
   * 建立 WebSocket 连接（到升级完成为止）。地址没写端口时同时尝试几个端口、按优先级选一个，
   * 选中的端口写回 this.address，之后断线重连只用这个端口。
   */
  private async dial(): Promise<WebSocket> {
    const gen = this.generation;
    const win = await firstByPriority(
      candidateAddresses(this.address!).map((a) => this.dialOne(a).then((ws) => ({ a, ws }))),
      {
        graceMs: PORT_GRACE,
        decisive: (e) => e instanceof HaneError && e.code === LocalErrorCode.FINGERPRINT_CHANGED,
        discard: (w) => w.ws.close(),
      },
    );
    if (gen !== this.generation) {
      win.ws.close();
      throw new HaneError(LocalErrorCode.CONNECTION_LOST, 'disconnected');
    }
    if (this.address!.portImplicit) {
      const { portImplicit: _, ...resolved } = win.a;
      this.address = resolved;
      this.store.setState({ address: resolved });
    }
    return win.ws;
  }

  private async dialOne(address: ServerAddress): Promise<WebSocket> {
    const allowed = (await this.opt.trust?.beforeConnect?.(hostPort(address))) ?? true;
    if (!allowed) throw new HaneError(LocalErrorCode.FINGERPRINT_CHANGED, 'certificate fingerprint changed');
    const factory = this.opt.webSocket ?? ((u: string, p: string[]) => new WebSocket(u, p));
    return new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = factory(controlUrl(address), [SUBPROTOCOL]);
      } catch (e) {
        reject(new HaneError(LocalErrorCode.UNREACHABLE, String(e)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        reject(new HaneError(LocalErrorCode.TIMEOUT, 'connect timeout'));
        ws.close();
      }, HANDSHAKE_TIMEOUT);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onclose = null;
        resolve(ws);
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        reject(new HaneError(LocalErrorCode.UNREACHABLE, `connection closed (${ev.code})`));
      };
    });
  }

  /** 在已打开的 WebSocket 上握手鉴权 */
  private openSocket(ws: WebSocket): Promise<Welcome> {
    const gen = ++this.generation;
    return new Promise<Welcome>((resolve, reject) => {
      this.ws = ws;
      let phase: 'hello' | 'auth' | 'ready' = 'hello';
      const timer = setTimeout(() => {
        reject(new HaneError(LocalErrorCode.TIMEOUT, 'handshake timeout'));
        ws.close();
      }, HANDSHAKE_TIMEOUT);

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
    this.store.setState({ serverId: toHex(ch.serverId), serverInfo: withCleanName(ch.info) });
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
    this.apiToken = w.apiToken;
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
    if (!w.resumed) {
      this.hiddenChat.clear();
      this.oldestChat.clear();
      this.imageKeys.clear();
    }
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
        void this.addChat(b.value.roomId, [b.value]);
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
        this.store.setState({ serverInfo: withCleanName(b.value.info) ?? s.serverInfo });
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
    timeoutMs = REQUEST_TIMEOUT,
  ): Promise<ResultOf<C>> {
    const id = this.nextId++;
    const resp = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaneError(LocalErrorCode.TIMEOUT, 'request timeout'));
      }, timeoutMs);
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

  /** 发送聊天消息。imageId 是 uploadChatImage 返回的图片（有图片时 text 可以为空） */
  /** 端到端加密房间里，加密还没准备好（媒体连接、密钥交换未完成）时抛出 HaneError(E2EE_NOT_READY) */
  async sendChat(text: string, opts: { replyTo?: bigint; imageId?: string } = {}): Promise<ChatMessage | undefined> {
    const s = this.store.getState();
    const roomId = s.media?.roomId ?? 'main';
    const imageId = opts.imageId ?? '';
    const msg = create(SendChatSchema, { roomId, text, clientMsgId: crypto.randomUUID(), replyTo: opts.replyTo ?? 0n, imageId });
    if (s.rooms[roomId]?.e2ee) {
      const image = imageId ? this.imageKeys.get(imageId) : undefined;
      if (imageId && !image) throw new ChatImageError('failed');
      const c = this.chatCipher;
      const sealed = c?.roomId === roomId ? await c.seal(toBinary(ChatPlaintextSchema, create(ChatPlaintextSchema, { text, image }))) : null;
      if (!sealed) throw new HaneError(LocalErrorCode.E2EE_NOT_READY, 'end-to-end encryption is not ready');
      msg.text = '';
      msg.encrypted = sealed;
    }
    const r = await this.request({ case: 'sendChat', value: msg });
    if (!r.message) return undefined;
    return (await this.addChat(roomId, [r.message]))[0];
  }

  /**
   * 把收到的消息放进状态：加密的先解密，解不开的暂存起来不显示（收到密钥后重试）。返回放进状态的消息。
   * 解密后的消息 text 换成正文，图片补上解密信息里的宽高（显示前的清洗由 mergeChat 负责）
   */
  private async addChat(roomId: string, msgs: ChatMessage[]): Promise<ChatMessage[]> {
    const shown: ChatMessage[] = [];
    // 同步取出（或建好）暂存表：几批消息可能同时在解密
    let held = this.hiddenChat.get(roomId);
    if (!held) this.hiddenChat.set(roomId, (held = new Map()));
    for (const m of msgs) {
      const oldest = this.oldestChat.get(roomId);
      if (oldest === undefined || m.id < oldest) this.oldestChat.set(roomId, m.id);
      if (!m.encrypted) {
        shown.push(m);
        continue;
      }
      const plain = await this.decryptChat(m);
      if (plain) {
        held.delete(m.id);
        shown.push(plain);
      } else {
        held.set(m.id, m);
        while (held.size > HIDDEN_CHAT_KEEP) held.delete(held.keys().next().value!);
      }
    }
    if (shown.length) {
      const st = this.store.getState();
      this.store.setState({ chat: { ...st.chat, [roomId]: mergeChat(st.chat[roomId], shown) } });
    }
    return shown;
  }

  private async decryptChat(m: ChatMessage): Promise<ChatMessage | null> {
    const c = this.chatCipher;
    if (c?.roomId !== m.roomId) return null;
    const raw = await c.open(m).catch(() => null);
    if (!raw) return null;
    let p;
    try {
      p = fromBinary(ChatPlaintextSchema, raw);
    } catch {
      return null;
    }
    let image = m.image;
    const k = p.image;
    // 图片的解密信息不合格（或消息没带图片）：只显示文字
    if (image && k && k.key.length === 32 && k.digest.length === 32 && (k.mime === 'image/png' || k.mime === 'image/jpeg') && validSize(k.width, k.height)) {
      this.imageKeys.set(image.id, k);
      while (this.imageKeys.size > IMAGE_KEYS_KEEP) this.imageKeys.delete(this.imageKeys.keys().next().value!);
      image = { ...image, width: k.width, height: k.height };
    } else {
      image = undefined;
    }
    if (!p.text && !image) return null;
    return { ...m, text: p.text, image };
  }

  /**
   * 上传聊天图片（PNG 或 JPEG），返回图片 ID，随后用 sendChat 发出。失败时抛出 ChatImageError。
   * 端到端加密房间里先加密再上传（要传入宽高，放进加密的正文里）；调用方应先把图片重新编码、去掉元数据
   */
  async uploadChatImage(data: Blob, size?: { width: number; height: number }): Promise<string> {
    const s = this.store.getState();
    const roomId = s.media?.roomId ?? 'main';
    if (!this.address || !this.apiToken) throw new ChatImageError('failed');
    let body = new Uint8Array(await data.arrayBuffer());
    let key: EncryptedImageKey | undefined;
    if (s.rooms[roomId]?.e2ee) {
      if (!size || !validSize(size.width, size.height) || (data.type !== 'image/png' && data.type !== 'image/jpeg')) throw new ChatImageError('unsupported');
      const sealed = await sealChatImage(body);
      body = sealed.file;
      key = create(EncryptedImageKeySchema, { key: sealed.key, digest: sealed.digest, mime: data.type, width: size.width, height: size.height });
    }
    // 分块上传，会议中按媒体的状况控制速度
    const j = (await uploadChunked(httpBase(this.address), this.apiToken, roomId, body, this.pacer)) as { id?: unknown };
    if (!isImageId(j?.id)) throw new ChatImageError('failed');
    if (key) this.imageKeys.set(j.id, key);
    return j.id;
  }

  /** 读取聊天图片，返回按文件头确定类型的 Blob。服务端的数据不可信：限制大小，只接受 PNG / JPEG */
  async loadChatImage(roomId: string, imageId: string): Promise<Blob> {
    if (!this.address || !this.apiToken || !isRoomId(roomId) || !isImageId(imageId)) throw new Error('unavailable');
    // 分段下载，会议中按媒体的状况控制速度
    let bytes = await downloadRanged(`${httpBase(this.address)}/api/v1/chat/images/${roomId}/${imageId}`, this.apiToken, CHAT_IMAGE_FETCH_MAX, this.pacer);
    // 加密的图片：核对摘要后解密，解密后的内容照样只按 PNG / JPEG 接受（发送者也不可信）
    const key = this.imageKeys.get(imageId);
    if (key) bytes = await openChatImage(bytes, key.key, key.digest);
    const type = sniffImage(bytes);
    if (!type) throw new Error('not a valid image');
    return new Blob([bytes as BlobPart], { type });
  }

  /** 加载更早的一页聊天（从收到过的最早一条往前，包括解不开、没显示的加密消息） */
  async loadOlderChat(roomId: string): Promise<void> {
    await this.loadChatHistory(roomId, this.oldestChat.get(roomId) ?? 0n);
  }

  /** 加载 beforeId 之前的一页聊天（0 表示最新一页），合并进状态。 */
  async loadChatHistory(roomId: string, beforeId = 0n, limit = 50): Promise<void> {
    const r = await this.request({
      case: 'getChatHistory',
      value: create(GetChatHistorySchema, { roomId, beforeId, limit }),
    });
    await this.addChat(roomId, r.messages);
    // 只有翻页（或首次加载）时更新「是否还有更早」
    const st = this.store.getState();
    if (beforeId !== 0n || st.chatHasMore[roomId] === undefined) this.store.setState({ chatHasMore: { ...st.chatHasMore, [roomId]: r.hasMore } });
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

  /** 在线会话的 IP、归属地和往返延迟 */
  async getSessionInfo(sessionId: string): Promise<GetSessionInfoResult> {
    return this.request({ case: 'getSessionInfo', value: create(GetSessionInfoSchema, { sessionId }) });
  }

  /** 让服务器下载 IPv6 归属地库（约 37 MB），完成后才返回 */
  async downloadIPv6GeoDB(): Promise<void> {
    await this.request({ case: 'downloadIpv6GeoDb', value: create(DownloadIPv6GeoDBSchema) }, 10 * 60_000);
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
