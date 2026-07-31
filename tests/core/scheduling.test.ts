import { describe, expect, it } from 'vitest';
import { waitUntil, yieldToUI } from '../../src/core/scheduling';

describe('待機', () => {
  it('制御を返してから再開する', async () => {
    const order: string[] = [];
    const p = yieldToUI().then(() => order.push('after'));
    order.push('sync');
    await p;
    expect(order).toEqual(['sync', 'after']);
  });

  it('マイクロタスクではなくタスクとして戻る（画面の更新が入る余地がある）', async () => {
    const order: string[] = [];
    const p = yieldToUI().then(() => order.push('task'));
    await Promise.resolve().then(() => order.push('microtask'));
    await p;
    expect(order).toEqual(['microtask', 'task']);
  });

  it('多重に呼んでも取りこぼさない', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => yieldToUI().then(() => i)),
    );
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('指定時刻まで待つ', async () => {
    const t0 = performance.now();
    await waitUntil(t0 + 40);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(30);
  });

  it('過ぎた時刻ならすぐ戻る', async () => {
    const t0 = performance.now();
    await waitUntil(t0 - 1000);
    expect(performance.now() - t0).toBeLessThan(30);
  });
});
