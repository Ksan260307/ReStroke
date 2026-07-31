/**
 * 色の解析。
 *
 * 画像を少数の代表色へまとめる。塗りは結局のところ「同じ絵の具を置いた範囲」の
 * 集まりなので、代表色を決めてから領域に分けると、塗り分けの単位がそのまま取れる。
 *
 * 5bit×3 の色ヒストグラム（32768 箱）の上で中央値分割を行う。全画素を直接扱わず
 * 箱の単位で処理するため、画像サイズに対してほぼ線形で済む。
 */

import { rgb } from '../core/schema';

const BITS = 5;
const LEVELS = 1 << BITS; // 32
const BINS = LEVELS * LEVELS * LEVELS;

export interface ColorAnalysis {
  /** 代表色 0xRRGGBB */
  palette: Uint32Array;
  /** 画素ごとの代表色番号 */
  index: Uint8Array;
  /** 代表色ごとの画素数 */
  histogram: Int32Array;
}

const binOf = (r: number, g: number, b: number): number =>
  ((r >> (8 - BITS)) << (BITS * 2)) | ((g >> (8 - BITS)) << BITS) | (b >> (8 - BITS));

export function quantize(rgba: Uint8ClampedArray, w: number, h: number, k: number): ColorAnalysis {
  const n = w * h;
  const count = new Int32Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const bin = binOf(r, g, b);
    count[bin]++;
    sumR[bin] += r;
    sumG[bin] += g;
    sumB[bin] += b;
  }

  // 使われている箱だけを集める。
  const bins: number[] = [];
  for (let i = 0; i < BINS; i++) if (count[i] > 0) bins.push(i);
  const order = Int32Array.from(bins);

  const target = Math.max(2, Math.min(k, order.length, 255));
  const boxes = medianCut(order, count, target);

  const palette = new Uint32Array(boxes.length);
  const histogram = new Int32Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const { start, end } = boxes[i];
    let cr = 0, cg = 0, cb = 0, ct = 0;
    for (let j = start; j < end; j++) {
      const bin = order[j];
      cr += sumR[bin];
      cg += sumG[bin];
      cb += sumB[bin];
      ct += count[bin];
    }
    if (ct === 0) ct = 1;
    palette[i] = rgb(Math.round(cr / ct), Math.round(cg / ct), Math.round(cb / ct));
    histogram[i] = ct;
  }

  // 箱 → 代表色番号の対応表を作り、画素はこの表を引くだけにする。
  const lut = new Uint8Array(BINS);
  for (let bin = 0; bin < BINS; bin++) {
    if (count[bin] === 0) continue;
    const r = ((bin >> (BITS * 2)) & (LEVELS - 1)) << (8 - BITS);
    const g = ((bin >> BITS) & (LEVELS - 1)) << (8 - BITS);
    const b = (bin & (LEVELS - 1)) << (8 - BITS);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const dr = ((c >>> 16) & 255) - r;
      const dg = ((c >>> 8) & 255) - g;
      const db = (c & 255) - b;
      // 人の目に合わせて緑を重く見る。
      const d = dr * dr * 2 + dg * dg * 4 + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    lut[bin] = best;
  }

  const index = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    index[i] = lut[binOf(rgba[p], rgba[p + 1], rgba[p + 2])];
  }

  return { palette, index, histogram };
}

interface Box {
  start: number;
  end: number;
  count: number;
  axis: number;
  span: number;
}

function medianCut(order: Int32Array, count: Int32Array, k: number): Box[] {
  const boxes: Box[] = [measure(order, count, 0, order.length)];
  while (boxes.length < k) {
    // 最も色幅の広い箱を割る。同点は画素数の多い方。
    let pick = -1;
    let score = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.end - b.start < 2 || b.span <= 0) continue;
      const s = b.span * Math.log(1 + b.count);
      if (s > score) {
        score = s;
        pick = i;
      }
    }
    if (pick < 0) break;

    const box = boxes[pick];
    const shift = box.axis === 0 ? BITS * 2 : box.axis === 1 ? BITS : 0;
    const sub = Array.from(order.subarray(box.start, box.end));
    sub.sort((a, b) => ((a >> shift) & (LEVELS - 1)) - ((b >> shift) & (LEVELS - 1)));
    order.set(sub, box.start);

    const half = box.count / 2;
    let acc = 0;
    let split = box.start + 1;
    for (let j = box.start; j < box.end - 1; j++) {
      acc += count[order[j]];
      if (acc >= half) {
        split = j + 1;
        break;
      }
    }
    boxes[pick] = measure(order, count, box.start, split);
    boxes.push(measure(order, count, split, box.end));
  }
  return boxes;
}

function measure(order: Int32Array, count: Int32Array, start: number, end: number): Box {
  let minR = 31, maxR = 0, minG = 31, maxG = 0, minB = 31, maxB = 0, total = 0;
  for (let j = start; j < end; j++) {
    const bin = order[j];
    const r = (bin >> (BITS * 2)) & (LEVELS - 1);
    const g = (bin >> BITS) & (LEVELS - 1);
    const b = bin & (LEVELS - 1);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
    total += count[bin];
  }
  const dr = (maxR - minR) * 1.4;
  const dg = (maxG - minG) * 2.0;
  const db = maxB - minB;
  let axis = 0;
  let span = dr;
  if (dg > span) {
    axis = 1;
    span = dg;
  }
  if (db > span) {
    axis = 2;
    span = db;
  }
  return { start, end, count: total, axis, span };
}
