/**
 * 通し確認。
 *
 * 「画像を入れてから、指定した長さの最後のフレームに何が出るか」までを一続きで見る。
 *
 * 最終フレームが元画像と一致する根拠は「仕上げの筆が画面の全画素を覆い、その筆が
 * 元画像そのものを絵の具にしている」ことなので、そこを幾何的に確かめる。
 * 実際の画素の一致はブラウザ上で別途確認している（README 参照）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimelapseEngine } from '../src/core/engine';
import { checkReplayable, parseLog, serializeLog } from '../src/core/history';
import { Brush, STAGE_COUNT } from '../src/core/schema';
import type { DrawingPlan } from '../src/core/schema';
import { installRecordingSurface } from './helpers/surface';
import type { RecordingHandle } from './helpers/surface';
import { buildPlan, noisyImage, sceneImage, solidImage, style } from './helpers/fixtures';

let handle: RecordingHandle;
const source = { fake: 'source' } as unknown as CanvasImageSource;

beforeEach(() => {
  handle = installRecordingSurface();
});
afterEach(() => handle.restore());

/** 仕上げの筆が覆っていない画素を数える。 */
function uncovered(plan: DrawingPlan): number {
  const { width: w, height: h, strokes: s } = plan;
  const from = plan.stageOffset[STAGE_COUNT - 1];
  const mask = new Uint8Array(w * h);
  for (let i = from; i < s.count; i++) {
    // 元画像を絵の具にして不透明に置いた筆だけが、一致の根拠になる
    if (s.brush[i] !== Brush.Refine || s.opacity[i] < 255) continue;
    const r = (s.width[i] * (0.65 + 0.35 * (s.pressure[i] / 255))) / 2;
    const steps = Math.max(2, Math.ceil(Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]) * 2));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const iu = 1 - u;
      const cx = iu * iu * s.x0[i] + 2 * iu * u * s.cx[i] + u * u * s.x1[i];
      const cy = iu * iu * s.y0[i] + 2 * iu * u * s.cy[i] + u * u * s.y1[i];
      for (let y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(h - 1, Math.floor(cy + r)); y++) {
        const dy = y - cy;
        const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
        for (let x = Math.max(0, Math.ceil(cx - dx)); x <= Math.min(w - 1, Math.floor(cx + dx)); x++) {
          mask[y * w + x] = 1;
        }
      }
    }
  }
  let miss = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0) miss++;
  return miss;
}

const makeEngine = (plan: DrawingPlan, styleId: string, sec: number, seed = 0x2024) =>
  new TimelapseEngine({
    plan, style: style(styleId), durationSec: sec,
    tickRate: 60, seed, renderScale: 1, checkpoints: 4, source,
  });

describe('通し確認', () => {
  it('どの長さでも、指定した尺のうちに全ストロークを引き終える', async () => {
    const { plan } = await buildPlan(sceneImage(200, 150));
    for (const sec of [3, 5, 10, 30, 60, 180]) {
      const e = makeEngine(plan, 'professional', sec);
      e.advance(e.totalTicks);
      expect(e.finished, `${sec} 秒`).toBe(true);
      expect(e.state.cursor, `${sec} 秒で描き残しがある`).toBe(plan.strokes.count);
    }
  });

  it('仕上げの筆が画面の全画素を覆う（最後は元画像そのものになる）', async () => {
    const { plan } = await buildPlan(sceneImage(200, 150));
    expect(uncovered(plan)).toBe(0);
  });

  it('どの画風でも覆いが崩れない', async () => {
    for (const id of ['beginner', 'professional', 'manga', 'anime', 'watercolor', 'impasto', 'pencil']) {
      const { plan } = await buildPlan(sceneImage(160, 120), { style: id });
      expect(uncovered(plan), id).toBe(0);
      const e = makeEngine(plan, id, 8, 5);
      e.advance(e.totalTicks);
      expect(e.state.cursor, id).toBe(plan.strokes.count);
    }
  });

  it('どの粒度でも覆いが崩れない', async () => {
    for (const level of [1, 3, 6, 9]) {
      const { plan } = await buildPlan(sceneImage(160, 120), { level });
      expect(uncovered(plan), `レベル ${level}`).toBe(0);
    }
  });

  it('極端な画像でも最後まで通る', async () => {
    for (const img of [solidImage(80, 60), noisyImage(160, 120), sceneImage(64, 48)]) {
      const { plan } = await buildPlan(img);
      expect(uncovered(plan)).toBe(0);
      const e = makeEngine(plan, 'intermediate', 4, 9);
      e.advance(e.totalTicks);
      expect(e.state.cursor).toBe(plan.strokes.count);
    }
  });

  it('書き出しと同じ刻みでフレームを取り出しても最後まで届く', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    for (const fps of [30, 60]) {
      const e = makeEngine(plan, 'anime', 6, 4);
      const ticksPerFrame = e.params.tickRate / fps;
      const frames = Math.round(e.totalTicks / ticksPerFrame);
      for (let f = 0; f <= frames; f++) {
        e.advanceTo(Math.min(e.totalTicks, Math.round(f * ticksPerFrame)));
      }
      expect(e.tick, `${fps}fps`).toBe(e.totalTicks);
      expect(e.state.cursor).toBe(plan.strokes.count);
    }
  });

  it('工程データを保存して読み直すと同じ工程を再現できる', async () => {
    const first = await buildPlan(sceneImage(160, 120), { style: 'watercolor', seed: 0x77, level: 4 });
    const e1 = makeEngine(first.plan, 'watercolor', 12, 0x77);
    const saved = parseLog(serializeLog(e1.log));
    expect(saved.seed).toBe(0x77);
    expect(saved.totalTicks).toBe(720);

    // 記録から設定を復元して作り直す
    const [styleId, seedHex, level] = saved.identity.params.split(':');
    const second = await buildPlan(sceneImage(160, 120), {
      style: styleId,
      seed: parseInt(seedHex, 16),
      level: Number(level),
    });
    expect(checkReplayable(second.plan.identity, saved.identity).ok).toBe(true);
    expect(Array.from(second.plan.strokes.x0)).toEqual(Array.from(first.plan.strokes.x0));
    expect(Array.from(second.plan.strokes.color)).toEqual(Array.from(first.plan.strokes.color));

    const e2 = makeEngine(second.plan, styleId, saved.totalTicks / saved.tickRate, saved.seed);
    e1.advanceTo(400);
    e2.advanceTo(400);
    expect(e2.state).toEqual(e1.state);
  });

  it('途中で行き来しても最終状態は変わらない', async () => {
    const { plan } = await buildPlan(sceneImage(160, 120));
    const straight = makeEngine(plan, 'manga', 10, 6);
    straight.advanceTo(straight.totalTicks);

    const wandering = makeEngine(plan, 'manga', 10, 6);
    for (const t of [200, 50, 400, 120, 599, 300]) wandering.advanceTo(t);
    wandering.advanceTo(wandering.totalTicks);

    expect(wandering.state).toEqual(straight.state);
  });

  it('粒度を上げるほど工程が細かくなる', async () => {
    const low = await buildPlan(sceneImage(200, 150), { level: 2 });
    const high = await buildPlan(sceneImage(200, 150), { level: 8 });
    expect(high.plan.strokes.count).toBeGreaterThan(low.plan.strokes.count * 3);
    expect(high.stats.lineCount).toBeGreaterThan(low.stats.lineCount);
    expect(high.stats.spacing).toBeLessThan(low.stats.spacing);
    expect(high.plan.palette.length).toBeGreaterThan(low.plan.palette.length);
  });
});
