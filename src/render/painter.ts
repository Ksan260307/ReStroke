/**
 * 出力アダプタ（キャンバス描画）。
 *
 * 状態遷移が出した描画命令を、そのままキャンバスへ写すだけの読み取り専用の層。
 * ここから状態を書き換えることはない。
 *
 * 描画面は 2 枚に分ける。
 *
 *   色の面 … 下塗り・ベース・影・光・細部
 *   線の面 … 当たり線・線画・仕上げの詰め（色の面の上に重なる）
 *
 * こうしておくと、線を引き終えたあとに色を置いても線が消えない。実際の制作で
 * 線画レイヤーを一番上に置くのと同じ考え方で、これがないと「線画を完成させてから
 * 着色に移る」という流れが成立しない。
 *
 * 紙の色はどちらの面にも含めず、画面へ出すときに下へ敷く。
 *
 * 仕上げの詰めでは、元画像そのものを絵の具として筆に乗せる。筆が通ったところには
 * 元画像の画素がそのまま置かれるので、塗り重ねるだけで最後は元画像と一致する。
 */

import type { DrawingPlan } from '../core/schema';
import { Brush, Stage, cssColor } from '../core/schema';
import type { PaintOps } from '../core/transition';
import { pressureAt } from '../core/dynamics';
import { clamp, lerp, rand01 } from '../core/rng';
import { createSurface } from './surface';
import type { Surface } from './surface';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface PainterOptions {
  /** 画像座標系に対する描画倍率 */
  scale: number;
  /** 抑揚の強さ 0-1 */
  taper: number;
  /** 面を塗るときの合成方法 */
  fillComposite: GlobalCompositeOperation;
  /** 線・影の合成方法 */
  inkComposite: GlobalCompositeOperation;
  /** かすれの粒度 */
  grain: number;
  /** 筆先のにじみ（影・光） */
  softness: number;
  /** 仕上げで絵の具として使う元画像 */
  source?: CanvasImageSource | null;
}

/** 途中経過の複製（色の面と線の面の対）。 */
export interface PainterSnapshot {
  color: Surface;
  ink: Surface;
}

function context(c: Surface, alpha: boolean): Ctx2D {
  const ctx = c.getContext('2d', { alpha }) as Ctx2D | null;
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  return ctx;
}

/** そのストロークがどちらの面に乗るか。 */
export function surfaceOf(stage: number, brush: number): 'ink' | 'color' {
  if (brush === Brush.Refine) return 'ink';
  return stage === Stage.Rough || stage === Stage.LineArt ? 'ink' : 'color';
}

export class Painter {
  /** 色の面（線の下） */
  readonly canvas: Surface;
  /** 線の面（色の上） */
  readonly ink: Surface;
  readonly ctx: Ctx2D;
  readonly inkCtx: Ctx2D;
  readonly width: number;
  readonly height: number;

  private plan: DrawingPlan;
  private opts: PainterOptions;
  private scratch: Surface | null = null;
  private composed: Surface | null = null;
  private source: Surface | null = null;
  private sourcePattern: CanvasPattern | null = null;

  constructor(plan: DrawingPlan, opts: PainterOptions) {
    this.plan = plan;
    this.opts = opts;
    this.width = Math.max(2, Math.round(plan.width * opts.scale));
    this.height = Math.max(2, Math.round(plan.height * opts.scale));
    this.canvas = createSurface(this.width, this.height);
    this.ink = createSurface(this.width, this.height);
    this.ctx = context(this.canvas, true);
    this.inkCtx = context(this.ink, true);
    for (const ctx of [this.ctx, this.inkCtx]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    if (opts.source) this.setSource(opts.source);
    this.clear();
  }

  /** 絵の具として使う元画像を、出力解像度で焼き込んでおく。 */
  setSource(source: CanvasImageSource): void {
    const surface = createSurface(this.width, this.height);
    const ctx = context(surface, false);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, this.width, this.height);
    this.source = surface;
    // 画素が 1 対 1 で対応する模様として持つ。筆で塗ると元画像がそのまま乗る。
    const make = (this.inkCtx as CanvasRenderingContext2D).createPattern;
    this.sourcePattern = typeof make === 'function'
      ? make.call(this.inkCtx as CanvasRenderingContext2D, surface as CanvasImageSource, 'no-repeat')
      : null;
  }

