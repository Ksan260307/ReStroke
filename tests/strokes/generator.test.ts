import { describe, expect, it } from 'vitest';
import { generateStrokes } from '../../src/strokes/generator';
import type { GenerateInput } from '../../src/strokes/generator';
import { detectEdges, imageStats } from '../../src/analysis/image';
import { quantize } from '../../src/analysis/quantize';
import { segment } from '../../src/analysis/segment';
import { estimateLayers } from '../../src/analysis/layers';
import { traceLines } from '../../src/analysis/lineart';
import { STAGE_COUNT, Stage } from '../../src/core/schema';
import type { StrokeTable } from '../../src/core/schema';
import type { WorkImage } from '../../src/analysis/image';
import { noisyImage, quality, sceneImage, solidImage, style } from '../helpers/fixtures';

function makeInput(img: WorkImage, styleId = 'professional', maxStrokes = 12000): GenerateInput {
  const st = style(styleId);
  const q = quality({ level: 4, maxStrokes });
  const minArea = Math.max(12, Math.round((img.width * img.height) / 9000));
  const edges = detectEdges(img.lum, img.width, img.height, 1, q.edgeRatio);
  const color = quantize(img.smooth, img.width, img.height, st.paletteSize);
  const seg = segment(color.index, img.lum, img.width, img.height, minArea);
  const assign = estimateLayers(seg, color.palette, imageStats(img).meanLum, minArea);
  const lines = traceLines(edges, { minLength: 5, claimRadius: q.claimRadius });
  return { img, edges, color, seg, assign, lines, style: st, seed: 0x5eed, quality: q, minArea };
}

/**
 * 指定範囲のストロークが実際に覆う画素数を数える。
 *
 * 最終フレームが元画像と一致するのは「全画素がどれかの筆の内側に入る」からなので、
 * その前提が本当に成り立っているかを幾何的に確かめる。
 */
function coverageOf(s: StrokeTable, from: number, w: number, h: number): number {
  const mask = new Uint8Array(w * h);
  for (let i = from; i < s.count; i++) {
    if (s.opacity[i] < 255) continue;
    const r = (s.width[i] * (0.65 + 0.35 * (s.pressure[i] / 255))) / 2;
    const steps = Math.max(2, Math.ceil(Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]) * 2));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const iu = 1 - u;
      const cx = iu * iu * s.x0[i] + 2 * iu * u * s.cx[i] + u * u * s.x1[i];
      const cy = iu * iu * s.y0[i] + 2 * iu * u * s.cy[i] + u * u * s.y1[i];
      for (let y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(h - 1, Math.floor(cy + r)); y++) {
        const dy = y - cy;
        const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
        for (let x = Math.max(0, Math.ceil(cx - dx)); x <= Math.min(w - 1, Math.floor(cx + dx)); x++) {
          mask[y * w + x] = 1;
        }
      }
    }
  }
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

