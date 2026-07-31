import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimelapseEngine, buildSimParams } from '../../src/core/engine';
import { STAGE_COUNT, Stage } from '../../src/core/schema';
import type { DrawingPlan } from '../../src/core/schema';
import { installRecordingSurface } from '../helpers/surface';
import type { RecordingHandle } from '../helpers/surface';
import { buildPlan, sceneImage, solidImage, style } from '../helpers/fixtures';

let handle: RecordingHandle;
let plan: DrawingPlan;

const source = { fake: 'source' } as unknown as CanvasImageSource;

const makeEngine = (over: Partial<Parameters<typeof TimelapseEngine.prototype.constructor>[0]> = {}) =>
  new TimelapseEngine({
    plan,
    style: style('professional'),
    durationSec: 10,
    tickRate: 60,
    seed: 0x33,
    renderScale: 1,
    checkpoints: 4,
    source,
    ...(over as object),
  });

beforeEach(async () => {
  handle = installRecordingSurface();
  if (!plan) plan = (await buildPlan(sceneImage(200, 150))).plan;
});
afterEach(() => handle.restore());

describe('時間配分', () => {
  it('工程の持ち時間の合計が指定した尺と一致する', async () => {
    for (const sec of [3, 10, 30, 60, 600]) {
      const p = buildSimParams(plan, style('professional'), sec, 60, 1);
      expect(p.totalTicks).toBe(sec * 60);
      let sum = 0;
      for (let s = 0; s < STAGE_COUNT; s++) sum += p.stageTicks[s];
      expect(sum, `${sec} 秒`).toBe(p.totalTicks);
    }
  });

  it('開始 tick は持ち時間の累積になる', () => {
    const p = buildSimParams(plan, style('manga'), 20, 60, 1);
    let acc = 0;
    for (let s = 0; s < STAGE_COUNT; s++) {
      expect(p.stageStart[s]).toBe(acc);
      acc += p.stageTicks[s];
    }
  });

  it('ストロークが無い工程には時間を割かない', () => {
    const p = buildSimParams(plan, style('impasto'), 20, 60, 1);
    for (let s = 0; s < STAGE_COUNT; s++) {
      const count = plan.stageOffset[s + 1] - plan.stageOffset[s];
      if (count === 0) expect(p.stageTicks[s]).toBe(0);
      else expect(p.stageTicks[s]).toBeGreaterThan(0);
    }
  });

  it('尺が極端に短くても全工程が 1 tick 以上を持つ', () => {
    const p = buildSimParams(plan, style('professional'), 1, 60, 1);
    for (let s = 0; s < STAGE_COUNT; s++) {
      const count = plan.stageOffset[s + 1] - plan.stageOffset[s];
      if (count > 0) expect(p.stageTicks[s]).toBeGreaterThanOrEqual(1);
    }
  });

  it('画風によって時間配分が変わる', () => {
    const manga = buildSimParams(plan, style('manga'), 30, 60, 1);
    const water = buildSimParams(plan, style('watercolor'), 30, 60, 1);
    expect(manga.stageTicks[Stage.LineArt]).toBeGreaterThan(water.stageTicks[Stage.LineArt]);
  });

  it('1 つの工程が時間を占めすぎない', () => {
    for (const id of ['professional', 'manga', 'pencil', 'impasto']) {
      const p = buildSimParams(plan, style(id), 30, 60, 1);
      for (let s = 0; s < STAGE_COUNT; s++) {
        expect(p.stageTicks[s] / p.totalTicks, `${id} の工程 ${s}`).toBeLessThanOrEqual(0.36);
      }
    }
  });
});

