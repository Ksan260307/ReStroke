import { describe, expect, it } from 'vitest';
import {
  Brush,
  DYNAMICS_VERSION,
  SCHEMA_VERSION,
  STAGE_COUNT,
  STAGE_LABELS,
  Stage,
  TRANSITION_VERSION,
  baseIdentity,
  blueOf,
  createStrokeTable,
  cssColor,
  greenOf,
  hexColor,
  identityKey,
  pushStroke,
  redOf,
  rgb,
} from '../../src/core/schema';

const sample = {
  x0: 1, y0: 2, cx: 3, cy: 4, x1: 5, y1: 6,
  width: 7.5, color: 0x123456, opacity: 200, pressure: 180,
  duration: 4, stage: Stage.Base, layer: 3, brush: Brush.Flat,
};

describe('論理スキーマ', () => {
  it('工程はすべて名前を持ち、順番が制作順になっている', () => {
    expect(Object.keys(STAGE_LABELS)).toHaveLength(STAGE_COUNT);
    expect(Stage.Background).toBeLessThan(Stage.Rough);
    expect(Stage.Rough).toBeLessThan(Stage.LineArt);
    expect(Stage.LineArt).toBeLessThan(Stage.Base);
    expect(Stage.Base).toBeLessThan(Stage.Shadow);
    expect(Stage.Shadow).toBeLessThan(Stage.Light);
    expect(Stage.Light).toBeLessThan(Stage.Detail);
    expect(Stage.Detail).toBeLessThan(Stage.Finish);
  });

  it('ストロークを追加すると全フィールドが保存される', () => {
    const t = createStrokeTable(4);
    expect(pushStroke(t, sample)).toBe(true);
    expect(t.count).toBe(1);
    expect(t.x0[0]).toBe(1);
    expect(t.y1[0]).toBe(6);
    expect(t.width[0]).toBeCloseTo(7.5, 5);
    expect(t.color[0]).toBe(0x123456);
    expect(t.opacity[0]).toBe(200);
    expect(t.pressure[0]).toBe(180);
    expect(t.duration[0]).toBe(4);
    expect(t.stage[0]).toBe(Stage.Base);
    expect(t.layer[0]).toBe(3);
    expect(t.brush[0]).toBe(Brush.Flat);
  });

  it('容量を超えると追加を断り、件数も増えない', () => {
    const t = createStrokeTable(2);
    expect(pushStroke(t, sample)).toBe(true);
    expect(pushStroke(t, sample)).toBe(true);
    expect(pushStroke(t, sample)).toBe(false);
    expect(t.count).toBe(2);
  });

  it('容量ぶんの領域だけを確保する', () => {
    const t = createStrokeTable(1000);
    expect(t.x0.length).toBe(1000);
    expect(t.color.length).toBe(1000);
    expect(t.opacity.length).toBe(1000);
    // 1 本あたり 40 バイト弱に収まっている
    const bytes = t.x0.BYTES_PER_ELEMENT * 7 + t.color.BYTES_PER_ELEMENT +
      3 * 1 + t.duration.BYTES_PER_ELEMENT + t.layer.BYTES_PER_ELEMENT;
    expect(bytes).toBeLessThanOrEqual(40);
  });

  it('色の分解と組み立て', () => {
    const c = rgb(18, 52, 86);
    expect(c).toBe(0x123456);
    expect(redOf(c)).toBe(18);
    expect(greenOf(c)).toBe(52);
    expect(blueOf(c)).toBe(86);
    expect(hexColor(c)).toBe('#123456');
    expect(cssColor(c, 0.5)).toBe('rgba(18,52,86,0.500)');
    // 範囲外は切り詰められる
    expect(rgb(300, -5, 255) >>> 0).toBe(rgb(300 & 255, -5 & 255, 255));
  });

  it('版の識別子は全項目を含む', () => {
    const id = baseIdentity('style:seed');
    expect(id.schema).toBe(SCHEMA_VERSION);
    expect(id.transition).toBe(TRANSITION_VERSION);
    expect(id.dynamics).toBe(DYNAMICS_VERSION);
    expect(id.params).toBe('style:seed');
    const key = identityKey(id);
    for (const part of [id.schema, id.transition, id.dynamics, id.numeric, id.params]) {
      expect(key).toContain(part);
    }
    expect(identityKey(baseIdentity('a'))).not.toBe(identityKey(baseIdentity('b')));
  });
});
