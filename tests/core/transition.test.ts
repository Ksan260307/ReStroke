import { describe, expect, it } from 'vitest';
import {
  buildWorkPrefix,
  catchUpReserve,
  copySimState,
  createPaintOps,
  createSimState,
  overallProgress,
  resetSimState,
  stageAtTick,
  stepSimulation,
} from '../../src/core/transition';
import type { SimParams } from '../../src/core/transition';
import { buildSimParams } from '../../src/core/engine';
import { STAGE_COUNT } from '../../src/core/schema';
import type { DrawingPlan } from '../../src/core/schema';
import { buildPlan, sceneImage, solidImage, style } from '../helpers/fixtures';

interface RunResult {
  ticks: number;
  finalCursor: number;
  /** 1 tick で描き切った本数の最大 */
  maxPerTick: number;
  /** 最後の tick で描き切った本数 */
  lastTick: number;
  /** 何も描かなかった tick の割合 */
  idleRatio: number;
  perTick: number[];
}

function runAll(plan: DrawingPlan, params: SimParams): RunResult {
  const prefix = buildWorkPrefix(plan);
  const state = createSimState();
  const ops = createPaintOps(256);
  const perTick: number[] = [];
  let prev = 0;
  let idle = 0;
  for (let t = 0; t < params.totalTicks; t++) {
    stepSimulation(plan, params, prefix, state, ops);
    const done = state.cursor - prev;
    prev = state.cursor;
    perTick.push(done);
    if (ops.count === 0) idle++;
  }
  return {
    ticks: params.totalTicks,
    finalCursor: state.cursor,
    maxPerTick: Math.max(...perTick),
    lastTick: perTick[perTick.length - 1],
    idleRatio: idle / params.totalTicks,
    perTick,
  };
}

const DURATIONS = [3, 5, 10, 20, 30, 60, 120];

