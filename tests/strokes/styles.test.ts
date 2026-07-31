import { describe, expect, it } from 'vitest';
import { STYLES, styleById } from '../../src/strokes/styles';
import { STAGE_COUNT, Stage } from '../../src/core/schema';

describe('画風プリセット', () => {
  it('識別子が重複しない', () => {
    const ids = STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('設計書の 8 種類がそろっている', () => {
    expect(STYLES.map((s) => s.name)).toEqual([
      '初心者', '中級者', 'プロ', '漫画家', 'アニメ制作', '水彩', '厚塗り', '色鉛筆',
    ]);
  });

  it('値がすべて妥当な範囲に収まる', () => {
    for (const s of STYLES) {
      expect(s.paletteSize).toBeGreaterThanOrEqual(2);
      expect(s.paletteSize).toBeLessThanOrEqual(255);
      expect(s.spacing).toBeGreaterThan(0);
      expect(s.widthFactor).toBeGreaterThan(0);
      expect(s.maxLength).toBeGreaterThan(s.spacing);
      expect(s.fillPasses).toBeGreaterThanOrEqual(1);
      expect(s.speed).toBeGreaterThan(0);
      for (const v of [s.fillOpacity, s.lineOpacity, s.rough, s.detail, s.taper, s.grain, s.softness, s.colorFidelity]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(s.stageWeights).toHaveLength(STAGE_COUNT);
      expect(s.stageWeights.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      for (const w of s.stageWeights) expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('動態モデルの値が妥当', () => {
    for (const s of STYLES) {
      const d = s.dynamics;
      expect(d.excitationDecay).toBeGreaterThan(0);
      expect(d.excitationDecay).toBeLessThan(1);
      expect(d.fatigueGain).toBeGreaterThanOrEqual(0);
      expect(d.pauseChance).toBeGreaterThanOrEqual(0);
      expect(d.pauseChance).toBeLessThan(0.5);
      expect(d.pauseTicks).toBeGreaterThan(0);
      expect(d.swayPeriod).toBeGreaterThan(1);
    }
  });

  it('線画を持たない画風は線画工程に時間を割かない', () => {
    for (const s of STYLES) {
      if (!s.lineArt) expect(s.stageWeights[Stage.LineArt]).toBe(0);
    }
    expect(STYLES.find((s) => s.id === 'impasto')!.lineArt).toBe(false);
  });

  it('画風ごとに性格が違う', () => {
    const beginner = styleById('beginner');
    const pro = styleById('professional');
    expect(beginner.jitter).toBeGreaterThan(pro.jitter);
    expect(beginner.speed).toBeLessThan(pro.speed);
    expect(styleById('anime').fillOpacity).toBeGreaterThan(styleById('watercolor').fillOpacity);
    expect(styleById('manga').stageWeights[Stage.LineArt])
      .toBeGreaterThan(styleById('watercolor').stageWeights[Stage.LineArt]);
    expect(styleById('pencil').spacing).toBeLessThan(styleById('watercolor').spacing);
  });

  it('未知の識別子は既定の画風になる', () => {
    expect(styleById('存在しない').id).toBe('professional');
    expect(styleById('watercolor').id).toBe('watercolor');
  });
});
