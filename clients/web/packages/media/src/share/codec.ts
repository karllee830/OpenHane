// 屏幕共享编码器选择：发送端能编码的集合 ∩ 房间可解码集合，按固定顺序取第一个。
import type { EngineCodec, ShareCodecPref } from './engine';

export interface EncodeCaps {
  /** 能编码的编码器；hardware 表示能效高（基本等同于硬件编码） */
  codecs: { codec: EngineCodec; hardware: boolean }[];
}

export interface CodecChoice {
  codec: EngineCodec;
  /** 备用编码器（LiveKit backup codec：只有出现无法解码主编码器的观众时才额外编码） */
  backup: 'h264' | undefined;
}

type Pref = { codec: EngineCodec; hw?: boolean };

/** 自定义里可以选的编码器：本机能硬件编码的 AV1 / H.265 / H.264（加密房间没有 AV1；服务器设为只用 H.264 时不能选） */
export function selectableShareCodecs(caps: EncodeCaps, o: { policy: 'auto' | 'compat'; e2ee: boolean }): ShareCodecPref[] {
  if (o.policy === 'compat') return [];
  return (['av1', 'h265', 'h264'] as const).filter((c) => caps.codecs.some((x) => x.codec === c && x.hardware) && !(o.e2ee && c === 'av1'));
}

let uiProbe: Promise<EncodeCaps> | null = null;
/** 设置界面用：探测一次（1080p）后缓存 */
export async function shareCodecOptions(o: { policy: 'auto' | 'compat'; e2ee: boolean }): Promise<ShareCodecPref[]> {
  uiProbe ??= detectEncodeCaps(1920, 1080);
  return selectableShareCodecs(await uiProbe, o);
}

/**
 * AV1 和 H.265 只用硬件编码；软件编码只允许 H.264 兜底（VP8 / VP9 不用于发送）。
 * 返回 null 表示本机连 H.264 都不能编码（例如没有 OpenH264 插件的 Firefox），无法共享。
 */
export function chooseShareCodec(o: {
  caps: EncodeCaps;
  roomDecodable: string[];
  policy: 'auto' | 'compat';
  e2ee: boolean;
  /** 自定义里用户指定的编码器 */
  prefer?: ShareCodecPref | null;
}): CodecChoice | null {
  const has = (c: EngineCodec, hw?: boolean) => o.caps.codecs.some((x) => x.codec === c && (hw === undefined || x.hardware === hw));
  // 用户指定、且本机能硬件编码：直接用，不看房间可解码集合（解不了的观众看备用的 H.264）。不满足时按自动选
  if (o.prefer && selectableShareCodecs(o.caps, o).includes(o.prefer)) {
    return { codec: o.prefer, backup: o.prefer !== 'h264' && has('h264') ? 'h264' : undefined };
  }
  const can = (c: EngineCodec, hw?: boolean) =>
    has(c, hw) &&
    o.roomDecodable.includes(`video/${c}`) &&
    !(o.e2ee && c === 'av1'); // S9：LiveKit 的帧加密不支持 AV1

  const prefs: Pref[] =
    o.policy === 'compat'
      ? [{ codec: 'h264', hw: true }]
      : [{ codec: 'av1', hw: true }, { codec: 'h265', hw: true }, { codec: 'h264', hw: true }];
  const pick = prefs.find((p) => can(p.codec, p.hw))?.codec;
  // 没有全房间都能解码的硬件编码器：用 H.264（硬件优先，没有就软件）。个别解不了 H.264 的观众看不到这一路
  if (!pick) return has('h264') ? { codec: 'h264', backup: undefined } : null;
  return { codec: pick, backup: pick !== 'h264' && has('h264') ? 'h264' : undefined };
}

/** 探测本机能编码的视频编码器，以及在给定分辨率下是否能效高（mediaCapabilities.powerEfficient） */
export async function detectEncodeCaps(width = 2560, height = 1440, fps = 30): Promise<EncodeCaps> {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  const mimes = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  const out: EncodeCaps['codecs'] = [];
  for (const codec of ['av1', 'h265', 'h264'] as const) {
    if (!mimes.has(`video/${codec}`)) continue;
    let hardware = false;
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: `video/${codec.toUpperCase()}`, width, height, framerate: fps, bitrate: 4_000_000 },
      });
      hardware = info.supported && info.powerEfficient;
    } catch {
      // 不支持查询：按软件编码处理
    }
    out.push({ codec, hardware });
  }
  return { codecs: out };
}

const DECODE_MIMES = ['video/av1', 'video/vp9', 'video/h265', 'video/h264', 'video/vp8'];
let decodeHw: Map<string, boolean> | null = null;

/** 探测各视频编码器能否硬件解码（mediaCapabilities.decodingInfo 的 powerEfficient），结果缓存。应用启动时调用一次 */
export async function probeVideoDecode(): Promise<void> {
  const out = new Map<string, boolean>();
  for (const mime of decodableMimes()) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'webrtc',
        video: { contentType: `video/${mime.slice(6).toUpperCase()}`, width: 1920, height: 1080, framerate: 30, bitrate: 4_000_000 },
      });
      out.set(mime, info.supported && info.powerEfficient);
    } catch {
      out.set(mime, false); // 不支持查询：按软件解码处理
    }
  }
  decodeHw = out;
}

function decodableMimes(): string[] {
  const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
  return [...new Set(caps.map((c) => c.mimeType.toLowerCase()).filter((m) => DECODE_MIMES.includes(m)))];
}

/** 本机能解码的视频编码器和能否硬件解码（上报给服务端）；probeVideoDecode 完成前 hardware 为 undefined */
export function videoDecodeCaps(): { mime: string; hardware?: boolean }[] {
  return decodableMimes().map((mime) => ({ mime, hardware: decodeHw ? (decodeHw.get(mime) ?? false) : undefined }));
}
