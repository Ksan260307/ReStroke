import { describe, expect, it } from 'vitest';
import { GifWriter } from '../../src/export/gif';
import { decodeGif } from '../helpers/gifDecoder';
import { rgb } from '../../src/core/schema';

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function frameData(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  }
  return d;
}

const palette = new Uint32Array([
  rgb(0, 0, 0), rgb(255, 255, 255), rgb(248, 8, 8), rgb(8, 248, 8), rgb(8, 8, 248),
]);

describe('GIF 書き出し', () => {
  it('署名・大きさ・終端が正しい', async () => {
    const w = new GifWriter({ width: 16, height: 12, delay: 8, palette });
    w.addFrame(frameData(16, 12, () => [255, 255, 255]));
    const bytes = await toBytes(w.finish());
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    const gif = decodeGif(bytes);
    expect(gif.width).toBe(16);
    expect(gif.height).toBe(12);
  });

  it('無限ループの指定が入る', async () => {
    const w = new GifWriter({ width: 8, height: 8, delay: 5, palette });
    w.addFrame(frameData(8, 8, () => [0, 0, 0]));
    expect(decodeGif(await toBytes(w.finish())).loops).toBe(0);
  });

  it('入れたフレームの数と表示時間が保たれる', async () => {
    const w = new GifWriter({ width: 12, height: 10, delay: 7, palette });
    for (let i = 0; i < 5; i++) {
      w.addFrame(frameData(12, 10, () => [i * 50, 0, 0]));
    }
    const gif = decodeGif(await toBytes(w.finish()));
    expect(gif.frames).toHaveLength(5);
    for (const f of gif.frames) {
      expect(f.delay).toBe(7);
      expect(f.width).toBe(12);
      expect(f.height).toBe(10);
    }
  });

  it('代表色そのままの画素は色が変わらない', async () => {
    const colors: [number, number, number][] = [
      [0, 0, 0], [255, 255, 255], [248, 8, 8], [8, 248, 8], [8, 8, 248],
    ];
    const w = new GifWriter({ width: 5, height: 1, delay: 4, palette });
    w.addFrame(frameData(5, 1, (x) => colors[x]));
    const gif = decodeGif(await toBytes(w.finish()));
    const f = gif.frames[0];
    for (let x = 0; x < 5; x++) {
      const [r, g, b] = colors[x];
      expect(f.colors[x]).toBe(rgb(r, g, b));
    }
  });

  it('代表色に無い色は近い色へ寄せる', async () => {
    const w = new GifWriter({ width: 2, height: 1, delay: 4, palette });
    w.addFrame(frameData(2, 1, (x) => (x === 0 ? [250, 20, 20] : [20, 20, 250])));
    const f = decodeGif(await toBytes(w.finish())).frames[0];
    const d = (c: number, r: number, g: number, b: number): number =>
      Math.hypot(((c >>> 16) & 255) - r, ((c >>> 8) & 255) - g, (c & 255) - b);
    expect(d(f.colors[0], 250, 20, 20)).toBeLessThan(40);
    expect(d(f.colors[1], 20, 20, 250)).toBeLessThan(40);
  });

  it('模様のあるフレームを画素単位で復元できる', async () => {
    const W = 40, H = 30;
    const pattern = (x: number, y: number): [number, number, number] =>
      (x + y) % 3 === 0 ? [0, 0, 0] : (x % 5 === 0 ? [248, 8, 8] : [255, 255, 255]);
    const w = new GifWriter({ width: W, height: H, delay: 6, palette });
    w.addFrame(frameData(W, H, pattern));
    const f = decodeGif(await toBytes(w.finish())).frames[0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = pattern(x, y);
        expect(f.colors[y * W + x], `(${x},${y})`).toBe(rgb(r, g, b));
      }
    }
  });

  it('単色のフレームでも壊れない', async () => {
    const w = new GifWriter({ width: 64, height: 64, delay: 10, palette });
    w.addFrame(frameData(64, 64, () => [255, 255, 255]));
    const f = decodeGif(await toBytes(w.finish())).frames[0];
    expect(f.colors.every((c) => c === rgb(255, 255, 255))).toBe(true);
  });

  it('辞書が一杯になる大きさでも正しく復元できる', async () => {
    // 圧縮辞書（4096 語）を使い切る程度の大きさと複雑さ
    const W = 200, H = 160;
    let s = 12345;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const px: [number, number, number][] = [];
    for (let i = 0; i < W * H; i++) {
      const v = Math.floor(rnd() * 5);
      px.push([[0, 0, 0], [255, 255, 255], [248, 8, 8], [8, 248, 8], [8, 8, 248]][v] as [number, number, number]);
    }
    const w = new GifWriter({ width: W, height: H, delay: 4, palette });
    w.addFrame(frameData(W, H, (x, y) => px[y * W + x]));
    const f = decodeGif(await toBytes(w.finish())).frames[0];
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = px[i];
      expect(f.colors[i]).toBe(rgb(r, g, b));
    }
  });

  it('代表色が 256 を超えても書き出せる', async () => {
    const many = new Uint32Array(400);
    for (let i = 0; i < many.length; i++) many[i] = rgb(i % 256, (i * 3) % 256, (i * 7) % 256);
    const w = new GifWriter({ width: 8, height: 8, delay: 5, palette: many });
    w.addFrame(frameData(8, 8, (x) => [x * 30, 0, 0]));
    const gif = decodeGif(await toBytes(w.finish()));
    expect(gif.table.length).toBe(768);
    expect(gif.frames).toHaveLength(1);
  });

  it('代表色が少なくてもカラーテーブルは 256 色ぶん用意される', async () => {
    const w = new GifWriter({ width: 4, height: 4, delay: 5, palette: new Uint32Array([rgb(1, 2, 3)]) });
    w.addFrame(frameData(4, 4, () => [1, 2, 3]));
    const gif = decodeGif(await toBytes(w.finish()));
    expect(gif.table.length).toBe(768);
    expect(gif.frames[0].colors[0]).toBe(rgb(1, 2, 3));
  });

  it('フレームを 1 枚も入れなくても壊れたファイルにならない', async () => {
    const w = new GifWriter({ width: 8, height: 8, delay: 5, palette });
    const gif = decodeGif(await toBytes(w.finish()));
    expect(gif.frames).toHaveLength(0);
    expect(gif.width).toBe(8);
  });

  it('同じ入力からは 1 バイトも違わない出力になる', async () => {
    const make = async (): Promise<Uint8Array> => {
      const w = new GifWriter({ width: 24, height: 20, delay: 6, palette });
      for (let i = 0; i < 3; i++) w.addFrame(frameData(24, 20, (x, y) => [(x * i) % 256, y * 4, 0]));
      return toBytes(w.finish());
    };
    expect(Array.from(await make())).toEqual(Array.from(await make()));
  });
});
