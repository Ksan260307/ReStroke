/**
 * レイヤー推定と描画順の決定。
 *
 * 1 枚の完成画像には「どれを先に塗ったか」の情報が残っていない。そこで、面積・
 * 明るさ・画面端に接しているかといった手がかりから、各領域を工程へ割り当てる。
 *
 *   広くて画面端に接する    → 背景
 *   広くて中間の明るさ      → ベースカラー
 *   狭くて暗い              → 影
 *   狭くて明るい            → 光
 *   小さい                  → 細部
 *
 * 復元ではなく推定である以上、正解は 1 つではない。ここでの狙いは「人が描くなら
 * こう進めるだろう」という順序を、破綻なく組み立てることにある。
 */

import { Stage, STAGE_LABELS } from '../core/schema';
import type { LayerInfo } from '../core/schema';
import type { Region, Segmentation } from './segment';

export interface LayerAssignment {
  /** 領域番号 → 工程 */
  regionStage: Uint8Array;
  /** 領域番号 → レイヤー番号 */
  regionLayer: Uint16Array;
  layers: LayerInfo[];
  /** 固定レイヤー */
  roughLayer: number;
  lineLayer: number;
  finishLayer: number;
}

const HUE_NAMES = ['赤系', '橙系', '黄系', '黄緑系', '緑系', '青緑系', '青系', '青紫系', '紫系', '赤紫系'];

function hueName(color: number): string {
  const r = (color >>> 16) & 255;
  const g = (color >>> 8) & 255;
  const b = color & 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 20) {
    const l = (r + g + b) / 3;
    return l > 200 ? '明るい無彩色' : l < 60 ? '暗い無彩色' : '無彩色';
  }
  let hue: number;
  if (mx === r) hue = ((g - b) / d) % 6;
  else if (mx === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = ((hue * 60) + 360) % 360;
  return HUE_NAMES[Math.min(HUE_NAMES.length - 1, Math.floor(hue / 36))];
}

const lumOf = (c: number): number =>
  (((c >>> 16) & 255) * 77 + ((c >>> 8) & 255) * 150 + (c & 255) * 29) / 256;

export function estimateLayers(
  seg: Segmentation,
  palette: Uint32Array,
  meanLum: number,
  minArea: number,
): LayerAssignment {
  const total = seg.width * seg.height;
  const regions = seg.regions;
  const regionStage = new Uint8Array(regions.length);
  const regionLayer = new Uint16Array(regions.length);

  interface Draft {
    key: string;
    stage: number;
    color: number;
    coverage: number;
    name: string;
  }
  const drafts = new Map<string, Draft>();
  const regionKey: string[] = new Array(regions.length);

  const classify = (r: Region): number => {
    const cov = r.area / total;
    const L = lumOf(palette[r.color]);
    if (r.touchesBorder && cov > 0.025) return Stage.Background;
    if (cov > 0.10) return Stage.Background;
    if (cov > 0.010) return Stage.Base;
    if (L < meanLum - 16) return Stage.Shadow;
    if (L > meanLum + 20) return Stage.Light;
    if (cov > 0.002) return Stage.Base;
    return Stage.Detail;
  };

  for (const r of regions) {
    if (r.area < minArea) {
      regionStage[r.id] = Stage.Detail;
      regionKey[r.id] = '';
      continue;
    }
    const stage = classify(r);
    regionStage[r.id] = stage;
    const color = palette[r.color];
    const key = `${stage}:${r.color}`;
    regionKey[r.id] = key;
    const cov = r.area / total;
    const d = drafts.get(key);
    if (d) {
      d.coverage += cov;
    } else {
      drafts.set(key, {
        key,
        stage,
        color,
        coverage: cov,
        name: `${STAGE_LABELS[stage]}・${hueName(color)}`,
      });
    }
  }

  // 固定レイヤー（領域に対応しない工程）。
  const fixed: Draft[] = [
    { key: 'rough', stage: Stage.Rough, color: 0x9a8f86, coverage: 0, name: STAGE_LABELS[Stage.Rough] },
    { key: 'line', stage: Stage.LineArt, color: 0x1f1c1a, coverage: 0, name: STAGE_LABELS[Stage.LineArt] },
    { key: 'finish', stage: Stage.Finish, color: 0xb0a89f, coverage: 0, name: STAGE_LABELS[Stage.Finish] },
  ];

  const all = [...fixed, ...drafts.values()];
  // 工程順、同じ工程内は面積の広い順（広い面から塗るのが自然）。
  all.sort((a, b) => (a.stage - b.stage) || (b.coverage - a.coverage));

  const idOf = new Map<string, number>();
  const layers: LayerInfo[] = all.map((d, i) => {
    idOf.set(d.key, i);
    return {
      id: i,
      name: d.name,
      stage: d.stage,
      order: i,
      strokeCount: 0,
      color: d.color,
      coverage: d.coverage,
    };
  });

  const detailFallback = idOf.get('finish') ?? 0;
  for (const r of regions) {
    const key = regionKey[r.id];
    regionLayer[r.id] = key ? (idOf.get(key) ?? detailFallback) : detailFallback;
  }

  return {
    regionStage,
    regionLayer,
    layers,
    roughLayer: idOf.get('rough') ?? 0,
    lineLayer: idOf.get('line') ?? 0,
    finishLayer: idOf.get('finish') ?? 0,
  };
}
