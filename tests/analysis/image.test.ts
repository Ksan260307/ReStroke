import { describe, expect, it } from 'vitest';
import { blurRgba, boxBlur, detectEdges, fitSize, imageStats } from '../../src/analysis/image';
import { makeWorkImage, noisyImage, sceneImage } from '../helpers/fixtures';

describe('前処理', () => {
  it('長辺が上限以下ならそのまま', () => {
    expect(fitSize(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it('長辺が上限を超えたら縦横比を保って縮める', () => {
    const r = fitSize(4000, 2000, 1000);
    expect(r.width).toBe(1000);
    expect(r.height).toBe(500);
    const p = fitSize(1000, 4000, 800);
    expect(p.height).toBe(800);
    expect(p.width).toBe(200);
  });

  it('極端に小さい画像でも 2px 以上になる', () => {
    const r = fitSize(1, 1, 1024);
    expect(r.width).toBeGreaterThanOrEqual(2);
    expect(r.height).toBeGreaterThanOrEqual(2);
  });

  it('平坦な画像はぼかしても変わらない', () => {
    const w = 32, h = 24;
    const src = new Uint8Array(w * h).fill(128);
    const out = boxBlur(src, w, h, 2);
    for (const v of out) expect(v).toBe(128);
  });

  it('ぼかしは粒のばらつきを減らす', () => {
    const img = noisyImage(120, 90);
    const variance = (data: Uint8ClampedArray): number => {
      let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        // 隣の画素との差の大きさで粒立ちを測る
        const d = i + 4 < data.length ? Math.abs(data[i] - data[i + 4]) : 0;
        sum += d; sum2 += d * d; n++;
      }
      return sum2 / n - (sum / n) ** 2;
    };
    expect(variance(img.smooth)).toBeLessThan(variance(img.rgba));
  });

  it('ぼかしても色の総量はほぼ保たれる', () => {
    const img = noisyImage(80, 60);
    const mean = (d: Uint8ClampedArray, ch: number): number => {
      let s = 0;
      for (let i = ch; i < d.length; i += 4) s += d[i];
      return s / (d.length / 4);
    };
    for (const ch of [0, 1, 2]) {
      expect(mean(img.smooth, ch)).toBeCloseTo(mean(img.rgba, ch), 0);
    }
  });

  it('半径 0 のぼかしは元のまま', () => {
    const img = makeWorkImage(16, 16, (x) => [x * 8, 0, 0]);
    const out = blurRgba(img.rgba, 16, 16, 0);
    expect(Array.from(out)).toEqual(Array.from(img.rgba));
  });

  it('輪郭は明暗の境目で立つ', () => {
    const w = 64, h = 48;
    const lum = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) lum[y * w + x] = x < 32 ? 20 : 230;
    }
    const edges = detectEdges(lum, w, h, 0);
    const onBorder = edges.mag[24 * w + 31];
    const inside = edges.mag[24 * w + 10];
    expect(onBorder).toBeGreaterThan(edges.threshold);
    expect(inside).toBe(0);
    // 勾配の向きは横方向
    expect(Math.abs(edges.gx[24 * w + 31])).toBeGreaterThan(Math.abs(edges.gy[24 * w + 31]));
  });

  it('平坦な画像では輪郭が立たない', () => {
    const w = 40, h = 40;
    const lum = new Uint8Array(w * h).fill(100);
    const edges = detectEdges(lum, w, h, 0);
    expect(Math.max(...edges.mag)).toBe(0);
    expect(edges.threshold).toBeGreaterThan(0);
  });

  it('画像の平均輝度と彩度を求める', () => {
    const dark = makeWorkImage(40, 40, () => [10, 10, 10]);
    const bright = makeWorkImage(40, 40, () => [240, 240, 240]);
    expect(imageStats(dark).meanLum).toBeLessThan(imageStats(bright).meanLum);
    expect(imageStats(dark).meanSat).toBeCloseTo(0, 0);

    const vivid = makeWorkImage(40, 40, () => [255, 0, 0]);
    expect(imageStats(vivid).meanSat).toBeGreaterThan(200);
  });

  it('風景ふうの画像は明暗と輪郭の両方を持つ', () => {
    const img = sceneImage();
    const stats = imageStats(img);
    expect(stats.meanLum).toBeGreaterThan(60);
    expect(stats.meanLum).toBeLessThan(220);
    const edges = detectEdges(img.lum, img.width, img.height, 1);
    const strong = Array.from(edges.mag).filter((m) => m >= edges.threshold).length;
    expect(strong).toBeGreaterThan(50);
  });
});
