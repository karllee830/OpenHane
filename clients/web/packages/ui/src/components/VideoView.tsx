import type { Track } from 'livekit-client';
import { useEffect, useRef } from 'react';

/** 把 LiveKit 视频轨道挂到 video 元素上（卸载时解除） */
export function VideoView({ track, fit = 'contain', mirror, className, onDoubleClick, testId }: {
  track: Track;
  fit?: 'contain' | 'cover' | 'none';
  mirror?: boolean;
  className?: string;
  onDoubleClick?: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      onDoubleClick={onDoubleClick}
      data-testid={testId}
      className={className}
      style={{ objectFit: fit === 'none' ? undefined : fit, transform: mirror ? 'scaleX(-1)' : undefined, maxWidth: fit === 'none' ? 'none' : undefined }}
    />
  );
}