  get hasSource(): boolean {
    return this.source !== null;
  }

  /** 何も描いていない状態に戻す。 */
  clear(): void {
    for (const ctx of [this.ctx, this.inkCtx]) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  /** 1 tick 分の描画命令を反映する。 */
  apply(ops: PaintOps, visibleLayers: Uint8Array | null): void {
    const s = this.plan.strokes;
    for (let k = 0; k < ops.count; k++) {
      const i = ops.index[k];
      if (visibleLayers && visibleLayers[s.layer[i]] === 0) continue;
      const ctx = surfaceOf(s.stage[i], s.brush[i]) === 'ink' ? this.inkCtx : this.ctx;
      if (s.brush[i] === Brush.Refine) {
        // 詰めの筆は引き終わった時点で一息に置く。
        // 途中で切って継ぎ足すと、継ぎ目に縁のぼかしが重なり、そこだけ 8bit の丸めで
        // 1 段階ずれる。元画像と最後まで一致させるには、一筆で置き切る必要がある。
        if (ops.to[k] < 1) continue;
        this.drawSegment(ctx, i, 0, 1);
        continue;
      }
      this.drawSegment(ctx, i, ops.from[k], ops.to[k]);
    }
  }

  /** ストローク i の区間 [u0, u1] を描く。 */
  private drawSegment(ctx: Ctx2D, i: number, u0: number, u1: number): void {
    const s = this.plan.strokes;
    const sc = this.opts.scale;
    const x0 = s.x0[i] * sc;
    const y0 = s.y0[i] * sc;
    const cx = s.cx[i] * sc;
    const cy = s.cy[i] * sc;
    const x1 = s.x1[i] * sc;
    const y1 = s.y1[i] * sc;
    const brush = s.brush[i];
    const baseW = Math.max(0.4, s.width[i] * sc);
    const alpha = s.opacity[i] / 255;
    const press = s.pressure[i] / 255;

    // 区間の長さから分割数を決める。短い区間で無駄に分割しない。
    const approx = (Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy)) * (u1 - u0);
    const taper = brush === Brush.Round || brush === Brush.Grain ? this.opts.taper : 0;
    const steps = clamp(Math.ceil(approx / (taper > 0.05 ? 6 : 14)), 1, 32);

    ctx.globalCompositeOperation = compositeFor(brush, this.opts);

    if (brush === Brush.Soft && this.opts.softness > 0) {
      // にじみは、細い芯と太い外周の重ね塗りで近似する（ぼかし処理より軽い）。
      this.strokePath(ctx, i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW * (1 + this.opts.softness * 1.6), alpha * 0.35, press, 0);
      this.strokePath(ctx, i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW, alpha * 0.75, press, 0);
      return;
    }

    if (brush === Brush.Grain && this.opts.grain > 0) {
      const n = 2;
      for (let g = 0; g < n; g++) {
        const off = (rand01(i, g, 0x7a11) - 0.5) * baseW * this.opts.grain * 1.4;
        this.strokePath(
          ctx, i, x0 + off, y0 + off * 0.3, cx + off, cy + off * 0.3, x1 + off, y1 + off * 0.3,
          u0, u1, steps, baseW * 0.55, alpha * 0.7, press, taper,
        );
      }
      return;
    }

    this.strokePath(ctx, i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW, alpha, press, taper);
  }

