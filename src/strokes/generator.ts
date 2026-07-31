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
import type { QualityLevel } from '../analysis/quality';
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
  /** 解析の粒度 */
  quality: QualityLevel;
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

/**
 * 最後の一撫でで使う筆の間隔（画像座標系）。
 *
 * 出力解像度でおよそ 25px 以上の幅になるようにしてある。これより細いと、筆の縁の
 * ぼかしが丸め誤差として残り、元画像と最後まで一致しない。
 */
const BROAD_GAP = 24;

export function generateStrokes(input: GenerateInput): GenerateResult {
  const scale = Math.max(input.img.width, input.img.height) / 1024;
  let spacing = Math.max(
    1.6,
    input.style.spacing * Math.max(0.55, scale) * input.quality.spacingScale,
  );
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
  const { img, edges, color, seg, assign, lines, style, seed, quality } = input;
  const w = img.width;
  const h = img.height;
  const table = createStrokeTable(quality.maxStrokes);
  const stageOffset = new Int32Array(STAGE_COUNT + 1);
  let overflow = false;
  let serial = 0;
  // 最後の一撫でぶんは必ず残す。ここが欠けると元画像と一致しなくなるため、
  // 予算が尽きても削らない。
  const broadCount = Math.ceil(h / BROAD_GAP) + 4;
  let limit = Math.max(1, quality.maxStrokes - broadCount);

  const sampleStep = Math.max(0.8, spacing * 0.42);
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
    if (table.count >= limit) {
      overflow = true;
      serial++;
      return;
    }
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
   * 下塗り。画面全体を大きな筆で一度覆う。
   *
   * 領域として拾えなかった細かい部分（写真の粒状感など）が紙のまま残らないよう、
   * 平均色でざっと敷いておく。すでに引いてある線の下へ入るので、線画は消えない。
   */
  function blockIn(): void {
    const gap = spacing * 2.8;
    const runLen = Math.max(gap * 3, maxLen * 1.8);
    let row = 0;
    for (let y = gap * 0.5; y < h + gap; y += gap, row++) {
      const yy = Math.min(h - 1, y);
      // 行ごとに継ぎ目の位置をずらす。そろえると縦の筋が見えてしまう。
      const offset = -runLen * rand01(seed ^ 0x4b1, row);
      for (let x = offset; x < w; x += runLen) {
        const x0 = Math.max(0, x);
        const x1 = Math.min(w - 1, x + runLen);
        if (x1 - x0 < gap * 0.5) continue;
        // 区間の平均色を取る（1 点だけ見ると粒に引っぱられる）。
        let cr = 0, cg = 0, cb = 0, n = 0;
        for (let t = 0; t <= 6; t++) {
          const sx = clamp(Math.round(x0 + ((x1 - x0) * t) / 6), 0, w - 1);
          const p = (Math.round(yy) * w + sx) * 4;
          cr += img.smooth[p];
          cg += img.smooth[p + 1];
          cb += img.smooth[p + 2];
          n++;
        }
        const col = vary(rgb(cr / n, cg / n, cb / n), style.colorJitter * 0.5, serial);
        const wob = randSigned(seed ^ 0x60d, serial, 4) * gap * 0.25;
        const under = seg.labels[Math.round(yy) * w + clamp(Math.round(x0), 0, w - 1)];
        emit(
          x0, yy + wob, x1, yy - wob,
          gap * 1.2, col, 1, 0.7,
          Stage.Base,
          under >= 0 ? assign.regionLayer[under] : assign.roughLayer,
          Brush.Under, style.bow * 0.4,
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

  // ---- ラフ ----
  // 形を探る当たり線だけを引く。色はここでは置かない（着色の仕事）。
  stageOffset[Stage.Rough] = table.count;
  {
    const sketchCount = Math.min(
      lines.length,
      Math.round(lines.length * (0.2 + style.rough * 0.3)),
    );
    for (let i = 0; i < sketchCount; i++) {
      const ln = lines[i];
      if (!ln) break;
      const b = ln.count - 1;
      const jitter = 2 + style.jitter * 1.5;
      const x0 = ln.pts[0] + randSigned(seed, i, 11) * jitter;
      const y0 = ln.pts[1] + randSigned(seed, i, 12) * jitter;
      const x1 = ln.pts[b * 2] + randSigned(seed, i, 13) * jitter;
      const y1 = ln.pts[b * 2 + 1] + randSigned(seed, i, 14) * jitter;
      emit(
        x0, y0, x1, y1, style.lineWidth * 1.3, 0x8b8378,
        0.3, 0.5, Stage.Rough, assign.roughLayer, Brush.Round, style.bow * 1.6,
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
  // まず下塗りで画面全体に色を入れ、そのあと広い面から順に置く。
  // 下塗りは引いた線の下へ潜り込むので、線画は塗りで消えない。
  stageOffset[Stage.Base] = table.count;
  {
    blockIn();
    const area = w * h;
    for (const r of regionsByStage[Stage.Base]) {
      const wide = r.area / area > 0.05;
      hatch(
        r, spacing * (wide ? 1.45 : 1), maxLen * (wide ? 1.5 : 1), Stage.Base,
        assign.regionLayer[r.id], fillBrush, style.fillOpacity,
        wide ? 1.3 : 1, wide ? Math.max(1, style.fillPasses - 1) : style.fillPasses,
      );
    }
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
  //
  // 元画像そのものを絵の具として筆に乗せ、画面を詰めていく。筆が通ったところには
  // 元の画素がそのまま置かれるので、塗り重ねだけで最後は元画像と一致する。
  // 別の絵を後から重ねるのではなく、あくまで筆を置いて仕上げる。
  stageOffset[Stage.Finish] = table.count;
  {
    const rest = Math.max(0, limit - table.count);
    refine(Math.round(rest * 0.58));
    sweep(rest - Math.round(rest * 0.58));
    // 取り置いたぶんを解放して、最後の一撫でを必ず入れる。
    limit = table.capacity;
    broadSweep();
  }

  /**
   * 詰め。
   *
   * 「まだ情報が足りていないところ」＝輪郭が強く、周囲との色の差が大きいところから
   * 順に置く。ただし順番どおりに並べると画面を上から順に舐めるような動きになるので、
   * 網の目を間引いた層に分け、全体をうっすら詰めてから密度を上げていく。
   * 絵全体が同時に鮮明になっていくように見える。
   */
  function refine(budget: number): void {
    if (budget <= 8) return;
    const ideal = Math.sqrt((w * h) / (budget * 1.5));
    const gap = clamp(ideal, Math.max(1.2, spacing * style.refine * quality.refineScale), spacing * 1.3);
    const cols = Math.max(1, Math.floor(w / gap));
    const rows = Math.max(1, Math.floor(h / gap));
    const total = cols * rows;
    const px = new Float32Array(total);
    const py = new Float32Array(total);
    const score = new Float32Array(total);
    const layer = new Uint8Array(total);
    const order = new Int32Array(total);

    // 4×4 の並びで 16 層に分ける。層 0 だけでも画面全体に散らばる。
    const SPREAD = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const step = Math.max(1, Math.round(gap));
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const k = ry * cols + rx;
        const x = (rx + 0.5) * gap;
        const y = (ry + 0.5) * gap;
        const ix = clamp(Math.round(x), 1, w - 2);
        const iy = clamp(Math.round(y), 1, h - 2);
        const i = iy * w + ix;
        px[k] = x;
        py[k] = y;
        layer[k] = SPREAD[(ry % 4) * 4 + (rx % 4)];
        // 輪郭の強さと、上下左右との色の差を足し合わせる。
        let s = edges.mag[i] * 1.5;
        const c0 = i * 4;
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
          const nx = clamp(ix + dx, 0, w - 1);
          const ny = clamp(iy + dy, 0, h - 1);
          const c1 = (ny * w + nx) * 4;
          s += (Math.abs(img.smooth[c0] - img.smooth[c1]) +
            Math.abs(img.smooth[c0 + 1] - img.smooth[c1 + 1]) +
            Math.abs(img.smooth[c0 + 2] - img.smooth[c1 + 2])) * 0.4;
        }
        score[k] = s;
        order[k] = k;
      }
    }

    // 情報量の多い順に、予算のぶんだけ選ぶ。型付き配列のまま並べ替える。
    const take = Math.min(budget, total);
    order.sort((a, b) => score[b] - score[a]);
    const picked = order.subarray(0, take);
    const maxScore = take > 0 ? score[picked[0]] : 1;

    // 層を先に、その中では情報量の多い順。画面全体が少しずつ詰まっていく。
    picked.sort((a, b) => {
      if (layer[a] !== layer[b]) return layer[a] - layer[b];
      const ba = Math.floor((1 - score[a] / (maxScore || 1)) * 4);
      const bb = Math.floor((1 - score[b] / (maxScore || 1)) * 4);
      if (ba !== bb) return ba - bb;
      return a - b;
    });

    const len = gap * 2.1;
    for (const k of picked) {
      const x = px[k];
      const y = py[k];
      const ix = clamp(Math.round(x), 1, w - 2);
      const iy = clamp(Math.round(y), 1, h - 2);
      const i = iy * w + ix;
      // 輪郭に沿って引く。平らなところは緩やかに向きを散らす。
      const g = Math.hypot(edges.gx[i], edges.gy[i]);
      let tx: number;
      let ty: number;
      if (g > 4) {
        tx = -edges.gy[i] / g;
        ty = edges.gx[i] / g;
      } else {
        const a = rand01(seed ^ 0x3c7, k) * Math.PI;
        tx = Math.cos(a);
        ty = Math.sin(a);
      }
      const half = len * (0.45 + rand01(seed ^ 0x77, k) * 0.35);
      const jx = randSigned(seed ^ 0x21, k, 1) * gap * 0.18;
      const jy = randSigned(seed ^ 0x22, k, 2) * gap * 0.18;
      emit(
        x - tx * half + jx, y - ty * half + jy,
        x + tx * half + jx, y + ty * half + jy,
        gap * 1.35, pick(x, y), 1, 0.75 + rand01(seed, k, 9) * 0.25,
        Stage.Finish, assign.finishLayer, Brush.Refine, style.bow * 0.3,
      );
    }
  }

  /**
   * 全体を撫でる掃き。
   *
   * 細かい筆で画面全体をなぞる。行の順番は飛び飛びにして、上から下へ拭き取るような
   * 動きに見えないようにする。
   */
  function sweep(budget: number): void {
    if (budget <= 4) return;
    const segLen = Math.max(8, spacing * 4);
    const perRow = Math.ceil((w + 2) / segLen);
    const rowCount = Math.max(1, Math.min(Math.floor(budget / perRow), Math.ceil(h * 2)));
    const gap = h / rowCount;
    const width = gap * 2.2 + 2;

    // 行を飛び飛びにたどる（0, 1/2, 1/4, 3/4, …）。
    const rowOrder = new Int32Array(rowCount);
    for (let i = 0; i < rowCount; i++) rowOrder[i] = i;
    rowOrder.sort((a, b) => bitReverse(a, rowCount) - bitReverse(b, rowCount) || a - b);

    for (const r of rowOrder) {
      const y = (r + 0.5) * gap;
      for (let x = -1; x < w + 1; x += segLen) {
        const x1 = Math.min(w + 1, x + segLen);
        emit(
          x, y, x1, y, width, pick((x + x1) / 2, y), 1, 1,
          Stage.Finish, assign.finishLayer, Brush.Refine, 0,
        );
      }
    }
  }

  /**
   * 最後の一撫で。
   *
   * 細い筆だけで仕上げると、筆の縁のぼかしが 8bit の丸めで 1 段階ずれたまま残り、
   * 元画像と完全には一致しない。最後に幅の広い筆で一度なでると、どの画素も筆の
   * 内側（ぼかしのかからない部分）に入るため、ずれが残らない。
   *
   * この時点で画面はほぼ元画像なので、見た目には何も起きていないように見える。
   */
  function broadSweep(): void {
    const gap = BROAD_GAP;
    // 太い筆で横へ引いていく。
    for (let r = -1; r <= Math.ceil(h / gap); r++) {
      const y = (r + 0.5) * gap;
      emit(
        -2, y, w + 2, y, gap * 2.2, pick(w / 2, clamp(y, 0, h - 1)), 1, 1,
        Stage.Finish, assign.finishLayer, Brush.Refine, 0,
      );
    }
    // 最後は画面と同じ高さの筆でひと息に通す。
    // 筆の縁（ぼかしのかかる部分）が画面の外へ出るため、全画素が筆の内側に入り、
    // 8bit の丸めによるわずかなずれも残らない。
    emit(
      -2, h / 2, w + 2, h / 2, h * 1.3, pick(w / 2, h / 2), 1, 1,
      Stage.Finish, assign.finishLayer, Brush.Refine, 0,
    );
  }

  stageOffset[STAGE_COUNT] = table.count;
  return { table, stageOffset, overflow };
}

/** 0..n-1 を「半分ずつ間を埋める」順に並べるための重み。 */
function bitReverse(v: number, n: number): number {
  let bits = 1;
  while (1 << bits < n) bits++;
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | ((v >> i) & 1);
  }
  return out;
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
