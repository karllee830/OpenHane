import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';

let server: TestServer;
let browser: Browser;

test.beforeAll(async () => {
  server = await startServer();
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen', // getDisplayMedia 自动选择（假设备提供屏幕画面）
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function join(nickname: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(server.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  return page;
}

const videoSize = (page: Page, testId: string) =>
  page.evaluate((id) => {
    const v = document.querySelector(`[data-testid="${id}"]`) as HTMLVideoElement | null;
    return v ? { w: v.videoWidth, h: v.videoHeight } : null;
  }, testId);

test('screen share: grant, publish, view, switch mode, stop; camera', async () => {
  const alice = await join('Alice');
  const bob = await join('Bob');
  await expect(bob.getByTestId('stage-tile')).toHaveCount(2);

  // Alice 共享屏幕
  await alice.getByTestId('share').click();
  await expect(alice.getByTestId('share-bar')).toBeVisible();
  await expect(alice.getByTestId('share-state')).toContainText(/\d+p \d+fps/);

  // Bob 切换到共享焦点布局，并且真正收到画面
  await expect(bob.getByTestId('share-stage')).toBeVisible();
  await expect.poll(async () => (await videoSize(bob, 'share-video'))?.w ?? 0, { timeout: 20_000 }).toBeGreaterThan(100);
  await expect(bob.getByTestId('share-label')).toContainText(/Alice.*\d+p · \d+ fps/, { timeout: 10_000 });
  // 不放大：发送分辨率不超过采集源（假屏幕约 1280×800）
  const { source, params } = await alice.evaluate(() => (window as any).__hane.media.state.getState().share);
  expect(source.height).toBeLessThanOrEqual(1080);
  expect(params.height).toBeLessThanOrEqual(source.height);

  // 切换到「流畅优先」：引擎立即进入流畅模式（帧率提高）
  await alice.getByTestId('share-intent').selectOption('smoothness');
  await expect(alice.getByTestId('share-state')).toContainText(/(30|60)fps/);

  // 自定义：在对话框里设分辨率 / 帧率 / 码率，应用后发送端立即按这些参数发送；观众端收到「自定义」意图
  await alice.getByTestId('share-intent').selectOption('custom');
  await alice.getByTestId('share-custom-height-480').check({ force: true }); // 胶囊按钮里的原生 radio 视觉上隐藏
  await alice.getByTestId('share-custom-fps-15').check({ force: true });
  await alice.getByTestId('share-custom-kbps').fill('900');
  await alice.getByTestId('share-custom-apply').click();
  await expect(alice.getByTestId('share-state')).toContainText('480p 15fps · 900 kbps');
  await expect
    .poll(() =>
      alice.evaluate(() => {
        const track = (window as any).__hane.media.liveShareRoom.localParticipant.getTrackPublication('screen_share')?.track; // 屏幕共享在共享连接上
        const enc = track?.sender?.getParameters().encodings?.[0];
        // 发送高度 = 采集高度 ÷ 缩小倍数
        return enc && { maxBitrate: enc.maxBitrate, maxFramerate: enc.maxFramerate, height: Math.round(track.mediaStreamTrack.getSettings().height / enc.scaleResolutionDownBy) };
      }),
    )
    .toEqual({ maxBitrate: 900_000, maxFramerate: 15, height: 480 });
  await expect
    .poll(() => bob.evaluate(() => Object.values((window as any).__hane.client.store.getState().rooms).flatMap((r: any) => r.shares ?? [])[0]?.intent))
    .toBe(4); // ShareIntent.CUSTOM

  // 停止共享：许可收回，Bob 回到宫格
  await alice.getByTestId('share-stop').click();
  await expect(alice.getByTestId('share-bar')).toHaveCount(0);
  await expect(bob.getByTestId('share-stage')).toHaveCount(0);
  await expect(bob.getByTestId('stage-tile')).toHaveCount(2);

  // 摄像头：Bob 开启，Alice 看到画面
  await bob.getByTestId('camera').click();
  await expect.poll(async () => (await videoSize(alice, 'camera-video'))?.w ?? 0, { timeout: 20_000 }).toBeGreaterThan(100);
  const p = await alice.evaluate(() => {
    const s = (window as any).__hane.client.store.getState();
    return Object.values(s.participants).find((x: any) => x.nickname === 'Bob') as any;
  });
  expect(p.cameraOn).toBe(true);
});

test('smart mode switches to smooth on moving content and back to clarity when it stops', async () => {
  // 无头浏览器无法采集真实的屏幕或标签页：用生成的视频帧代替采集源，
  // 内容由测试控制。抽帧分析 → 自适应引擎 → 编码参数这条链路与真实共享完全相同。
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__haneAnimate = false;
    w.__haneShareTrack = async () => {
      // 用定时器按 30 帧 / 秒主动生成视频帧（MediaStreamTrackGenerator），帧率不受渲染性能影响：
      // CI 的机器没有 GPU，canvas.captureStream + requestAnimationFrame 达不到流畅模式的 20 帧门槛
      const c = new OffscreenCanvas(640, 360);
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#222';
      g.font = '24px sans-serif';
      for (let y = 40; y < 360; y += 36) g.fillText('羽见文档内容 document text line', 30, y);
      const gen = new (globalThis as any).MediaStreamTrackGenerator({ kind: 'video' });
      const writer = gen.writable.getWriter();
      let ts = 0;
      setInterval(() => {
        if (w.__haneAnimate) {
          // 整屏换成随机颜色：所有像素逐帧变化，接近视频 / 游戏画面
          g.fillStyle = `rgb(${(Math.random() * 255) | 0},${(Math.random() * 255) | 0},${(Math.random() * 255) | 0})`;
          g.fillRect(0, 0, 640, 360);
        }
        void writer.write(new VideoFrame(c, { timestamp: (ts += 33_333) }));
      }, 33);
      return gen as MediaStreamTrack;
    };
  });
  const page = await ctx.newPage();
  await page.goto(server.address);
  await page.getByTestId('nickname').fill('Mover');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await page.getByTestId('share').click();
  await expect(page.getByTestId('share-state')).toBeVisible();
  const mode = () => page.evaluate(() => (window as any).__hane.media.state.getState().share?.params.mode);
  expect(await mode()).toBe('text');
  await page.waitForTimeout(1500);
  expect(await mode()).toBe('text'); // 静止文档保持清晰模式

  // 开始播放「视频」：≥ 2 秒的大面积高帧率变化后切换到流畅模式
  await page.evaluate(() => ((window as any).__haneAnimate = true));
  await expect
    .poll(mode, { timeout: 10_000 })
    .toBe('motion')
    .catch(async (e) => {
      console.log('share signals at failure:', JSON.stringify(await page.evaluate(() => (window as any).__hane.media.state.getState().share?.signals)));
      throw e;
    });
  await expect(page.getByTestId('share-state')).toContainText(/流畅|smooth/);

  // 停止播放：在流畅模式至少停留 4 秒、活跃占比降到 40% 以下后回到清晰模式
  await page.evaluate(() => ((window as any).__haneAnimate = false));
  await expect.poll(mode, { timeout: 15_000 }).toBe('text');
  await ctx.close();
});
