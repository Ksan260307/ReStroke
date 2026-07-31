/**
 * ストローク生成。
 *
 * 塗りつぶされた領域を「筆の運び」へ変換する。領域の主軸に沿って一定間隔の走査線を
 * 引き、その領域に入っている区間だけを 1 本のストロークとして切り出す。形に沿って
 * 筆が走るので、単純な横方向の塗りつぶしよりも手描きらしい跡が残る。
 *
 * 生成されるのは、始点・制御点・終点・太さ・色・不透明度・筆圧・所要時間を持つ
 * 平坦な表（SoA）。この表と乱数シードさえあれば、動画は何度でも同じものが作れる。
 *
 * 総本数には上限を設ける。上限に当たった場合は筆の間隔を広げて作り直す＝1 本あたりを
 * 太く粗くすることで、どんな画像でも決まった予算内に収める。
 */

import type { WorkImage, EdgeMap } from '../analysis/image';
import type { ColorAnalysis } from '../analysis/quantize';
import type { Segmentation, Region } from '../analysis/segment';
import type { LayerAssignment } from '../analysis/layers';
import type { Polyline } from '../analysis/lineart';
import type { StyleProfile } from './styles';
import { Brush, Stage, STAGE_COUNT, createStrokeTable, pushStroke, rgb } from '../core/schema';
import type { StrokeTable } from '../core/schema';
import { clamp, rand01, randSigned } from '../core/rng';

export interface GenerateInput {
  img: WorkImage;
  edges: EdgeMap;
  color: ColorAnalysis;
  seg: Segmentation;
  assign: LayerAssignment;
  lines: Polyline[];
  style: StyleProfile;
  seed: number;
  maxStrokes: number;
  /** 塗りの対象とする最小面積（これ未満は領域として扱われていない） */
  minArea: number;
}

export interface GenerateResult {
  strokes: StrokeTable;
  stageOffset: Int32Array;
  /** 上限に当たって粗くしたか */
  coarsened: boolean;
  /** 実際に使った筆の間隔 */
  spacing: number;
}

const MAX_REGIONS_PER_STAGE = 1400;

export function generateStrokes(input: GenerateInput): GenerateResult {
  const scale = Math.max(input.img.width, input.img.height) / 1024;
  let spacing = Math.max(2, input.style.spacing * Math.max(0.55, scale));
  let coarsened = false;

  for (let attempt = 0; attempt < 4; attempt++) {
    const out = build(input, spacing);
    if (!out.overflow || attempt === 3) {
      return { strokes: out.table, stageOffset: out.stageOffset, coarsened, spacing };
    }
    // 予算に収まらなかったので筆を太くして本数を減らす。
    spacing *= 1.45;
    coarsened = true;
  }
  throw new Error('ストロークを生成できませんでした');
}

interface BuildResult {
  table: StrokeTable;
  stageOffset: Int32Array;
  overflow: boolean;
}