  private strokePath(
    ctx: Ctx2D, i: number,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
    u0: number, u1: number, steps: number,
    baseW: number, alpha: number, press: number, taper: number,
  ): void {
    const brush = this.plan.strokes.brush[i];
    // 詰めの筆は元画像を絵の具にする。用意が無ければ拾った色で代用する。
    if (brush === Brush.Refine && this.sourcePattern) {
      ctx.strokeStyle = this.sourcePattern;
      ctx.globalAlpha = alpha;
    } else {
      ctx.strokeStyle = cssColor(this.plan.strokes.color[i], alpha);
      ctx.globalAlpha = 1;
    }

    if (taper <= 0.05) {
      // 幅が一定なら 1 パスで引ける。面塗りはこちらが大半を占める。
      ctx.lineWidth = baseW * (0.65 + 0.35 * press);
      ctx.beginPath();
      let px = quadratic(x0, cx, x1, u0);
      let py = quadratic(y0, cy, y1, u0);
      ctx.moveTo(px, py);
      for (let k = 1; k <= steps; k++) {
        const u = lerp(u0, u1, k / steps);
        px = quadratic(x0, cx, x1, u);
        py = quadratic(y0, cy, y1, u);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    for (let k = 0; k < steps; k++) {
      const ua = lerp(u0, u1, k / steps);
      const ub = lerp(u0, u1, (k + 1) / steps);
      const um = (ua + ub) * 0.5;
      ctx.lineWidth = Math.max(0.4, baseW * pressureAt(um, 0.6 + 0.4 * press, taper));
      ctx.beginPath();
      ctx.moveTo(quadratic(x0, cx, x1, ua), quadratic(y0, cy, y1, ua));
      ctx.lineTo(quadratic(x0, cx, x1, ub), quadratic(y0, cy, y1, ub));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 途中経過の複製を作る（巻き戻し高速化用のキャッシュ）。 */
  snapshot(): PainterSnapshot {
    const copy = (src: Surface): Surface => {
      const c = createSurface(this.width, this.height);
      const ctx = context(c, true);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(src as CanvasImageSource, 0, 0);
      return c;
    };
    return { color: copy(this.canvas), ink: copy(this.ink) };
  }

  /** キャッシュした途中経過へ戻す。 */
  restore(snap: PainterSnapshot): void {
    const put = (ctx: Ctx2D, src: Surface): void => {
      ctx.globalCompositeOperation = 'copy';
      ctx.globalAlpha = 1;
      ctx.drawImage(src as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };
    put(this.ctx, snap.color);
    put(this.inkCtx, snap.ink);
  }

  /** 紙を敷き、色の面、線の面の順に重ねる。 */
  private paintInto(ctx: Ctx2D, dw: number, dh: number): void {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssColor(this.plan.paper, 1);
    ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(this.canvas as CanvasImageSource, 0, 0, dw, dh);
    ctx.drawImage(this.ink as CanvasImageSource, 0, 0, dw, dh);
  }

  /** 表示用キャンバスへ転送する。 */
  present(dest: CanvasRenderingContext2D, dw: number, dh: number): void {
    this.paintInto(dest, dw, dh);
  }

  /** 現在の見た目そのままの面を返す（書き出し用）。 */
  output(): Surface {
    if (!this.composed) this.composed = createSurface(this.width, this.height);
    this.paintInto(context(this.composed, false), this.width, this.height);
    return this.composed;
  }

  /** 縮小したフレームを取り出す（GIF 書き出し用）。 */
  readScaled(w: number, h: number): ImageData {
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch = createSurface(w, h);
    }
    const ctx = context(this.scratch, false);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    this.paintInto(ctx, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  toBlob(type = 'image/png', quality?: number): Promise<Blob> {
    const c = this.output();
    if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) {
      return c.convertToBlob({ type, quality });
    }
    return new Promise((resolve, reject) => {
      (c as unknown as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('画像を書き出せませんでした'))),
        type,
        quality,
      );
    });
  }
}

/** 筆ごとの重ね方。 */
function compositeFor(brush: number, opts: PainterOptions): GlobalCompositeOperation {
  // 下塗りと詰めは、画風の合成方法に関わらず素直に置く。
  // 乗算のまま重ねると、置きたい色より暗くなってしまう。
  if (brush === Brush.Under || brush === Brush.Refine) return 'source-over';
  return brush === Brush.Flat ? opts.fillComposite : opts.inkComposite;
}

/** 2 次ベジェの座標。 */
function quadratic(p0: number, p1: number, p2: number, u: number): number {
  const iu = 1 - u;
  return iu * iu * p0 + 2 * iu * u * p1 + u * u * p2;
}
