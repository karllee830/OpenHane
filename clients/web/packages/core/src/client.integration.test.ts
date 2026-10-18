import { MemoryIdentityStore } from '@hane/platform';
import { ErrorCode, Platform, Role } from '@hane/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenHaneClient } from './client';
import { HaneError } from './errors';
import { skipServerTests, startServer, type TestServer } from './testing/server';

function newClient(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return new OpenHaneClient({ identity: new MemoryIdentityStore(seed), appVersion: 'test', platform: Platform.WEB });
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(skipServerTests)('OpenHaneClient against the real server', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  it('joins, sees others, chats, updates state and becomes admin', async () => {
    const alice = newClient(1);
    const bob = newClient(2);
    await alice.connect({ address: server.address, nickname: 'Alice' });
    await bob.connect({ address: server.address, nickname: 'Bob' });

    const a = alice.store.getState();
    expect(a.status).toBe('connected');
    expect(a.self?.nickname).toBe('Alice');
    expect(a.media?.roomId).toBe('main');
    expect(a.media?.url).toBe(`ws://127.0.0.1:${server.port}`);
    expect(a.media?.grant?.token.length).toBeGreaterThan(100);
    expect(a.media?.policy?.audio?.maxBitrateBps).toBe(32000);

    await until(() => Object.keys(alice.store.getState().participants).length === 2);

    await bob.sendChat('你好，Alice');
    await until(() => (alice.store.getState().chat.main ?? []).some((m) => m.text === '你好，Alice'));

    await alice.updateSelf({ micMuted: true });
    await until(() => bob.store.getState().participants[a.self!.sessionId]?.state?.micMuted === true);

    // 权限令牌 → 管理员 → 修改设置，所有人实时收到
    expect(await alice.redeemToken(server.adminToken.toLowerCase())).toBe(Role.ADMIN);
    await until(() => alice.store.getState().self?.role === Role.ADMIN);
    await alice.updateSettings({ 'server.name': '"测试服务器"', 'audio.preset': '"hd"' });
    await until(() => bob.store.getState().serverInfo?.name === '测试服务器');
    await until(() => bob.store.getState().media?.policy?.audio?.maxBitrateBps === 64000);
    await expect(bob.getSettings()).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });

    // 新连接加载聊天历史
    const carol = newClient(3);
    await carol.connect({ address: server.address, nickname: 'Carol' });
    await until(() => (carol.store.getState().chat.main ?? []).length === 1);

    // 离开：其他人看到离开（主动断开后服务端在宽限期结束时移除；这里只验证状态复位）
    carol.disconnect();
    expect(carol.store.getState().status).toBe('idle');
    alice.disconnect();
    bob.disconnect();
  });

  it('reports password errors without retrying', async () => {
    const admin = newClient(1);
    await admin.connect({ address: server.address, nickname: 'Admin' });
    await admin.updateSettings({ 'server.password': '"pw"' });
    const guest = newClient(9);
    const err = await guest.connect({ address: server.address, nickname: 'Guest' }).catch((e) => e);
    expect(err).toBeInstanceOf(HaneError);
    expect((err as HaneError).code).toBe(ErrorCode.PASSWORD_REQUIRED);
    expect(guest.store.getState().status).toBe('failed');
    await guest.connect({ address: server.address, nickname: 'Guest', password: 'pw' });
    expect(guest.store.getState().status).toBe('connected');
    await admin.updateSettings({ 'server.password': 'null' });
    admin.disconnect();
    guest.disconnect();
  });

  it('resumes the same session after the control connection drops', async () => {
    const alice = newClient(4);
    const bob = newClient(5);
    await alice.connect({ address: server.address, nickname: 'Dropper' });
    await bob.connect({ address: server.address, nickname: 'Watcher' });
    const sid = alice.store.getState().self!.sessionId;
    // 模拟网络中断：直接关掉底层 WebSocket
    (alice as unknown as { ws: WebSocket }).ws.close();
    await until(() => alice.store.getState().status === 'reconnecting');
    await until(() => alice.store.getState().status === 'connected', 10_000);
    expect(alice.store.getState().self?.sessionId).toBe(sid);
    await until(() => bob.store.getState().participants[sid]?.reconnecting === false);
    alice.disconnect();
    bob.disconnect();
  });
});
