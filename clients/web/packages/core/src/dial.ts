// 同时尝试多个候选，按优先级取结果。

type Outcome<T> = { state: 'pending' } | { state: 'ok'; value: T } | { state: 'failed'; error: unknown } | { state: 'decisive'; error: unknown };

/**
 * 同时开始所有尝试，返回排在最前面的结果：
 * - 排在前面的还没有结果时，后面的成功了也再等 graceMs，期间前面的成功就用前面的；
 * - decisive(e) 为真的失败（如证书指纹变化）和成功一样算作结果，不再往后找；
 * - 全部普通失败时抛出第一个候选的错误。
 * 没被选中的成功结果（包括选定之后才完成的）交给 discard 释放。
 */
export function firstByPriority<T>(
  attempts: Promise<T>[],
  opts: { graceMs: number; decisive: (e: unknown) => boolean; discard: (v: T) => void },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const outcomes: Outcome<T>[] = attempts.map(() => ({ state: 'pending' }));
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (i: number) => {
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      outcomes.forEach((o, j) => {
        if (j !== i && o.state === 'ok') opts.discard(o.value);
      });
      const o = outcomes[i]!;
      if (o.state === 'ok') resolve(o.value);
      else if (o.state !== 'pending') reject(o.error);
    };

    /** 宽限期结束：跳过还没结果的，取第一个已有结果的 */
    const settleNow = () => {
      graceTimer = null;
      if (done) return;
      const i = outcomes.findIndex((o) => o.state === 'ok' || o.state === 'decisive');
      if (i >= 0) finish(i);
    };

    const evaluate = () => {
      if (done) return;
      const i = outcomes.findIndex((o) => o.state !== 'failed');
      if (i < 0) {
        finish(0);
        return;
      }
      if (outcomes[i]!.state !== 'pending') {
        finish(i);
        return;
      }
      if (!graceTimer && outcomes.some((o, j) => j > i && (o.state === 'ok' || o.state === 'decisive'))) {
        graceTimer = setTimeout(settleNow, opts.graceMs);
      }
    };

    attempts.forEach((p, i) => {
      p.then(
        (value) => {
          if (done) {
            opts.discard(value);
            return;
          }
          outcomes[i] = { state: 'ok', value };
          evaluate();
        },
        (error) => {
          if (done) return;
          outcomes[i] = opts.decisive(error) ? { state: 'decisive', error } : { state: 'failed', error };
          evaluate();
        },
      );
    });
  });
}
