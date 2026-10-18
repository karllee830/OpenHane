import { OpenHaneClient } from '@hane/core';
import { MediaSession, isE2EESupported, probeVideoDecode, videoDecodeCaps, type AudioPrefs } from '@hane/media';
import { Platform } from '@hane/protocol';
import { App } from '@hane/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '../shared/ipc';
import { createDesktopPlatform } from './platform';
import '../../../web/src/index.css';

const bridge = (window as unknown as { haneDesktop: DesktopBridge }).haneDesktop;
const platform = createDesktopPlatform(bridge);
const platformKind = { win32: Platform.WINDOWS, linux: Platform.LINUX, darwin: Platform.MACOS }[bridge.info.platform] ?? Platform.UNSPECIFIED;
void probeVideoDecode(); // 硬件解码能力：连接前探测（几毫秒），随 ClientHello 上报
const client = new OpenHaneClient({
  identity: platform.identity,
  trust: platform.trust,
  appVersion: bridge.info.version,
  platform: platformKind,
  osVersion: navigator.userAgent.slice(0, 120),
  videoDecodeCaps,
  e2eeSupported: isE2EESupported,
});
const media = new MediaSession(client, platform.storage.get<Partial<AudioPrefs>>('audioPrefs'));
media.state.subscribe((s, prev) => {
  if (s.prefs !== prev.prefs) platform.storage.set('audioPrefs', s.prefs);
});
// 调试与端到端测试使用（__haneShareOverrides 由测试在页面加载前注入，例如共享当前标签页）
const w = window as unknown as { __hane: unknown; __haneShareOverrides?: Record<string, unknown>; __haneShareTrack?: () => Promise<MediaStreamTrack> };
w.__hane = { client, media };
if (w.__haneShareOverrides) media.shareCaptureOverrides = w.__haneShareOverrides;
if (w.__haneShareTrack) media.shareTrackFactory = w.__haneShareTrack;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App services={{ platform, client, media }} />
  </StrictMode>,
);
