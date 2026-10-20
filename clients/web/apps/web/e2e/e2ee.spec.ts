import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

let server: TestServer;
let browser: Browser;
const extraServers: TestServer[] = [];

test.beforeAll(async () => {
  server = await startServer();
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${sineWav()}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.stop();
  for (const s of extraServers) await s.stop();
});

async function join(nickname: string, srv: TestServer = server): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 常开 + 关闭降噪：假麦克风的正弦波原样发出
  await ctx.addInitScript(() => localStorage.setItem('hane.audioPrefs', JSON.stringify({ ns: 'off', mode: 'open' })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(srv.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hane.media.state.getState().status), { timeout: 20_000 }).toBe('connected');
  return page;
}

const e2ee = (p: Page) => p.evaluate(() => (window as any).__hane.media.state.getState().e2ee);

/** 远端音频：累计能量和收到的包数（WebRTC 统计） */
async function remoteAudio(page: Page): Promise<{ energy: number; packets: number }> {
  return page.evaluate(async () => {
    const room = (window as any).__hane.media.liveRoom;
    let energy = 0;
    let packets = 0;
    for (const p of room?.remoteParticipants.values() ?? []) {
      for (const pub of p.audioTrackPublications.values()) {
        const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
        report?.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            energy += s.totalAudioEnergy ?? 0;
            packets += s.packetsReceived ?? 0;
          }
        });
      }
    }
    return { energy, packets };
  });
}

test('end-to-end encrypted room: key exchange, safety code, undecryptable without keys, rotation when someone leaves', async () => {
  const alice = await join('Alice');
  const bob = await join('Bob');
  const eve = await join('Eve');
  await alice.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);

  // Alice 建加密房间（服务器默认策略「可选」）；Eve 进房前设置为丢弃收到的密钥包（拿不到任何人的密钥）
  const roomId = await alice.evaluate(async () => (await (window as any).__hane.client.createRoom({ name: '机密', overrides: { e2ee: true }, join: true })).room.id);
  await eve.evaluate(() => ((globalThis as any).__haneDropKeys = true));
  for (const p of [bob, eve]) await p.evaluate((id) => (window as any).__hane.client.joinRoom(id), roomId);
  for (const p of [alice, bob, eve]) await expect.poll(async () => (await e2ee(p))?.enabled, { timeout: 15_000 }).toBe(true);

  // 安全码：三个人看到的相同
  await expect.poll(async () => (await e2ee(alice))?.safetyCode?.length, { timeout: 10_000 }).toBe(8);
  const code: number[] = (await e2ee(alice)).safetyCode;
  await expect.poll(async () => (await e2ee(bob))?.safetyCode).toEqual(code);
  await expect.poll(async () => (await e2ee(eve))?.safetyCode).toEqual(code);
  await alice.getByTestId('e2ee-badge').click();
  await expect(alice.getByTestId('safety-code')).toHaveAttribute('data-code', code.join(','));
  await expect(alice.getByTestId('safety-code').locator('li')).toHaveCount(8);
  await alice.keyboard.press('Escape');

  // Bob 收齐了密钥，听得到；Eve 收得到数据包（经过 SFU 的是密文），但没有密钥解不出声音
  // Bob 与 Eve 几乎同时进入：彼此的密钥包可能在对方开始接收前到达，由控制连接暂存后交给密钥管理器，不会丢
  await expect.poll(async () => Object.keys((await e2ee(bob)).missing).length, { timeout: 10_000 }).toBe(0);
  expect(Object.keys((await e2ee(eve)).missing).length).toBe(2); // Eve 丢弃了收到的密钥包（她自己的密钥照常发出）
  await expect.poll(async () => (await remoteAudio(bob)).energy, { timeout: 20_000 }).toBeGreaterThan(0.01);
  await expect.poll(async () => (await remoteAudio(eve)).packets, { timeout: 10_000 }).toBeGreaterThan(100);
  expect((await remoteAudio(eve)).energy).toBeLessThan(0.001);
  await expect(eve.getByTestId('e2ee-pending').first()).toBeVisible();
  // 流量优先级：媒体连接期间每秒判断一次；本机网络没有拥堵
  const traffic = (p: Page) => p.evaluate(() => (window as any).__hane.media.state.getState().traffic);
  await expect.poll(async () => (await traffic(alice))?.upBps ?? 0).toBeGreaterThan(0);
  expect(await traffic(alice)).toMatchObject({ upCongested: false, shareYield: false });

  // 聊天：服务端转来的是密文，Bob 解开后显示；Eve 没有密钥，消息不显示
  const chat = (p: Page) =>
    p.evaluate((id) => ((window as any).__hane.client.store.getState().chat[id] ?? []).map((m: any) => ({ text: m.text, encrypted: !!m.encrypted, image: m.image ? [m.image.width, m.image.height] : null })), roomId);
  await alice.evaluate(() => (window as any).__hane.client.sendChat('机密消息'));
  await expect.poll(() => chat(bob)).toEqual([{ text: '机密消息', encrypted: true, image: null }]);
  expect(await chat(alice)).toEqual([{ text: '机密消息', encrypted: true, image: null }]);
  // 图片：加密后上传，Bob 解密后得到 PNG，宽高来自加密的正文
  const imageId = await alice.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    c.getContext('2d')!.fillRect(0, 0, 64, 48);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const client = (window as any).__hane.client;
    const id = await client.uploadChatImage(blob, { width: 64, height: 48 });
    await client.sendChat('', { imageId: id });
    return id;
  });
  await expect.poll(async () => (await chat(bob)).length).toBe(2);
  expect((await chat(bob))[1]).toEqual({ text: '', encrypted: true, image: [64, 48] });
  const loaded = await bob.evaluate(async ([room, id]) => {
    const b: Blob = await (window as any).__hane.client.loadChatImage(room, id);
    return [b.type, b.size];
  }, [roomId, imageId]);
  expect(loaded[0]).toBe('image/png');
  expect(loaded[1]).toBeGreaterThan(0);
  expect(await chat(eve)).toEqual([]);

  // Eve 离开：Alice 和 Bob 轮换密钥（索引 0 → 1），2 秒内完成切换；之后 Bob 仍然听得到 Alice
  await eve.getByTestId('leave').click();
  for (const p of [alice, bob]) {
    await expect.poll(async () => (await e2ee(p))?.lastRotation?.switchedAt ?? null, { timeout: 5_000 }).not.toBeNull();
    const r = (await e2ee(p)).lastRotation;
    console.log('rotation', r.switchedAt - r.startedAt, 'ms, index', r.index);
    expect(r.index).toBe(1);
    expect(r.switchedAt - r.startedAt).toBeLessThan(2000);
  }
  const before = (await remoteAudio(bob)).energy;
  await bob.waitForTimeout(1500);
  expect((await remoteAudio(bob)).energy).toBeGreaterThan(before + 0.001);
  // 安全码随成员变化，Alice 和 Bob 仍一致
  // （重新计算期间为 null，按没变处理）
  await expect.poll(async () => ((await e2ee(alice)).safetyCode ?? code).join(',')).not.toBe(code.join(','));
  await expect.poll(async () => (await e2ee(bob)).safetyCode).toEqual((await e2ee(alice)).safetyCode);
});

