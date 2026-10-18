import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Lock, VideoOff } from 'lucide-react';
import type { TrackRef } from '@hane/media';
import type { Participant } from '@hane/protocol';
import { bestGrid } from '../grid';
import { useT } from '../i18n';
import { useClient, useLevels, useMedia, useVideoTracks } from '../services';
import { VideoView } from './VideoView';
import { Avatar } from './Avatar';
import { tileTint, YouTag } from './MeetingBits';
import { RoleBadge, StatusIcons } from './ParticipantList';

const NONE: Record<string, boolean> = {};

/**
 * 舞台：纯语音时是居中的成员卡片；有人开摄像头时是填满舞台的 16:9 宫格。
 * 画面带这个人头像颜色的底色，说话时描边并发光（与苹果客户端相同）。
 */
export function Stage() {
  const t = useT();
  const participants = useClient((s) => s.participants);
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  const selfId = useClient((s) => s.self?.sessionId);
  const speaking = useLevels((s) => s.speaking);
  const tracks = useVideoTracks();
  // 端到端加密：还没收到其密钥的成员，画面和声音暂时无法解密
  const missingKey = useMedia((s) => s.e2ee?.missing) ?? NONE;
  const members = useMemo(
    () => Object.values(participants).filter((p) => p.roomId === roomId).sort((a, b) => a.nickname.localeCompare(b.nickname)),
    [participants, roomId],
  );
  const cameraOf = (identity: string) => tracks.find((x) => x.source === 'camera' && x.identity === identity);
  if (members.some((p) => cameraOf(p.mediaIdentity))) {
    return <VideoGrid members={members} cameraOf={cameraOf} speaking={speaking} missingKey={missingKey} />;
  }
  return (
    <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-4xl flex-wrap justify-center gap-4">
        {members.map((p) => {
          const isSpeaking = !!speaking[p.mediaIdentity];
          return (
            <div
              key={p.sessionId}
              className={`flex w-40 flex-col items-center gap-2.5 rounded-2xl border px-3 py-4 transition-[border-color,box-shadow] duration-150 ${
                isSpeaking ? 'border-[var(--color-speaking)] shadow-[0_0_16px_color-mix(in_oklab,var(--color-speaking)_35%,transparent)]' : 'border-border'
              }`}
              style={tileTint(p.uid)}
              data-testid="stage-tile"
              data-speaking={isSpeaking}
            >
              <Avatar name={p.nickname} uid={p.uid} speaking={isSpeaking} size={76} dimmed={p.reconnecting} />
              <div className="flex max-w-full items-center gap-1 text-sm font-medium">
                <span className="truncate">{p.nickname}</span>
                <RoleBadge role={p.role} />
              </div>
              <div className="flex min-h-[18px] items-center gap-1.5">
                {p.sessionId === selfId && <YouTag />}
                <StatusIcons p={p} />
              </div>
              {missingKey[p.sessionId] && (
                <span className="flex items-center gap-1 text-xs" data-testid="e2ee-pending">
                  <Lock size={12} aria-hidden />
                  {t('e2ee.pending')}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {members.length <= 1 && <p className="mt-8 text-sm text-muted">{t('stage.empty')}</p>}
    </main>
  );
}

/** 视频宫格：按人数和舞台尺寸选列数，让每个 16:9 画面尽可能大；没开摄像头的人在带头像颜色的底色上显示头像 */
function VideoGrid({
  members,
  cameraOf,
  speaking,
  missingKey,
}: {
  members: Participant[];
  cameraOf: (identity: string) => TrackRef | undefined;
  speaking: Record<string, boolean>;
  missingKey: Record<string, boolean>;
}) {
  const t = useT();
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const GAP = 12;
  const g = bestGrid(members.length, size.w, size.h, GAP);
  return (
    <main className="relative flex-1 overflow-hidden">
      <div ref={area} className="absolute inset-4 flex flex-wrap content-center items-center justify-center" style={{ gap: GAP }}>
        {g.width > 0 &&
          members.map((p) => {
            const cam = cameraOf(p.mediaIdentity);
            const isSpeaking = !!speaking[p.mediaIdentity];
            return (
              <div
                key={p.sessionId}
                className={`relative overflow-hidden rounded-2xl border transition-[border-color,box-shadow] duration-150 ${
                  isSpeaking
                    ? 'border-[var(--color-speaking)] shadow-[0_0_0_2px_var(--color-speaking),0_0_18px_color-mix(in_oklab,var(--color-speaking)_40%,transparent)]'
                    : 'border-border'
                }`}
                style={{ width: g.width, height: g.height, ...(cam ? { background: '#000' } : tileTint(p.uid)) }}
                data-testid="stage-tile"
                data-speaking={isSpeaking}
              >
                {cam ? (
                  <VideoView track={cam.track} fit="cover" mirror={cam.local} className="h-full w-full" testId="camera-video" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <Avatar name={p.nickname} uid={p.uid} size={Math.max(40, Math.min(104, Math.round(g.height / 2.6)))} dimmed={p.reconnecting} />
                  </div>
                )}
                {cam?.paused && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm text-white" data-testid="video-paused">
                    <VideoOff size={20} />
                    {t('video.paused')}
                  </div>
                )}
                <div
                  className={`absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full px-2.5 py-0.5 text-sm backdrop-blur ${
                    cam ? 'bg-black/55 text-white [&_.text-muted]:text-white/80' : 'bg-surface/75 text-text'
                  }`}
                >
                  <span className="truncate">{p.nickname}</span>
                  <StatusIcons p={p} />
                </div>
                {missingKey[p.sessionId] && (
                  <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-xs text-white backdrop-blur" data-testid="e2ee-pending">
                    <Lock size={12} aria-hidden />
                    {t('e2ee.pending')}
                  </span>
                )}
              </div>
            );
          })}
      </div>
    </main>
  );
}
