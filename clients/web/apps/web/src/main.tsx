import { OpenHaneClient } from '@hane/core';
import { MediaSession, isE2EESupported, probeVideoDecode, videoDecodeCaps, type AudioPrefs } from '@hane/media';
import { createWebPlatform } from '@hane/platform';
import { Platform } from '@hane/protocol';
import { App } from '@hane/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const platform = createWebPlatform();
void probeVideoDecode(); // 硬件解码能力：连接前探测（几毫秒），随 ClientHello 上报
const client = new OpenHaneClient({
  identity: platform.identity,
  appVersion: __APP_VERSION__,
  platform: Platform.WEB,
  osVersion: navigator.userAgent.slice(0, 120),
  videoDecodeCaps,
  e2eeSupported: isE2EESupported,
  log: import.meta.env.DEV ? (...a) => console.debug('[hane]', ...a) : undefined,
});
const media = new MediaSession(client, platform.storage.get<Partial<AudioPrefs>>('audioPrefs'));
media.state.subscribe((s, prev) => {
  if (s.prefs !== prev.prefs) platform.storage.set('audioPrefs', s.prefs);
});

// 由羽见服务端提供页面时，直接连接同一地址；?server= 可以覆盖（开发时连接其他服务器）
const params = new URLSearchParams(location.search);
const defaultAddress = params.get('server') ?? (import.meta.env.PROD ? location.origin : undefined);
// 网页邀请链接 /j/<邀请码>，或 ?invite=
const invite = location.pathname.match(/^\/j\/([A-Za-z0-9_-]{4,64})\/?$/)?.[1] ?? params.get('invite') ?? undefined;

// 调试与端到端测试使用
// 调试与端到端测试使用（__haneShareOverrides 由测试在页面加载前注入，例如共享当前标签页）
const w = window as unknown as { __hane: unknown; __haneShareOverrides?: Record<string, unknown>; __haneShareTrack?: () => Promise<MediaStreamTrack> };
w.__hane = { client, media };
if (w.__haneShareOverrides) media.shareCaptureOverrides = w.__haneShareOverrides;
if (w.__haneShareTrack) media.shareTrackFactory = w.__haneShareTrack;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App services={{ platform, client, media }} defaultAddress={defaultAddress} invite={invite} />
  </StrictMode>,
);
