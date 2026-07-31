import { describe, expect, it } from 'vitest';
import { estimateLayers } from '../../src/analysis/layers';
import { quantize } from '../../src/analysis/quantize';
import { segment } from '../../src/analysis/segment';
import { Stage } from '../../src/core/schema';
import { imageStats } from '../../src/analysis/image';
import { sceneImage } from '../helpers/fixtures';
import type { WorkImage } from '../../src/analysis/image';

function analyzeLayers(img: WorkImage, minArea = 40) {
  const color = quantize(img.smooth, img.width, img.height, 20);
  const seg = segment(color.index, img.lum, img.width, img.height, minArea);
  const assign = estimateLayers(seg, color.palette, imageStats(img).meanLum, minArea);
  return { color, seg, assign };
}

describe('レイヤー推定', () => {
  it('工程ごとの固定レイヤーが必ず用意される', () => {
    const { assign } = analyzeLayers(sceneImage());
    expect(assign.layers[assign.roughLayer].stage).toBe(Stage.Rough);
    expect(assign.layers[assign.lineLayer].stage).toBe(Stage.LineArt);
    expect(assign.layers[assign.finishLayer].stage).toBe(Stage.Finish);
  });

  it('レイヤーは工程順に並ぶ', () => {
    const { assign } = analyzeLayers(sceneImage());
    for (let i = 1; i < assign.layers.length; i++) {
      expect(assign.layers[i].stage).toBeGreaterThanOrEqual(assign.layers[i - 1].stage);
    }
  });

  it('レイヤー番号は連番で、参照先が必ず存在する', () => {
    const { seg, assign } = analyzeLayers(sceneImage());
    assign.layers.forEach((l, i) => expect(l.id).toBe(i));
    for (const r of seg.regions) {
      expect(assign.regionLayer[r.id]).toBeLessThan(assign.layers.length);
      expect(assign.regionStage[r.id]).toBeLessThanOrEqual(Stage.Finish);
    }
  });

  it('背景にあたる広い面はベースカラーへ吸収される（独立した工程を持たない）', () => {
    const { seg, assign } = analyzeLayers(sceneImage());
    const total = seg.width * seg.height;
    const wide = seg.regions.filter((r) => r.area / total > 0.05);
    expect(wide.length).toBeGreaterThan(0);
    for (const r of wide) {
      expect(assign.regionStage[r.id]).toBe(Stage.Base);
    }
    // 画面端に接する広い面（空・地面）も同じ扱い
    const border = seg.regions.filter((r) => r.touchesBorder && r.area / total > 0.05);
    expect(border.length).toBeGreaterThan(0);
    for (const r of border) expect(assign.regionStage[r.id]).toBe(Stage.Base);
  });

  it('暗く狭い領域は影、明るく狭い領域は光になる', () => {
    const { seg, assign } = analyzeLayers(sceneImage());
    const stages = new Set(seg.regions.filter((r) => r.area >= 40).map((r) => assign.regionStage[r.id]));
    expect(stages.has(Stage.Shadow) || stages.has(Stage.Light)).toBe(true);

    const meanLum = imageStats(sceneImage()).meanLum;
    for (const r of seg.regions) {
      if (assign.regionStage[r.id] === Stage.Shadow) {
        expect(r.meanLum).toBeLessThan(meanLum + 40);
      }
    }
  });

  it('レイヤー名は工程名と色みを含む', () => {
    const { assign } = analyzeLayers(sceneImage());
    const named = assign.layers.filter((l) => l.name.includes('・'));
    expect(named.length).toBeGreaterThan(0);
    for (const l of named) {
      expect(l.name).toMatch(/^(ラフ|線画|ベースカラー|影|光|細部|仕上げ)・/);
    }
  });

  it('同じ工程・同じ色の領域は 1 枚にまとまる', () => {
    const { seg, assign } = analyzeLayers(sceneImage());
    const groups = new Map<string, number>();
    for (const r of seg.regions) {
      if (r.area < 40) continue;
      const key = `${assign.regionStage[r.id]}:${r.color}`;
      const layer = assign.regionLayer[r.id];
      if (groups.has(key)) expect(groups.get(key)).toBe(layer);
      else groups.set(key, layer);
    }
  });

  it('面積の合計比が 1 を大きく超えない', () => {
    const { assign } = analyzeLayers(sceneImage());
    const total = assign.layers.reduce((a, l) => a + l.coverage, 0);
    expect(total).toBeGreaterThan(0.5);
    expect(total).toBeLessThanOrEqual(1.001);
  });
});
