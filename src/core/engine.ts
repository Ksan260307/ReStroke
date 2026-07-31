/**
 * タイムライン生成エンジン。
 *
 * 状態遷移・描画・履歴をつなぐ層。外からは「t 番目の時点の絵を見せて」という
 * 要求だけを受け付ける。
 *
 * 前に進むときは差分を描き足すだけ。後ろへ戻るときは、記録した入力から計算し直す。
 * 毎回先頭から計算し直すと遅いので、途中経過を何点かキャッシュしておき、そこから
 * 再開する。キャッシュは捨てても結果は変わらない（捨てれば遅くなるだけ）。
 */

import type { DrawingPlan } from './schema';
import { STAGE_COUNT, Stage } from './schema';
import { Painter } from '../render/painter';
import type { Surface } from '../render/surface';
import type { StyleProfile } from '../strokes/styles';
import {
  buildWorkPrefix,
  copySimState,
  createPaintOps,
  createSimState,
  resetSimState,
  stageAtTick,
  stepSimulation,
} from './transition';
import type { PaintOps, SimParams, SimState } from './transition';
import { createLog, recordInput } from './history';
import type { SessionLog } from './history';

export interface EngineOptions {
  plan: DrawingPlan;
  style: StyleProfile;
  durationSec: number;
  tickRate: number;
  seed: number;
  /** 画像座標系に対する出力倍率 */
  renderScale: number;
  /** 巻き戻し用キャッシュの点数（0 で無効） */
  checkpoints?: number;
  sourceName?: string;
  /** 収束先の元画像 */
  source?: CanvasImageSource | null;
}

type Snapshot = { tick: number; canvas: Surface; state: SimState };

export class TimelapseEngine {
  readonly plan: DrawingPlan;
  readonly painter: Painter;
  readonly params: SimParams;
  readonly log: SessionLog;
  readonly state: SimState = createSimState();

  private ops: PaintOps = createPaintOps(4096);
  private workPrefix: Float64Array;
  private snapshots: Snapshot[] = [];
  private snapshotInterval: number;
  private snapshotLimit: number;
  /** レイヤーの露出。null なら全部見せる */
  private visibility: Uint8Array | null = null;

  constructor(options: EngineOptions) {
    this.plan = options.plan;
    this.painter = new Painter(options.plan, {
      scale: options.renderScale,
      taper: options.style.taper,
      fillComposite: options.style.fillComposite,
      inkComposite: options.style.inkComposite,
      grain: options.style.grain,
      softness: options.style.softness,
      source: options.source ?? null,
    });
    this.params = buildSimParams(options.plan, options.style, options.durationSec, options.tickRate, options.seed);
    this.workPrefix = buildWorkPrefix(options.plan);
    this.snapshotLimit = options.checkpoints ?? 8;
    this.snapshotInterval = Math.max(
      30,
      Math.ceil(this.params.totalTicks / Math.max(1, this.snapshotLimit)),
    );
    this.log = createLog(
      options.plan.identity,
      options.seed,
      this.params.totalTicks,
      options.tickRate,
      {
        createdAt: new Date().toISOString(),
        sourceName: options.sourceName ?? '',
        sourceWidth: options.plan.sourceWidth,
        sourceHeight: options.plan.sourceHeight,
        strokeCount: options.plan.strokes.count,
        app: 'ReStroke 0.1.0',
      },
    );
    // 状態を動かす入力は開始時の設定のみ。以降の操作（再生位置や表示の切り替え）は
    // 見せ方の話であって、描かれる絵を変えないので記録しない。
    recordInput(this.log, {
      tick: 0,
      kind: 'session-start',
      value: options.durationSec,
      note: options.style.id,
    });
    this.painter.clear();
  }

  get tick(): number {
    return this.state.tick;
  }

  get totalTicks(): number {
    return this.params.totalTicks;
  }

  get finished(): boolean {
    return this.state.tick >= this.params.totalTicks;
  }

  /** 現在の工程 */
  get stage(): number {
    return stageAtTick(this.params, Math.min(this.state.tick, this.params.totalTicks - 1));
  }

  /** 描き終えた本数の割合 */
  get progress(): number {
    return this.params.totalTicks === 0 ? 1 : this.state.tick / this.params.totalTicks;
  }

  setVisibility(v: Uint8Array | null): void {
    this.visibility = v;
    const target = this.state.tick;
    this.dropCache();
    this.rewind();
    this.advanceTo(target);
  }

  /** 先頭へ戻す。 */
  rewind(): void {
    resetSimState(this.state);
    this.painter.clear();
  }

  /** キャッシュを捨てる（正しさには影響しない）。 */
  dropCache(): void {
    this.snapshots = [];
  }

  /** n tick 進める。 */
  advance(n: number): void {
    for (let i = 0; i < n && this.state.tick < this.params.totalTicks; i++) {
      this.stepOnce();
    }
  }

  /** 指定 tick へ移動する。戻る場合はキャッシュから計算し直す。 */
  advanceTo(target: number): void {
    const t = Math.max(0, Math.min(target, this.params.totalTicks));
    if (t < this.state.tick) {
      const snap = this.findSnapshot(t);
      if (snap) {
        this.painter.restore(snap.canvas);
        copySimState(snap.state, this.state);
      } else {
        resetSimState(this.state);
        this.painter.clear();
      }
    }
    while (this.state.tick < t) this.stepOnce();
  }

