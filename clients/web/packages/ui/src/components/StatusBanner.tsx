import { CircleAlert, LoaderCircle, RefreshCw, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useMedia, useServices } from '../services';
import { useServerUpdated, useUpdateState } from './Updates';

/**
 * 舞台顶部的状态提示：控制连接重连、语音通道状态、麦克风 / 摄像头错误、自动播放被阻止。
 * 以胶囊浮在舞台上方（由会议页放在浮层里），出现和消失时不会把舞台挤上挤下。
 */
export function StatusBanner() {
  const t = useT();
  const { media, platform } = useServices();
  const update = useUpdateState();
  const serverUpdated = useServerUpdated();
  const status = useClient((s) => s.status);
  const attempt = useClient((s) => s.attempt);
  const mediaStatus = useMedia((s) => s.status);
  const micError = useMedia((s) => s.micError);
  const needsUnlock = useMedia((s) => s.needsAudioUnlock);
  const cameraError = useMedia((s) => s.cameraError);
  const error = useClient((s) => s.error);

  const items: { tone: 'warn' | 'error' | 'info'; text: string; onClick?: () => void; testId?: string; icon?: ReactNode }[] = [];
  if (status === 'reconnecting') items.push({ tone: 'warn', text: t('status.reconnecting', { n: attempt }) + (error ? ` ${describeError(error, t)}` : '') });
  else if (mediaStatus === 'reconnecting') items.push({ tone: 'warn', text: t('status.mediaReconnecting') });
  else if (mediaStatus === 'connecting') items.push({ tone: 'info', text: t('status.mediaConnecting') });
  if (micError)
    items.push({
      tone: 'error',
      text: micError === 'permission-denied' ? t('mic.permissionDenied') : micError === 'no-device' ? t('mic.noDevice') : micError === 'busy' ? t('mic.busy') : t('mic.error', { message: micError }),
    });
  if (cameraError)
    items.push({
      tone: 'error',
      text: cameraError === 'permission-denied' ? t('camera.permissionDenied') : cameraError === 'no-device' ? t('camera.noDevice') : cameraError === 'not-allowed' ? t('camera.notAllowed') : cameraError === 'busy' ? t('camera.busy') : cameraError === 'disconnected' ? t('camera.disconnected') : cameraError,
    });
  if (needsUnlock) items.push({ tone: 'warn', text: t('audio.unlock'), onClick: () => void media.unlockAudio(), testId: 'audio-unlock' });
  if (update?.status === 'ready') items.push({ tone: 'info', text: t('update.ready', { version: update.version ?? '' }), onClick: () => platform.updates?.install(), testId: 'update-ready', icon: <RefreshCw size={15} className="shrink-0 text-accent" aria-hidden /> });
  if (serverUpdated) items.push({ tone: 'info', text: t('update.serverUpdated', { version: serverUpdated }), onClick: () => location.reload(), testId: 'server-updated', icon: <RefreshCw size={15} className="shrink-0 text-accent" aria-hidden /> });

  if (!items.length) return null;
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 pt-2" role="status">
      {items.map((it, i) => {
        const icon =
          it.icon ??
          (it.tone === 'info' || (it.tone === 'warn' && !it.onClick) ? (
            <LoaderCircle size={15} className={`shrink-0 animate-spin ${it.tone === 'warn' ? 'text-warning' : 'text-muted'}`} aria-hidden />
          ) : it.onClick ? (
            <Volume2 size={15} className="shrink-0 text-accent" aria-hidden />
          ) : (
            <CircleAlert size={15} className="shrink-0 text-danger" aria-hidden />
          ));
        const cls = `pointer-events-auto flex max-w-[min(42rem,100%)] items-center gap-2 rounded-full border bg-surface/95 px-4 py-1.5 text-sm shadow-lg backdrop-blur ${
          it.tone === 'error' ? 'border-danger/40' : it.tone === 'warn' ? 'border-warning/50' : 'border-border'
        }`;
        return it.onClick ? (
          <button key={i} className={`${cls} cursor-pointer underline-offset-2 hover:underline`} onClick={it.onClick} data-testid={it.testId}>
            {icon}
            {it.text}
          </button>
        ) : (
          <div key={i} className={cls}>
            {icon}
            <span className="min-w-0">{it.text}</span>
          </div>
        );
      })}
    </div>
  );
}
