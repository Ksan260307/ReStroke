import { describe, expect, it } from 'vitest';
import { analyzeWorkImage } from '../../src/analysis/pipeline';
import {
  DYNAMICS_VERSION,
  SCHEMA_VERSION,
  STAGE_COUNT,
  TRANSITION_VERSION,
} from '../../src/core/schema';
import { STYLES, styleById } from '../../src/strokes/styles';
import { buildPlan, noisyImage, quality, sceneImage, solidImage } from '../helpers/fixtures';

describe('解析パイプライン', () => {
  it('画像から工程一式を組み立てる', async () => {
    const img = sceneImage();
    const { plan, stats } = await buildPlan(img);
    expect(plan.width).toBe(img.width);
    expect(plan.height).toBe(img.height);
    expect(plan.strokes.count).toBeGreaterThan(100);
    expect(plan.layers.length).toBeGreaterThan(3);
    expect(plan.palette.length).toBeGreaterThan(1);
    expect(stats.strokeCount).toBe(plan.strokes.count);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('工程の境界が単調で、最後が総数と一致する', async () => {
    const { plan } = await buildPlan(sceneImage());
    for (let s = 1; s <= STAGE_COUNT; s++) {
      expect(plan.stageOffset[s]).toBeGreaterThanOrEqual(plan.stageOffset[s - 1]);
    }
    expect(plan.stageOffset[STAGE_COUNT]).toBe(plan.strokes.count);
  });

  it('進捗が順番に報告される', async () => {
    const phases: [string, number][] = [];
    await analyzeWorkImage(sceneImage(160, 120), 160, 120, {
      style: styleById('professional'),
      seed: 1,
      quality: quality({ level: 4, maxStrokes: 5000 }),
      onProgress: (phase, ratio) => phases.push([phase, ratio]),
    });
    expect(phases.length).toBeGreaterThan(4);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i][1]).toBeGreaterThanOrEqual(phases[i - 1][1]);
    }
    expect(phases[phases.length - 1][1]).toBe(1);
  });

  it('版の識別子が記録される', async () => {
    const { plan } = await buildPlan(sceneImage(120, 90), { style: 'manga', seed: 0x99 });
    expect(plan.identity.schema).toBe(SCHEMA_VERSION);
    expect(plan.identity.transition).toBe(TRANSITION_VERSION);
    expect(plan.identity.dynamics).toBe(DYNAMICS_VERSION);
    expect(plan.identity.params.startsWith('manga:')).toBe(true);
    expect(plan.identity.params).toContain((0x99).toString(16));
  });

  it('レイヤーは 1 本以上のストロークを持つものだけが残る', async () => {
    const { plan } = await buildPlan(sceneImage());
    expect(plan.layers.length).toBeGreaterThan(0);
    for (const l of plan.layers) expect(l.strokeCount).toBeGreaterThan(0);
    const total = plan.layers.reduce((a, l) => a + l.strokeCount, 0);
    expect(total).toBe(plan.strokes.count);
    plan.layers.forEach((l, i) => expect(l.order).toBe(i));
  });

  it('ストロークが指す番号は必ず実在する', async () => {
    const { plan } = await buildPlan(sceneImage());
    const ids = new Set(plan.layers.map((l) => l.id));
    for (let i = 0; i < plan.strokes.count; i++) {
      expect(ids.has(plan.strokes.layer[i])).toBe(true);
    }
  });

  it('元画像の大きさを記録する', async () => {
    const img = sceneImage(200, 150);
    const r = await analyzeWorkImage(img, 4000, 3000, {
      style: styleById('anime'), seed: 3, quality: quality({ level: 4, maxStrokes: 6000 }),
    });
    expect(r.plan.sourceWidth).toBe(4000);
    expect(r.plan.sourceHeight).toBe(3000);
    expect(r.plan.width).toBe(200);
  });

  it('同じ画像と種からは同じ工程になる', async () => {
    const a = await buildPlan(sceneImage(160, 120), { seed: 7 });
    const b = await buildPlan(sceneImage(160, 120), { seed: 7 });
    expect(b.plan.strokes.count).toBe(a.plan.strokes.count);
    expect(Array.from(b.plan.strokes.x0)).toEqual(Array.from(a.plan.strokes.x0));
    expect(b.plan.identity).toEqual(a.plan.identity);
  });

  it('種が変われば工程も変わる', async () => {
    const a = await buildPlan(sceneImage(160, 120), { seed: 1 });
    const b = await buildPlan(sceneImage(160, 120), { seed: 2 });
    expect(b.plan.identity.params).not.toBe(a.plan.identity.params);
    expect(Array.from(b.plan.strokes.x0)).not.toEqual(Array.from(a.plan.strokes.x0));
  });

  it('すべての画風で通る', async () => {
    for (const s of STYLES) {
      const { plan } = await buildPlan(sceneImage(160, 120), { style: s.id, maxStrokes: 8000 });
      expect(plan.strokes.count, s.id).toBeGreaterThan(50);
      expect(plan.layers.length, s.id).toBeGreaterThan(0);
    }
  });

  it('単色でも粒状でも破綻しない', async () => {
    for (const img of [solidImage(120, 90), noisyImage(160, 120)]) {
      const { plan } = await buildPlan(img);
      expect(plan.strokes.count).toBeGreaterThan(0);
      expect(plan.stageOffset[STAGE_COUNT]).toBe(plan.strokes.count);
    }
  });

  it('紙の色は画風の指定に従う', async () => {
    const { plan } = await buildPlan(sceneImage(120, 90), { style: 'impasto' });
    expect(plan.paper).toBe(styleById('impasto').paper);
  });

  it('本数の上限を超えない', async () => {
    const { plan, stats } = await buildPlan(sceneImage(240, 180), { style: 'pencil', maxStrokes: 900 });
    expect(plan.strokes.count).toBeLessThanOrEqual(900);
    expect(stats.coarsened).toBe(true);
  });
});