describe('再生エンジン', () => {
  it('先頭から終端まで進める', () => {
    const e = makeEngine();
    expect(e.tick).toBe(0);
    expect(e.finished).toBe(false);
    e.advance(e.totalTicks);
    expect(e.tick).toBe(e.totalTicks);
    expect(e.finished).toBe(true);
    expect(e.state.cursor).toBe(plan.strokes.count);
  });

  it('終端を超えて進めても止まる', () => {
    const e = makeEngine();
    e.advance(e.totalTicks * 3);
    expect(e.tick).toBe(e.totalTicks);
  });

  it('指定位置へ移動できる', () => {
    const e = makeEngine();
    e.advanceTo(300);
    expect(e.tick).toBe(300);
    e.advanceTo(120);
    expect(e.tick).toBe(120);
    e.advanceTo(-50);
    expect(e.tick).toBe(0);
    e.advanceTo(e.totalTicks + 999);
    expect(e.tick).toBe(e.totalTicks);
  });

  it('巻き戻しても状態は前進時とまったく同じ', () => {
    const forward = makeEngine();
    forward.advanceTo(400);
    const backward = makeEngine();
    backward.advanceTo(backward.totalTicks);
    backward.advanceTo(400);
    expect(backward.state).toEqual(forward.state);
  });

  it('キャッシュの有無で結果が変わらない', () => {
    const cached = makeEngine({ checkpoints: 6 });
    const plain = makeEngine({ checkpoints: 0 });
    for (const t of [500, 100, 300, 0, 599]) {
      cached.advanceTo(t);
      plain.advanceTo(t);
      expect(cached.state, `tick ${t}`).toEqual(plain.state);
    }
  });

  it('キャッシュを捨てても正しさは失われない', () => {
    const e = makeEngine({ checkpoints: 6 });
    e.advanceTo(e.totalTicks);
    e.advanceTo(200);
    const withCache = { ...e.state, dyn: { ...e.state.dyn } };
    e.dropCache();
    e.advanceTo(e.totalTicks);
    e.advanceTo(200);
    expect(e.state).toEqual(withCache);
  });

  it('先頭へ戻すと紙の状態に戻る', () => {
    const e = makeEngine();
    e.advanceTo(300);
    e.rewind();
    expect(e.tick).toBe(0);
    expect(e.state.cursor).toBe(0);
    expect(e.state.dyn.accumulation).toBe(0);
  });

  it('工程の範囲を報告する', () => {
    const e = makeEngine();
    const ranges = e.stageRanges();
    expect(ranges.length).toBeGreaterThan(0);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
      expect(ranges[i].stage).toBeGreaterThan(ranges[i - 1].stage);
    }
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(e.totalTicks);
  });

  it('現在の工程が tick に追従する', () => {
    const e = makeEngine();
    const ranges = e.stageRanges();
    for (const r of ranges) {
      e.advanceTo(r.start);
      expect(e.stage).toBe(r.stage);
    }
  });

  it('履歴には開始時の設定が記録される', () => {
    const e = makeEngine({ durationSec: 12, sourceName: 'x.png' });
    expect(e.log.seed).toBe(0x33);
    expect(e.log.totalTicks).toBe(720);
    expect(e.log.inputs).toHaveLength(1);
    expect(e.log.inputs[0]).toMatchObject({ tick: 0, kind: 'session-start', value: 12 });
    expect(e.log.meta.sourceName).toBe('x.png');
    expect(e.log.meta.strokeCount).toBe(plan.strokes.count);
    expect(e.log.identity).toEqual(plan.identity);
  });

  it('進捗は 0 から 1 まで動く', () => {
    const e = makeEngine();
    expect(e.progress).toBe(0);
    e.advanceTo(Math.floor(e.totalTicks / 2));
    expect(e.progress).toBeCloseTo(0.5, 2);
    e.advanceTo(e.totalTicks);
    expect(e.progress).toBe(1);
  });
});

describe('レイヤーの表示', () => {
  it('隠したレイヤーの筆致は描かれない', () => {
    const e = makeEngine();
    const hidden = new Uint8Array(plan.layers.length + 1).fill(1);
    hidden[plan.layers[0].id] = 0;
    e.setVisibility(hidden);
    e.advanceTo(e.totalTicks);
    expect(e.tick).toBe(e.totalTicks);
    // 状態そのものは表示に左右されない
    const shown = makeEngine();
    shown.advanceTo(shown.totalTicks);
    expect(e.state).toEqual(shown.state);
  });

  it('表示を戻せる', () => {
    const e = makeEngine();
    const all = new Uint8Array(plan.layers.length + 1).fill(1);
    e.setVisibility(all);
    e.setVisibility(null);
    e.advanceTo(e.totalTicks);
    expect(e.state.cursor).toBe(plan.strokes.count);
  });
});

describe('極端な入力', () => {
  it('単色の画像でも動く', async () => {
    const simple = (await buildPlan(solidImage(64, 48))).plan;
    const e = new TimelapseEngine({
      plan: simple, style: style('anime'), durationSec: 3,
      tickRate: 60, seed: 1, renderScale: 1, checkpoints: 2, source,
    });
    e.advance(e.totalTicks);
    expect(e.finished).toBe(true);
    expect(e.state.cursor).toBe(simple.strokes.count);
  });
});
