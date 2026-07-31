import { describe, expect, it } from 'vitest';
import { checkReplayable, createLog, parseLog, recordInput, serializeLog } from '../../src/core/history';
import type { SessionLog } from '../../src/core/history';
import { baseIdentity } from '../../src/core/schema';

const meta: SessionLog['meta'] = {
  createdAt: '2026-01-01T00:00:00.000Z',
  sourceName: 'a.png',
  sourceWidth: 100,
  sourceHeight: 80,
  strokeCount: 42,
  app: 'ReStroke test',
};

const makeLog = (params = 'professional:1:1080:18000:6.5:42'): SessionLog =>
  createLog(baseIdentity(params), 0xabcdef, 1800, 60, meta);

describe('履歴', () => {
  it('記録するのは版・種・入力列だけで、絵は含まない', () => {
    const log = makeLog();
    expect(Object.keys(log).sort()).toEqual(
      ['identity', 'inputs', 'meta', 'seed', 'tickRate', 'totalTicks'].sort(),
    );
    expect(JSON.stringify(log)).not.toContain('data:image');
  });

  it('入力は tick 順に並ぶ', () => {
    const log = makeLog();
    recordInput(log, { tick: 10, kind: 'b' });
    recordInput(log, { tick: 3, kind: 'a' });
    recordInput(log, { tick: 7, kind: 'c' });
    recordInput(log, { tick: 1, kind: 'z' });
    expect(log.inputs.map((i) => i.tick)).toEqual([1, 3, 7, 10]);
  });

  it('同じ版なら再生してよい', () => {
    const id = baseIdentity('x');
    expect(checkReplayable(id, id)).toEqual({ ok: true });
  });

  it('版が違えば再生を断り、理由を返す', () => {
    const current = baseIdentity('x');
    const cases: [Partial<ReturnType<typeof baseIdentity>>, string][] = [
      [{ schema: 'other' }, 'データ定義'],
      [{ transition: 'other' }, '遷移規則'],
      [{ dynamics: 'other' }, '動態モデル'],
      [{ numeric: 'other' }, '数値表現'],
      [{ params: 'y' }, '生成パラメータ'],
    ];
    for (const [patch, reason] of cases) {
      const check = checkReplayable({ ...current, ...patch }, current);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain(reason);
    }
  });

  it('複数の違いをまとめて報告する', () => {
    const current = baseIdentity('x');
    const check = checkReplayable({ ...current, schema: 'a', dynamics: 'b' }, current);
    expect(check.reason).toContain('データ定義');
    expect(check.reason).toContain('動態モデル');
  });

  it('保存して読み直しても内容が変わらない', () => {
    const log = makeLog();
    recordInput(log, { tick: 0, kind: 'session-start', value: 30, note: 'professional' });
    const restored = parseLog(serializeLog(log));
    expect(restored).toEqual(log);
    expect(checkReplayable(restored.identity, log.identity).ok).toBe(true);
  });

  it('壊れたデータは受け付けない', () => {
    expect(() => parseLog('これは JSON ではない')).toThrow();
    expect(() => parseLog('{}')).toThrow('形式');
    expect(() => parseLog('null')).toThrow('形式');
    expect(() => parseLog(JSON.stringify({ identity: baseIdentity('x') }))).toThrow('形式');
  });

  it('入力列が無い古いデータも読める', () => {
    const raw = JSON.stringify({ identity: baseIdentity('x'), seed: 1, totalTicks: 60, tickRate: 60, meta });
    expect(parseLog(raw).inputs).toEqual([]);
  });
});
