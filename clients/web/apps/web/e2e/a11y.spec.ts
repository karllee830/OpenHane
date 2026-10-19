// 无障碍检查：用 axe-core 检查主要页面和对话框，WCAG 2.1 A / AA 规则下不允许「严重」和「重大」问题。
import AxeBuilder from '@axe-core/playwright';
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

/** 检查当前页面；返回严重 / 重大问题的摘要（便于在失败信息里直接看到） */
async function audit(page: Page, name: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const all = result.violations.map((v) => `[${v.impact}] ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(' | ')}`);
  if (all.length) console.log(`${name}:\n  ${all.join('\n  ')}`);
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${name}: ${v.id} (${v.nodes.length})`);
}

test('main screens and dialogs have no serious accessibility violations', async () => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(server.address);
    await expect(page.getByTestId('nickname')).toBeVisible();
    problems.push(...(await audit(page, `${scheme} connect`)));

    await page.getByTestId('nickname').fill(`A11y-${scheme}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('server-name')).toBeVisible();
    if (scheme === 'light') await page.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);
    await page.waitForTimeout(500);
    problems.push(...(await audit(page, `${scheme} meeting`)));

    await page.evaluate(() => (window as any).__hane.media.setCameraEnabled(true));
    await expect(page.getByTestId('camera-video')).toBeVisible({ timeout: 10_000 });
    problems.push(...(await audit(page, `${scheme} meeting + camera`)));
    await page.evaluate(() => (window as any).__hane.media.setCameraEnabled(false));

    for (const dialog of ['settings', ...(scheme === 'light' ? ['admin'] : [])]) {
      await page.getByTestId('more').click();
      await page.getByTestId(`more-${dialog}`).click();
      await page.waitForTimeout(300);
      problems.push(...(await audit(page, `${scheme} ${dialog} dialog`)));
      await page.keyboard.press('Escape');
    }
    if (scheme === 'light') {
      await page.getByTestId('room-create').click();
      await page.waitForTimeout(300);
      problems.push(...(await audit(page, `${scheme} room dialog`)));
      await page.keyboard.press('Escape');
    }
    await ctx.close();
  }
  expect(problems).toEqual([]);
});
