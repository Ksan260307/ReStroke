import { describe, expect, it } from 'vitest';
import { quantize } from '../../src/analysis/quantize';
import { blueOf, greenOf, redOf } from '../../src/core/schema';
import { makeWorkImage, noisyImage, sceneImage } from '../helpers/fixtures';

const run = (img: { rgba: Uint8ClampedArray; width: number; height: number }, k: number) =>
  quantize(img.rgba, img.width, img.height, k);

describe('色解析', () => {
  it('指定した色数を超えない', () => {
    const img = sceneImage();
    for (const k of [2, 8, 16, 26, 64]) {
      const r = run(img, k);
      expect(r.palette.length).toBeLessThanOrEqual(k);
      expect(r.palette.length).toBeGreaterThan(0);
    }
  });

  it('単色の画像は 1〜2 色にまとまり、その色を保つ', () => {
    const img = makeWorkImage(64, 48, () => [200, 100, 50]);
    const r = run(img, 16);
    expect(r.palette.length).toBeLessThanOrEqual(2);
    expect(redOf(r.palette[0])).toBeCloseTo(200, -1);
    expect(greenOf(r.palette[0])).toBeCloseTo(100, -1);
    expect(blueOf(r.palette[0])).toBeCloseTo(50, -1);
  });

  it('画素ごとの割り当ては必ず代表色の範囲に収まる', () => {
    const img = sceneImage(160, 120);
    const r = run(img, 20);
    expect(r.index.length).toBe(160 * 120);
    for (let i = 0; i < r.index.length; i++) {
      expect(r.index[i]).toBeLessThan(r.palette.length);
    }
  });

  it('代表色ごとの画素数の合計が全画素と一致する', () => {
    const img = sceneImage(120, 90);
    const r = run(img, 12);
    const sum = Array.from(r.histogram).reduce((a, b) => a + b, 0);
    expect(sum).toBe(120 * 90);
  });

  it('割り当てた色は元の色から大きく外れない', () => {
    const img = sceneImage(160, 120);
    const r = run(img, 26);
    let worst = 0;
    for (let i = 0; i < r.index.length; i++) {
      const c = r.palette[r.index[i]];
      const p = i * 4;
      const d = Math.hypot(
        redOf(c) - img.rgba[p],
        greenOf(c) - img.rgba[p + 1],
        blueOf(c) - img.rgba[p + 2],
      );
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(140);
  });

  it('色数を増やすほど元の色に近づく', () => {
    const img = sceneImage(120, 90);
    const error = (k: number): number => {
      const r = run(img, k);
      let sum = 0;
      for (let i = 0; i < r.index.length; i++) {
        const c = r.palette[r.index[i]];
        const p = i * 4;
        sum += Math.hypot(redOf(c) - img.rgba[p], greenOf(c) - img.rgba[p + 1], blueOf(c) - img.rgba[p + 2]);
      }
      return sum / r.index.length;
    };
    expect(error(24)).toBeLessThan(error(4));
  });

  it('同じ入力からは同じ結果になる', () => {
    const img = sceneImage(100, 80);
    const a = run(img, 16);
    const b = run(img, 16);
    expect(Array.from(b.palette)).toEqual(Array.from(a.palette));
    expect(Array.from(b.index)).toEqual(Array.from(a.index));
  });

  it('粒状の画像でも破綻しない', () => {
    const r = run(noisyImage(120, 90), 26);
    expect(r.palette.length).toBeGreaterThan(4);
    expect(r.palette.length).toBeLessThanOrEqual(26);
  });

  it('色数を 2 未満に指定しても代表色を返す', () => {
    const r = run(sceneImage(60, 40), 1);
    expect(r.palette.length).toBeGreaterThanOrEqual(1);
  });
});
