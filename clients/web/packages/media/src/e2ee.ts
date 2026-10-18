// 端到端加密的密钥管理：发送者密钥模型。
// 每个人给自己的媒体流生成一把随机密钥，用 HPKE 分别加密发给房间里的每个成员；服务器只中转密钥包，无法解开。
// - 进入加密房间：生成密钥（索引 0）发给所有人；之后有人进来，把当前密钥发给他；
// - 有人离开：轮换自己的密钥（索引 +1）并重新分发，约 1 秒后切换到新密钥发送（旧密钥仍可解密路上的包）；
// - 收到别人的密钥包：解开后交给帧解密器；收到之前对方的画面和声音无法解密（界面显示「正在建立加密…」）。
import { keyPackageAAD, newMediaKey, openKeyPackage, safetyCode, sealKeyPackage, verifyE2EEKey, type OpenHaneClient } from '@hane/core';
import { SendKeyPackageSchema, create, type Participant } from '@hane/protocol';
import { BaseKeyProvider, createKeyMaterialFromBuffer } from 'livekit-client';
import { createStore } from 'zustand/vanilla';

/** 密钥环大小（LiveKit 帧加密器的默认值） */
const KEY_RING = 16;
/** 轮换后切换到新密钥前的等待：给其他人收到新密钥包的时间 */
export const ROTATE_SWITCH_MS = 1000;

export interface E2EEState {
  enabled: boolean;
  /** 安全码（所有人相同即说明大家看到的成员列表一致） */
  safetyCode: string | null;
  /** 自己当前发送使用的密钥索引 */
  keyIndex: number;
  /** 还没收到其密钥的成员（session id → true） */
  missing: Record<string, boolean>;
  /** 最近一次轮换：开始时刻和完成切换的时刻（performance.now()，测试与诊断用） */
  lastRotation: { startedAt: number; switchedAt: number | null; index: number } | null;
}

class SenderKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0 }); // 不自动「棘轮」：密钥只由我们显式分发
  }
  async setParticipantKey(identity: string, key: Uint8Array, index: number) {
    const material = await createKeyMaterialFromBuffer(key.slice().buffer); // HKDF（与苹果端一致，S9 已验证互通）
    this.onSetEncryptionKey(material, identity, index);
    // 屏幕共享走单独的连接（身份 = 主连接身份 + #s），用同一把密钥
    this.onSetEncryptionKey(material, identity + '#s', index);
  }
}

export class E2EEKeys {
  readonly provider = new SenderKeyProvider();
  readonly state = createStore<E2EEState>()(() => ({ enabled: false, safetyCode: null, keyIndex: 0, missing: {}, lastRotation: null }));
  /** 端到端测试用：丢弃收到的密钥包（模拟拿不到密钥的成员） */
  dropIncoming = false;

