// 首屏只导出不依赖 livekit-client 的部分；会议部分由 MediaSession 按需加载（session.ts）。
export { MediaSession, defaultAudioPrefs, type AudioPrefs, type LevelState, type MediaState, type MediaStatus, type TrackRef } from './session';
export { ShareCancelled, ShareUnsupported, canEncodeScreenShare } from './share/support';
export type { ShareIntentName, ShareStatus } from './share/controller';
export { chooseShareCodec, probeVideoDecode, shareCodecOptions, videoDecodeCaps } from './share/codec';
export { ScreenShareEngine, customMode, type CustomShare, type ShareCodecPref, type ShareParams } from './share/engine';
export type { E2EEKeys, E2EEState } from './e2ee';
export { isE2EESupported } from './e2eeSupport';
export { aiNoiseAvailable } from '@hane/audio-dsp';
