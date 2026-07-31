import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Painter } from '../../src/render/painter';
import type { PainterOptions } from '../../src/render/painter';
import { Brush, Stage, createStrokeTable, cssColor, pushStroke, rgb } from '../../src/core/schema';
import type { DrawingPlan } from '../../src/core/schema';
import { baseIdentity } from '../../src/core/schema';
import { createPaintOps } from '../../src/core/transition';
import type { PaintOps } from '../../src/core/transition';
import { installRecordingSurface } from '../helpers/surface';
import type { RecordingContext, RecordingHandle } from '../helpers/surface';

const PAPER = rgb(250, 248, 244);

function makePlan(brush = Brush.Flat): DrawingPlan {
  const strokes = createStrokeTable(4);
  const base = {
    x0: 10, y0: 20, cx: 30, cy: 20, x1: 50, y1: 20,
    width: 4, color: rgb(200, 40, 60), opacity: 128, pressure: 255,
    duration: 2, stage: Stage.Base, layer: 0, brush,
  };
  pushStroke(strokes, base);
  pushStroke(strokes, { ...base, y0: 40, cy: 40, y1: 40, color: rgb(10, 220, 30), layer: 1 });
  pushStroke(strokes, { ...base, y0: 60, cy: 60, y1: 60, color: rgb(10, 20, 230), layer: 2 });
  return {
    width: 100, height: 80, sourceWidth: 100, sourceHeight: 80,
    paper: PAPER, palette: new Uint32Array([PAPER]), layers: [],
    strokes, stageOffset: new Int32Array([0, 0, 0, 0, 3, 3, 3, 3, 3]),
    identity: baseIdentity('test'),
  };
}

const options = (over: Partial<PainterOptions> = {}): PainterOptions => ({
  scale: 1, taper: 0, fillComposite: 'source-over', inkComposite: 'source-over',
  grain: 0, softness: 0, ...over,
});

function opsFor(indices: number[], from = 0, to = 1): PaintOps {
  const ops = createPaintOps(8);
  ops.count = indices.length;
  indices.forEach((i, k) => {
    ops.index[k] = i;
    ops.from[k] = from;
    ops.to[k] = to;
  });
  return ops;
}

let handle: RecordingHandle;
const ctxOf = (p: Painter): RecordingContext => p.ctx as unknown as RecordingContext;

beforeEach(() => {
  handle = installRecordingSurface();
});
afterEach(() => handle.restore());

describe('描画', () => {
  it('出力の大きさは倍率に従う', () => {
    const p = new Painter(makePlan(), options({ scale: 2 }));
    expect(p.width).toBe(200);
    expect(p.height).toBe(160);
  });

  it('初期化で紙の色に塗る', () => {
    const p = new Painter(makePlan(), options());
    const fills = ctxOf(p).calls.filter((c) => c.op === 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].state.fillStyle).toBe(cssColor(PAPER, 1));
    expect(fills[0].args).toEqual([0, 0, 100, 80]);
  });

  it('命令の順に、色と不透明度どおりに筆を置く', () => {
    const p = new Painter(makePlan(), options());
    ctxOf(p).drain();
    p.apply(opsFor([0, 1, 2]), null);
    const strokes = ctxOf(p).calls.filter((c) => c.op === 'stroke');
    expect(strokes).toHaveLength(3);
    expect(strokes[0].state.strokeStyle).toBe(cssColor(rgb(200, 40, 60), 128 / 255));
    expect(strokes[1].state.strokeStyle).toBe(cssColor(rgb(10, 220, 30), 128 / 255));
    expect(strokes[2].state.strokeStyle).toBe(cssColor(rgb(10, 20, 230), 128 / 255));
  });

  it('隠したレイヤーの筆致は描かない', () => {
    const p = new Painter(makePlan(), options());
    ctxOf(p).drain();
    const visible = new Uint8Array([1, 0, 1]);
    p.apply(opsFor([0, 1, 2]), visible);
    const strokes = ctxOf(p).calls.filter((c) => c.op === 'stroke');
    expect(strokes).toHaveLength(2);
    expect(strokes.some((s) => s.state.strokeStyle.includes('10,220,30'))).toBe(false);
  });

  it('区間を分けて描いても最終的な軌跡は同じ範囲を通る', () => {
    const whole = new Painter(makePlan(), options());
    ctxOf(whole).drain();
    whole.apply(opsFor([0], 0, 1), null);
    const wholePts = ctxOf(whole).calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo');

    const split = new Painter(makePlan(), options());
    ctxOf(split).drain();
    split.apply(opsFor([0], 0, 0.5), null);
    split.apply(opsFor([0], 0.5, 1), null);
    const splitPts = ctxOf(split).calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo');

    expect(wholePts[0].args).toEqual(splitPts[0].args);
    const lastWhole = wholePts[wholePts.length - 1].args as number[];
    const lastSplit = splitPts[splitPts.length - 1].args as number[];
    expect(lastSplit[0]).toBeCloseTo(lastWhole[0], 5);
    expect(lastSplit[1]).toBeCloseTo(lastWhole[1], 5);
  });

  it('抑揚を付けると区間ごとに筆幅が変わる', () => {
    const flat = new Painter(makePlan(Brush.Round), options({ taper: 0 }));
    ctxOf(flat).drain();
    flat.apply(opsFor([0]), null);
    const flatWidths = new Set(ctxOf(flat).calls.filter((c) => c.op === 'stroke').map((c) => c.state.lineWidth));
    expect(flatWidths.size).toBe(1);

    const tapered = new Painter(makePlan(Brush.Round), options({ taper: 0.8 }));
    ctxOf(tapered).drain();
    tapered.apply(opsFor([0]), null);
    const widths = ctxOf(tapered).calls.filter((c) => c.op === 'stroke').map((c) => c.state.lineWidth);
    expect(widths.length).toBeGreaterThan(1);
    expect(new Set(widths).size).toBeGreaterThan(1);
    // 中央が最も太い
    expect(Math.max(...widths)).toBe(widths[Math.floor(widths.length / 2)]);
  });

  it('にじみ筆は太い外周と細い芯の 2 回で描く', () => {
    const p = new Painter(makePlan(Brush.Soft), options({ softness: 0.8 }));
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    const widths = ctxOf(p).calls.filter((c) => c.op === 'stroke').map((c) => c.state.lineWidth);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeGreaterThan(widths[1]);
  });

  it('かすれ筆は細い線を重ねる', () => {
    const p = new Painter(makePlan(Brush.Grain), options({ grain: 0.9 }));
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    expect(ctxOf(p).calls.filter((c) => c.op === 'stroke').length).toBeGreaterThanOrEqual(2);
  });

  it('面と線で合成方法を使い分ける', () => {
    const p = new Painter(makePlan(Brush.Flat), options({ fillComposite: 'multiply', inkComposite: 'source-over' }));
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    expect(ctxOf(p).calls.find((c) => c.op === 'stroke')!.state.composite).toBe('multiply');
  });

  it('複製は本体を写し、復元は複製から書き戻す', () => {
    const p = new Painter(makePlan(), options());
    const snap = p.snapshot();
    expect(snap.width).toBe(p.width);
    expect(snap.height).toBe(p.height);
    // 複製側には本体からの転写が記録されている
    const intoSnap = (snap.getContext() as RecordingContext).calls.filter((c) => c.op === 'drawImage');
    expect(intoSnap).toHaveLength(1);
    expect(intoSnap[0].args[0]).toBe(p.canvas);

    ctxOf(p).drain();
    p.restore(snap);
    const draws = ctxOf(p).calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0].args[0]).toBe(snap);
    expect(draws[0].state.globalAlpha).toBe(1);
  });
});

