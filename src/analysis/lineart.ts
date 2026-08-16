/**
 * 線画の抽出。
 *
 * 輪郭の強い画素を種にして、勾配と直交する向き（＝線が伸びる向き）へ稜線をたどる。
 * 塗りつぶした輪郭画像をそのまま線として扱うと「なぞった跡」が出ないため、
 * 実際にペンを動かす軌跡としてつながった折れ線を取り出す。
 */

import type { EdgeMap } from './image';

export interface Polyline {
  /** x,y の交互配列 */
  pts: Float32Array;
  count: number;
  length: number;
}

export interface TraceOptions {
  /** 1 歩の長さ（px） */
  step: number;
  /** 追跡を打ち切る強さの比率 */
  stopRatio: number;
  /** 最短の線の長さ（px） */
  minLength: number;
  /** 取り出す線の最大本数 */
  maxLines: number;
  /**
   * なぞった画素の周囲を、何画素ぶん自分のものとして確保するか。
   *
   * 0 にすると隣り合う稜線をそれぞれ別の線として拾うので、線の本数が大きく増える。
   * 1 にすると太い輪郭が 1 本にまとまり、本数は減るが 1 本 1 本が長くなる。
   */
  claimRadius: number;
}

const DEFAULTS: TraceOptions = {
  step: 1.6,
  stopRatio: 0.5,
  minLength: 7,
  maxLines: 4000,
  claimRadius: 1,
};

