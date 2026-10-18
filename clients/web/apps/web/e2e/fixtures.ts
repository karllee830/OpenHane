/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 写出 48 kHz 单声道 16 位 PCM 的最简 WAV（Chromium 的假麦克风对文件头比较挑剔）。 */
function writeWav(path: string, pcm: Buffer): string {
  const rate = 48000;
  const n = pcm.length >> 1;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  pcm.copy(buf, 44, 0, n * 2);
  writeFileSync(path, buf);
  return path;
}

/** 正弦波（Chromium 的假麦克风会循环播放）。 */
export function sineWav(freq = 440, seconds = 10, amplitude = 0.3): string {
  const n = 48000 * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * amplitude * 32767), i * 2);
  return writeWav(join(tmpdir(), `hane-sine-${freq}.wav`), pcm);
}

/** 用 macOS 的 say 合成一段中文语音（48 kHz 16 位 WAV）；其他平台或没有中文语音时返回 null。 */
export function speechWav(): string | null {
  if (process.platform !== 'darwin') return null;
  const aiff = join(tmpdir(), 'hane-speech.aiff');
  const raw = join(tmpdir(), 'hane-speech-raw.wav');
  try {
    // 与 S5 相同：显式指定中文语音（默认语音读不了中文，会输出几乎为空的文件）
    execFileSync('say', ['-v', 'Flo (Chinese (China mainland))', '-o', aiff,
      '大家好，欢迎参加今天的项目例会。我们先回顾一下上周的进度，接下来请大家依次介绍各自负责的部分。']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, raw]);
    // afconvert 写的 WAV 带 FLLR 填充块：取出 data 块，重写成最简文件头
    const b = readFileSync(raw);
    const at = b.indexOf('data', 12);
    if (at < 0) return null;
    const size = b.readUInt32LE(at + 4);
    const pcm = b.subarray(at + 8, size > 0 && at + 8 + size <= b.length ? at + 8 + size : b.length);
    if (pcm.length < 48000) return null; // 不到 0.5 秒：合成失败
    return writeWav(join(tmpdir(), 'hane-speech.wav'), pcm);
  } catch {
    return null;
  }
}
