import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  MAX_QUALITY,
  MIN_QUALITY,
  describeQuality,
  qualityFor,
} from '../../src/analysis/quality';

const levels = Array.from({ length: MAX_QUALITY }, (_, i) => qualityFor(i + 1));

describe('解析の粒度', () => {
  it('既定値は範囲内にある', () => {
    expect(DEFAULT_QUALITY).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(DEFAULT_QUALITY).toBeLessThanOrEqual(MAX_QUALITY);
  });

  it('範囲外の指定は端に丸める', () => {
    expect(qualityFor(0).level).toBe(MIN_QUALITY);
    expect(qualityFor(-5).level).toBe(MIN_QUALITY);
    expect(qualityFor(99).level).toBe(MAX_QUALITY);
    expect(qualityFor(Number.NaN).level).toBe(DEFAULT_QUALITY);
    expect(qualityFor(4.4).level).toBe(4);
  });

  it('上げるほど細かくなる（単調）', () => {
    for (let i = 1; i < levels.length; i++) {
      const lo = levels[i - 1];
      const hi = levels[i];
      expect(hi.analysisSide, `解析解像度 ${i}`).toBeGreaterThan(lo.analysisSide);
      expect(hi.maxStrokes, `本数 ${i}`).toBeGreaterThan(lo.maxStrokes);
      expect(hi.spacingScale, `筆の間隔 ${i}`).toBeLessThan(lo.spacingScale);
      expect(hi.paletteScale, `色数 ${i}`).toBeGreaterThan(lo.paletteScale);
      expect(hi.edgeRatio, `線の拾い方 ${i}`).toBeGreaterThan(lo.edgeRatio);
      expect(hi.lineMinLength, `線の最短 ${i}`).toBeLessThan(lo.lineMinLength);
      expect(hi.detailScale, `細部 ${i}`).toBeGreaterThan(lo.detailScale);
      expect(hi.refineScale, `詰め ${i}`).toBeLessThan(lo.refineScale);
    }
  });

  it('どの段階でも値が妥当な範囲に収まる', () => {
    for (const q of levels) {
      expect(q.analysisSide).toBeGreaterThanOrEqual(480);
      expect(q.analysisSide).toBeLessThanOrEqual(2048);
      expect(q.maxStrokes).toBeGreaterThanOrEqual(2000);
      expect(q.maxStrokes).toBeLessThanOrEqual(500000);
      expect(q.spacingScale).toBeGreaterThan(0.2);
      expect(q.paletteScale).toBeGreaterThan(0.3);
      expect(q.edgeRatio).toBeGreaterThan(0);
      expect(q.edgeRatio).toBeLessThan(0.5);
      expect(q.lineMinLength).toBeGreaterThan(0);
      expect(q.claimRadius).toBeGreaterThanOrEqual(0);
      expect(q.claimRadius).toBeLessThanOrEqual(1);
      expect(q.refineScale).toBeGreaterThan(0);
    }
  });

  it('同じ指定からは同じ設定になる', () => {
    expect(qualityFor(7)).toEqual(qualityFor(7));
  });

  it('説明文に解析解像度と本数が入る', () => {
    const q = qualityFor(6);
    const text = describeQuality(q);
    expect(text).toContain(String(q.analysisSide));
    expect(text).toContain('万本');
    expect(describeQuality(qualityFor(1))).toMatch(/本$/);
  });
});
