import { isE2EESupported as livekitSupported } from 'livekit-client';
import { afterEach, describe, expect, it } from 'vitest';
import { isE2EESupported } from './e2eeSupport';

const g = globalThis as { window?: unknown };

describe('isE2EESupported', () => {
  afterEach(() => {
    delete g.window;
  });

  it('和 livekit-client 的判断一致', () => {
    const cases: unknown[] = [
      undefined,
      {},
      { RTCRtpSender: { prototype: {} } },
      { RTCRtpSender: { prototype: { createEncodedStreams() {} } } },
      { RTCRtpSender: { prototype: {} }, RTCRtpScriptTransform: class {} },
    ];
    for (const w of cases) {
      if (w === undefined) delete g.window;
      else g.window = w;
      expect(isE2EESupported()).toBe(livekitSupported());
    }
  });
});
