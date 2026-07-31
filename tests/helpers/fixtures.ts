/**
 * テスト用の画像とひな形。
 *
 * ブラウザの画像読み込みを介さずに作業画像を組み立てる。前処理より後ろの経路は
 * 本番とまったく同じものを通すので、解析・生成の検証はここから始められる。
 */

import { blurRgba } from '../../src/analysis/image';
import type { WorkImage } from '../../src/analysis/image';
import { analyzeWorkImage } from '../../src/analysis/pipeline';
import type { AnalyzeResult } from '../../src/analysis/pipeline';
import { styleById } from '../../src/strokes/styles';
import type { StyleProfile } from '../../src/strokes/styles';
import { qualityFor } from '../../src/analysis/quality';
import type { QualityLevel } from '../../src/analysis/quality';

export type Painter2D = (x: number, y: number) => [number, number, number];

export function makeWorkImage(width: number, height: number, fn: Painter2D): WorkImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const lum = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [r, g, b] = fn(x, y);
      const p = i * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
      lum[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
  }
  const radius = Math.max(1, Math.round(Math.min(width, height) / 340));
  return { width, height, rgba, smooth: blurRgba(rgba, width, height, radius), lum };
}

/** 単色。領域が 1 つしかない極端な入力。 */
export function solidImage(w = 96, h = 72, color: [number, number, number] = [200, 120, 60]): WorkImage {
  return makeWorkImage(w, h, () => color);
}

/**
 * 風景ふうの絵。
 *
 * 空（上下グラデーション）・地面・家（暗い輪郭つき）・太陽・影・ハイライトを含み、
 * ラフ／線画／ベース／影／光／細部のすべての工程に材料が行き渡る。
 */
export function sceneImage(w = 320, h = 240): WorkImage {
  const horizon = Math.round(h * 0.62);
  return makeWorkImage(w, h, (x, y) => {
    // 家
    const hx0 = Math.round(w * 0.16), hx1 = Math.round(w * 0.48);
    const hy0 = Math.round(h * 0.34), hy1 = horizon + 4;
    const onEdge =
      (x >= hx0 - 2 && x <= hx1 + 2 && (Math.abs(y - hy0) <= 2 || Math.abs(y - hy1) <= 2)) ||
      (y >= hy0 - 2 && y <= hy1 + 2 && (Math.abs(x - hx0) <= 2 || Math.abs(x - hx1) <= 2));
    if (onEdge) return [40, 32, 28];
    if (x > hx0 && x < hx1 && y > hy0 && y < hy1) {
      const dx = Math.round(w * 0.30), dy = Math.round(h * 0.46);
      if (x > dx && x < dx + Math.round(w * 0.08) && y > dy) return [96, 62, 40]; // 扉（影）
      if (x > hx0 + 6 && x < hx0 + 26 && y > hy0 + 8 && y < hy0 + 26) return [232, 244, 250]; // 窓（光）
      return [214, 196, 160];
    }
    // 太陽
    if (Math.hypot(x - w * 0.82, y - h * 0.18) < h * 0.09) return [246, 214, 120];
    // 地面
    if (y >= horizon) {
      const t = (y - horizon) / Math.max(1, h - horizon);
      return [96 + t * 30, 150 + t * 24, 84 + t * 18];
    }
    // 空
    const t = y / horizon;
    return [110 + t * 90, 165 + t * 60, 214 + t * 32];
  });
}

/** 粒状（写真に近い）画像。領域が細かく砕けるかを見る。 */
export function noisyImage(w = 240, h = 180): WorkImage {
  let s = 987654321;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return makeWorkImage(w, h, (x, y) => [
    Math.min(255, 60 + (x / w) * 150 + rnd() * 70),
    Math.min(255, 90 + (y / h) * 120 + rnd() * 70),
    Math.min(255, 140 - (x / w) * 60 + rnd() * 70),
  ]);
}

export interface PlanOptions {
  style?: string;
  seed?: number;
  /** 解析の粒度（1-10） */
  level?: number;
  /** 本数の上限だけを差し替えたいとき */
  maxStrokes?: number;
}

export function quality(options: PlanOptions = {}): QualityLevel {
  const q = qualityFor(options.level ?? 4);
  return options.maxStrokes ? { ...q, maxStrokes: options.maxStrokes } : q;
}

export async function buildPlan(
  work: WorkImage,
  options: PlanOptions = {},
): Promise<AnalyzeResult> {
  return analyzeWorkImage(work, work.width, work.height, {
    style: styleById(options.style ?? 'professional'),
    seed: options.seed ?? 0x1234abcd,
    quality: quality(options),
  });
}

export function style(id: string): StyleProfile {
  return styleById(id);
}