describe('状態遷移', () => {
  it('どの長さでも、指定 tick 以内に全ストロークを描き切る', async () => {
    const { plan } = await buildPlan(sceneImage());
    expect(plan.strokes.count).toBeGreaterThan(200);
    for (const sec of DURATIONS) {
      const params = buildSimParams(plan, style('professional'), sec, 60, 7);
      const r = runAll(plan, params);
      expect(r.finalCursor, `${sec} 秒で描き残しがある`).toBe(plan.strokes.count);
    }
  });


  it('画風を変えても描き切る', async () => {
    for (const id of ['beginner', 'intermediate', 'professional', 'manga', 'anime', 'watercolor', 'impasto', 'pencil']) {
      const { plan } = await buildPlan(sceneImage(240, 180), { style: id, maxStrokes: 9000 });
      const params = buildSimParams(plan, style(id), 15, 60, 3);
      const r = runAll(plan, params);
      expect(r.finalCursor, `${id} で描き残しがある`).toBe(plan.strokes.count);
    }
  });

  it('最後の tick に大量のストロークがまとめて現れない', async () => {
    const { plan } = await buildPlan(sceneImage());
    for (const sec of DURATIONS) {
      const params = buildSimParams(plan, style('professional'), sec, 60, 11);
      const r = runAll(plan, params);
      const average = plan.strokes.count / params.totalTicks;
      // 最後の 1 tick が平均の 25 倍を超えるなら、事実上「最後に一気に完成」している
      expect(r.lastTick, `${sec} 秒: 最終 tick ${r.lastTick} 本 / 平均 ${average.toFixed(1)} 本`)
        .toBeLessThan(Math.max(12, average * 25));
    }
  });

  it('進み方が偏らない（仕上げ前の塗りは前半で 3 割以上進む）', async () => {
    // 本数で測ると、仕上げの細かい筆が大量にあるぶん後半に偏って見える。
    // 仕上げは画面全体を塗り直す工程なので、そこを除いた「絵を組み立てる塗り」で測る。
    const { plan } = await buildPlan(sceneImage());
    const params = buildSimParams(plan, style('intermediate'), 30, 60, 5);
    const prefix = buildWorkPrefix(plan);
    const state = createSimState();
    const ops = createPaintOps(256);
    const s = plan.strokes;
    const finishFrom = plan.stageOffset[STAGE_COUNT - 1];
    const areaOf = (i: number): number =>
      i >= finishFrom
        ? 0
        : Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]) * s.width[i] + s.width[i] * s.width[i];
    let totalArea = 0;
    for (let i = 0; i < s.count; i++) totalArea += areaOf(i);
    expect(totalArea).toBeGreaterThan(0);

    let firstHalf = 0;
    const halfTick = Math.floor(params.totalTicks / 2);
    for (let t = 0; t < params.totalTicks; t++) {
      stepSimulation(plan, params, prefix, state, ops);
      if (t >= halfTick) continue;
      for (let k = 0; k < ops.count; k++) {
        firstHalf += areaOf(ops.index[k]) * (ops.to[k] - ops.from[k]);
      }
    }
    expect(firstHalf / totalArea).toBeGreaterThan(0.3);
    expect(firstHalf / totalArea).toBeLessThanOrEqual(1.0001);
  });

  it('同じ入力からは同じ状態列になる', async () => {
    const { plan } = await buildPlan(sceneImage(200, 150));
    const params = buildSimParams(plan, style('watercolor'), 12, 60, 99);
    const a = runAll(plan, params);
    const b = runAll(plan, params);
    expect(b.perTick).toEqual(a.perTick);
    expect(b.finalCursor).toBe(a.finalCursor);
  });

  it('種が変われば進み方も変わる', async () => {
    const { plan } = await buildPlan(sceneImage(200, 150));
    const a = runAll(plan, buildSimParams(plan, style('professional'), 12, 60, 1));
    const b = runAll(plan, buildSimParams(plan, style('professional'), 12, 60, 2));
    expect(b.perTick).not.toEqual(a.perTick);
    // それでも到達点は同じ
    expect(b.finalCursor).toBe(a.finalCursor);
  });

  it('描画命令は区間の切れ目なく連続する', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    const params = buildSimParams(plan, style('manga'), 8, 60, 4);
    const prefix = buildWorkPrefix(plan);
    const state = createSimState();
    const ops = createPaintOps(64);
    const progress = new Float64Array(plan.strokes.count);
    for (let t = 0; t < params.totalTicks; t++) {
      stepSimulation(plan, params, prefix, state, ops);
      let prevIndex = -1;
      for (let k = 0; k < ops.count; k++) {
        const i = ops.index[k];
        // 番号は必ず昇順（描き順が実行順に左右されない）
        expect(i).toBeGreaterThan(prevIndex);
        prevIndex = i;
        // 前回の続きから始まっている
        expect(ops.from[k]).toBeCloseTo(progress[i], 6);
        expect(ops.to[k]).toBeGreaterThan(ops.from[k] - 1e-9);
        expect(ops.to[k]).toBeLessThanOrEqual(1);
        progress[i] = ops.to[k];
      }
    }
    // すべてのストロークが最後まで引かれている
    for (let i = 0; i < plan.strokes.count; i++) {
      expect(progress[i], `ストローク ${i} が引き切られていない`).toBe(1);
    }
  });

  it('工程は tick の進みに対して後戻りしない', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    const params = buildSimParams(plan, style('professional'), 20, 60, 8);
    let prev = -1;
    for (let t = 0; t < params.totalTicks; t++) {
      const s = stageAtTick(params, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('終端を超えて進めても状態は変わらない', async () => {
    const { plan } = await buildPlan(solidImage());
    const params = buildSimParams(plan, style('anime'), 3, 60, 2);
    const prefix = buildWorkPrefix(plan);
    const state = createSimState();
    const ops = createPaintOps(32);
    for (let t = 0; t < params.totalTicks + 50; t++) {
      stepSimulation(plan, params, prefix, state, ops);
    }
    expect(state.tick).toBe(params.totalTicks);
    expect(state.cursor).toBe(plan.strokes.count);
  });

  it('状態の複製と初期化が正しく働く', () => {
    const s = createSimState();
    s.tick = 42;
    s.cursor = 7;
    s.progress = 0.5;
    s.completed = 6;
    s.dyn.accumulation = 1.25;
    const copy = copySimState(s);
    expect(copy).toEqual(s);
    expect(copy.dyn).not.toBe(s.dyn);
    resetSimState(s);
    expect(s.tick).toBe(0);
    expect(s.cursor).toBe(0);
    expect(s.dyn.accumulation).toBe(0);
    expect(copy.tick).toBe(42);
  });

  it('作業量の累積は単調増加する', async () => {
    const { plan } = await buildPlan(sceneImage(120, 90));
    const prefix = buildWorkPrefix(plan);
    expect(prefix.length).toBe(plan.strokes.count + 1);
    for (let i = 1; i < prefix.length; i++) {
      expect(prefix[i]).toBeGreaterThan(prefix[i - 1]);
    }
  });

  it('追いつき用の余裕は工程の長さに収まる', async () => {
    const { plan } = await buildPlan(sceneImage(120, 90));
    for (const sec of [3, 30, 600]) {
      const params = buildSimParams(plan, style('pencil'), sec, 60, 1);
      for (let s = 0; s < STAGE_COUNT; s++) {
        const reserve = catchUpReserve(params, s);
        expect(reserve).toBeGreaterThanOrEqual(0);
        if (params.stageTicks[s] > 2) expect(reserve).toBeLessThan(params.stageTicks[s]);
      }
    }
  });

  it('全体の進捗は 0 から 1 まで動く', async () => {
    const { plan } = await buildPlan(solidImage());
    const params = buildSimParams(plan, style('anime'), 4, 60, 1);
    const prefix = buildWorkPrefix(plan);
    const state = createSimState();
    const ops = createPaintOps(32);
    expect(overallProgress(plan, state)).toBe(0);
    for (let t = 0; t < params.totalTicks; t++) stepSimulation(plan, params, prefix, state, ops);
    expect(overallProgress(plan, state)).toBe(1);
  });
});
