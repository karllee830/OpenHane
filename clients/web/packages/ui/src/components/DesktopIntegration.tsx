import { useEffect } from 'react';
import { useVoiceActions } from '../actions';
import { useServices } from '../services';

/** 托盘图标与客户端状态同步，托盘菜单的操作转给客户端（只在提供托盘的平台生效）。 */
export function DesktopIntegration() {
  const { platform, client, media } = useServices();
  const { setMuted, setDeafened } = useVoiceActions();
  const tray = platform.tray;

  useEffect(() => {
    if (!tray) return;
    const push = () => {
      const c = client.store.getState();
      const m = media.state.getState();
      tray.setState({ connected: c.status === 'connected', meeting: c.status === 'connected' || c.status === 'reconnecting', muted: m.micMuted, deafened: m.deafened, serverName: c.serverInfo?.name });
    };
    push();
    const u1 = client.store.subscribe((s, p) => {
      if (s.status !== p.status || s.serverInfo !== p.serverInfo) push();
    });
    const u2 = media.state.subscribe((s, p) => {
      if (s.micMuted !== p.micMuted || s.deafened !== p.deafened) push();
    });
    return () => {
      u1();
      u2();
    };
  }, [tray, client, media]);

  // 共享期间本应用窗口不进入共享画面
  useEffect(() => {
    const picker = platform.screenPicker;
    if (!picker) return;
    return media.state.subscribe((s, p) => {
      if (!!s.share !== !!p.share) picker.setSharing(!!s.share);
    });
  }, [platform, media]);

  useEffect(
    () =>
      tray?.onAction((a) => {
        const m = media.state.getState();
        if (a === 'toggle-mute') void setMuted(!m.micMuted);
        else if (a === 'toggle-deafen') void setDeafened(!m.deafened);
        else if (a === 'leave') client.disconnect();
      }),
    [tray, media, client, setMuted, setDeafened],
  );
  return null;
}
