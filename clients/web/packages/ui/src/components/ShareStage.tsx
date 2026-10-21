import type { Participant, ShareInfo } from '@hane/protocol';
import type { TrackRef } from '@hane/media';
import { Maximize, Monitor, Scan, ScanSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useClient, useLevels, useServices } from '../services';
import { Avatar } from './Avatar';
import { VideoView } from './VideoView';

/** 画质信息：「1440p · 15 fps · AV1 · 1.8 Mbps」 */
function useQuality(t: TrackRef | undefined): string {
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!t || t.local) return;
    let lastBytes = 0;
    let lastAt = 0;
    const timer = setInterval(async () => {
      const report = await (t.track as unknown as { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> }).getRTCStatsReport?.();
      report?.forEach((s: Record<string, unknown>) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        const now = performance.now();
        const bytes = Number(s.bytesReceived ?? 0);
        const mbps = lastAt ? ((bytes - lastBytes) * 8) / ((now - lastAt) * 1000) : 0;
        lastBytes = bytes;
        lastAt = now;
        const codec = String((report.get(String(s.codecId)) as Record<string, unknown> | undefined)?.mimeType ?? '').replace('video/', '').toUpperCase();
        setQ(`${s.frameHeight ?? '?'}p · ${Math.round(Number(s.framesPerSecond ?? 0))} fps · ${codec} · ${mbps.toFixed(1)} Mbps`);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [t]);
  return q;
}

/** 有屏幕共享时的舞台：共享画面占满，成员缩为一行 */
export function ShareStage({ shares, tracks }: { shares: ShareInfo[]; tracks: TrackRef[] }) {
  const t = useT();
  const participants = useClient((s) => s.participants);
  const selfId = useClient((s) => s.self?.sessionId);
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  const speaking = useLevels((s) => s.speaking);
  const [selected, setSelected] = useState<string | null>(null);
  const [actual, setActual] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const current = shares.find((s) => s.grantId === selected) ?? shares[shares.length - 1]!;
  const sharer = participants[current.sessionId];
  const track = tracks.find((x) => x.source === 'screen' && x.identity === sharer?.mediaIdentity);
  const quality = useQuality(track);
  const mine = current.sessionId === selfId;
  const members = Object.values(participants).filter((p: Participant) => p.roomId === roomId);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {shares.length > 1 && (
        <div className="flex gap-1 border-b border-border px-3 pt-2" role="tablist">
          {shares.map((s) => (
            <button
              key={s.grantId}
              role="tab"
              aria-selected={s.grantId === current.grantId}
              onClick={() => setSelected(s.grantId)}
              className={`max-w-64 truncate rounded-t-md px-3 py-1.5 text-sm ${s.grantId === current.grantId ? 'bg-surface-2 font-medium' : 'text-muted'}`}
              title={t('share.of', { name: participants[s.sessionId]?.nickname ?? '?' })}
            >
              {t('share.of', { name: participants[s.sessionId]?.nickname ?? '?' })}
            </button>
          ))}
        </div>
      )}
      <div ref={box} className="relative min-h-0 flex-1 bg-black" data-testid="share-stage">
        {mine ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white/80">
            <Monitor size={48} />
            <p>{t('share.youAreSharing')}</p>
          </div>
        ) : track ? (
          <div className={`h-full w-full ${actual ? 'overflow-auto' : 'overflow-hidden'}`}>
            <VideoView
              track={track.track}
              fit={actual ? 'none' : 'contain'}
              className={actual ? 'block' : 'h-full w-full'}
              onDoubleClick={() => setActual((a) => !a)}
              testId="share-video"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-white/60">…</div>
        )}
        <div className="absolute left-3 bottom-3 max-w-[calc(100%-1.5rem)] truncate rounded bg-black/60 px-2 py-1 text-xs text-white" data-testid="share-label">
          {t('share.of', { name: sharer?.nickname ?? '?' })}
          {quality && ` · ${quality}`}
        </div>
        {!mine && (
          <div className="absolute right-3 top-3 flex gap-1">
            <button className="rounded bg-black/60 p-1.5 text-white hover:bg-black/80" onClick={() => setActual((a) => !a)} title={actual ? t('share.fit') : t('share.actual')} aria-label={actual ? t('share.fit') : t('share.actual')}>
              {actual ? <Scan size={16} /> : <ScanSearch size={16} />}
            </button>
            <button className="rounded bg-black/60 p-1.5 text-white hover:bg-black/80" onClick={() => void box.current?.requestFullscreen()} title={t('share.fullscreen')} aria-label={t('share.fullscreen')}>
              <Maximize size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto border-t border-border bg-surface p-2">
        {members.map((p) => {
          const cam = tracks.find((x) => x.source === 'camera' && x.identity === p.mediaIdentity);
          return (
            <div key={p.sessionId} className="relative flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2" title={p.nickname}>
              {cam ? <VideoView track={cam.track} fit="cover" mirror={cam.local} className="h-full w-full" /> : <Avatar name={p.nickname} uid={p.uid} speaking={!!speaking[p.mediaIdentity]} size={40} />}
              <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/50 px-1 text-xs text-white">{p.nickname}</span>
            </div>
          );
        })}
      </div>
    </main>
  );
}
