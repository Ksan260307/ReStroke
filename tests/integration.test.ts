/**
 * 通し確認。
 *
 * 「画像を入れてから、指定した長さの最後のフレームに何が出るか」までを一続きで見る。
 * とくに、長さをどう設定しても最後は必ず元画像そのものになることを確かめる。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimelapseEngine } from '../src/core/engine';
import { checkReplayable, parseLog, serializeLog } from '../src/core/history';
import { installRecordingSurface } from './helpers/surface';
import type { RecordingHandle } from './helpers/surface';
import { buildPlan, noisyImage, sceneImage, solidImage, style } from './helpers/fixtures';

let handle: RecordingHandle;
const source = { fake: 'source' } as unknown as CanvasImageSource;

beforeEach(() => {
  handle = installRecordingSurface();
});
afterEach(() => handle.restore());

describe('通し確認', () => {
  it('どの長さでも、最後のフレームは元画像そのものになる', async () => {
    const { plan } = await buildPlan(sceneImage(200, 150));
    for (const sec of [3, 5, 10, 30, 60, 180]) {
      const e = new TimelapseEngine({
        plan, style: style('professional'), durationSec: sec,
        tickRate: 60, seed: 0x2024, renderScale: 1, checkpoints: 4, source,
      });
      e.advance(e.totalTicks);
      expect(e.finished, `${sec} 秒`).toBe(true);
      expect(e.state.cursor, `${sec} 秒で描き残しがある`).toBe(plan.strokes.count);
      expect(e.painter.effectiveConvergence, `${sec} 秒で元画像に一致していない`).toBe(1);
    }
  });

  it('どの画風でも最後は元画像そのものになる', async () => {
    for (const id of ['beginner', 'professional', 'manga', 'anime', 'watercolor', 'impasto', 'pencil']) {
      const { plan } = await buildPlan(sceneImage(160, 120), { style: id, maxStrokes: 8000 });
      const e = new TimelapseEngine({
        plan, style: style(id), durationSec: 8,
        tickRate: 60, seed: 5, renderScale: 1, checkpoints: 3, source,
      });
      e.advance(e.totalTicks);
      expect(e.state.cursor, id).toBe(plan.strokes.count);
      expect(e.painter.effectiveConvergence, id).toBe(1);
    }
  });

  it('極端な画像でも最後まで通る', async () => {
    for (const img of [solidImage(80, 60), noisyImage(160, 120), sceneImage(64, 48)]) {
      const { plan } = await buildPlan(img);
      const e = new TimelapseEngine({
        plan, style: style('intermediate'), durationSec: 4,
        tickRate: 60, seed: 9, renderScale: 1.5, checkpoints: 2, source,
      });
      e.advance(e.totalTicks);
      expect(e.state.cursor).toBe(plan.strokes.count);
      expect(e.painter.effectiveConvergence).toBe(1);
    }
  });

  it('書き出しと同じ刻みでフレームを取り出しても最後は一致する', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    for (const fps of [30, 60]) {
      const e = new TimelapseEngine({
        plan, style: style('anime'), durationSec: 6,
        tickRate: 60, seed: 4, renderScale: 1, checkpoints: 4, source,
      });
      const ticksPerFrame = e.params.tickRate / fps;
      const frames = Math.round(e.totalTicks / ticksPerFrame);
      for (let f = 0; f <= frames; f++) {
        e.advanceTo(Math.min(e.totalTicks, Math.round(f * ticksPerFrame)));
      }
      expect(e.tick, `${fps}fps`).toBe(e.totalTicks);
      expect(e.painter.effectiveConvergence, `${fps}fps`).toBe(1);
      expect(e.state.cursor).toBe(plan.strokes.count);
    }
  });

  it('工程データを保存して読み直すと同じ工程を再現できる', async () => {
    const first = await buildPlan(sceneImage(160, 120), { style: 'watercolor', seed: 0x77 });
    const e1 = new TimelapseEngine({
      plan: first.plan, style: style('watercolor'), durationSec: 12,
      tickRate: 60, seed: 0x77, renderScale: 1, checkpoints: 4, source,
    });
    const saved = parseLog(serializeLog(e1.log));
    expect(saved.seed).toBe(0x77);
    expect(saved.totalTicks).toBe(720);

    // 記録から設定を復元して作り直す
    const [styleId, seedHex] = saved.identity.params.split(':');
    const second = await buildPlan(sceneImage(160, 120), {
      style: styleId,
      seed: parseInt(seedHex, 16),
    });
    expect(checkReplayable(second.plan.identity, saved.identity).ok).toBe(true);
    expect(Array.from(second.plan.strokes.x0)).toEqual(Array.from(first.plan.strokes.x0));
    expect(Array.from(second.plan.strokes.color)).toEqual(Array.from(first.plan.strokes.color));

    const e2 = new TimelapseEngine({
      plan: second.plan, style: style(styleId), durationSec: saved.totalTicks / saved.tickRate,
      tickRate: saved.tickRate, seed: saved.seed, renderScale: 1, checkpoints: 4, source,
    });
    e1.advanceTo(400);
    e2.advanceTo(400);
    expect(e2.state).toEqual(e1.state);
  });

  it('途中で行き来しても最終状態は変わらない', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    const make = () => new TimelapseEngine({
      plan, style: style('manga'), durationSec: 10,
      tickRate: 60, seed: 6, renderScale: 1, checkpoints: 5, source,
    });
    const straight = make();
    straight.advanceTo(straight.totalTicks);

    const wandering = make();
    for (const t of [200, 50, 400, 120, 599, 300]) wandering.advanceTo(t);
    wandering.advanceTo(wandering.totalTicks);

    expect(wandering.state).toEqual(straight.state);
    expect(wandering.painter.effectiveConvergence).toBe(1);
  });
});