  private roomId = '';
  private selfId = '';
  private localIdentity = '';
  private myIndex = 0;
  private myKey: Uint8Array = new Uint8Array();
  private members = new Set<string>();
  private haveKeyFrom = new Set<string>();
  private verified = new Map<string, Promise<boolean>>();
  private unsubs: (() => void)[] = [];
  private switchTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly client: OpenHaneClient) {}

  /** 进入加密房间（媒体连接建立之后、发布轨道之前调用）：设置并分发自己的密钥 */
  async start(roomId: string, localIdentity: string): Promise<void> {
    this.roomId = roomId;
    this.localIdentity = localIdentity;
    this.selfId = this.client.store.getState().self?.sessionId ?? '';
    this.myIndex = 0;
    this.myKey = newMediaKey();
    await this.provider.setParticipantKey(localIdentity, this.myKey, 0);
    this.members = this.currentMembers();
    this.state.setState({ enabled: true, keyIndex: 0 });
    this.unsubs.push(
      // 进入房间前（媒体连接建立期间）到达的密钥包由控制连接暂存，这里一并取出
      this.client.setKeyPackageSink(roomId, (k) => void this.onKeyPackage(k)),
      this.client.store.subscribe((s, prev) => {
        if (s.participants !== prev.participants) void this.onMembersChanged();
      }),
    );
    await Promise.all([...this.members].map((id) => this.sendTo(id)));
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.switchTimer) clearTimeout(this.switchTimer);
    this.state.setState({ enabled: false, safetyCode: null, missing: {} });
  }

  private currentMembers(): Set<string> {
    const s = this.client.store.getState();
    return new Set(Object.values(s.participants).filter((p) => p.roomId === this.roomId && p.sessionId !== this.selfId).map((p) => p.sessionId));
  }

  private async onMembersChanged() {
    if (this.stopped) return;
    const next = this.currentMembers();
    const added = [...next].filter((id) => !this.members.has(id));
    const removed = [...this.members].filter((id) => !next.has(id));
    this.members = next;
    for (const id of removed) this.haveKeyFrom.delete(id);
    if (removed.length) {
      await this.rotate(); // 有人离开：轮换（新密钥也会发给刚进来的人）
    } else {
      await Promise.all(added.map((id) => this.sendTo(id)));
    }
    void this.refresh();
  }

  /** 轮换自己的密钥：先分发新密钥，稍后再切换过去发送 */
  private async rotate() {
    const index = (this.myIndex + 1) % KEY_RING;
    const key = newMediaKey();
    this.myIndex = index;
    this.myKey = key;
    const startedAt = performance.now();
    this.state.setState({ lastRotation: { startedAt, switchedAt: null, index } });
    await Promise.all([...this.members].map((id) => this.sendTo(id)));
    if (this.switchTimer) clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(() => {
      if (this.stopped || this.myIndex !== index) return;
      void this.provider.setParticipantKey(this.localIdentity, key, index).then(() =>
        this.state.setState({ keyIndex: index, lastRotation: { startedAt, switchedAt: performance.now(), index } }),
      );
    }, ROTATE_SWITCH_MS);
  }

  private verify(p: Participant): Promise<boolean> {
    const k = p.e2eeKey;
    if (!k) return Promise.resolve(false);
    const cacheKey = `${p.sessionId}:${[...k.publicKey].join(',')}`;
    let v = this.verified.get(cacheKey);
    if (!v) {
      v = verifyE2EEKey(p.uid, p.publicKey, k.publicKey, k.signature);
      this.verified.set(cacheKey, v);
    }
    return v;
  }

  private async sendTo(sessionId: string) {
    const p = this.client.store.getState().participants[sessionId];
    if (!p?.e2eeKey || this.stopped) return;
    // 公钥签名不对（服务端或中间人塞进来的密钥）：不给它发密钥
    if (!(await this.verify(p))) {
      console.warn('[hane] e2ee: rejecting unverifiable key of', p.nickname);
      return;
    }
    const index = this.myIndex;
    const { enc, ciphertext } = await sealKeyPackage(p.e2eeKey.publicKey, keyPackageAAD(this.roomId, this.selfId, sessionId, index), this.myKey);
    await this.client
      .request({ case: 'sendKeyPackage', value: create(SendKeyPackageSchema, { toSessionId: sessionId, roomId: this.roomId, keyIndex: index, enc, ciphertext }) })
      .catch((e) => console.warn('[hane] e2ee: send key package failed', e));
  }

  private async onKeyPackage(k: { fromSessionId: string; roomId: string; keyIndex: number; enc: Uint8Array; ciphertext: Uint8Array }) {
    // 端到端测试：globalThis.__haneDropKeys 在进入房间前设置，模拟拿不到任何密钥的成员
    const drop = this.dropIncoming || !!(globalThis as { __haneDropKeys?: boolean }).__haneDropKeys;
    if (this.stopped || drop || k.roomId !== this.roomId) return;
    const kx = this.client.keyExchange;
    const from = this.client.store.getState().participants[k.fromSessionId];
    if (!kx || !from) return;
    try {
      const key = await openKeyPackage(kx.privateKey, k.enc, k.ciphertext, keyPackageAAD(k.roomId, k.fromSessionId, this.selfId, k.keyIndex));
      await this.provider.setParticipantKey(from.mediaIdentity, key, k.keyIndex);
      // 第一次收到对方的密钥：回发一次自己的当前密钥。对方进入房间时我们发的包可能在它开始监听之前就到了（被丢弃）
      const first = !this.haveKeyFrom.has(k.fromSessionId);
      this.haveKeyFrom.add(k.fromSessionId);
      void this.refresh();
      if (first) void this.sendTo(k.fromSessionId);
    } catch (e) {
      console.warn('[hane] e2ee: cannot open key package from', from.nickname, e);
    }
  }

  /** 重新计算安全码和「还没收到密钥」的成员 */
  private async refresh() {
    const s = this.client.store.getState();
    const room = Object.values(s.participants).filter((p) => p.roomId === this.roomId);
    const code = await safetyCode(room.map((p) => ({ uid: p.uid, publicKey: p.publicKey })));
    const missing: Record<string, boolean> = {};
    for (const id of this.members) if (!this.haveKeyFrom.has(id)) missing[id] = true;
    this.state.setState({ safetyCode: code, missing });
  }
}
