// 越权测试与管理操作生效时间。
// 被篡改的客户端绕过界面和客户端检查、直接调用 LiveKit 发布：没有共享许可时发不出屏幕共享，被强制静音时发不出麦克风（SFU 按服务端下发的权限拒绝）；
// 强制静音从发出请求到 SFU 收回对方的麦克风 ≤ 500 ms。
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

let server: TestServer;
let browser: Browser;

test.beforeAll(async () => {
  server = await startServer();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sineWav()}`, '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function join(nickname: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => localStorage.setItem('hane.audioPrefs', JSON.stringify({ ns: 'off', mode: 'open' })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(server.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hane.media.state.getState().status), { timeout: 20_000 }).toBe('connected');
  return page;
}

/** 绕过客户端（含 SDK 的权限预检查）直接向 SFU 发布一条轨道；返回结果（SFU 不接受时 LiveKit 报错或超时） */
function tamperedPublish(page: Page, kind: 'screen' | 'mic'): Promise<string> {
  return page.evaluate(async (kind) => {
    const room = (window as any).__hane.media.liveRoom;
    // 篡改：跳过 SDK 自己根据权限做的预检查，让发布请求真正到达 SFU
    room.localParticipant.hasPermissionsToPublish = () => true;
    let track: MediaStreamTrack;
    if (kind === 'screen') {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const g = canvas.getContext('2d')!;
      setInterval(() => {
        g.fillStyle = `hsl(${Date.now() % 360} 70% 50%)`;
        g.fillRect(0, 0, 640, 360);
      }, 50);
      track = canvas.captureStream(20).getVideoTracks()[0]!;
    } else {
      track = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0]!;
    }
    try {
      await room.localParticipant.publishTrack(track, { source: kind === 'screen' ? 'screen_share' : 'microphone', name: `tampered-${kind}` });
      return 'published';
    } catch (e) {
      return `rejected: ${String(e)}`;
    }
  }, kind);
}

/** Alice 是否看到了 Bob 的某个来源的轨道 */
const seesSource = (page: Page, source: string) =>
  page.evaluate((source) => {
    const room = (window as any).__hane.media.liveRoom;
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.source === source) return true;
    return false;
  }, source);

test('tampered client cannot share without a grant or speak while force-muted; moderation takes effect within 500 ms', async () => {
  test.setTimeout(90_000);
  const alice = await join('Alice');
  const bob = await join('Bob');
  await alice.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);
  const bobId = await bob.evaluate(() => (window as any).__hane.client.store.getState().self.sessionId);
  await expect.poll(() => seesSource(alice, 'microphone'), { timeout: 10_000 }).toBe(true);

  // 1. 没有共享许可：直接发布屏幕共享被 SFU 拒绝，Alice 看不到
  const screen = await tamperedPublish(bob, 'screen');
  console.log('tampered screen share:', screen);
  expect(screen).toMatch(/^rejected/);
  expect(await seesSource(alice, 'screen_share')).toBe(false);

  // 2. 强制静音：记录 Bob 本地麦克风被 SFU 收回的时刻，计算生效时间
  await bob.evaluate(() => {
    const room = (window as any).__hane.media.liveRoom;
    room.on('localTrackUnpublished', (pub: any) => {
      if (pub.source === 'microphone') (window as any).__micRevokedAt ??= Date.now();
    });
  });
  const t0 = await alice.evaluate(async (id) => {
    const t = Date.now();
    await (window as any).__hane.client.moderate(id, 1 /* FORCE_MUTE */);
    return t;
  }, bobId);
  await expect.poll(() => bob.evaluate(() => (window as any).__micRevokedAt ?? null), { timeout: 5_000 }).not.toBeNull();
  const revokedAt = await bob.evaluate(() => (window as any).__micRevokedAt);
  console.log('force mute took effect in', revokedAt - t0, 'ms');
  expect(revokedAt - t0).toBeLessThan(500);
  await expect.poll(() => seesSource(alice, 'microphone'), { timeout: 5_000 }).toBe(false);

  // 3. 被强制静音时直接重新发布麦克风：被 SFU 拒绝，Alice 收不到
  const mic = await tamperedPublish(bob, 'mic');
  console.log('tampered microphone:', mic);
  expect(mic).toMatch(/^rejected/);
  expect(await seesSource(alice, 'microphone')).toBe(false);

  // 解除后恢复正常
  await alice.evaluate((id) => (window as any).__hane.client.moderate(id, 2 /* UNMUTE */), bobId);
  await expect.poll(() => seesSource(alice, 'microphone'), { timeout: 10_000 }).toBe(true);
});
