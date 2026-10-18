// 简短的提示音（WebAudio 合成，不需要音频文件）：有人进入 / 离开、自己静音 / 取消静音。
let ctx: AudioContext | null = null;

function tone(freqs: number[], durMs = 90, gain = 0.06) {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const g = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const start = t0 + (i * durMs) / 1000;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(gain, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + durMs / 1000);
      osc.connect(g).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + durMs / 1000 + 0.02);
    });
  } catch {
    // 没有音频设备或被浏览器阻止：忽略
  }
}

export const sounds = {
  join: () => tone([660, 880]),
  leave: () => tone([880, 660]),
  mute: () => tone([520], 70),
  unmute: () => tone([780], 70),
};