export function traceLines(edges: EdgeMap, options: Partial<TraceOptions> = {}): Polyline[] {
  const opt = { ...DEFAULTS, ...options };
  const { width: w, height: h, mag, gx, gy, threshold } = edges;
  // 「どの線がなぞった画素か」を持つ。自分の足跡で止まらないようにするため、
  // 単なる通過済み印ではなく所有者を記録する（0 は未通過）。
  const owner = new Int32Array(w * h);
  let currentLine = 0;
  const stopLevel = threshold * opt.stopRatio;

  // 強い画素から順に種にする（主要な輪郭が先に引かれる）。
  const counts = new Int32Array(256);
  let seedTotal = 0;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= threshold) {
      counts[mag[i]]++;
      seedTotal++;
    }
  }
  const offsets = new Int32Array(256);
  let acc = 0;
  for (let v = 255; v >= 0; v--) {
    offsets[v] = acc;
    acc += counts[v];
  }
  const seeds = new Int32Array(seedTotal);
  const fill = offsets.slice();
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= threshold) seeds[fill[mag[i]]++] = i;
  }

  const lines: Polyline[] = [];

  // 追跡中の点を置く作業用の入れ物。種ごとに確保し直すと、数十万回の確保が
  // そのままゴミになるので、前後 1 組ずつを使い回す。
  const MAX_STEPS = 512;
  const fwdXs = new Float32Array(MAX_STEPS);
  const fwdYs = new Float32Array(MAX_STEPS);
  const bwdXs = new Float32Array(MAX_STEPS);
  const bwdYs = new Float32Array(MAX_STEPS);

  for (let s = 0; s < seeds.length && lines.length < opt.maxLines; s++) {
    const p = seeds[s];
    if (owner[p] !== 0) continue;
    const sy = (p / w) | 0;
    const sx = p - sy * w;

    currentLine++;
    const fwdCount = walk(sx, sy, 1, fwdXs, fwdYs);
    const bwdCount = walk(sx, sy, -1, bwdXs, bwdYs);
    const total = fwdCount + bwdCount;
    if (total < 2) {
      owner[p] = currentLine;
      continue;
    }

    const pts = new Float32Array(total * 2);
    let k = 0;
    for (let i = bwdCount - 1; i >= 0; i--) {
      pts[k++] = bwdXs[i];
      pts[k++] = bwdYs[i];
    }
    for (let i = 0; i < fwdCount; i++) {
      pts[k++] = fwdXs[i];
      pts[k++] = fwdYs[i];
    }

    let length = 0;
    for (let i = 2; i < pts.length; i += 2) {
      length += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    }
    if (length < opt.minLength) continue;
    lines.push({ pts, count: total, length });
  }

  // 長い線＝主要な形から先に描く。ただし長さの順にそのまま並べると、ペンが画面中を
  // 飛び回る。長さで 3 段の帯に分け、その中では画面の上から下・左から右へ進める。
  if (lines.length > 2) {
    let longest = 0;
    for (const l of lines) if (l.length > longest) longest = l.length;
    if (longest <= 0) longest = 1;
    const band = h / 3;
    // 並べ替えの比較のたびに計算し直さないよう、先に段を求めておく。
    const tiers = new Map<Polyline, number>();
    for (const l of lines) {
      tiers.set(l, Math.min(2, Math.floor((1 - l.length / longest) * 3)));
    }
    lines.sort((a, b) => {
      const ta = tiers.get(a)!;
      const tb = tiers.get(b)!;
      if (ta !== tb) return ta - tb;
      const ra = Math.floor(a.pts[1] / band);
      const rb = Math.floor(b.pts[1] / band);
      if (ra !== rb) return ra - rb;
      // 同点は長さで倒し、並べ替えの実装によらず同じ結果になるようにする。
      return a.pts[0] - b.pts[0] || b.length - a.length;
    });
  }
  return lines;

  function walk(x0: number, y0: number, sign: number, xs: Float32Array, ys: Float32Array): number {
    const maxSteps = MAX_STEPS;
    let count = 0;
    let x = x0 + 0.5;
    let y = y0 + 0.5;
    const i0 = y0 * w + x0;
    let dx = -gy[i0];
    let dy = gx[i0];
    const norm = Math.hypot(dx, dy);
    if (norm < 1e-4) return count;
    dx = (dx / norm) * sign;
    dy = (dy / norm) * sign;

    for (let n = 0; n < maxSteps; n++) {
      const ix = Math.round(x - 0.5);
      const iy = Math.round(y - 0.5);
      if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1) break;
      const idx = iy * w + ix;
      if (mag[idx] < stopLevel) break;
      // 別の線がすでになぞった輪郭なら、そこで打ち切る（二重描きを避ける）。
      // 自分の足跡は通り抜けてよい。
      if (owner[idx] !== 0 && owner[idx] !== currentLine) break;
      // 輪が閉じたら止める（同じ輪を何周もしない）。
      if (n > 8 && Math.hypot(x - (x0 + 0.5), y - (y0 + 0.5)) < opt.step) break;

      xs[count] = x;
      ys[count] = y;
      count++;
      claim(ix, iy);

      // 進行方向の前後 ±22 度から、最も稜線が強い向きを選ぶ。
      let bestAng = 0;
      let bestMag = -1;
      for (let a = -1; a <= 1; a++) {
        const ang = a * 0.38;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const nx = dx * cos - dy * sin;
        const ny = dx * sin + dy * cos;
        const px = Math.round(x + nx * opt.step - 0.5);
        const py = Math.round(y + ny * opt.step - 0.5);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const m = mag[py * w + px];
        if (m > bestMag) {
          bestMag = m;
          bestAng = ang;
        }
      }
      if (bestMag < stopLevel) break;
      const cos = Math.cos(bestAng);
      const sin = Math.sin(bestAng);
      const ndx = dx * cos - dy * sin;
      const ndy = dx * sin + dy * cos;
      dx = ndx;
      dy = ndy;
      x += dx * opt.step;
      y += dy * opt.step;
    }
    return count;
  }

  /** その画素の周囲を現在の線のものとして確保する（先に取った線が優先）。 */
  function claim(ix: number, iy: number): void {
    const r = opt.claimRadius;
    for (let yy = iy - r; yy <= iy + r; yy++) {
      if (yy < 0 || yy >= h) continue;
      const row = yy * w;
      for (let xx = ix - r; xx <= ix + r; xx++) {
        if (xx < 0 || xx >= w) continue;
        if (owner[row + xx] === 0) owner[row + xx] = currentLine;
      }
    }
  }
}
