/**
 * 解析パイプライン。
 *
 *   画像 → 前処理 → 輪郭抽出 → 領域分割 → 色解析 → レイヤー推定 → 描画順推定
 *        → ストローク生成
 *
 * 各段は前段の出力だけを入力に取る。段の間で待ちを入れて進捗を返すので、重い画像でも
 * 画面が固まらない。
 */

import { detectEdges, imageStats, toWorkImage } from './image';
import type { WorkImage } from './image';
import { quantize } from './quantize';
import { segment } from './segment';
import { estimateLayers } from './layers';
import { traceLines } from './lineart';
import { generateStrokes } from '../strokes/generator';
import type { StyleProfile } from '../strokes/styles';
import { STAGE_COUNT, baseIdentity } from '../core/schema';
import type { DrawingPlan, LayerInfo } from '../core/schema';
import { yieldToUI } from '../core/scheduling';

export interface AnalyzeOptions {
  style: StyleProfile;
  seed: number;
  /** 解析解像度（長辺） */
  analysisSide: number;
  /** ストローク本数の上限 */
  maxStrokes: number;
  onProgress?: (phase: string, ratio: number) => void;
}

export interface AnalyzeResult {
  plan: DrawingPlan;
  work: WorkImage;
  stats: {
    regionCount: number;
    lineCount: number;
    strokeCount: number;
    paletteSize: number;
    coarsened: boolean;
    spacing: number;
    elapsedMs: number;
  };
}

export async function analyze(
  bitmap: ImageBitmap,
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  options.onProgress?.('画像を読み込んでいます', 0.04);
  await yieldToUI();
  const work = toWorkImage(bitmap, options.analysisSide);
  return analyzeWorkImage(work, bitmap.width, bitmap.height, options);
}

/**
 * 読み込み済みの作業画像から工程を組み立てる。
 *
 * 画像の取り込みだけを切り離してあるので、ブラウザ以外からも同じ経路を通せる。
 */
export async function analyzeWorkImage(
  work: WorkImage,
  sourceWidth: number,
  sourceHeight: number,
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const t0 = performance.now();
  const { style, seed } = options;
  const report = async (phase: string, ratio: number): Promise<void> => {
    options.onProgress?.(phase, ratio);
    await yieldToUI();
  };

  const { meanLum } = imageStats(work);

  await report('輪郭を抽出しています', 0.18);
  const edges = detectEdges(work.lum, work.width, work.height, 1);

  await report('色を解析しています', 0.34);
  const color = quantize(work.smooth, work.width, work.height, style.paletteSize);

  await report('領域を分割しています', 0.5);
  const minArea = Math.max(12, Math.round((work.width * work.height) / 9000));
  const seg = segment(color.index, work.lum, work.width, work.height, minArea);

  await report('レイヤーを推定しています', 0.64);
  const assign = estimateLayers(seg, color.palette, meanLum, minArea);

  await report('描画順を推定しています', 0.74);
  const lines = style.lineArt || style.rough > 0.02
    ? traceLines(edges, {
        minLength: Math.max(5, style.spacing * 0.9),
        maxLines: 6000,
      })
    : [];

  await report('ストロークを生成しています', 0.84);
  const generated = generateStrokes({
    img: work,
    edges,
    color,
    seg,
    assign,
    lines,
    style,
    seed,
    maxStrokes: options.maxStrokes,
    minArea,
  });

  await report('描画工程を組み立てています', 0.95);
  const layers: LayerInfo[] = assign.layers.map((l) => ({ ...l }));
  const st = generated.strokes;
  for (let i = 0; i < st.count; i++) {
    const l = layers[st.layer[i]];
    if (l) l.strokeCount++;
  }
  const usedLayers = layers.filter((l) => l.strokeCount > 0);
  usedLayers.forEach((l, i) => (l.order = i));

  const paper = style.paper ?? estimatePaper(color);
  const params = [
    style.id,
    seed.toString(16),
    options.analysisSide,
    options.maxStrokes,
    generated.spacing.toFixed(3),
    st.count,
  ].join(':');

  const plan: DrawingPlan = {
    width: work.width,
    height: work.height,
    sourceWidth,
    sourceHeight,
    paper,
    palette: color.palette,
    layers: usedLayers,
    strokes: st,
    stageOffset: generated.stageOffset,
    identity: baseIdentity(params),
  };

  // 工程の境界が単調になっていることを確かめる（以降のペース配分の前提）。
  for (let s = 1; s <= STAGE_COUNT; s++) {
    if (plan.stageOffset[s] < plan.stageOffset[s - 1]) {
      throw new Error('描画順の組み立てに失敗しました');
    }
  }

  await report('完了', 1);
  return {
    plan,
    work,
    stats: {
      regionCount: seg.regions.length,
      lineCount: lines.length,
      strokeCount: st.count,
      paletteSize: color.palette.length,
      coarsened: generated.coarsened,
      spacing: generated.spacing,
      elapsedMs: performance.now() - t0,
    },
  };
}

/** 最も広い明るい色を紙の色とみなす。 */
function estimatePaper(color: { palette: Uint32Array; histogram: Int32Array }): number {
  let best = 0xfdfcf8;
  let bestCount = -1;
  for (let i = 0; i < color.palette.length; i++) {
    const c = color.palette[i];
    const l = (((c >>> 16) & 255) + ((c >>> 8) & 255) + (c & 255)) / 3;
    if (l < 170) continue;
    if (color.histogram[i] > bestCount) {
      bestCount = color.histogram[i];
      best = c;
    }
  }
  return best;
}
