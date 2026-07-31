/**
 * 履歴。
 *
 * 保存するのは「どの版の規則で・どのシードから・どんな入力があったか」の 3 点だけで、
 * 各時点の絵そのものは保存しない。絵は必要になったときに先頭から計算し直す。
 * 状態を全部保存する方式に比べて記録量が桁違いに小さく、しかも任意の時点へ戻れる。
 *
 * 途中の絵をキャッシュ（チェックポイント）することはあるが、それは速度のためだけの
 * 派生物で、捨てても正しさは失われない。
 */

import type { PlanIdentity } from './schema';
import { identityKey } from './schema';

export interface InputEvent {
  tick: number;
  kind: string;
  value?: number;
  note?: string;
}

/** 一次履歴。これが唯一の正典。 */
export interface SessionLog {
  /** 再生結果を左右する識別情報。一致しなければ再生しない */
  identity: PlanIdentity;
  seed: number;
  totalTicks: number;
  tickRate: number;
  inputs: InputEvent[];
  /** 監査用の付帯情報。一致検査には使わない */
  meta: {
    createdAt: string;
    sourceName: string;
    sourceWidth: number;
    sourceHeight: number;
    strokeCount: number;
    app: string;
  };
}

export function createLog(
  identity: PlanIdentity,
  seed: number,
  totalTicks: number,
  tickRate: number,
  meta: SessionLog['meta'],
): SessionLog {
  return { identity, seed, totalTicks, tickRate, inputs: [], meta };
}

export function recordInput(log: SessionLog, event: InputEvent): void {
  log.inputs.push(event);
  // tick 順を保つ（記録漏れ・順序入れ替えがあると再生がずれる）
  for (let i = log.inputs.length - 1; i > 0; i--) {
    if (log.inputs[i - 1].tick <= log.inputs[i].tick) break;
    const tmp = log.inputs[i - 1];
    log.inputs[i - 1] = log.inputs[i];
    log.inputs[i] = tmp;
  }
}

export interface ReplayCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 記録した工程を再生してよいかを検査する。
 *
 * 規則の版が違えば同じ入力から別の絵になるので、黙って再生してはならない。
 */
export function checkReplayable(recorded: PlanIdentity, current: PlanIdentity): ReplayCheck {
  if (identityKey(recorded) === identityKey(current)) return { ok: true };
  const diffs: string[] = [];
  if (recorded.schema !== current.schema) diffs.push('データ定義');
  if (recorded.transition !== current.transition) diffs.push('遷移規則');
  if (recorded.dynamics !== current.dynamics) diffs.push('動態モデル');
  if (recorded.numeric !== current.numeric) diffs.push('数値表現');
  if (recorded.params !== current.params) diffs.push('生成パラメータ');
  return { ok: false, reason: `${diffs.join('・')}が現在の版と一致しません` };
}

export function serializeLog(log: SessionLog): string {
  return JSON.stringify(log, null, 2);
}

export function parseLog(text: string): SessionLog {
  const raw = JSON.parse(text) as SessionLog;
  if (!raw || !raw.identity || typeof raw.seed !== 'number') {
    throw new Error('工程データの形式が正しくありません');
  }
  raw.inputs ??= [];
  return raw;
}
