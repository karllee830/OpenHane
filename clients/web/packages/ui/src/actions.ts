import { useCallback } from 'react';
import { useServices } from './services';
import { sounds } from './sounds';

/** 麦克风 / 声音操作：同时更新媒体和控制面状态（其他人看到的图标来自控制面）。 */
export function useVoiceActions() {
  const { client, media } = useServices();

  const setMuted = useCallback(
    async (muted: boolean) => {
      // 关闭声音时不能单独打开麦克风：取消静音会同时开启声音
      const deafened = media.state.getState().deafened;
      if (!muted && deafened) {
        media.setDeafened(false);
        void client.updateSelf({ deafened: false, micMuted: false }).catch(() => undefined);
      } else {
        void client.updateSelf({ micMuted: muted }).catch(() => undefined);
      }
      await media.setMicMuted(muted);
      (muted ? sounds.mute : sounds.unmute)();
    },
    [client, media],
  );

  const setDeafened = useCallback(
    async (deafened: boolean) => {
      media.setDeafened(deafened);
      // 关闭声音同时静音麦克风；开启声音时恢复麦克风
      await media.setMicMuted(deafened);
      void client.updateSelf({ deafened, micMuted: deafened }).catch(() => undefined);
      (deafened ? sounds.mute : sounds.unmute)();
    },
    [client, media],
  );

  return { setMuted, setDeafened };
}
