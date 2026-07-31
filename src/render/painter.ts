/**
 * 出力アダプタ（キャンバス描画）。
 *
 * 状態遷移が出した描画命令を、そのままキャンバスへ写すだけの読み取り専用の層。
 * ここから状態を書き換えることはない。
 *
 * 軽量化の要点は「毎フレーム全部描き直さない」こと。キャンバスは塗り重ねの結果を
 * そのまま保持しているので、その tick で伸びた分の区間だけを追記すればよい。
 * 巻き戻すときだけ、キャッシュした途中経過から再計算する。
 *
 * 最後の数秒では、筆致の上に元画像を重ねていく（収束）。工程の終わりが必ず
 * 元画像そのものになるようにするための仕上げで、重ね具合は tick だけで決まるため
 * プレビューと書き出しで必ず一致する。
 */

import type { DrawingPlan } from '../core/schema';
import { Brush, cssColor } from '../core/schema';
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
  /** 収束先の元画像。無ければ収束しない */
  source?: CanvasImageSource | null;
}

function context(c: Surface): Ctx2D {
  const ctx = c.getContext('2d', { alpha: false }) as Ctx2D | null;
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  return ctx;
}

export class Painter {
  /** 筆致だけを保持する面。収束の重ねはここには入れない */
  readonly canvas: Surface;
  readonly ctx: Ctx2D;
  readonly width: number;
  readonly height: number;
  /** 元画像の重ね具合 0-1。1 で完全に元画像となる */
  convergence = 0;
  /** 収束を行うか（レイヤーを隠しているときは行わない） */
  convergenceEnabled = true;

  private plan: DrawingPlan;
  private opts: PainterOptions;
  private scratch: Surface | null = null;
  private composed: Surface | null = null;
  private source: Surface | null = null;

  constructor(plan: DrawingPlan, opts: PainterOptions) {
    this.plan = plan;
    this.opts = opts;
    this.width = Math.max(2, Math.round(plan.width * opts.scale));
    this.height = Math.max(2, Math.round(plan.height * opts.scale));
    this.canvas = createSurface(this.width, this.height);
    this.ctx = context(this.canvas);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    if (opts.source) this.setSource(opts.source);
    this.clear();
  }

  /** 収束先の画像を出力解像度で焼き込んでおく（毎フレームの拡大縮小を避ける）。 */
  setSource(source: CanvasImageSource): void {
    const surface = createSurface(this.width, this.height);
    const ctx = context(surface);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, this.width, this.height);
    this.source = surface;
  }

  /** 実際に適用される重ね具合。 */
  get effectiveConvergence(): number {
    if (!this.source || !this.convergenceEnabled) return 0;
    return clamp(this.convergence, 0, 1);
  }

  /** 紙の状態に戻す。 */
  clear(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssColor(this.plan.paper, 1);
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /** 1 tick 分の描画命令を反映する。 */
  apply(ops: PaintOps, visibleLayers: Uint8Array | null): void {
    const s = this.plan.strokes;
    for (let k = 0; k < ops.count; k++) {
      const i = ops.index[k];
      if (visibleLayers && visibleLayers[s.layer[i]] === 0) continue;
      this.drawSegment(i, ops.from[k], ops.to[k]);
    }
  }

  /** ストローク i の区間 [u0, u1] を描く。 */
  private drawSegment(i: number, u0: number, u1: number): void {
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
    const ctx = this.ctx;

    // 区間の長さから分割数を決める。短い区間で無駄に分割しない。
    const approx = (Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy)) * (u1 - u0);
    const taper = brush === Brush.Round || brush === Brush.Grain ? this.opts.taper : 0;
    const steps = clamp(Math.ceil(approx / (taper > 0.05 ? 6 : 14)), 1, 32);

    ctx.globalCompositeOperation =
      brush === Brush.Flat ? this.opts.fillComposite : this.opts.inkComposite;

    if (brush === Brush.Soft && this.opts.softness > 0) {
      // にじみは、細い芯と太い外周の重ね塗りで近似する（ぼかし処理より軽い）。
      this.strokePath(i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW * (1 + this.opts.softness * 1.6), alpha * 0.35, press, 0);
      this.strokePath(i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW, alpha * 0.75, press, 0);
      return;
    }

    if (brush === Brush.Grain && this.opts.grain > 0) {
      const n = 2;
      for (let g = 0; g < n; g++) {
        const off = (rand01(i, g, 0x7a11) - 0.5) * baseW * this.opts.grain * 1.4;
        this.strokePath(
          i, x0 + off, y0 + off * 0.3, cx + off, cy + off * 0.3, x1 + off, y1 + off * 0.3,
          u0, u1, steps, baseW * 0.55, alpha * 0.7, press, taper,
        );
      }
      return;
    }

    this.strokePath(i, x0, y0, cx, cy, x1, y1, u0, u1, steps, baseW, alpha, press, taper);
  }

  private strokePath(
    i: number,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
    u0: number, u1: number, steps: number,
    baseW: number, alpha: number, press: number, taper: number,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = cssColor(this.plan.strokes.color[i], alpha);

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
  }

  /** 途中経過の複製を作る（巻き戻し高速化用のキャッシュ）。 */
  snapshot(): Surface {
    const c = createSurface(this.width, this.height);
    const ctx = context(c);
    ctx.drawImage(this.canvas as CanvasImageSource, 0, 0);
    return c;
  }

  /** キャッシュした途中経過へ戻す。 */
  restore(snap: Surface): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(snap as CanvasImageSource, 0, 0);
  }

  /** 筆致に元画像の重ねを加えて描く。 */
  private paintInto(ctx: Ctx2D, dw: number, dh: number): void {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.canvas as CanvasImageSource, 0, 0, dw, dh);
    const a = this.effectiveConvergence;
    if (a > 0 && this.source) {
      ctx.globalAlpha = a;
      ctx.drawImage(this.source as CanvasImageSource, 0, 0, dw, dh);
      ctx.globalAlpha = 1;
    }
  }

  /** 表示用キャンバスへ転送する。 */
  present(dest: CanvasRenderingContext2D, dw: number, dh: number): void {
    this.paintInto(dest, dw, dh);
  }

  /** 現在の見た目そのままの面を返す（書き出し用）。 */
  output(): Surface {
    if (this.effectiveConvergence <= 0) return this.canvas;
    if (!this.composed) this.composed = createSurface(this.width, this.height);
    this.paintInto(context(this.composed), this.width, this.height);
    return this.composed;
  }

  /** 縮小したフレームを取り出す（GIF 書き出し用）。 */
  readScaled(w: number, h: number): ImageData {
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch = createSurface(w, h);
    }
    const ctx = context(this.scratch);
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

/** 2 次ベジェの座標。 */
function quadratic(p0: number, p1: number, p2: number, u: number): number {
  const iu = 1 - u;
  return iu * iu * p0 + 2 * iu * u * p1 + u * u * p2;
}
