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

  it('描画面は透明で始まる（紙は表示時に敷く）', () => {
    const p = new Painter(makePlan(), options());
    const ctx = ctxOf(p);
    expect(ctx.calls.filter((c) => c.op === 'fillRect')).toHaveLength(0);
    expect(ctx.calls.filter((c) => c.op === 'clearRect')).toHaveLength(1);

    const dest = handle.surfaces[0].ctx;
    dest.calls = [];
    p.present(dest as unknown as CanvasRenderingContext2D, 100, 80);
    const fills = dest.calls.filter((c) => c.op === 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].state.fillStyle).toBe(cssColor(PAPER, 1));
    // 紙を敷いてから筆致を重ねる
    expect(dest.calls.findIndex((c) => c.op === 'fillRect'))
      .toBeLessThan(dest.calls.findIndex((c) => c.op === 'drawImage'));
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

describe('下塗りと詰め', () => {
  const source = { fake: 'source' } as unknown as CanvasImageSource;

  it('下塗りは既にある線の下へ潜り込ませる', () => {
    const p = new Painter(makePlan(Brush.Under), options());
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    const stroke = ctxOf(p).calls.find((c) => c.op === 'stroke')!;
    expect(stroke.state.composite).toBe('destination-over');
  });

  it('詰めの筆は元画像を絵の具にする', () => {
    const p = new Painter(makePlan(Brush.Refine), options({ source }));
    expect(p.hasSource).toBe(true);
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    const stroke = ctxOf(p).calls.find((c) => c.op === 'stroke')!;
    expect(stroke.state.composite).toBe('source-over');
    // 単色ではなく模様（元画像）で塗っている
    expect(stroke.state.strokeStyle).toContain('pattern');
    expect(stroke.state.globalAlpha).toBeCloseTo(128 / 255, 5);
  });

  it('元画像が無ければ拾った色で代用する', () => {
    const p = new Painter(makePlan(Brush.Refine), options());
    expect(p.hasSource).toBe(false);
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    const stroke = ctxOf(p).calls.find((c) => c.op === 'stroke')!;
    expect(stroke.state.strokeStyle).toBe(cssColor(rgb(200, 40, 60), 128 / 255));
  });

  it('詰めの筆は引き終わるまで置かれず、置くときは一筆で通す', () => {
    const p = new Painter(makePlan(Brush.Refine), options({ source }));
    ctxOf(p).drain();
    // 途中の区間では何も置かない
    p.apply(opsFor([0], 0, 0.4), null);
    p.apply(opsFor([0], 0.4, 0.8), null);
    expect(ctxOf(p).calls.filter((c) => c.op === 'stroke')).toHaveLength(0);

    // 引き終わった時点で、始点から終点までを一度に置く
    p.apply(opsFor([0], 0.8, 1), null);
    const calls = ctxOf(p).calls;
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1);
    const move = calls.find((c) => c.op === 'moveTo')!.args as number[];
    const lines = calls.filter((c) => c.op === 'lineTo');
    const last = lines[lines.length - 1].args as number[];
    expect(move[0]).toBeCloseTo(10, 5); // 始点
    expect(last[0]).toBeCloseTo(50, 5); // 終点
  });

  it('画風が乗算でも詰めは上書きになる', () => {
    const p = new Painter(makePlan(Brush.Refine), options({ source, fillComposite: 'multiply', inkComposite: 'multiply' }));
    ctxOf(p).drain();
    p.apply(opsFor([0]), null);
    expect(ctxOf(p).calls.find((c) => c.op === 'stroke')!.state.composite).toBe('source-over');
  });

  it('書き出し用の面には紙が敷かれる', () => {
    const p = new Painter(makePlan(), options({ source }));
    const out = p.output();
    expect(out).not.toBe(p.canvas);
    const ctx = out.getContext() as RecordingContext;
    expect(ctx.calls.filter((c) => c.op === 'fillRect')).toHaveLength(1);
    expect(ctx.calls.filter((c) => c.op === 'drawImage')).toHaveLength(1);
  });

  it('縮小して取り出すときも紙が敷かれる', () => {
    const p = new Painter(makePlan(), options({ source }));
    const data = p.readScaled(50, 40);
    expect(data.data.length).toBe(50 * 40 * 4);
    const scratch = handle.surfaces[handle.surfaces.length - 1].ctx;
    expect(scratch.calls.filter((c) => c.op === 'fillRect')).toHaveLength(1);
    expect(scratch.calls.filter((c) => c.op === 'drawImage')).toHaveLength(1);
  });
});
