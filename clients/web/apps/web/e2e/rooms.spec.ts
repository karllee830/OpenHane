import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

let server: TestServer;
let browser: Browser;

// 每个测试一台独立的服务器：首个管理员令牌只能使用一次
test.beforeEach(async () => {
  server = await startServer();
});
test.afterEach(async () => {
  await server?.stop();
});

test.beforeAll(async () => {
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
});

// 常开 + 关闭降噪：假麦克风的正弦波原样发出，便于确认切换房间后声音不断
const OPEN_MIC = { ns: 'off', mode: 'open' };

async function join(nickname: string, url = server.address, prefs: Record<string, unknown> = OPEN_MIC): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((p) => localStorage.setItem('hane.audioPrefs', JSON.stringify(p)), prefs);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(url);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await expect.poll(() => mediaStatus(page), { timeout: 20_000 }).toBe('connected');
  return page;
}

const mediaStatus = (p: Page) => p.evaluate(() => (window as any).__hane.media.state.getState().status);
const mediaRoom = (p: Page) => p.evaluate(() => (window as any).__hane.media.liveRoom?.name ?? null);
const lastSwitch = (p: Page) => p.evaluate(() => (window as any).__hane.media.state.getState().lastSwitch);
const micPublished = (p: Page) => p.evaluate(() => !!(window as any).__hane.media.liveRoom?.localParticipant.getTrackPublication('microphone'));

/** 远端音频的累计能量（WebRTC 统计） */
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

test('rooms: create, fast switch without audio gap, password, moderation, drag to move, close, kick', async () => {
  const alice = await join('Alice');
  const bob = await join('Bob');
  await alice.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);

  // 新建带密码的房间并立即进入：「先连后断」，切换 ≤ 1 秒、麦克风空档 ≤ 300 ms
  await alice.getByTestId('room-create').click();
  await alice.getByTestId('room-name').fill('设计评审');
  await alice.getByTestId('room-password').fill('pw');
  await alice.getByTestId('room-submit').click();
  await expect.poll(() => lastSwitch(alice), { timeout: 10_000 }).not.toBeNull();
  const sw = await lastSwitch(alice);
  console.log('room switch (create):', sw);
  expect(sw.totalMs).toBeLessThan(1000);
  expect(sw.gapMs).toBeLessThan(300);
  expect(await mediaRoom(alice)).toMatch(/^r_/);
  expect(await micPublished(alice)).toBe(true);

  // Bob：房间需要密码；输错提示，输对进入
  const room = bob.getByTestId('room-设计评审');
  await expect(room).toBeVisible();
  await room.getByTestId('room-enter').click();
  await bob.getByTestId('room-password-input').fill('wrong');
  await bob.keyboard.press('Enter');
  await expect(bob.getByText(/房间密码不正确|Wrong room password/)).toBeVisible();
  await bob.getByTestId('room-password-input').fill('pw');
  await bob.keyboard.press('Enter');
  await expect.poll(() => mediaRoom(bob), { timeout: 10_000 }).toMatch(/^r_/);
  await expect.poll(() => lastSwitch(bob), { timeout: 10_000 }).not.toBeNull();
  const bsw = await lastSwitch(bob);
  console.log('room switch (join):', bsw);
  expect(bsw.totalMs).toBeLessThan(1000);
  expect(bsw.gapMs).toBeLessThan(300);
  // 新房间里互相听得到
  await expect.poll(() => remoteAudioEnergy(alice), { timeout: 15_000 }).toBeGreaterThan(0.01);

  // 主持操作：强制静音 → Bob 收到提示、麦克风被 SFU 取消发布、按钮显示「已被主持人静音」
  await alice.getByTestId('member-Bob').click();
  await alice.getByTestId('mod-mute').click();
  await expect(bob.getByTestId('notice')).toContainText(/静音|muted/);
  await expect(bob.getByTestId('mic')).toHaveAttribute('aria-label', /已被主持人静音|Muted by a moderator/);
  await expect.poll(() => micPublished(bob), { timeout: 10_000 }).toBe(false);
  // 解除：麦克风重新发布（保持静音，由本人开麦）
  await alice.getByTestId('member-Bob').click();
  await alice.getByTestId('mod-unmute').click();
  await expect(bob.getByTestId('notice')).toContainText(/允许你发言|allowed you to speak/);
  await expect.poll(() => micPublished(bob), { timeout: 10_000 }).toBe(true);
  expect(await bob.evaluate(() => (window as any).__hane.media.state.getState().micMuted)).toBe(true);

  // 拖拽 Bob 到主会议：Bob 被移动并收到提示
  await alice.getByTestId('member-Bob').dragTo(alice.getByTestId('room-主会议'));
  await expect(bob.getByTestId('notice')).toContainText(/移动到|moved you/);
  await expect.poll(() => mediaRoom(bob), { timeout: 10_000 }).toBe('main');

  // 关闭房间：Alice 回到主会议
  await alice.getByTestId('room-设计评审').getByTestId('room-menu').click();
  await alice.getByTestId('room-close').click();
  await expect(alice.getByTestId('notice')).toContainText(/已关闭|was closed/);
  await expect.poll(() => mediaRoom(alice), { timeout: 10_000 }).toBe('main');
  await expect(alice.getByTestId('room-设计评审')).toHaveCount(0);

  // 踢出：Bob 回到连接页，看到操作者和原因
  await alice.getByTestId('member-Bob').click();
  await alice.getByTestId('mod-kick').click();
  await alice.getByTestId('mod-reason').fill('请注意言行');
  await alice.getByTestId('mod-confirm').click();
  await expect(bob.getByTestId('connect-error')).toContainText(/Alice/);
  await expect(bob.getByTestId('connect-error')).toContainText('请注意言行');

  // 审计日志里有这些操作
  await alice.getByTestId('more').click();
  await alice.getByTestId('more-admin').click();
  await alice.getByTestId('admin-tab-audit').click();
  await expect(alice.getByTestId('audit-list')).toContainText('moderate.kick');
  await expect(alice.getByTestId('audit-list')).toContainText('room.close');
});

