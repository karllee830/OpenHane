// 屏幕共享连接的传输方式：默认 TCP 优先（服务端过滤掉 UDP 候选，从一开始就走 TCP），
// TCP 连不上时改用 UDP；管理员设为 UDP 优先时先走 UDP，不稳定时客户端通过 ICE 重启切到 TCP，共享和声音不中断。
// 语音和摄像头所在的主连接始终走 UDP。「自动」切换的判断逻辑见 packages/media/src/transport.test.ts。
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

let server: TestServer;
let browser: Browser;

test.beforeAll(async () => {
  // 测试服务器默认关闭 TCP 回退端口：这里打开一个
  server = await startServer({ HANE_TCP_FALLBACK_PORT: String(40000 + Math.floor(Math.random() * 20000)) });
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sineWav()}`, '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function join(nickname: string, init?: () => void): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (init) await ctx.addInitScript(init);
  // 常开 + 关闭降噪：假麦克风的正弦波原样发出
  await ctx.addInitScript(() => localStorage.setItem('hane.audioPrefs', JSON.stringify({ ns: 'off', mode: 'open', nsChosen: true })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(server.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hane.media.state.getState().status), { timeout: 20_000 }).toBe('connected');
  return page;
}

const transport = (p: Page) => p.evaluate(() => (window as any).__hane.media.state.getState().transport);

/** 观看端收到的屏幕共享帧数（共享连接）和声音能量（主连接） */
const received = (p: Page) =>
  p.evaluate(async () => {
    let frames = 0;
    let energy = 0;
    const media = (window as any).__hane.media;
    for (const room of [media.liveRoom, media.liveShareRoom]) {
      for (const rp of room?.remoteParticipants.values() ?? []) {
        for (const pub of rp.trackPublications.values()) {
          const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
          report?.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') frames += s.framesDecoded ?? 0;
            if (s.type === 'inbound-rtp' && s.kind === 'audio' && room === media.liveRoom) energy += s.totalAudioEnergy ?? 0;
          });
        }
      }
    }
    return { frames, energy };
  });

/** 主连接选中的候选地址对的协议 */
const mainProtocol = (p: Page) =>
  p.evaluate(async () => {
    const pc = (window as any).__hane.media.liveRoom.engine.pcManager.publisher.pc as RTCPeerConnection;
    const r = await pc.getStats();
    let proto = null;
    r.forEach((s: any) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) proto = r.get(r.get(s.selectedCandidatePairId)?.localCandidateId)?.protocol ?? null;
    });
    return proto;
  });

test('screen share connection is TCP first (TCP-only from the start), falls back to UDP when TCP cannot connect; UDP-first switches to TCP; voice stays on UDP', async () => {
  test.setTimeout(120_000);
  const alice = await join('Alice');
  const bob = await join('Bob');
  // 默认 TCP 优先：共享连接一连上就是 TCP，没有切换
  await alice.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d')!;
    let n = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(n += 7) % 360},60%,50%)`;
      g.fillRect(0, 0, 1280, 720);
    }, 50);
    (window as any).__hane.media.shareTrackFactory = async () => {
      await new Promise((r) => setTimeout(r, 300)); // 等发布权限同步到 SFU
      return c.captureStream(20).getVideoTracks()[0];
    };
  });
  await alice.evaluate(() => (window as any).__hane.media.startScreenShare('smoothness', false));
  await expect.poll(async () => (await received(bob)).frames, { timeout: 15_000 }).toBeGreaterThan(20);
  for (const p of [alice, bob]) {
    await expect.poll(async () => transport(p), { timeout: 10_000 }).toEqual({ protocol: 'tcp', switched: null });
    // 主连接（语音、摄像头）仍走 UDP
    expect(await mainProtocol(p)).toBe('udp');
  }
  const before = await received(bob);
  await expect.poll(async () => (await received(bob)).frames - before.frames, { timeout: 15_000 }).toBeGreaterThan(40);
  await expect.poll(async () => (await received(bob)).energy - before.energy, { timeout: 15_000 }).toBeGreaterThan(0.01);

  // TCP 连不上（这里用极短的超时模拟端口被拦）：改用 UDP，照样能看到共享
  const carol = await join('Carol', () => ((globalThis as any).__haneShareTcpTimeoutMs = 1));
  await expect.poll(async () => (await received(carol)).frames, { timeout: 20_000 }).toBeGreaterThan(20);
  await expect.poll(async () => transport(carol), { timeout: 10_000 }).toEqual({ protocol: 'udp', switched: null });

  // 管理员设为 UDP 优先：新的共享连接先走 UDP，判断为需要 TCP 时 ICE 重启切过去（和「自动」检测相同的切换路径）
  await alice.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);
  await alice.evaluate(() => (window as any).__hane.client.updateSettings({ 'media.share_transport': '"udp"' }));
  const dave = await join('Dave');
  await expect.poll(async () => (await received(dave)).frames, { timeout: 20_000 }).toBeGreaterThan(20);
  await expect.poll(async () => (await transport(dave)).protocol, { timeout: 10_000 }).toBe('udp');
  await dave.evaluate(() => (window as any).__hane.media.liveShareRoom.simulateScenario('force-tcp'));
  await expect.poll(async () => (await transport(dave)).protocol, { timeout: 20_000 }).toBe('tcp');
  expect(await mainProtocol(dave)).toBe('udp');
  const d0 = (await received(dave)).frames;
  await expect.poll(async () => (await received(dave)).frames - d0, { timeout: 15_000 }).toBeGreaterThan(40);
});
