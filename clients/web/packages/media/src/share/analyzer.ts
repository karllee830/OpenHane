// 屏幕内容变化检测：逐帧缩到 32×18 与上一帧比较，得到变化面积和变化帧率。
// 采样帧率与编码帧率分开：采集轨道保持高帧率，编码帧率由发送参数控制，检测不受影响。

const W = 32;
const H = 18;
const PIXEL_DELTA = 24; // RGB 差值之和超过它算作变化的像素
const MIN_AREA = 0.002; // 低于它算作噪声（光标闪烁等）

export class ChangeAnalyzer {
  private frames: { t: number; area: number }[] = [];
  private prev: Uint8ClampedArray | null = null;
  private stopped = false;
  private canvas = new OffscreenCanvas(W, H);
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private cleanup: (() => void) | null = null;

  constructor(track: MediaStreamTrack) {
    const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
      .MediaStreamTrackProcessor;
    if (MSTP) this.runWithProcessor(new MSTP({ track: track.clone() }));
    else this.runWithVideoElement(track);
  }

  private sample(source: CanvasImageSource) {
    this.ctx.drawImage(source, 0, 0, W, H);
    const d = this.ctx.getImageData(0, 0, W, H).data;
    if (this.prev) {
      let changed = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]! - this.prev[i]!) + Math.abs(d[i + 1]! - this.prev[i + 1]!) + Math.abs(d[i + 2]! - this.prev[i + 2]!) > PIXEL_DELTA) changed++;
      }
      const t = performance.now();
      this.frames.push({ t, area: changed / (W * H) });
      while (this.frames.length && t - this.frames[0]!.t > 2000) this.frames.shift();
    }
    this.prev = d;
  }

  /** Chrome / Edge：MediaStreamTrackProcessor 逐帧读取 */
  private runWithProcessor(p: { readable: ReadableStream<VideoFrame> }) {
    const reader = p.readable.getReader();
    this.cleanup = () => void reader.cancel().catch(() => undefined);
    void (async () => {
      while (!this.stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          if (!this.stopped) this.sample(frame);
        } finally {
          frame.close();
        }
      }
    })();
  }

  /** Safari / Firefox：用 video 元素 + requestVideoFrameCallback */
  private runWithVideoElement(track: MediaStreamTrack) {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const tick = () => {
      if (this.stopped) return;
      if (video.readyState >= 2) this.sample(video);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
      else setTimeout(tick, 33);
    };
    tick();
    this.cleanup = () => {
      video.srcObject = null;
    };
  }

  /** 最近 500 ms 的信号 */
  signals(): { changedAreaRatio: number; changeFps: number } {
    const now = performance.now();
    const recent = this.frames.filter((f) => now - f.t <= 500 && f.area > MIN_AREA);
    return {
      changedAreaRatio: recent.length ? recent.reduce((a, f) => a + f.area, 0) / recent.length : 0,
      changeFps: recent.length * 2,
    };
  }

  stop(): void {
    this.stopped = true;
    this.cleanup?.();
  }
}