describe('ストローク生成', () => {
  it('工程の境界が単調で、最後が総数と一致する', () => {
    const r = generateStrokes(makeInput(sceneImage()));
    expect(r.stageOffset.length).toBe(STAGE_COUNT + 1);
    for (let s = 1; s <= STAGE_COUNT; s++) {
      expect(r.stageOffset[s]).toBeGreaterThanOrEqual(r.stageOffset[s - 1]);
    }
    expect(r.stageOffset[STAGE_COUNT]).toBe(r.strokes.count);
    expect(r.stageOffset[0]).toBe(0);
  });

  it('ストロークは工程順に並ぶ', () => {
    const r = generateStrokes(makeInput(sceneImage()));
    for (let i = 1; i < r.strokes.count; i++) {
      expect(r.strokes.stage[i]).toBeGreaterThanOrEqual(r.strokes.stage[i - 1]);
    }
  });

  it('すべての値が妥当な範囲に収まる', () => {
    const img = sceneImage();
    const r = generateStrokes(makeInput(img));
    const s = r.strokes;
    expect(s.count).toBeGreaterThan(100);
    for (let i = 0; i < s.count; i++) {
      for (const v of [s.x0[i], s.y0[i], s.x1[i], s.y1[i], s.cx[i], s.cy[i]]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // 画面から極端に外れた筆致は出さない
      expect(s.x0[i]).toBeGreaterThan(-img.width * 0.2);
      expect(s.x0[i]).toBeLessThan(img.width * 1.2);
      expect(s.y0[i]).toBeGreaterThan(-img.height * 0.2);
      expect(s.y0[i]).toBeLessThan(img.height * 1.2);
      expect(s.width[i]).toBeGreaterThan(0);
      expect(s.width[i]).toBeLessThan(img.width);
      expect(s.opacity[i]).toBeGreaterThan(0);
      expect(s.opacity[i]).toBeLessThanOrEqual(255);
      expect(s.pressure[i]).toBeLessThanOrEqual(255);
      expect(s.duration[i]).toBeGreaterThanOrEqual(1);
      expect(s.color[i]).toBeLessThanOrEqual(0xffffff);
      expect(s.stage[i]).toBeLessThan(STAGE_COUNT);
      expect(s.brush[i]).toBeLessThanOrEqual(5);
    }
  });

  it('本数の上限を必ず守る', () => {
    for (const limit of [200, 800, 3000]) {
      const r = generateStrokes(makeInput(sceneImage(), 'pencil', limit));
      expect(r.strokes.count).toBeLessThanOrEqual(limit);
    }
  });

  it('上限に当たったら筆を太くして作り直す', () => {
    const small = generateStrokes(makeInput(sceneImage(), 'pencil', 400));
    const large = generateStrokes(makeInput(sceneImage(), 'pencil', 40000));
    expect(small.coarsened).toBe(true);
    expect(small.spacing).toBeGreaterThan(large.spacing);
    expect(large.coarsened).toBe(false);
  });

  it('ラフは線だけを引き、色を置かない', () => {
    const r = generateStrokes(makeInput(sceneImage()));
    const s = r.strokes;
    let count = 0;
    for (let i = r.stageOffset[Stage.Rough]; i < r.stageOffset[Stage.LineArt]; i++) {
      count++;
      // 当たり線は細く、下塗り用の平筆ではない
      expect(s.brush[i]).toBe(1);
      expect(s.width[i]).toBeLessThan(8);
    }
    expect(count).toBeGreaterThan(0);
  });

  it('下塗りは着色工程にあり、線の下へ潜り込む', () => {
    const img = noisyImage(160, 120);
    const r = generateStrokes(makeInput(img, 'professional'));
    const under: number[] = [];
    for (let i = r.stageOffset[Stage.Base]; i < r.stageOffset[Stage.Shadow]; i++) {
      if (r.strokes.brush[i] === 5) under.push(i);
    }
    expect(under.length).toBeGreaterThan(0);
    // 下塗りの帯が画像の縦横いっぱいに渡っていること
    const ys = under.map((i) => r.strokes.y0[i]);
    expect(Math.min(...ys)).toBeLessThan(img.height * 0.15);
    expect(Math.max(...ys)).toBeGreaterThan(img.height * 0.85);
    expect(Math.min(...under.map((i) => r.strokes.x0[i]))).toBeLessThan(img.width * 0.1);
    expect(Math.max(...under.map((i) => r.strokes.x1[i]))).toBeGreaterThan(img.width * 0.9);
    // ラフには下塗りが残っていない
    for (let i = r.stageOffset[Stage.Rough]; i < r.stageOffset[Stage.LineArt]; i++) {
      expect(r.strokes.brush[i]).not.toBe(5);
    }
  });

  it('仕上げで残りの予算を使い切って詰める', () => {
    const budget = 6000;
    const r = generateStrokes(makeInput(sceneImage(200, 150), 'professional', budget));
    const finish = r.stageOffset[STAGE_COUNT] - r.stageOffset[Stage.Finish];
    expect(finish).toBeGreaterThan(100);
    // 予算のほとんどを使い切る
    expect(r.strokes.count).toBeGreaterThan(budget * 0.85);
    expect(r.strokes.count).toBeLessThanOrEqual(budget);
    // 詰めはすべて元画像を絵の具にする筆で、不透明に置く
    for (let i = r.stageOffset[Stage.Finish]; i < r.strokes.count; i++) {
      expect(r.strokes.brush[i]).toBe(4);
      expect(r.strokes.opacity[i]).toBe(255);
    }
  });

  it('仕上げの最後の掃きが画面の全画素を覆う', () => {
    const img = sceneImage(160, 120);
    const r = generateStrokes(makeInput(img, 'professional', 8000));
    const covered = coverageOf(r.strokes, r.stageOffset[Stage.Finish], img.width, img.height);
    expect(covered, '塗り残しがある').toBe(img.width * img.height);
  });

  it('粒度を上げても掃きの覆いは崩れない', () => {
    for (const level of [1, 4, 8]) {
      const img = sceneImage(140, 110);
      const base = makeInput(img, 'watercolor');
      const r = generateStrokes({ ...base, quality: quality({ level }) });
      const covered = coverageOf(r.strokes, r.stageOffset[Stage.Finish], img.width, img.height);
      expect(covered, `レベル ${level} で塗り残しがある`).toBe(img.width * img.height);
    }
  });

  it('予算を増やすほど詰めが細かくなる', () => {
    const small = generateStrokes(makeInput(sceneImage(200, 150), 'professional', 3000));
    const large = generateStrokes(makeInput(sceneImage(200, 150), 'professional', 12000));
    const count = (r: typeof small): number => r.stageOffset[STAGE_COUNT] - r.stageOffset[Stage.Finish];
    expect(count(large)).toBeGreaterThan(count(small) * 2);
  });

  it('線画を持たない画風では線画工程が空になる', () => {
    const r = generateStrokes(makeInput(sceneImage(), 'impasto'));
    expect(r.stageOffset[Stage.Base] - r.stageOffset[Stage.LineArt]).toBe(0);
  });

  it('線画を持つ画風では線画工程にストロークがある', () => {
    for (const id of ['manga', 'anime', 'professional']) {
      const r = generateStrokes(makeInput(sceneImage(), id));
      expect(r.stageOffset[Stage.Base] - r.stageOffset[Stage.LineArt]).toBeGreaterThan(0);
    }
  });

  it('同じ入力からは同じストロークが出る', () => {
    const a = generateStrokes(makeInput(sceneImage(200, 150)));
    const b = generateStrokes(makeInput(sceneImage(200, 150)));
    expect(b.strokes.count).toBe(a.strokes.count);
    expect(Array.from(b.strokes.x0)).toEqual(Array.from(a.strokes.x0));
    expect(Array.from(b.strokes.color)).toEqual(Array.from(a.strokes.color));
    expect(Array.from(b.stageOffset)).toEqual(Array.from(a.stageOffset));
  });

  it('種が変われば筆致も変わる', () => {
    const base = makeInput(sceneImage(200, 150));
    const a = generateStrokes(base);
    const b = generateStrokes({ ...base, seed: 0xbeef });
    expect(Array.from(b.strokes.x0)).not.toEqual(Array.from(a.strokes.x0));
  });

  it('単色の画像でも破綻せず塗る', () => {
    const r = generateStrokes(makeInput(solidImage(120, 90)));
    expect(r.strokes.count).toBeGreaterThan(0);
    for (let i = 0; i < r.strokes.count; i++) {
      expect(Number.isFinite(r.strokes.x0[i])).toBe(true);
    }
  });

  it('拾った色が元画像から大きく外れない', () => {
    const img = sceneImage(160, 120);
    const r = generateStrokes(makeInput(img));
    const s = r.strokes;
    let far = 0;
    for (let i = 0; i < s.count; i++) {
      const mx = Math.max(0, Math.min(img.width - 1, Math.round((s.x0[i] + s.x1[i]) / 2)));
      const my = Math.max(0, Math.min(img.height - 1, Math.round((s.y0[i] + s.y1[i]) / 2)));
      const p = (my * img.width + mx) * 4;
      const d = Math.hypot(
        ((s.color[i] >>> 16) & 255) - img.rgba[p],
        ((s.color[i] >>> 8) & 255) - img.rgba[p + 1],
        (s.color[i] & 255) - img.rgba[p + 2],
      );
      if (d > 150) far++;
    }
    // 線画や影は意図的に濃い色を使うため、全体の一部に留まればよい
    expect(far / s.count).toBeLessThan(0.35);
  });

  it('所要時間が長さに見合っている', () => {
    const r = generateStrokes(makeInput(sceneImage()));
    const s = r.strokes;
    for (let i = 0; i < s.count; i++) {
      const len = Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]);
      expect(s.duration[i]).toBeGreaterThanOrEqual(1);
      expect(s.duration[i]).toBeLessThanOrEqual(Math.max(2, len) + 2);
    }
  });
});
