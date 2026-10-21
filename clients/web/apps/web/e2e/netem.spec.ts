// 弱网测试：Alice 的媒体只走 server/cmd/hanenetem 的 TURN 中继（在中继上注入限速、延迟、抖动、丢包），Bob 直连。
// 「Bob 听 Alice」经过 Alice 受损的上行，「Alice 听 Bob」经过 Alice 受损的下行，与「自己这边网络差」的真实情况一致。
// 每个场景测 10 秒：丢包率、隐藏帧比例（播放端用丢包隐藏补出来的采样占比，越低越好）、抖动缓冲延迟、往返时延。
//   HANE_NETEM=1 HANE_SKIP_DESKTOP_BUILD=1 npx playwright test netem      （HANE_NETEM_DEBUG=1 打印恢复过程的时间线）
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { startServer, type TestServer } from '../../../packages/core/src/testing/server';
import { sineWav } from './fixtures';

// 整套约 4 分钟：媒体相关改动后运行（HANE_NETEM=1），默认跳过
test.skip(!process.env.HANE_NETEM, 'HANE_NETEM 未设置');

const SERVER_DIR = resolve(fileURLToPath(import.meta.url), '../../../../../../server');

let server: TestServer;
let browser: Browser;
let netem: ChildProcess;
let control = '';
let turnPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

// 每个测试一台独立的服务器：上一个测试的成员在断线宽限期内仍会显示在宫格里
test.beforeEach(async () => {
  server = await startServer();
});

test.beforeAll(async () => {
  const bin = joinPath(mkdtempSync(joinPath(tmpdir(), 'hane-netem-')), 'hanenetem');
  execFileSync('go', ['build', '-o', bin, './cmd/hanenetem'], { cwd: SERVER_DIR, stdio: 'inherit' });
  turnPort = await freePort();
  const controlPort = await freePort();
  control = `http://127.0.0.1:${controlPort}`;
  netem = spawn(bin, ['-listen', `127.0.0.1:${turnPort}`, '-control', `127.0.0.1:${controlPort}`], { stdio: ['ignore', 'inherit', 'inherit'] });
  await expect.poll(() => fetch(`${control}/stats`).then((r) => r.ok).catch(() => false), { timeout: 10_000 }).toBe(true);
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sineWav()}`, '--autoplay-policy=no-user-gesture-required'],
  });
});

// 每个测试结束时让参与者离开（否则留在房间里占用中继带宽、改变宫格布局）
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  await server?.stop();
});

test.afterAll(async () => {
  await browser?.close();
  netem?.kill();
});

async function join(nickname: string, relayOnly: boolean): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  await ctx.addInitScript(() => localStorage.setItem('hane.audioPrefs', JSON.stringify({ ns: 'off', mode: 'open' })));
  if (relayOnly) {
    await ctx.addInitScript((port) => {
      (globalThis as any).__haneRtcConfig = {
        iceTransportPolicy: 'relay',
        iceServers: [{ urls: [`turn:127.0.0.1:${port}?transport=udp`], username: 'hane', credential: 'hane' }],
      };
    }, turnPort);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${nickname}] pageerror`, e));
  await page.goto(server.address);
  await page.getByTestId('nickname').fill(nickname);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('server-name')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hane.media.state.getState().status), { timeout: 30_000 }).toBe('connected');
  return page;
}

interface AudioStats {
  received: number;
  lost: number;
  samples: number;
  concealed: number;
  jbDelay: number;
  jbCount: number;
  rttMs: number | null;
}

/** 远端音频的累计统计（inbound-rtp）和当前往返时延（选中的候选对） */
function audioStats(page: Page): Promise<AudioStats> {
  return page.evaluate(async () => {
    const room = (window as any).__hane.media.liveRoom;
    const out = { received: 0, lost: 0, samples: 0, concealed: 0, jbDelay: 0, jbCount: 0, rttMs: null as number | null };
    for (const p of room?.remoteParticipants.values() ?? []) {
      for (const pub of p.audioTrackPublications.values()) {
        const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
        report?.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            out.received += s.packetsReceived ?? 0;
            out.lost += s.packetsLost ?? 0;
            out.samples += s.totalSamplesReceived ?? 0;
            out.concealed += (s.concealedSamples ?? 0) - (s.silentConcealedSamples ?? 0);
            out.jbDelay += s.jitterBufferDelay ?? 0;
            out.jbCount += s.jitterBufferEmittedCount ?? 0;
          }
          if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime !== undefined) out.rttMs = s.currentRoundTripTime * 1000;
        });
      }
    }
    return out;
  });
}

interface Window {
  lossPct: number;
  concealPct: number;
  jitterBufferMs: number;
  rttMs: number | null;
  packets: number;
}

