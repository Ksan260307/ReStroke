/**
 * 状態遷移。
 *
 *     S(t+1) = F(S(t), 入力(t), 環境(t))
 *
 * F は純粋関数として書く。副作用（描画・I/O・暗黙の乱数）を持たないので、同じ
 * 初期シードと同じ入力列からは必ず同じ状態列が再生される。描画は戻り値の
 * 「描画命令」を受け取った側の仕事で、遷移自体はキャンバスに触れない。
 *
 * 手のモデルは「一度に 1 本のストロークを引くが、速度が変わる」。1 tick で複数本
 * 描き切ることも、1 本に何 tick もかけることもある。
 */

import type { DrawingPlan } from './schema';
import { advanceDynamics, createDynamicsState, resetDynamicsState } from './dynamics';
import type { DynamicsProfile, DynamicsState } from './dynamics';
import { STAGE_COUNT } from './schema';

/** 遷移に与える固定パラメータ。生成時に確定し、途中では変わらない。 */
export interface SimParams {
  seed: number;
  totalTicks: number;
  tickRate: number;
  dynamics: DynamicsProfile;
  /** 工程ごとの持ち時間（tick） */
  stageTicks: Int32Array;
  /** 工程ごとの開始 tick（累積） */
  stageStart: Int32Array;
  /** 工程ごとの筆の乗りやすさ */
  stageIntensity: Float32Array;
}

/** 確定状態。これだけで任意時点の絵が再現できる。 */
export interface SimState {
  tick: number;
  /** 現在描いているストローク番号 */
  cursor: number;
  /** そのストロークの進捗 0-1 */
  progress: number;
  /** 描き終えた本数 */
  completed: number;
  dyn: DynamicsState;
}

/** 1 tick 分の描画命令。同一ストロークの差分区間を表す。 */
export interface PaintOps {
  count: number;
  index: Int32Array;
  from: Float32Array;
  to: Float32Array;
}

export function createPaintOps(capacity = 1024): PaintOps {
  return {
    count: 0,
    index: new Int32Array(capacity),
    from: new Float32Array(capacity),
    to: new Float32Array(capacity),
  };
}

function growOps(ops: PaintOps): PaintOps {
  const cap = ops.index.length * 2;
  const index = new Int32Array(cap);
  const from = new Float32Array(cap);
  const to = new Float32Array(cap);
  index.set(ops.index);
  from.set(ops.from);
  to.set(ops.to);
  ops.index = index;
  ops.from = from;
  ops.to = to;
  return ops;
}

export function createSimState(): SimState {
  return { tick: 0, cursor: 0, progress: 0, completed: 0, dyn: createDynamicsState() };
}

export function resetSimState(s: SimState): void {
  s.tick = 0;
  s.cursor = 0;
  s.progress = 0;
  s.completed = 0;
  resetDynamicsState(s.dyn);
}

export function copySimState(src: SimState, dst?: SimState): SimState {
  const d = dst ?? createSimState();
  d.tick = src.tick;
  d.cursor = src.cursor;
  d.progress = src.progress;
  d.completed = src.completed;
  d.dyn.potential = src.dyn.potential;
  d.dyn.excitation = src.dyn.excitation;
  d.dyn.accumulation = src.dyn.accumulation;
  d.dyn.restTicks = src.dyn.restTicks;
  return d;
}

/** 工程ごとの作業量の累積。ペース配分に使う。 */
export function buildWorkPrefix(plan: DrawingPlan): Float64Array {
  const n = plan.strokes.count;
  const dur = plan.strokes.duration;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + Math.max(1, dur[i]);
  return prefix;
}

/** 工程の終わりに残す追いつき用の余裕（tick）。 */
export function catchUpReserve(params: SimParams, stage: number): number {
  const len = params.stageTicks[stage];
  if (len <= 2) return 0;
  return Math.min(Math.max(1, Math.round(len * 0.12)), 24, len - 1);
}

