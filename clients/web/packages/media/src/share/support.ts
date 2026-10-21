// 屏幕共享的错误类型和编码能力检测：界面在首屏就要用，不依赖 livekit-client。

export class ShareCancelled extends Error {}

/** 本机不能编码屏幕共享可用的任何编码器（连 H.264 都没有，例如没有 OpenH264 插件的 Firefox） */
export class ShareUnsupported extends Error {}

/** 屏幕共享用硬件 AV1 / H.265，或者 H.264 兜底（唯一允许软件编码的）：不能编码 H.264 的浏览器不能共享 */
export function canEncodeScreenShare(): boolean {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return caps.some((c) => c.mimeType.toLowerCase() === 'video/h264');
}