async function measure(page: Page, ms: number): Promise<Window> {
  const a = await audioStats(page);
  await page.waitForTimeout(ms);
  const b = await audioStats(page);
  const received = b.received - a.received;
  const lost = b.lost - a.lost;
  const samples = b.samples - a.samples;
  return {
    lossPct: (lost / Math.max(1, received + lost)) * 100,
    concealPct: (Math.max(0, b.concealed - a.concealed) / Math.max(1, samples)) * 100,
    jitterBufferMs: ((b.jbDelay - a.jbDelay) / Math.max(1, b.jbCount - a.jbCount)) * 1000,
    rttMs: b.rttMs,
    packets: received,
  };
}

const setScenario = (name: string) => fetch(`${control}/profile?name=${name}`).then((r) => expect(r.ok).toBe(true));
const fmt = (w: Window) =>
  `loss ${w.lossPct.toFixed(1).padStart(5)}%  concealed ${w.concealPct.toFixed(1).padStart(5)}%  jitter buffer ${w.jitterBufferMs.toFixed(0).padStart(4)} ms  packets ${String(w.packets).padStart(4)}`;

test('weak network matrix: voice stays intelligible on a bad uplink / downlink', async () => {
  test.setTimeout(240_000);
  const alice = await join('Alice', true);
  const bob = await join('Bob', false);
  // 确认 Alice 确实只走中继
  const allocations = await fetch(`${control}/stats`).then((r) => r.json());
  expect(allocations.allocations).toBeGreaterThan(0);
  await expect.poll(async () => (await audioStats(bob)).received, { timeout: 15_000 }).toBeGreaterThan(50);
  await expect.poll(async () => (await audioStats(alice)).received, { timeout: 15_000 }).toBeGreaterThan(50);

  const results: Record<string, { up: Window; down: Window }> = {};
  for (const name of ['good', 'wifi', '4g', 'poor', 'terrible', 'burst']) {
    await setScenario(name);
    await alice.waitForTimeout(3000); // 让拥塞控制和抖动缓冲适应
    const [up, down] = await Promise.all([measure(bob, 10_000), measure(alice, 10_000)]);
    results[name] = { up, down };
    console.log(`${name.padEnd(9)} Bob←Alice(上行) ${fmt(up)}\n${''.padEnd(9)} Alice←Bob(下行) ${fmt(down)}  rtt ${down.rttMs?.toFixed(0) ?? '-'} ms`);
  }
  console.log(JSON.stringify(await fetch(`${control}/stats`).then((r) => r.json())));
  await setScenario('off');

  // 各场景都要有声音（没有中断）；随机丢包由 RED 冗余编码补回，隐藏比例很低；20% 突发丢包时偶有瑕疵但不中断
  const maxConceal: Record<string, number> = { good: 1, wifi: 1, '4g': 1, poor: 2, terrible: 4, burst: 25 };
  for (const [name, r] of Object.entries(results)) {
    for (const [dir, w] of [['up', r.up], ['down', r.down]] as const) {
      expect(w.packets, `${name} ${dir} packets`).toBeGreaterThan(300);
      expect(w.concealPct, `${name} ${dir} concealed`).toBeLessThan(maxConceal[name]!);
    }
  }
});

interface VideoWindow {
  height: number;
  fps: number;
  kbps: number;
  paused: boolean;
}

/** 收到的对方摄像头：分辨率、帧率、码率（窗口内），以及 SFU 是否暂停了这路视频 */
async function measureVideo(page: Page, ms: number): Promise<VideoWindow> {
  const snap = () =>
    page.evaluate(async () => {
      const room = (window as any).__hane.media.liveRoom;
      let bytes = 0;
      let frames = 0;
      let height = 0;
      let paused = false;
      for (const p of room?.remoteParticipants.values() ?? []) {
        for (const pub of p.videoTrackPublications.values()) {
          if (pub.source !== 'camera') continue;
          paused ||= pub.track?.streamState === 'paused';
          const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport();
          report?.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') {
              bytes += s.bytesReceived ?? 0;
              frames += s.framesDecoded ?? 0;
              height = Math.max(height, s.frameHeight ?? 0);
            }
          });
        }
      }
      return { bytes, frames, height, paused, t: performance.now() };
    });
  const a = await snap();
  await page.waitForTimeout(ms);
  const b = await snap();
  const sec = (b.t - a.t) / 1000;
  return { height: b.height, fps: (b.frames - a.frames) / sec, kbps: ((b.bytes - a.bytes) * 8) / 1000 / sec, paused: b.paused };
}

const fmtV = (v: VideoWindow) => `${String(v.height).padStart(4)}p ${v.fps.toFixed(0).padStart(3)} fps ${v.kbps.toFixed(0).padStart(5)} kbps${v.paused ? '  [paused]' : ''}`;

