import { describe, expect, it } from 'vitest';
import { detectEdges } from '../../src/analysis/image';
import { traceLines } from '../../src/analysis/lineart';
import { makeWorkImage, sceneImage } from '../helpers/fixtures';

/** 太さ 3px の直線 1 本だけを持つ画像。 */
function singleLine(w = 120, h = 90, horizontal = true) {
  return makeWorkImage(w, h, (x, y) => {
    const on = horizontal ? Math.abs(y - h / 2) <= 1.5 : Math.abs(x - w / 2) <= 1.5;
    return on ? [20, 20, 20] : [245, 245, 245];
  });
}

describe('線画の抽出', () => {
  it('直線から線をたどれる', () => {
    const img = singleLine();
    const edges = detectEdges(img.lum, img.width, img.height, 0);
    const lines = traceLines(edges, { minLength: 5 });
    expect(lines.length).toBeGreaterThan(0);
    // 画像幅に近い長さの線が取れている
    expect(Math.max(...lines.map((l) => l.length))).toBeGreaterThan(img.width * 0.5);
  });

  it('縦の線もたどれる', () => {
    const img = singleLine(90, 120, false);
    const edges = detectEdges(img.lum, img.width, img.height, 0);
    const lines = traceLines(edges, { minLength: 5 });
    expect(Math.max(...lines.map((l) => l.length))).toBeGreaterThan(img.height * 0.5);
  });

  it('主要な形から先に、近いところを続けて描く', () => {
    const edges = detectEdges(sceneImage().lum, 320, 240, 1);
    const lines = traceLines(edges);
    expect(lines.length).toBeGreaterThan(6);
    // 前半の線は後半より長い（大きな形が先）
    const half = Math.floor(lines.length / 2);
    const mean = (a: typeof lines): number => a.reduce((s, l) => s + l.length, 0) / a.length;
    expect(mean(lines.slice(0, half))).toBeGreaterThan(mean(lines.slice(half)));

    // 続けて引く線どうしは近い（ペンが画面中を飛び回らない）
    let jumps = 0;
    for (let i = 1; i < lines.length; i++) {
      const d = Math.hypot(lines[i].pts[0] - lines[i - 1].pts[0], lines[i].pts[1] - lines[i - 1].pts[1]);
      if (d > 320 * 0.6) jumps++;
    }
    expect(jumps / lines.length).toBeLessThan(0.25);
  });

  it('点列は画像の内側に収まる', () => {
    const img = sceneImage(200, 150);
    const edges = detectEdges(img.lum, img.width, img.height, 1);
    for (const l of traceLines(edges)) {
      expect(l.count * 2).toBe(l.pts.length);
      for (let i = 0; i < l.pts.length; i += 2) {
        expect(l.pts[i]).toBeGreaterThanOrEqual(0);
        expect(l.pts[i]).toBeLessThanOrEqual(img.width);
        expect(l.pts[i + 1]).toBeGreaterThanOrEqual(0);
        expect(l.pts[i + 1]).toBeLessThanOrEqual(img.height);
      }
    }
  });

  it('最短の長さより短い線は返さない', () => {
    const img = sceneImage(200, 150);
    const edges = detectEdges(img.lum, img.width, img.height, 1);
    const lines = traceLines(edges, { minLength: 25 });
    for (const l of lines) expect(l.length).toBeGreaterThanOrEqual(25);
  });

  it('本数の上限を守る', () => {
    const img = sceneImage(240, 180);
    const edges = detectEdges(img.lum, img.width, img.height, 1);
    expect(traceLines(edges, { maxLines: 5 }).length).toBeLessThanOrEqual(5);
  });

  it('輪郭が無ければ 1 本も返さない', () => {
    const img = makeWorkImage(80, 60, () => [180, 180, 180]);
    const edges = detectEdges(img.lum, img.width, img.height, 0);
    expect(traceLines(edges)).toHaveLength(0);
  });

  it('同じ画像からは同じ線が取れる', () => {
    const img = sceneImage(160, 120);
    const edges = detectEdges(img.lum, img.width, img.height, 1);
    const a = traceLines(edges);
    const b = traceLines(edges);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(b[i].pts)).toEqual(Array.from(a[i].pts));
    }
  });

  it('確保する幅を狭めると線の本数が増える', () => {
    const img = sceneImage(240, 180);
    const edges = detectEdges(img.lum, img.width, img.height, 1, 0.2);
    const wide = traceLines(edges, { minLength: 4, claimRadius: 1 });
    const narrow = traceLines(edges, { minLength: 4, claimRadius: 0 });
    expect(narrow.length).toBeGreaterThan(wide.length);
  });

  it('拾う割合を上げると線の本数が増える', () => {
    const img = sceneImage(240, 180);
    const few = traceLines(detectEdges(img.lum, img.width, img.height, 1, 0.05), { minLength: 4 });
    const many = traceLines(detectEdges(img.lum, img.width, img.height, 1, 0.3), { minLength: 4 });
    expect(many.length).toBeGreaterThan(few.length);
  });

  it('同じ輪郭を何度もなぞらない', () => {
    const img = singleLine(160, 120);
    const edges = detectEdges(img.lum, img.width, img.height, 0);
    const lines = traceLines(edges, { minLength: 5 });
    const totalPoints = lines.reduce((a, l) => a + l.count, 0);
    // 輪郭画素数を大きく超えてなぞっていないこと
    const edgePixels = Array.from(edges.mag).filter((m) => m >= edges.threshold).length;
    expect(totalPoints).toBeLessThan(edgePixels * 2);
  });
});
