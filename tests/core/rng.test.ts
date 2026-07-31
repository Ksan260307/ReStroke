import { describe, expect, it } from 'vitest';
import {
  clamp,
  fastCos,
  fastSin,
  formatSeed,
  hash32,
  lerp,
  rand01,
  randRange,
  randSigned,
  resolveSeed,
  seedFromString,
} from '../../src/core/rng';

describe('決定論的な数値', () => {
  it('同じ引数からは常に同じ値を返す', () => {
    for (let i = 0; i < 200; i++) {
      expect(hash32(i, i * 3, i * 7)).toBe(hash32(i, i * 3, i * 7));
    }
  });

  it('呼ぶ順序に影響されない（内部状態を持たない）', () => {
    const forward: number[] = [];
    for (let i = 0; i < 100; i++) forward.push(hash32(42, i));
    const backward: number[] = [];
    for (let i = 99; i >= 0; i--) backward.unshift(hash32(42, i));
    expect(backward).toEqual(forward);
  });

  it('引数が少し違えば値は大きく変わる', () => {
    const a = hash32(1, 2, 3);
    expect(hash32(1, 2, 4)).not.toBe(a);
    expect(hash32(2, 2, 3)).not.toBe(a);
    expect(hash32(1, 3, 3)).not.toBe(a);
  });

  it('32bit の範囲に収まる', () => {
    for (let i = 0; i < 500; i++) {
      const v = hash32(i * 2654435761, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('rand01 は [0,1) に収まり、偏らない', () => {
    const buckets = new Array(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rand01(i, 0x5bf0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 10 * 0.85);
      expect(b).toBeLessThan(n / 10 * 1.15);
    }
  });

  it('randSigned は [-1,1) に収まり、平均はほぼ 0', () => {
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = randSigned(i, 7);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
  });

  it('randRange は指定した範囲に収まる', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randRange(-3, 8, i);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(8);
    }
  });

  it('テーブル引きの正弦が十分な精度を持つ', () => {
    for (let i = 0; i < 2000; i++) {
      const rad = (i / 2000) * Math.PI * 4 - Math.PI * 2;
      expect(fastSin(rad)).toBeCloseTo(Math.sin(rad), 3);
      expect(fastCos(rad)).toBeCloseTo(Math.cos(rad), 3);
    }
  });

  it('正弦は環境に依存せず同じ値を返す', () => {
    const a = Array.from({ length: 50 }, (_, i) => fastSin(i * 0.37));
    const b = Array.from({ length: 50 }, (_, i) => fastSin(i * 0.37));
    expect(b).toEqual(a);
  });

  it('文字列から安定した種を作る', () => {
    expect(seedFromString('restroke')).toBe(seedFromString('restroke'));
    expect(seedFromString('restroke')).not.toBe(seedFromString('restrokf'));
    expect(seedFromString('')).toBe(seedFromString(''));
    expect(Number.isInteger(seedFromString('日本語でも動く'))).toBe(true);
  });

  it('入力欄の文字列から種を決める', () => {
    expect(resolveSeed('restroke')).toBe(seedFromString('restroke'));
    expect(resolveSeed('  restroke  ')).toBe(seedFromString('restroke'));
    expect(resolveSeed('')).toBe(seedFromString('restroke'));
    expect(resolveSeed('   ')).toBe(seedFromString('restroke'));
  });

  it('16 進表記の種はその値をそのまま使う', () => {
    expect(resolveSeed('#4d37984a')).toBe(0x4d37984a);
    expect(resolveSeed('#ff')).toBe(255);
    expect(resolveSeed('#FFFFFFFF')).toBe(0xffffffff);
    // 16 進として読めないものは通常の文字列扱い
    expect(resolveSeed('#zzz')).toBe(seedFromString('#zzz'));
    expect(resolveSeed('#123456789')).toBe(seedFromString('#123456789'));
  });

  it('種の表記は読み書きで往復する', () => {
    for (const seed of [0, 1, 0xdeadbeef, 0xffffffff, 12345]) {
      expect(resolveSeed(formatSeed(seed))).toBe(seed >>> 0);
    }
    expect(resolveSeed(formatSeed(seedFromString('日本語')))).toBe(seedFromString('日本語'));
  });

  it('clamp と lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(1.5, 0, 3)).toBe(1.5);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });
});
