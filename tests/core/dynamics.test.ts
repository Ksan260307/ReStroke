import { describe, expect, it } from 'vitest';
import {
  STYLE_DYNAMICS_DEFAULT,
  advanceDynamics,
  copyDynamicsState,
  createDynamicsState,
  pressureAt,
  resetDynamicsState,
} from '../../src/core/dynamics';

const profile = STYLE_DYNAMICS_DEFAULT;

function run(ticks: number, seed = 5, completedPerTick = 1): { factors: number[]; state: ReturnType<typeof createDynamicsState> } {
  const s = createDynamicsState();
  const factors: number[] = [];
  for (let t = 0; t < ticks; t++) {
    factors.push(advanceDynamics(s, profile, seed, t, completedPerTick, 1));
  }
  return { factors, state: s };
}

describe('動態モデル', () => {
  it('蓄積（疲労）は決して減らない', () => {
    const s = createDynamicsState();
    let prev = 0;
    for (let t = 0; t < 2000; t++) {
      advanceDynamics(s, profile, 3, t, t % 3, 1);
      expect(s.accumulation).toBeGreaterThanOrEqual(prev);
      prev = s.accumulation;
    }
    expect(s.accumulation).toBeGreaterThan(0);
  });

  it('初期化で蓄積も戻る（巻き戻しは再計算で行う）', () => {
    const { state } = run(300);
    expect(state.accumulation).toBeGreaterThan(0);
    resetDynamicsState(state);
    expect(state.accumulation).toBe(0);
    expect(state.excitation).toBe(0);
    expect(state.restTicks).toBe(0);
    expect(state.potential).toBe(1);
  });

  it('励起は上限を超えず、入力が止まれば減衰する', () => {
    const s = createDynamicsState();
    for (let t = 0; t < 500; t++) advanceDynamics(s, profile, 1, t, 30, 2);
    expect(s.excitation).toBeLessThanOrEqual(2.5);
    const peak = s.excitation;
    for (let t = 500; t < 560; t++) advanceDynamics(s, profile, 1, t, 0, 1);
    expect(s.excitation).toBeLessThan(peak);
  });

  it('同じ種と tick からは同じ結果になる', () => {
    const a = run(400, 77);
    const b = run(400, 77);
    expect(b.factors).toEqual(a.factors);
    expect(b.state).toEqual(a.state);
  });

  it('種が変われば緩急も変わる', () => {
    expect(run(400, 1).factors).not.toEqual(run(400, 2).factors);
  });

  it('作業速度は正の範囲に収まる', () => {
    const { factors } = run(3000, 12);
    for (const f of factors) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(3);
    }
  });

  it('平均の作業速度は 1 前後に収まる（尺が大きくずれない）', () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const { factors } = run(4000, seed);
      const mean = factors.reduce((a, b) => a + b, 0) / factors.length;
      expect(mean).toBeGreaterThan(0.6);
      expect(mean).toBeLessThan(1.6);
    }
  });

  it('ときどき手が止まる（休止が入る）', () => {
    const { factors } = run(4000, 8);
    const zero = factors.filter((f) => f === 0).length;
    expect(zero).toBeGreaterThan(0);
    expect(zero / factors.length).toBeLessThan(0.3);
  });

  it('休止しない設定なら止まらない', () => {
    const s = createDynamicsState();
    const noPause = { ...profile, pauseChance: 0 };
    for (let t = 0; t < 1000; t++) {
      expect(advanceDynamics(s, noPause, 4, t, 1, 1)).toBeGreaterThan(0);
    }
  });

  it('状態の複製は元に影響しない', () => {
    const s = createDynamicsState();
    advanceDynamics(s, profile, 1, 0, 5, 1);
    const c = copyDynamicsState(s);
    advanceDynamics(s, profile, 1, 1, 5, 1);
    expect(c.accumulation).not.toBe(s.accumulation);
  });

  it('筆圧は入りと抜きで弱くなる', () => {
    expect(pressureAt(0, 1, 1)).toBeCloseTo(0, 5);
    expect(pressureAt(1, 1, 1)).toBeCloseTo(0, 5);
    expect(pressureAt(0.5, 1, 1)).toBeCloseTo(1, 5);
    // 抑揚なしなら一定
    expect(pressureAt(0, 0.8, 0)).toBeCloseTo(0.8, 5);
    expect(pressureAt(0.5, 0.8, 0)).toBeCloseTo(0.8, 5);
    // 範囲外でも壊れない
    expect(pressureAt(-1, 1, 1)).toBeCloseTo(0, 5);
    expect(pressureAt(2, 1, 1)).toBeCloseTo(0, 5);
  });
});
