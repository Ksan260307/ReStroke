import { describe, expect, it } from 'vitest';
import { segment } from '../../src/analysis/segment';

/** 文字で書いた図から索引画像を作る（1 文字 = 1 画素）。 */
function fromAscii(rows: string[]): { index: Uint8Array; lum: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const index = new Uint8Array(w * h);
  const lum = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      index[y * w + x] = ch.charCodeAt(0) - 48;
      lum[y * w + x] = ch === '0' ? 30 : ch === '1' ? 140 : 240;
    }
  }
  return { index, lum, w, h };
}

describe('領域分割', () => {
  it('つながった同色の塊を 1 つにまとめる', () => {
    const { index, lum, w, h } = fromAscii([
      '0000000000',
      '0111100000',
      '0111100000',
      '0000002220',
      '0000002220',
    ]);
    const seg = segment(index, lum, w, h, 1);
    expect(seg.regions).toHaveLength(3);
    const areas = seg.regions.map((r) => r.area).sort((a, b) => b - a);
    expect(areas).toEqual([36, 8, 6]);
  });

  it('斜めにしか触れていない塊は別々に数える', () => {
    const { index, lum, w, h } = fromAscii([
      '1100',
      '1100',
      '0011',
      '0011',
    ]);
    const seg = segment(index, lum, w, h, 1);
    const ones = seg.regions.filter((r) => r.color === 1);
    expect(ones).toHaveLength(2);
  });

  it('外接矩形・重心・面積が正しい', () => {
    const { index, lum, w, h } = fromAscii([
      '000000',
      '011100',
      '011100',
      '000000',
    ]);
    const seg = segment(index, lum, w, h, 1);
    const r = seg.regions.find((x) => x.color === 1)!;
    expect(r.area).toBe(6);
    expect(r.minX).toBe(1);
    expect(r.maxX).toBe(3);
    expect(r.minY).toBe(1);
    expect(r.maxY).toBe(2);
    expect(r.cx).toBeCloseTo(2, 5);
    expect(r.cy).toBeCloseTo(1.5, 5);
  });

  it('横長の領域は主軸が横向きになる', () => {
    const rows = ['0'.repeat(40)];
    for (let i = 0; i < 3; i++) rows.push('0' + '1'.repeat(38) + '0');
    rows.push('0'.repeat(40));
    const { index, lum, w, h } = fromAscii(rows);
    const seg = segment(index, lum, w, h, 1);
    const r = seg.regions.find((x) => x.color === 1)!;
    expect(Math.abs(Math.sin(r.angle))).toBeLessThan(0.2);
    expect(r.elongation).toBeGreaterThan(0.9);
  });

  it('正方形に近い領域は細長くない', () => {
    const rows: string[] = [];
    for (let i = 0; i < 12; i++) rows.push(i > 1 && i < 10 ? '00' + '1'.repeat(8) + '00' : '0'.repeat(12));
    const { index, lum, w, h } = fromAscii(rows);
    const seg = segment(index, lum, w, h, 1);
    const r = seg.regions.find((x) => x.color === 1)!;
    expect(r.elongation).toBeLessThan(0.4);
  });

  it('画面端に接しているかを判定する', () => {
    const { index, lum, w, h } = fromAscii([
      '1110',
      '1110',
      '0000',
    ]);
    const seg = segment(index, lum, w, h, 1);
    const inner = seg.regions.find((x) => x.color === 1)!;
    expect(inner.touchesBorder).toBe(true);
    const outer = seg.regions.find((x) => x.color === 0)!;
    expect(outer.touchesBorder).toBe(true);
  });

  it('平均輝度を保持する', () => {
    const { index, lum, w, h } = fromAscii(['22', '22']);
    const seg = segment(index, lum, w, h, 1);
    expect(seg.regions[0].meanLum).toBe(240);
  });

  it('小さすぎる塊は塗りの対象から外す', () => {
    const { index, lum, w, h } = fromAscii([
      '000000000',
      '011000000',
      '000000010',
      '000000000',
    ]);
    const seg = segment(index, lum, w, h, 3);
    // 領域としては数えるが、画素の割り当ては外れる
    expect(seg.regions.length).toBe(3);
    const tiny = seg.regions.filter((r) => r.area < 3);
    expect(tiny.length).toBe(2);
    for (const r of tiny) {
      for (let i = 0; i < seg.labels.length; i++) expect(seg.labels[i]).not.toBe(r.id);
    }
  });

  it('全画素が単色でも動く', () => {
    const { index, lum, w, h } = fromAscii(['111', '111']);
    const seg = segment(index, lum, w, h, 1);
    expect(seg.regions).toHaveLength(1);
    expect(seg.regions[0].area).toBe(6);
    expect(Array.from(seg.labels)).toEqual(new Array(6).fill(0));
  });

  it('大きな画像でも再帰による破綻がない', () => {
    const w = 400, h = 300;
    const index = new Uint8Array(w * h);
    const lum = new Uint8Array(w * h).fill(120);
    const seg = segment(index, lum, w, h, 1);
    expect(seg.regions).toHaveLength(1);
    expect(seg.regions[0].area).toBe(w * h);
  });
});