function build(input: GenerateInput, spacing: number): BuildResult {
  const { img, edges, color, seg, assign, lines, style, seed } = input;
  const w = img.width;
  const h = img.height;
  const table = createStrokeTable(input.maxStrokes);
  const stageOffset = new Int32Array(STAGE_COUNT + 1);
  let overflow = false;
  let serial = 0;

  const sampleStep = Math.max(1, spacing * 0.42);
  const widthBase = spacing * style.widthFactor;
  const maxLen = style.maxLength * Math.max(0.6, spacing / style.spacing);

  const emit = (
    x0: number, y0: number, x1: number, y1: number,
    width: number, col: number, opacity: number, pressure: number,
    stage: number, layer: number, brush: number, bow: number,
  ): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const nx = len > 1e-3 ? -(y1 - y0) / len : 0;
    const ny = len > 1e-3 ? (x1 - x0) / len : 0;
    const k = randSigned(seed ^ 0x2f1b, serial, 0x77) * bow * Math.min(len * 0.35, 14);
    const duration = clamp(Math.round(len / style.speed) + 1, 1, 255);
    const ok = pushStroke(table, {
      x0, y0,
      cx: mx + nx * k,
      cy: my + ny * k,
      x1, y1,
      width: Math.max(0.6, width),
      color: col,
      opacity: Math.round(clamp(opacity, 0, 1) * 255),
      pressure: Math.round(clamp(pressure, 0, 1) * 255),
      duration,
      stage,
      layer,
      brush,
    });
    if (!ok) overflow = true;
    serial++;
  };

  /**
   * その場所の色を拾う。
   *
   * 元の画素ではなく平滑化した版から取る。1 画素だけ見ると写真のノイズをそのまま
   * 筆に乗せてしまい、まだらになるため。
   */
  const pick = (x: number, y: number): number => {
    const ix = clamp(Math.round(x), 0, w - 1);
    const iy = clamp(Math.round(y), 0, h - 1);
    const p = (iy * w + ix) * 4;
    return rgb(img.smooth[p], img.smooth[p + 1], img.smooth[p + 2]);
  };

  const blend = (a: number, b: number, t: number): number =>
    rgb(
      Math.round(((a >>> 16) & 255) * (1 - t) + ((b >>> 16) & 255) * t),
      Math.round(((a >>> 8) & 255) * (1 - t) + ((b >>> 8) & 255) * t),
      Math.round((a & 255) * (1 - t) + (b & 255) * t),
    );

  const vary = (c: number, amount: number, salt: number): number => {
    if (amount <= 0) return c;
    const d = randSigned(seed ^ 0x51e7, salt) * amount * 255;
    const s = 1 + randSigned(seed ^ 0x9d3a, salt) * amount * 0.35;
    return rgb(
      clamp(Math.round(((c >>> 16) & 255) * s + d), 0, 255),
      clamp(Math.round(((c >>> 8) & 255) * s + d * 0.9), 0, 255),
      clamp(Math.round((c & 255) * s + d * 1.1), 0, 255),
    );
  };

  const fillBrush = style.grain > 0.6 ? Brush.Grain : Brush.Flat;
  const regionsByStage = groupRegions(seg, assign, input.minArea);

  /**
   * 画面全体を大きな筆で一度覆う。
   *
   * 領域として拾えなかった細かい部分（写真の粒状感など）が紙のまま残らないよう、
   * 平均色でざっと敷いておく。実際の制作でも、細部に入る前に全体の色を置く。
   */
  function blockIn(): void {
    const gap = spacing * 2.8;
    const runLen = Math.max(gap * 3, maxLen * 1.8);
    for (let y = gap * 0.5; y < h + gap; y += gap) {
      const yy = Math.min(h - 1, y);
      for (let x = 0; x < w; x += runLen) {
        const x1 = Math.min(w - 1, x + runLen);
        // 区間の平均色を取る（1 点だけ見ると粒に引っぱられる）。
        let cr = 0, cg = 0, cb = 0, n = 0;
        for (let t = 0; t <= 6; t++) {
          const sx = clamp(Math.round(x + ((x1 - x) * t) / 6), 0, w - 1);
          const p = (Math.round(yy) * w + sx) * 4;
          cr += img.smooth[p];
          cg += img.smooth[p + 1];
          cb += img.smooth[p + 2];
          n++;
        }
        const col = vary(rgb(cr / n, cg / n, cb / n), style.colorJitter * 0.5, serial);
        const wob = randSigned(seed ^ 0x60d, serial, 4) * gap * 0.25;
        const under = seg.labels[Math.round(yy) * w + clamp(Math.round(x), 0, w - 1)];
        emit(
          x, yy + wob, x1, yy - wob,
          gap * 1.2, col, Math.min(1, style.fillOpacity * 1.15), 0.7,
          Stage.Background,
          under >= 0 ? assign.regionLayer[under] : assign.roughLayer,
          Brush.Flat, style.bow * 0.4,
        );
      }
    }
  }

  /** 領域を主軸方向の走査線で塗る。 */
  const hatch = (
    r: Region,
    gap: number,
    lenCap: number,
    stage: number,
    layer: number,
    brush: number,
    opacity: number,
    widthScale: number,
    passes: number,
  ): void => {
    const labels = seg.labels;
    for (let pass = 0; pass < passes; pass++) {
      const angle = r.angle + (pass % 2 === 0 ? 0 : 0.42) + randSigned(seed, r.id, pass) * 0.05;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const nx = -dy;
      const ny = dx;
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (let c = 0; c < 4; c++) {
        const px = (c & 1) === 0 ? r.minX : r.maxX;
        const py = c < 2 ? r.minY : r.maxY;
        const rx = px - r.cx;
        const ry = py - r.cy;
        const u = rx * nx + ry * ny;
        const v = rx * dx + ry * dy;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }

      const offset = (gap * (pass + 0.5)) / passes;
      for (let u = uMin + offset; u <= uMax; u += gap) {
        let runStart = Number.NaN;
        let prevV = vMin;
        for (let v = vMin; v <= vMax + sampleStep; v += sampleStep) {
          const x = r.cx + u * nx + v * dx;
          const y = r.cy + u * ny + v * dy;
          const ix = x | 0;
          const iy = y | 0;
          const inside =
            ix >= 0 && iy >= 0 && ix < w && iy < h && labels[iy * w + ix] === r.id;
          if (inside) {
            if (Number.isNaN(runStart)) runStart = v;
            else if (v - runStart >= lenCap) {
              flush(runStart, v);
              runStart = v;
            }
          } else if (!Number.isNaN(runStart)) {
            flush(runStart, prevV);
            runStart = Number.NaN;
          }
          prevV = v;
        }
        if (!Number.isNaN(runStart)) flush(runStart, vMax);

        function flush(v0: number, v1: number): void {
          if (v1 - v0 < gap * 0.35) return;
          const jx = randSigned(seed ^ 0x1234, serial, 1) * style.jitter;
          const jy = randSigned(seed ^ 0x5678, serial, 2) * style.jitter;
          const x0 = r.cx + u * nx + v0 * dx + jx;
          const y0 = r.cy + u * ny + v0 * dy + jy;
          const x1 = r.cx + u * nx + v1 * dx + jx;
          const y1 = r.cy + u * ny + v1 * dy + jy;
          const base = color.palette[r.color];
          const sampled = pick((x0 + x1) / 2, (y0 + y1) / 2);
          const col = vary(blend(base, sampled, style.colorFidelity), style.colorJitter, serial);
          const press = 0.55 + rand01(seed ^ 0xa1, serial) * 0.45;
          emit(
            x0, y0, x1, y1,
            widthBase * widthScale * (0.85 + rand01(seed, serial, 3) * 0.3),
            col, opacity, press, stage, layer, brush, style.bow,
          );
        }
      }
    }
  };

  // ---- 背景 ----
  stageOffset[Stage.Background] = table.count;
  blockIn();
  for (const r of regionsByStage[Stage.Background]) {
    hatch(
      r, spacing * 1.5, maxLen * 1.6, Stage.Background, assign.regionLayer[r.id],
      fillBrush, style.fillOpacity, 1.35, Math.max(1, style.fillPasses - 1),
    );
  }

  // ---- ラフ ----
  stageOffset[Stage.Rough] = table.count;
  if (style.rough > 0.02) {
    const majors = [...regionsByStage[Stage.Background], ...regionsByStage[Stage.Base]]
      .sort((a, b) => b.area - a.area)
      .slice(0, Math.max(3, Math.round(18 * style.rough)));
    for (const r of majors) {
      hatch(
        r, spacing * (6 - style.rough * 2), maxLen * 2.2, Stage.Rough, assign.roughLayer,
        Brush.Flat, style.fillOpacity * 0.45 * style.rough + 0.05, 3.2, 1,
      );
    }
    // 形を探る当たり線。
    const sketchCount = Math.round(lines.length * 0.12 * style.rough);
    for (let i = 0; i < sketchCount; i++) {
      const ln = lines[i];
      if (!ln) break;
      const a = 0;
      const b = ln.count - 1;
      const x0 = ln.pts[a * 2] + randSigned(seed, i, 11) * 4;
      const y0 = ln.pts[a * 2 + 1] + randSigned(seed, i, 12) * 4;
      const x1 = ln.pts[b * 2] + randSigned(seed, i, 13) * 4;
      const y1 = ln.pts[b * 2 + 1] + randSigned(seed, i, 14) * 4;
      emit(
        x0, y0, x1, y1, style.lineWidth * 1.4, 0x8b8378,
        0.28 * style.rough + 0.08, 0.5, Stage.Rough, assign.roughLayer, Brush.Round, style.bow * 1.6,
      );
    }
  }

  // ---- 線画 ----
  stageOffset[Stage.LineArt] = table.count;
  if (style.lineArt) {
    const chunkLen = maxLen * 1.2;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let acc = 0;
      let startIdx = 0;
      for (let p = 1; p < ln.count; p++) {
        acc += Math.hypot(
          ln.pts[p * 2] - ln.pts[(p - 1) * 2],
          ln.pts[p * 2 + 1] - ln.pts[(p - 1) * 2 + 1],
        );
        const last = p === ln.count - 1;
        if (acc >= chunkLen || last) {
          emitLineChunk(ln, startIdx, p);
          startIdx = p;
          acc = 0;
        }
      }
    }
  }

  function emitLineChunk(ln: Polyline, a: number, b: number): void {
    if (b - a < 1) return;
    const x0 = ln.pts[a * 2];
    const y0 = ln.pts[a * 2 + 1];
    const x1 = ln.pts[b * 2];
    const y1 = ln.pts[b * 2 + 1];
    const m = (a + b) >> 1;
    const mx = ln.pts[m * 2];
    const my = ln.pts[m * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1.2) return;
    // 中間点を通る 2 次ベジェになるよう制御点を置く。
    const ccx = 2 * mx - (x0 + x1) / 2;
    const ccy = 2 * my - (y0 + y1) / 2;
    const dark = darkestNear(mx, my);
    const col = blend(dark, 0x181513, 0.35);
    const press = 0.6 + rand01(seed ^ 0x33, serial) * 0.4;
    const duration = clamp(Math.round(len / (style.speed * 0.8)) + 1, 1, 255);
    const jx = randSigned(seed ^ 0x99, serial, 5) * style.jitter * 0.5;
    const jy = randSigned(seed ^ 0x9a, serial, 6) * style.jitter * 0.5;
    const ok = pushStroke(table, {
      x0: x0 + jx, y0: y0 + jy,
      cx: ccx + jx, cy: ccy + jy,
      x1: x1 + jx, y1: y1 + jy,
      width: style.lineWidth * (0.8 + press * 0.4),
      color: col,
      opacity: Math.round(clamp(style.lineOpacity, 0, 1) * 255),
      pressure: Math.round(press * 255),
      duration,
      stage: Stage.LineArt,
      layer: assign.lineLayer,
      brush: style.grain > 0.5 ? Brush.Grain : Brush.Round,
    });
    if (!ok) overflow = true;
    serial++;
  }

  function darkestNear(x: number, y: number): number {
    let best = 0xffffff;
    let bestL = 1e9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = clamp(Math.round(x) + dx, 0, w - 1);
        const iy = clamp(Math.round(y) + dy, 0, h - 1);
        const l = img.lum[iy * w + ix];
        if (l < bestL) {
          bestL = l;
          const p = (iy * w + ix) * 4;
          best = rgb(img.smooth[p], img.smooth[p + 1], img.smooth[p + 2]);
        }
      }
    }
    return best;
  }

  // ---- ベースカラー ----
  stageOffset[Stage.Base] = table.count;
  for (const r of regionsByStage[Stage.Base]) {
    hatch(
      r, spacing, maxLen, Stage.Base, assign.regionLayer[r.id],
      fillBrush, style.fillOpacity, 1, style.fillPasses,
    );
  }

  // ---- 影 ----
  stageOffset[Stage.Shadow] = table.count;
  for (const r of regionsByStage[Stage.Shadow]) {
    hatch(
      r, spacing * 1.15, maxLen * 0.9, Stage.Shadow, assign.regionLayer[r.id],
      style.softness > 0.35 ? Brush.Soft : fillBrush,
      style.fillOpacity * 0.85, 1.05, Math.max(1, style.fillPasses - 1),
    );
  }

  // ---- 光 ----
  stageOffset[Stage.Light] = table.count;
  for (const r of regionsByStage[Stage.Light]) {
    hatch(
      r, spacing * 0.95, maxLen * 0.8, Stage.Light, assign.regionLayer[r.id],
      style.softness > 0.35 ? Brush.Soft : fillBrush,
      style.fillOpacity * 0.9, 0.9, 1,
    );
  }

  // ---- 細部 ----
  stageOffset[Stage.Detail] = table.count;
  {
    // 小さな色の塊を先に埋め、そのあと輪郭沿いに短い筆を置く。
    for (const r of regionsByStage[Stage.Detail]) {
      hatch(
        r, spacing * 0.85, maxLen * 0.5, Stage.Detail, assign.regionLayer[r.id],
        fillBrush, style.fillOpacity * 0.95, 0.85, 1,
      );
    }

    const gap = Math.max(3, spacing * (2.6 - style.detail * 1.6));
    const { mag, gx, gy, threshold } = edges;
    const detailLen = Math.max(4, spacing * 2.2);
    for (let y = 2; y < h - 2; y += gap) {
      for (let x = 2; x < w - 2; x += gap) {
        const iy = y | 0;
        const ix = x | 0;
        const i = iy * w + ix;
        if (mag[i] < threshold * 1.15) continue;
        if (rand01(seed ^ 0xd7, i) > style.detail) continue;
        const g = Math.hypot(gx[i], gy[i]) || 1;
        const tx = -gy[i] / g;
        const ty = gx[i] / g;
        const half = detailLen * (0.4 + rand01(seed, i, 7) * 0.6) * 0.5;
        const col = vary(darkestNear(ix, iy), style.colorJitter * 0.6, serial);
        emit(
          ix - tx * half, iy - ty * half, ix + tx * half, iy + ty * half,
          style.lineWidth * 0.9, col, style.lineOpacity * 0.8,
          0.5 + rand01(seed, i, 8) * 0.5, Stage.Detail,
          seg.labels[i] >= 0 ? assign.regionLayer[seg.labels[i]] : assign.finishLayer,
          Brush.Round, style.bow,
        );
      }
    }
  }

  // ---- 仕上げ ----
  stageOffset[Stage.Finish] = table.count;
  {
    // 主要な輪郭を締め直し、明るい点を置く。
    const accents = Math.min(lines.length, 70);
    for (let i = 0; i < accents; i++) {
      const ln = lines[i];
      const b = ln.count - 1;
      const m = b >> 1;
      const x0 = ln.pts[0];
      const y0 = ln.pts[1];
      const x1 = ln.pts[b * 2];
      const y1 = ln.pts[b * 2 + 1];
      const ccx = 2 * ln.pts[m * 2] - (x0 + x1) / 2;
      const ccy = 2 * ln.pts[m * 2 + 1] - (y0 + y1) / 2;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 6) continue;
      const ok = pushStroke(table, {
        x0, y0, cx: ccx, cy: ccy, x1, y1,
        width: style.lineWidth * 0.7,
        color: blend(darkestNear(ln.pts[m * 2], ln.pts[m * 2 + 1]), 0x120f0e, 0.5),
        opacity: Math.round(style.lineOpacity * 0.55 * 255),
        pressure: 200,
        duration: clamp(Math.round(len / style.speed) + 1, 1, 255),
        stage: Stage.Finish,
        layer: assign.finishLayer,
        brush: Brush.Round,
      });
      if (!ok) overflow = true;
      serial++;
    }
    const sparkles = 90;
    for (let i = 0; i < sparkles; i++) {
      const x = rand01(seed ^ 0x1f3, i, 1) * w;
      const y = rand01(seed ^ 0x1f3, i, 2) * h;
      const ix = clamp(Math.round(x), 0, w - 1);
      const iy = clamp(Math.round(y), 0, h - 1);
      if (img.lum[iy * w + ix] < 205) continue;
      const c = pick(ix, iy);
      emit(
        ix - 1, iy, ix + 1.5, iy - 0.5, widthBase * 0.5,
        blend(c, 0xffffff, 0.35), 0.5, 0.9,
        Stage.Finish, assign.finishLayer, Brush.Soft, 0.2,
      );
    }
  }

  stageOffset[STAGE_COUNT] = table.count;
  return { table, stageOffset, overflow };
}

function groupRegions(seg: Segmentation, assign: LayerAssignment, minArea: number): Region[][] {
  const byStage: Region[][] = Array.from({ length: STAGE_COUNT }, () => []);
  for (const r of seg.regions) {
    if (r.area < minArea) continue; // 画素が割り当てられていないので塗れない
    byStage[assign.regionStage[r.id]].push(r);
  }
  for (let s = 0; s < STAGE_COUNT; s++) {
    // 広い面から先に塗る。数が多すぎる場合は上位だけを対象にする。
    byStage[s].sort((a, b) => b.area - a.area);
    if (byStage[s].length > MAX_REGIONS_PER_STAGE) {
      byStage[s] = byStage[s].slice(0, MAX_REGIONS_PER_STAGE);
    }
  }
  return byStage;
}
