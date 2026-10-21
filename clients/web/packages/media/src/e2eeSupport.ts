// 端到端加密的浏览器支持检测：和 livekit-client 的 isE2EESupported 判断相同。首屏连接前就要用，不为它加载 livekit-client。

/** 浏览器支持 Insertable Streams 或 RTCRtpScriptTransform（媒体帧加密） */
export function isE2EESupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { RTCRtpSender?: { prototype: { createEncodedStreams?: unknown } }; RTCRtpScriptTransform?: unknown };
  return (typeof w.RTCRtpSender !== 'undefined' && typeof w.RTCRtpSender.prototype.createEncodedStreams !== 'undefined') || typeof w.RTCRtpScriptTransform !== 'undefined';
}
