/// <reference types="node" />
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';

const MAIN = resolve(import.meta.dirname, '../dist/main.cjs');
let server: TestServer;

test.beforeAll(async () => {
  server = await startServer({ HANE_TLS_MODE: 'self-signed' });
});
test.afterAll(async () => {
  await server?.stop();
});

async function launch(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, HANE_E2E: '1', HANE_USER_DATA: userData },
    // 仓库放在网络共享（SMB）上时，Electron.app 内部的符号链接不可用：用 HANE_ELECTRON_EXE 指向本地磁盘上的 Electron
    executablePath: process.env.HANE_ELECTRON_EXE || undefined,
  });
  const win = await app.firstWindow();
  // 屏幕画面由测试采集源提供（无法在测试中采集真实屏幕）
  await win.waitForFunction(() => (window as any).__hane);
  await win.evaluate(() => {
    (window as any).__hane.media.shareTrackFactory = async () => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.getContext('2d')!.fillRect(0, 0, 10, 10);
      return c.captureStream(15).getVideoTracks()[0];
    };
  });
  win.on('pageerror', (e) => console.error('[desktop] pageerror', e));
  return { app, win };
}

async function connect(win: Page) {
  await win.getByTestId('address').fill(`127.0.0.1:${server.port}`);
  await win.getByTestId('connect').click();
  // 第一次使用还没有昵称：在弹出的对话框里填写
  const nickname = win.getByTestId('nickname');
  if (await nickname.waitFor({ timeout: 2000 }).then(() => true, () => false)) {
    await nickname.fill('桌面用户');
    await win.getByTestId('join-submit').click();
  }
}

test('desktop app: TOFU pinning, sandbox, share picker + content protection, persistent identity, fingerprint change warning', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'hane-desktop-'));

  // 第一次连接：自签名证书被记住，媒体连上
  let { app, win } = await launch(userData);
  expect(await win.evaluate(() => typeof (window as any).require)).toBe('undefined'); // 渲染进程没有 Node
  expect(await win.evaluate(() => location.protocol)).toBe('app:');
  await connect(win);
  await expect(win.getByTestId('server-name')).toBeVisible();
  const pins = JSON.parse(readFileSync(join(userData, 'pins.json'), 'utf8')).pins;
  expect(pins['127.0.0.1']).toBe(server.fingerprint);
  await expect.poll(() => win.evaluate(() => (window as any).__hane.media.state.getState().status), { timeout: 20_000 }).toBe('connected');
  // 默认的 AI 降噪在 app:// 下能加载（WASM 以字节传进 AudioWorklet 编译；编译好的模块在这里传不进去）
  expect(await win.evaluate(() => (window as any).__hane.media.state.getState().prefs.ns)).toBe('ai');
  await expect.poll(() => win.evaluate(() => (window as any).__hane.media.levels.getState().local?.ns), { timeout: 20_000 }).toBe('active');
  const uid = await win.evaluate(() => (window as any).__hane.client.store.getState().self.uid);

  // 自定义共享选择器：选来源 + 模式 → 共享开始 → 本应用窗口开启内容保护（不进入共享画面）→ 停止后关闭
  await win.getByTestId('share').click();
  await win.getByTestId('picker-source').first().click();
  await win.getByText(/清晰优先|Clarity/).first().click();
  await win.getByTestId('picker-start').click();
  await expect(win.getByTestId('share-bar')).toBeVisible();
  await expect(win.getByTestId('share-intent')).toHaveValue('clarity');
  // 内容保护只有 macOS / Windows 支持（Linux 上 isContentProtected() 恒为 false），Linux 上检查我们请求的状态
  const protectedNow = () =>
    process.platform === 'linux'
      ? app.evaluate(() => (globalThis as any).__haneContentProtection)
      : app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isContentProtected());
  await expect.poll(protectedNow).toBe(true);
  await win.getByTestId('share-stop').click();
  await expect(win.getByTestId('share-bar')).toHaveCount(0);
  // 停止后关闭内容保护。macOS 上 isContentProtected() 关闭后仍返回 true（Electron 在该系统上的行为），所以检查我们请求的状态
  await expect.poll(() => app.evaluate(() => (globalThis as any).__haneContentProtection)).toBe(false);
  await app.close();

  // 记住的指纹被改掉（模拟服务器换了证书或者被中间人冒充）：拒绝连接并全屏警告
  writeFileSync(join(userData, 'pins.json'), JSON.stringify({ pins: { '127.0.0.1': 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } }));
  ({ app, win } = await launch(userData));
  await connect(win);
  const warning = win.getByTestId('tofu-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(server.fingerprint);
  await expect(win.getByTestId('server-name')).toHaveCount(0);

  // 取消：回到连接页；再次连接时仍然提示（预检拦下，Chromium 没有发起连接，也就没有缓存失败结果）
  await win.getByTestId('tofu-cancel').click();
  await expect(warning).toHaveCount(0);
  await expect(win.getByTestId('connect')).toBeVisible();
  await win.getByTestId('connect').click();
  await expect(warning).toBeVisible();

  // 用户确认是正常变化：改为信任新指纹并重新连接；身份（UID）跨重启保持不变
  await win.getByTestId('tofu-accept').click();
  await expect(win.getByTestId('server-name')).toBeVisible();
  expect(JSON.parse(readFileSync(join(userData, 'pins.json'), 'utf8')).pins['127.0.0.1']).toBe(server.fingerprint);
  expect(await win.evaluate(() => (window as any).__hane.client.store.getState().self.uid)).toBe(uid);
  await app.close();
});
