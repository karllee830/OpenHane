import { describe, expect, it, vi } from 'vitest';
import { firstByPriority } from './dial';

/** 在 ms 毫秒后成功 / 失败的尝试 */
const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const failAfter = (ms: number, e: unknown) => new Promise<never>((_, j) => setTimeout(() => j(e), ms));
const never = () => new Promise<never>(() => undefined);

const run = <T>(attempts: Promise<T>[], discard = vi.fn()) =>
  firstByPriority(attempts, { graceMs: 500, decisive: (e) => e === 'fatal', discard });

describe('firstByPriority', () => {
  it('prefers the first candidate when both succeed', async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    const p = run([after(100, 'a'), after(10, 'b')], discard);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('a');
    expect(discard).toHaveBeenCalledWith('b');
    vi.useRealTimers();
  });

  it('falls back after the grace period when the first never answers', async () => {
    vi.useFakeTimers();
    const p = run([never(), after(10, 'b')]);
    await vi.advanceTimersByTimeAsync(509);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('b');
    vi.useRealTimers();
  });

  it('falls back immediately when the first fails', async () => {
    vi.useFakeTimers();
    const p = run([failAfter(5, 'refused'), after(10, 'b')]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('b');
    vi.useRealTimers();
  });

  it('stops at a decisive failure', async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    const p = run([failAfter(20, 'fatal'), after(10, 'b')], discard);
    const r = expect(p).rejects.toBe('fatal');
    await vi.advanceTimersByTimeAsync(20);
    await r;
    expect(discard).toHaveBeenCalledWith('b');
    vi.useRealTimers();
  });

  it('reports the first error when all fail', async () => {
    await expect(run([Promise.reject('e1'), Promise.reject('e2')])).rejects.toBe('e1');
  });

  it('discards late successes', async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    const p = run([after(10, 'a'), after(50, 'b')], discard);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe('a');
    expect(discard).toHaveBeenCalledWith('b');
    vi.useRealTimers();
  });
});