test('weak network: camera video degrades by layer instead of freezing', async () => {
  test.setTimeout(240_000);
  await setScenario('off');
  const alice = await join('Alice', true);
  const bob = await join('Bob', false);
  for (const p of [alice, bob]) await p.evaluate(() => (window as any).__hane.media.setCameraEnabled(true));
  await expect.poll(async () => (await measureVideo(bob, 1000)).fps, { timeout: 20_000 }).toBeGreaterThan(5);
  await expect.poll(async () => (await measureVideo(alice, 1000)).fps, { timeout: 20_000 }).toBeGreaterThan(5);
  if (process.env.HANE_SHOT) await bob.screenshot({ path: process.env.HANE_SHOT });
  const results: Record<string, { up: VideoWindow; down: VideoWindow }> = {};
  for (const name of ['good', '4g', 'poor', 'terrible']) {
    await setScenario(name);
    await alice.waitForTimeout(8000); // 拥塞控制收敛、SFU 切换订阅层需要几秒
    const [up, down] = await Promise.all([measureVideo(bob, 8000), measureVideo(alice, 8000)]);
    results[name] = { up, down };
    console.log(`${name.padEnd(9)} Bob←Alice(上行) ${fmtV(up)}   Alice←Bob(下行) ${fmtV(down)}`);
  }
  await setScenario('off');
  // 不冻结：每个场景都有画面（最差的场景允许严重降帧，或者被 SFU 暂停并在界面上提示）；上行带宽不够时降到低一层
  for (const [name, r] of Object.entries(results)) {
    for (const [dir, v] of [['up', r.up], ['down', r.down]] as const) {
      if (name === 'terrible') expect(v.fps > 2 || v.paused, `${name} ${dir}: ${fmtV(v)}`).toBe(true);
      else expect(v.fps, `${name} ${dir}: ${fmtV(v)}`).toBeGreaterThan(name === 'poor' ? 5 : 8);
    }
  }
  expect(results.terrible!.up.height).toBeLessThan(results.good!.up.height);
});

test('network switch: media recovers after the path dies (relay allocations dropped) and after a 3 s outage', async () => {
  test.setTimeout(120_000);
  await setScenario('off');
  const alice = await join('Alice', true);
  const bob = await join('Bob', false);
  await expect.poll(async () => (await audioStats(bob)).received, { timeout: 15_000 }).toBeGreaterThan(50);

  /** 从 t0 起到 Bob 重新持续收到 Alice 的声音（1 秒内新增 ≥ 30 个包）所用的时间 */
  const recovery = async (t0: number) => {
    let last = (await audioStats(bob)).received;
    for (;;) {
      await bob.waitForTimeout(1000);
      const now = (await audioStats(bob)).received;
      if (process.env.HANE_NETEM_DEBUG) console.log(new Date().toISOString().slice(17, 23), 'bob +', now - last);
      if (now - last >= 30 && Date.now() - t0 > 1500) return Date.now() - t0;
      last = now;
      if (Date.now() - t0 > 60_000) throw new Error('media did not recover within 60 s');
    }
  };

  // 网络中断 3 秒后恢复（同一条路径）
  let t0 = Date.now();
  await fetch(`${control}/blackout?ms=3000`);
  const outage = await recovery(t0);
  console.log('3 s outage: audio back after', outage, 'ms');
  expect(outage).toBeLessThan(6000);

  // 换网：中继分配全部失效，客户端需要发现路径断开、ICE 重启、重新分配中继
  if (process.env.HANE_NETEM_DEBUG) await alice.evaluate(() => {
    const room = (window as any).__hane.media.liveRoom;
    const log: string[] = ((window as any).__haneLog = []);
    const t = () => new Date().toISOString().slice(17, 23);
    for (const ev of ['reconnecting', 'reconnected', 'signalReconnecting', 'disconnected', 'connectionStateChanged', 'mediaDevicesError']) room.on(ev, (...a: any[]) => log.push(`${t()} ${ev} ${a.map(String).join(' ')}`));
    const pcs = [room.engine?.pcManager?.publisher?.pc, room.engine?.pcManager?.subscriber?.pc].filter(Boolean);
    pcs.forEach((pc: RTCPeerConnection, i: number) => {
      pc.addEventListener('iceconnectionstatechange', () => log.push(`${t()} pc${i} ice ${pc.iceConnectionState}`));
      pc.addEventListener('connectionstatechange', () => log.push(`${t()} pc${i} conn ${pc.connectionState}`));
    });
  });
  t0 = Date.now();
  await fetch(`${control}/reset`);
  const sw = await recovery(t0);
  console.log('path change: audio back after', sw, 'ms; media status', await alice.evaluate(() => (window as any).__hane.media.state.getState().status));
  if (process.env.HANE_NETEM_DEBUG) console.log((await alice.evaluate(() => (window as any).__haneLog)).join('\n'));
  // 路径悄无声息地失效（最坏情况）：浏览器 3–8 秒后才发现 ICE 断开，之后 2 秒内由看门狗触发 ICE 重启（live.ts watchIce）
  expect(sw).toBeLessThan(20_000);
});
