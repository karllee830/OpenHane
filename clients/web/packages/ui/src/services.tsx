import type { ClientState, OpenHaneClient } from '@hane/core';
import type { LevelState, MediaSession, MediaState, TrackRef } from '@hane/media';
import type { PlatformServices } from '@hane/platform';
import { createContext, useContext, useMemo } from 'react';
import { useStore } from 'zustand';

export interface AppServices {
  platform: PlatformServices;
  client: OpenHaneClient;
  media: MediaSession;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

export function useClient<T>(selector: (s: ClientState) => T): T {
  return useStore(useServices().client.store, selector);
}

export function useMedia<T>(selector: (s: MediaState) => T): T {
  return useStore(useServices().media.state, selector);
}

export function useLevels<T>(selector: (s: LevelState) => T): T {
  return useStore(useServices().media.levels, selector);
}

/** 当前所有视频轨道（摄像头、屏幕），轨道变化时重新计算 */
export function useVideoTracks(): TrackRef[] {
  const { media } = useServices();
  const version = useMedia((s) => s.videoVersion);
  return useMemo(() => media.videoTracks(), [media, version]);
}
