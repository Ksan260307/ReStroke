/**
 * 動態モデル。
 *
 * 「描き手の手の動き」を 4 つの量で表す。状態遷移はこの契約だけを介して
 * ペースを決めるので、モデルを差し替えればタッチの性格が変わる。
 *
 *   勢い (potential)   : そのとき手がどれだけ速く動いているか
 *   励起 (excitation)  : 一時的な集中・筆の乗り。時間とともに減衰する
 *   蓄積 (accumulation): 疲労。単調非減少で、巻き戻しは再計算でのみ起きる
 *   相互作用           : ストローク同士の重なり。読み書きを分離した二重バッファで解く
 *
 * すべての量は「確定した状態」と明示シードだけから決まる。実時刻・実測フレーム時間・
 * 表示中のカメラ位置には依存させない。依存させると同じ入力から違う動画が出てしまう。
 */

import { DYNAMICS_VERSION } from './schema';
import { clamp, fastSin, rand01 } from './rng';

export { DYNAMICS_VERSION };

export interface DynamicsProfile {
  /** 励起の減衰率（1 tick あたりに残る割合） */
  excitationDecay: number;
  /** ストローク完了 1 本あたりの疲労増分 */
  fatigueGain: number;
  /** 疲労がペースを落とす強さ 0-1 */
  fatigueDrag: number;
  /** 手のゆらぎの振幅 */
  swayAmplitude: number;
  /** ゆらぎの周期（tick） */
  swayPeriod: number;
  /** 一息つく確率（tick あたり） */
  pauseChance: number;
  /** 一息の長さ（tick） */
  pauseTicks: number;
}

/** 動態の可変量。状態遷移の内部状態の一部。 */
export interface DynamicsState {
  potential: number;
  excitation: number;
  /** 単調非減少 */
  accumulation: number;
  /** 残りの休止 tick */
  restTicks: number;
}

export function createDynamicsState(): DynamicsState {
  return { potential: 1, excitation: 0, accumulation: 0, restTicks: 0 };
}

export function resetDynamicsState(s: DynamicsState): void {
  s.potential = 1;
  s.excitation = 0;
  s.accumulation = 0;
  s.restTicks = 0;
}

export function copyDynamicsState(src: DynamicsState): DynamicsState {
  return { ...src };
}

/**
 * 1 tick 分の動態更新。
 *
 * 戻り値は「このtickの作業速度倍率」。平均が 1 付近になるよう作ってあるので、
 * 全体の尺には影響せず、ペースの緩急だけが変わる。
 */
export function advanceDynamics(
  s: DynamicsState,
  profile: DynamicsProfile,
  seed: number,
  tick: number,
  completed: number,
  stageIntensity: number,
): number {
  // 蓄積は減らない。巻き戻したいときは記録から再計算する。
  s.accumulation += completed * profile.fatigueGain;

  // 励起は減衰しつつ、ストロークを描き切るたびに乗る。
  s.excitation = s.excitation * profile.excitationDecay + completed * 0.06 * stageIntensity;
  s.excitation = clamp(s.excitation, 0, 2.5);

  // 休止中は作業しない。
  if (s.restTicks > 0) {
    s.restTicks--;
    s.potential = s.potential * 0.7;
    return 0;
  }
  if (rand01(seed ^ 0x9e3779b9, tick) < profile.pauseChance) {
    s.restTicks = profile.pauseTicks;
    return 0;
  }

  // ゆらぎ: ゆっくりした波と細かいノイズの合成。
  const sway =
    fastSin((tick / profile.swayPeriod) * Math.PI * 2) * 0.6 +
    fastSin((tick / (profile.swayPeriod * 0.37)) * Math.PI * 2) * 0.25 +
    (rand01(seed, tick, 0x51ed) - 0.5) * 0.3;

  const drag = 1 / (1 + s.accumulation * profile.fatigueDrag);
  const target = (1 + sway * profile.swayAmplitude + s.excitation * 0.25) * drag;

  // 手の速度は急には変わらない。
  s.potential = s.potential * 0.72 + target * 0.28;
  return clamp(s.potential, 0.08, 3);
}

/** 筆圧の推定。ストローク内の位置 u(0-1) に対する筆圧プロファイル。 */
export function pressureAt(u: number, basePressure: number, taper: number): number {
  // 入りと抜きで細くなる。taper=0 で均一、1 で強い抑揚。
  const inOut = Math.sin(Math.PI * clamp(u, 0, 1)) ** 0.55;
  return basePressure * (1 - taper + taper * inOut);
}

export const STYLE_DYNAMICS_DEFAULT: DynamicsProfile = {
  excitationDecay: 0.9,
  fatigueGain: 0.00035,
  fatigueDrag: 0.55,
  swayAmplitude: 0.35,
  swayPeriod: 190,
  pauseChance: 0.004,
  pauseTicks: 14,
};
