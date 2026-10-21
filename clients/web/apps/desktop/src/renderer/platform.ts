import { createWebPlatform, type PlatformServices } from '@hane/platform';
import type { DesktopBridge } from '../shared/ipc';

/** Electron 平台实现：身份、TOFU、全局热键、托盘、深链接由主进程提供；键值存储沿用 Web 实现。 */
export function createDesktopPlatform(bridge: DesktopBridge): PlatformServices {
  const web = createWebPlatform();
  let pttListener: ((pressed: boolean) => void) | null = null;
  bridge.onPtt((p) => pttListener?.(p));
  const update = bridge.getUpdateInfo();
  let updateState = update.state;
  let beta = update.beta;
  const updateListeners = new Set<(s: typeof updateState) => void>();
  bridge.onUpdateState((s) => {
    updateState = s;
    updateListeners.forEach((cb) => cb(s));
  });
  return {
    kind: 'electron',
    storage: web.storage,
    identity: { getMasterSeed: () => bridge.getMasterSeed() },
    trust: {
      seenSpki: (hostPort) => bridge.seenSpki(hostPort),
      onMismatch: (cb) => bridge.onTofuMismatch(cb),
      acceptFingerprint: (host, fp) => bridge.acceptFingerprint(host, fp),
      beforeConnect: (hostPort) => bridge.beforeConnect(hostPort),
      check: (hostPort) => bridge.checkFingerprint(hostPort),
    },
    hotkeys: {
      unavailableReason: bridge.info.hotkeyUnavailable,
      registerPushToTalk(code, onChange) {
        pttListener = onChange;
        void bridge.registerPtt(code);
        return () => {
          if (pttListener === onChange) {
            pttListener = null;
            void bridge.registerPtt('');
          }
        };
      },
    },
    tray: { setState: (s) => bridge.setTrayState(s), onAction: (cb) => bridge.onTrayAction(cb) },
    screenPicker: {
      listSources: () => bridge.listShareSources(),
      select: (id) => bridge.selectShareSource(id),
      setSharing: (active) => bridge.setSharing(active),
      audioSupported: false, // Windows 进程环回扩展完成后开启
    },
    deepLinks: { onLink: (cb) => bridge.onDeepLink(cb) },
    updates: update.store ? undefined : {
      automatic: update.automatic,
      state: () => updateState,
      onChange: (cb) => {
        updateListeners.add(cb);
        return () => updateListeners.delete(cb);
      },
      beta: () => beta,
      setBeta: (on) => {
        beta = on;
        bridge.setUpdateBeta(on);
      },
      check: () => bridge.checkForUpdates(),
      install: () => bridge.installUpdate(),
      releasesUrl: 'https://github.com/karllee830/OpenHane/releases',
    },
  };
}