test('end-to-end encrypted room: screen share on the separate share connection uses the same keys and decrypts correctly', async () => {
  // 管理员令牌只能兑换一次：这个测试用自己的服务器
  const own = await startServer();
  extraServers.push(own);
  const alice = await join('Alice2', own);
  const bob = await join('Bob2', own);
  await alice.evaluate((t) => (window as any).__hane.client.redeemToken(t), own.adminToken);
  const roomId = await alice.evaluate(async () => (await (window as any).__hane.client.createRoom({ name: '机密共享', overrides: { e2ee: true }, join: true })).room.id);
  await bob.evaluate((id) => (window as any).__hane.client.joinRoom(id), roomId);
  for (const p of [alice, bob]) await expect.poll(async () => (await e2ee(p))?.enabled, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => Object.keys((await e2ee(bob)).missing).length, { timeout: 10_000 }).toBe(0);
  // 左红右蓝的合成画面
  await alice.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d')!;
    let n = 0;
    setInterval(() => {
      g.fillStyle = '#e00000';
      g.fillRect(0, 0, 640, 720);
      g.fillStyle = '#0000e0';
      g.fillRect(640, 0, 640, 720);
      g.fillStyle = '#fff';
      g.fillText(String(n++), 600, 360);
    }, 50);
    (window as any).__hane.media.shareTrackFactory = async () => c.captureStream(20).getVideoTracks()[0];
  });
  await alice.evaluate(() => (window as any).__hane.media.startScreenShare('clarity', false));
  // Bob 在共享连接上解密出正确的画面（不是乱码）
  await expect
    .poll(
      () =>
        bob.evaluate(async () => {
          const room = (window as any).__hane.media.liveShareRoom;
          for (const p of room?.remoteParticipants.values() ?? []) {
            for (const pub of p.videoTrackPublications.values()) {
              if (!pub.track) continue;
              const v = document.createElement('video');
              v.muted = true;
              v.srcObject = new MediaStream([pub.track.mediaStreamTrack]);
              await v.play().catch(() => undefined);
              await new Promise((r) => setTimeout(r, 500));
              const c = document.createElement('canvas');
              c.width = 1280;
              c.height = 720;
              const g = c.getContext('2d')!;
              g.drawImage(v, 0, 0, 1280, 720);
              const [lr, , lb] = g.getImageData(200, 200, 1, 1).data;
              const [rr, , rb] = g.getImageData(1080, 200, 1, 1).data;
              return lr! > 150 && lb! < 80 && rb! > 150 && rr! < 80;
            }
          }
          return false;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(await bob.evaluate(() => (window as any).__hane.media.liveShareRoom.isE2EEEnabled)).toBe(true);
});