describe('元画像への収束', () => {
  const source = { fake: 'source' } as unknown as CanvasImageSource;

  it('元画像が無ければ収束しない', () => {
    const p = new Painter(makePlan(), options());
    p.convergence = 1;
    expect(p.effectiveConvergence).toBe(0);
  });

  it('重ね具合 0 では筆致だけを写す', () => {
    const p = new Painter(makePlan(), options({ source }));
    const dest = handle.surfaces[0].ctx;
    dest.calls = [];
    p.convergence = 0;
    p.present(dest as unknown as CanvasRenderingContext2D, 100, 80);
    const draws = dest.calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(1);
  });

  it('重ね具合に応じて元画像を重ねる', () => {
    const p = new Painter(makePlan(), options({ source }));
    const dest = handle.surfaces[0].ctx;
    dest.calls = [];
    p.convergence = 0.4;
    p.present(dest as unknown as CanvasRenderingContext2D, 100, 80);
    const draws = dest.calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(2);
    expect(draws[0].state.globalAlpha).toBe(1);
    expect(draws[1].state.globalAlpha).toBeCloseTo(0.4, 6);
  });

  it('重ね具合 1 では元画像そのものになる', () => {
    const p = new Painter(makePlan(), options({ source }));
    const dest = handle.surfaces[0].ctx;
    dest.calls = [];
    p.convergence = 1;
    p.present(dest as unknown as CanvasRenderingContext2D, 100, 80);
    const draws = dest.calls.filter((c) => c.op === 'drawImage');
    expect(draws[draws.length - 1].state.globalAlpha).toBe(1);
    // 最後に描かれるのは元画像
    expect(draws[draws.length - 1].args[0]).not.toBe(p.canvas);
  });

  it('範囲外の値は 0-1 に丸める', () => {
    const p = new Painter(makePlan(), options({ source }));
    p.convergence = 5;
    expect(p.effectiveConvergence).toBe(1);
    p.convergence = -2;
    expect(p.effectiveConvergence).toBe(0);
  });

  it('無効にすれば重ねない', () => {
    const p = new Painter(makePlan(), options({ source }));
    p.convergence = 1;
    p.convergenceEnabled = false;
    expect(p.effectiveConvergence).toBe(0);
  });

  it('書き出し用の面は収束を含む', () => {
    const p = new Painter(makePlan(), options({ source }));
    p.convergence = 0;
    expect(p.output()).toBe(p.canvas);
    p.convergence = 0.5;
    expect(p.output()).not.toBe(p.canvas);
  });

  it('縮小して取り出すときも収束を含む', () => {
    const p = new Painter(makePlan(), options({ source }));
    p.convergence = 0.5;
    const data = p.readScaled(50, 40);
    expect(data.data.length).toBe(50 * 40 * 4);
    const scratch = handle.surfaces[handle.surfaces.length - 1].ctx;
    expect(scratch.calls.filter((c) => c.op === 'drawImage')).toHaveLength(2);
  });
});
