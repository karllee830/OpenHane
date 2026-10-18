// 苹果端 ⇄ Web 端端到端加密互通。需要先构建 macOS 应用，用 HANE_MAC_APP 指定可执行文件：
//   HANE_MAC_APP=${OPENHANE_CACHE:-$HOME/Library/Caches/openhane}/DerivedData/Build/Products/Debug/OpenHane.app/Contents/MacOS/OpenHane \
//   HANE_SKIP_DESKTOP_BUILD=1 pnpm exec playwright test interop-macos
// 未设置时跳过。检查：双方互相拿到密钥、安全码一致；Web 能解码 Mac 加密后的屏幕共享（合成画面），Mac 能解密 Web 的声音。
import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

const MAC_APP = process.env.HANE_MAC_APP;

test.skip(!MAC_APP, 'HANE_MAC_APP 未设置');

test('E2EE interop: macOS app and web exchange keys, agree on the safety code and decrypt each other', async () => {
  test.setTimeout(90_000);
  const server = await startServer({ HANE_TLS_MODE: 'self-signed' });
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sineWav()}`, '--autoplay-policy=no-user-gesture-required'],
  });
  // HANE_INTEROP_DIR：保留 Mac 应用的截图和状态文件（排查用）
  const dir = process.env.HANE_INTEROP_DIR ?? mkdtempSync(join(tmpdir(), 'hane-interop-'));
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => localStorage.setItem('hane.audioPrefs', JSON.stringify({ ns: 'off', mode: 'open' })));
    const web = await ctx.newPage();
    web.on('pageerror', (e) => console.error('[web] pageerror', e));
    await web.goto(server.address);
    await web.getByTestId('nickname').fill('Web');
    await web.getByTestId('connect').click();
    await expect(web.getByTestId('server-name')).toBeVisible();
    await web.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);
    // 主会议开启端到端加密
    await web.evaluate(() => (window as any).__hane.client.updateRoom('main', { overrides: { e2ee: true } }));
    await expect.poll(() => web.evaluate(() => (window as any).__hane.media.state.getState().e2ee?.enabled ?? false), { timeout: 20_000 }).toBe(true);
    // 记录解密错误
    await web.evaluate(() => {
      (window as any).__encErrors = 0;
      (window as any).__hane.media.liveRoom.on('encryptionError', () => ((window as any).__encErrors += 1));
    });

    // 启动 Mac 应用：自动连接，合成画面共享屏幕，等待一段时间后写出状态并退出
    const mac = spawn(MAC_APP!, [], {
      env: {
        ...process.env,
        HANE_AUTOCONNECT: `127.0.0.1:${server.port}|Mac`,
        HANE_SNAPSHOT_DIR: dir,
        HANE_SNAPSHOT_SHARE: '1',
        HANE_SNAPSHOT_WAIT: '12',
        HANE_E2E: '1',
        HANE_SEED_BYTE: '77',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const macExit = new Promise<void>((r) => mac.once('exit', () => r()));

    // Web：拿到 Mac 的密钥，并能解码 Mac 加密后的屏幕共享
    const e2ee = () => web.evaluate(() => (window as any).__hane.media.state.getState().e2ee);
    await expect.poll(async () => Object.values((await web.evaluate(() => (window as any).__hane.client.store.getState().participants)) as any[]).length, { timeout: 30_000 }).toBe(2);
    await expect.poll(async () => Object.keys((await e2ee()).missing).length, { timeout: 15_000 }).toBe(0);
    await expect
      .poll(
        () =>
          web.evaluate(async () => {
            // 屏幕共享在共享连接上
            const room = (window as any).__hane.media.liveShareRoom;
            let decoded = 0;
            for (const p of room?.remoteParticipants.values() ?? []) {
              for (const pub of p.videoTrackPublications.values()) {
                if (!pub.isSubscribed) pub.setSubscribed(true);
                const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
                report?.forEach((s: any) => {
                  if (s.type === 'inbound-rtp' && s.kind === 'video') decoded += s.framesDecoded ?? 0;
                });
              }
            }
            return decoded;
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(10);
    const webCode = (await e2ee()).safetyCode;
    expect(await web.evaluate(() => (window as any).__encErrors)).toBe(0);

    // Mac：状态文件
    await macExit;
    const status = Object.fromEntries(
      readFileSync(join(dir, 'status.txt'), 'utf8')
        .split(/\s+|\n/)
        .map((kv) => kv.split('='))
        .filter((kv) => kv.length === 2),
    );
    console.log('mac status:', status, 'web safety code:', webCode);
    expect(status.e2ee).toBe('on');
    expect(status.missing).toBe('0');
    expect(Number(status.remoteOK)).toBeGreaterThan(0);
    expect(status.decryptFailed).toBe('0');
    expect(readFileSync(join(dir, 'status.txt'), 'utf8')).toContain(`safetyCode=${webCode}`);
  } finally {
    await browser.close();
    await server.stop();
    if (!process.env.HANE_INTEROP_DIR) rmSync(dir, { recursive: true, force: true });
  }
});
