import { describe, expect, it } from 'vitest';
import { FrameMetrics } from '../../src/core/metrics';

function feed(m: FrameMetrics, frameMs: number, count: number, start = 1000): void {
  for (let i = 0; i <= count; i++) m.sample(start + i * frameMs);
}

describe('計測', () => {
  it('十分な標本が集まるまで間引かない', () => {
    const m = new FrameMetrics();
    feed(m, 100, 4);
    expect(m.presentSkip).toBe(0);
  });

  it('軽いときは毎フレーム転送する', () => {
    const m = new FrameMetrics();
    feed(m, 16, 40);
    expect(m.presentSkip).toBe(0);
    expect(m.fps).toBeGreaterThan(50);
  });

  it('重くなるほど転送を間引く', () => {
    const mid = new FrameMetrics();
    feed(mid, 33, 40);
    expect(mid.presentSkip).toBe(1);

    const heavy = new FrameMetrics();
    feed(heavy, 60, 40);
    expect(heavy.presentSkip).toBe(2);
    expect(heavy.fps).toBeLessThan(20);
  });

  it('異常な間隔は無視する（タブ復帰時などの飛び）', () => {
    const m = new FrameMetrics();
    feed(m, 16, 40);
    const before = m.frameMs;
    m.sample(1000000);
    m.sample(1000016);
    expect(m.frameMs).toBeCloseTo(before, 0);
  });

  it('初期化で状態が戻る', () => {
    const m = new FrameMetrics();
    feed(m, 60, 40);
    expect(m.presentSkip).toBeGreaterThan(0);
    m.reset();
    expect(m.presentSkip).toBe(0);
    expect(m.frameMs).toBeCloseTo(16.7, 1);
  });
});