  private stepOnce(): void {
    if (
      this.snapshotLimit > 0 &&
      this.state.tick % this.snapshotInterval === 0 &&
      !this.snapshots.some((s) => s.tick === this.state.tick)
    ) {
      this.captureSnapshot();
    }
    stepSimulation(this.plan, this.params, this.workPrefix, this.state, this.ops);
    this.painter.apply(this.ops, this.visibility);
  }

  private captureSnapshot(): void {
    if (this.snapshots.length >= this.snapshotLimit) {
      // 古いものから捨てる（欠けても先頭から計算し直せる）。
      this.snapshots.shift();
    }
    this.snapshots.push({
      tick: this.state.tick,
      canvas: this.painter.snapshot(),
      state: copySimState(this.state),
    });
  }

  private findSnapshot(tick: number): Snapshot | null {
    let best: Snapshot | null = null;
    for (const s of this.snapshots) {
      if (s.tick <= tick && (!best || s.tick > best.tick)) best = s;
    }
    return best;
  }

  /** 工程ごとの tick 範囲（UI 表示用）。 */
  stageRanges(): { stage: number; start: number; end: number }[] {
    const out: { stage: number; start: number; end: number }[] = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
      if (this.params.stageTicks[s] <= 0) continue;
      out.push({
        stage: s,
        start: this.params.stageStart[s],
        end: this.params.stageStart[s] + this.params.stageTicks[s],
      });
    }
    return out;
  }
}

/**
 * 工程ごとの時間配分を決める。
 *
 * ストロークが 1 本もない工程には時間を割り当てず、その分を他へ回す。
 * 逆に、本数が極端に多い工程には少し多めに配る（重み × 本数比の折衷）。
 */
export function buildSimParams(
  plan: DrawingPlan,
  style: StyleProfile,
  durationSec: number,
  tickRate: number,
  seed: number,
): SimParams {
  const totalTicks = Math.max(tickRate, Math.round(durationSec * tickRate));
  const counts = new Float64Array(STAGE_COUNT);
  let totalStrokes = 0;
  for (let s = 0; s < STAGE_COUNT; s++) {
    counts[s] = plan.stageOffset[s + 1] - plan.stageOffset[s];
    totalStrokes += counts[s];
  }

  const weights = new Float64Array(STAGE_COUNT);
  let sum = 0;
  for (let s = 0; s < STAGE_COUNT; s++) {
    if (counts[s] <= 0) continue;
    const share = totalStrokes > 0 ? counts[s] / totalStrokes : 0;
    // 画風が決めた配分と、実際の本数の比を折衷する。本数の多い工程が
    // 一瞬で流れてしまわないよう、本数側の重みを小さくしすぎない。
    weights[s] = style.stageWeights[s] * 0.55 + share * 100 * 0.45;
    sum += weights[s];
  }
  if (sum <= 0) {
    weights[Stage.Base] = 1;
    sum = 1;
  }

  // 1 つの工程が時間を占めすぎないようにする。仕上げの詰めは本数が桁違いに多く、
  // 放っておくと動画の大半が詰め作業になってしまう。
  const CAP = 0.34;
  for (let pass = 0; pass < 4; pass++) {
    let over = false;
    for (let s = 0; s < STAGE_COUNT; s++) {
      const limit = sum * CAP;
      if (weights[s] > limit) {
        sum -= weights[s] - limit;
        weights[s] = limit;
        over = true;
      }
    }
    if (!over) break;
  }

  const stageTicks = new Int32Array(STAGE_COUNT);
  const stageStart = new Int32Array(STAGE_COUNT);
  let assigned = 0;
  let lastUsed = -1;
  for (let s = 0; s < STAGE_COUNT; s++) {
    if (weights[s] <= 0) continue;
    const t = Math.max(1, Math.floor((weights[s] / sum) * totalTicks));
    stageTicks[s] = t;
    assigned += t;
    lastUsed = s;
  }
  if (lastUsed < 0) {
    stageTicks[Stage.Base] = totalTicks;
    lastUsed = Stage.Base;
    assigned = totalTicks;
  }
  // 端数は最後の工程へ寄せる（合計が指定尺と必ず一致するように）。
  stageTicks[lastUsed] += totalTicks - assigned;

  let acc = 0;
  for (let s = 0; s < STAGE_COUNT; s++) {
    stageStart[s] = acc;
    acc += stageTicks[s];
  }

  const stageIntensity = new Float32Array(STAGE_COUNT);
  stageIntensity[Stage.Rough] = 1.2;
  stageIntensity[Stage.LineArt] = 1.35;
  stageIntensity[Stage.Base] = 0.8;
  stageIntensity[Stage.Shadow] = 1;
  stageIntensity[Stage.Light] = 1.1;
  stageIntensity[Stage.Detail] = 1.4;
  stageIntensity[Stage.Finish] = 1.25;

  return {
    seed,
    totalTicks,
    tickRate,
    dynamics: style.dynamics,
    stageTicks,
    stageStart,
    stageIntensity,
  };
}
