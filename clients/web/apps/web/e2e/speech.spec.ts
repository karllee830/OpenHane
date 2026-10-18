import { chromium, expect, test } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { speechWav } from './fixtures';

const wav = speechWav();
let server: TestServer;

test.skip(!wav, 'needs macOS `say` to synthesize speech');

test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

// 说话方：语音激活 + 指定的降噪档位；收听方：默认设置。说话时语音概率高、门打开，收听方看到说话指示
// 两个用例共用一个服务端：昵称加上后缀，避免与上一个用例还没离开的成员重名
async function speakerOpensGate(tag: string, prefs: Record<string, unknown>) {
  const speaker = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const listener = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const join = async (b: typeof speaker, name: string, p?: Record<string, unknown>) => {
      const ctx = await b.newContext();
      if (p) await ctx.addInitScript((v) => localStorage.setItem('hane.audioPrefs', JSON.stringify(v)), p);
      const page = await ctx.newPage();
      await page.goto(server.address);
      await page.getByTestId('nickname').fill(name);
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('server-name')).toBeVisible();
      return page;
    };
    const s = await join(speaker, `Speaker${tag}`, prefs);
    const l = await join(listener, `Listener${tag}`);
    await expect.poll(() => s.evaluate(() => (window as any).__hane.media.levels.getState().local?.ns), { timeout: 30_000 }).toBe('active');
    const seen = await s.evaluate(async () => {
      const levels = (window as any).__hane.media.levels;
      let maxVad = 0;
      let opened = false;
      const end = performance.now() + 8000;
      while (performance.now() < end) {
        const st = levels.getState().local;
        maxVad = Math.max(maxVad, st?.vad ?? 0);
        opened ||= !!st?.speaking;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { maxVad, opened };
    });
    expect(seen.maxVad).toBeGreaterThan(0.8);
    expect(seen.opened).toBe(true);
    // 收听方看到说话方在说话（SFU 的音量检测）
    await expect(l.getByTestId('stage-tile').filter({ hasText: `Speaker${tag}` })).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 });
  } finally {
    await speaker.close();
    await listener.close();
  }
}

test('voice activation with AI noise suppression (DeepFilterNet) opens on real speech', async () => {
  await speakerOpensGate('AI', { ns: 'ai', nsChosen: true, mode: 'voice' });
});

test('voice activation with RNNoise opens on real speech', async () => {
  await speakerOpensGate('RN', { ns: 'standard', nsChosen: true, mode: 'voice' });
});
