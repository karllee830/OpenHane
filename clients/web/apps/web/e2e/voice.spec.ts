import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

let server: TestServer;
let browser: Browser;

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
});

/** 打开服务端提供的 Web 客户端并加入；prefs 写入 localStorage 作为个人音频设置。 */
async function join(nickname: string, prefs?: Record<string, unknown>): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (prefs) await ctx.addInitScript((p) => localStorage.setItem('hane.audioPrefs', JSON.stringify(p)), prefs);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(server.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  return page;
}

/** 远端音频的累计能量（来自 WebRTC 统计），用来确认确实收到了声音。 */
async function remoteAudioEnergy(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const room = (window as any).__hane.media.liveRoom;
    let energy = 0;
    for (const p of room?.remoteParticipants.values() ?? []) {
      for (const pub of p.audioTrackPublications.values()) {
        const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
        report?.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') energy += s.totalAudioEnergy ?? 0;
        });
      }
    }
    return energy;
  });
}

test('two people talk, chat, and the first becomes admin', async () => {
  // Alice：常开 + 关闭降噪，假麦克风的正弦波原样发出；Bob：默认设置（语音激活 + AI 降噪）
  const alice = await join('Alice', { ns: 'off', mode: 'open' });
  const bob = await join('Bob');

  await expect(alice.getByTestId('stage-tile')).toHaveCount(2);
  await expect(bob.getByTestId('stage-tile')).toHaveCount(2);

  // 声音：Bob 收到 Alice 的音频，且能量持续增长
  await expect.poll(() => remoteAudioEnergy(bob), { timeout: 20_000 }).toBeGreaterThan(0.01);
  const e1 = await remoteAudioEnergy(bob);
  await bob.waitForTimeout(1500);
  expect(await remoteAudioEnergy(bob)).toBeGreaterThan(e1);

  // 说话指示：Bob 看到 Alice 在说话（SFU 的音量检测）
  await expect(bob.getByTestId('stage-tile').filter({ hasText: 'Alice' })).toHaveAttribute('data-speaking', 'true', { timeout: 20_000 });

  // AI 降噪（DeepFilterNet）在 AudioWorklet 中加载成功（Bob 默认开启）
  await expect
    .poll(() => bob.evaluate(() => (window as any).__hane.media.levels.getState().local?.ns), { timeout: 30_000 })
    .toBe('active');
  // 纯正弦波不是人声（被压低约 60 dB，局部信噪比 -15 dB，语音概率约 0.01）：模型加载完成后，Bob 的语音激活门在句尾保持时间过后关闭
  // （加载前只有能量门控，会被正弦波打开）
  await expect
    .poll(() => bob.evaluate(() => (window as any).__hane.media.levels.getState().local?.speaking), { timeout: 5_000 })
    .toBe(false);
  expect(await bob.evaluate(() => (window as any).__hane.media.levels.getState().local?.vad)).toBeLessThan(0.2);

  // 聊天
  await alice.getByRole('textbox', { name: /发送消息|Send a message/ }).fill('大家好');
  await alice.keyboard.press('Enter');
  await expect(bob.getByTestId('chat-list')).toContainText('大家好');

  // 静音状态同步给其他人
  await alice.getByTestId('mic').click();
  await expect(bob.getByLabel(/已静音|Muted/).first()).toBeVisible();

  // 使用启动横幅中的管理员令牌
  await alice.getByTestId('more').click();
  await alice.getByTestId('more-redeem').click();
  await alice.getByTestId('redeem-input').fill(server.adminToken);
  await alice.getByTestId('redeem-submit').click();
  await expect(alice.getByTestId('redeem-result')).toContainText(/管理员|Admin/);
  await alice.keyboard.press('Escape');

  // 管理面板：改服务器名称，Bob 实时看到
  await alice.getByTestId('more').click();
  await alice.getByTestId('more-admin').click();
  await alice.getByTestId('admin-name').fill('E2E 服务器');
  await alice.getByTestId('admin-save').click();
  await expect(bob.getByTestId('server-name')).toHaveText('E2E 服务器');
  await alice.keyboard.press('Escape');

  // 离开
  await bob.getByTestId('leave').click();
  await expect(bob.getByTestId('connect')).toBeVisible();
});