/** tick が属する工程を返す。 */
export function stageAtTick(params: SimParams, tick: number): number {
  for (let s = STAGE_COUNT - 1; s >= 0; s--) {
    if (params.stageTicks[s] > 0 && tick >= params.stageStart[s]) return s;
  }
  return 0;
}

/**
 * 1 tick 進める。
 *
 * ペースは「その工程の残り作業量 ÷ 残り tick 数」を基準に、動態モデルの倍率を掛けて
 * 決める。基準値を毎 tick 引き直すので、休止やゆらぎで遅れても工程の終わりには必ず
 * 追いつく。尺は指定どおりのまま、緩急だけが自然に出る。
 */
export function stepSimulation(
  plan: DrawingPlan,
  params: SimParams,
  workPrefix: Float64Array,
  state: SimState,
  ops: PaintOps,
): PaintOps {
  ops.count = 0;
  if (state.tick >= params.totalTicks) return ops;

  const strokes = plan.strokes;
  const tick = state.tick;
  const stage = stageAtTick(params, tick);
  const stageEndTick = params.stageStart[stage] + params.stageTicks[stage];
  const isFinalTick = tick >= params.totalTicks - 1;

  // この工程で描き終えているべき最後のストローク。
  let strokeEnd = plan.stageOffset[stage + 1];
  if (isFinalTick) strokeEnd = strokes.count;

  const dynFactor = advanceDynamics(
    state.dyn,
    params.dynamics,
    params.seed,
    tick,
    0,
    params.stageIntensity[stage],
  );

  // 残り作業量（tick 換算）と残り時間から基準ペースを引き直す。
  const cur = state.cursor;
  const doneWork =
    workPrefix[Math.min(cur, strokes.count)] +
    (cur < strokes.count ? state.progress * Math.max(1, strokes.duration[cur]) : 0);
  const remainWork = Math.max(0, workPrefix[strokeEnd] - doneWork);
  // 工程の終わりに少し余裕を残す。
  // ゆらぎや一息で遅れが出ても、この余裕の中で追いつけるため、工程の最後の 1 tick に
  // 大量のストロークがまとめて現れる（＝急に絵が完成する）ことがなくなる。
  const remainTicks = Math.max(1, stageEndTick - catchUpReserve(params, stage) - tick);
  let budget = (remainWork / remainTicks) * dynFactor;
  if (isFinalTick) budget = remainWork;
  if (budget <= 0) {
    state.tick = tick + 1;
    return ops;
  }

  let completedThisTick = 0;
  let guard = 0;
  while (budget > 1e-6 && state.cursor < strokeEnd && guard++ < 100000) {
    const i = state.cursor;
    const d = Math.max(1, strokes.duration[i]);
    const remain = (1 - state.progress) * d;
    const take = Math.min(budget, remain);
    const from = state.progress;
    const to = take >= remain - 1e-6 ? 1 : from + take / d;

    if (ops.count >= ops.index.length) growOps(ops);
    const k = ops.count++;
    ops.index[k] = i;
    ops.from[k] = from;
    ops.to[k] = to;

    budget -= take;
    if (to >= 1) {
      state.cursor = i + 1;
      state.progress = 0;
      state.completed++;
      completedThisTick++;
    } else {
      state.progress = to;
    }
  }

  // 描き切った本数を動態へ反映（次 tick の励起・疲労に効く）。
  if (completedThisTick > 0) {
    state.dyn.accumulation += completedThisTick * params.dynamics.fatigueGain;
    state.dyn.excitation = Math.min(
      2.5,
      state.dyn.excitation + completedThisTick * 0.03 * params.stageIntensity[stage],
    );
  }

  state.tick = tick + 1;
  return ops;
}

/** 現在の全体進捗 0-1。 */
export function overallProgress(plan: DrawingPlan, state: SimState): number {
  return plan.strokes.count === 0 ? 1 : state.cursor / plan.strokes.count;
}