test('invite link: landing page, joins without the server password and grants a role', async () => {
  const admin = await join('Admin');
  await admin.evaluate((t) => (window as any).__hane.client.redeemToken(t), server.adminToken);
  await admin.evaluate(() => (window as any).__hane.client.updateSettings({ 'server.password': '"secret"' }));

  await admin.getByTestId('more').click();
  await admin.getByTestId('more-admin').click();
  await admin.getByTestId('admin-tab-invites').click();
  await admin.getByRole('combobox').nth(1).selectOption({ index: 1 }); // 附带角色：主持人
  await admin.getByTestId('invite-create').click();
  const link = (await admin.getByTestId('invite-link').textContent())!.trim();
  expect(link).toMatch(/\/j\/[A-Za-z0-9_-]+$/);

  // 打开邀请链接：落地页 → 在浏览器中加入 → 不需要密码，获得主持人角色
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guest = await ctx.newPage();
  await guest.goto(server.address + new URL(link).pathname);
  await expect(guest.getByTestId('invite-open-app')).toHaveAttribute('href', /^openhane:\/\/.*invite=/);
  await guest.getByTestId('invite-browser').click();
  await expect(guest.getByTestId('invite-banner')).toBeVisible();
  await guest.getByTestId('nickname').fill('Guest');
  await guest.getByTestId('connect').click();
  await expect(guest.getByTestId('server-name')).toBeVisible();
  expect(await guest.evaluate(() => (window as any).__hane.client.store.getState().self.role)).toBe(2); // ROLE_MODERATOR

  await admin.evaluate(() => (window as any).__hane.client.updateSettings({ 'server.password': 'null' }));
});
