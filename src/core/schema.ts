/**
 * 論理スキーマ定義。
 *
 * ストロークの「論理的な意味」だけをここで定義し、物理的な持ち方（SoA・型付き配列・
 * ビット幅）は実装側の裁量とする。実際にはメモリ削減のため構造体配列ではなく
 * フィールドごとの型付き配列（SoA）に持ち、色は 32bit に詰める。
 *
 * スキーマ／遷移規則／動態モデルはバージョン識別子を持つ。これらが変われば同じ入力
 * からでも別の結果になるため、記録した工程を再生するときの照合キーになる。
 */

export const SCHEMA_VERSION = 'stroke-plan/1.0';
export const TRANSITION_VERSION = 'paint-transition/1.0';
export const DYNAMICS_VERSION = 'paint-dynamics/1.0';

/**
 * 描画工程。並び順がそのまま制作順になる。
 *
 * ラフで全体の当たりと色を置き、線画で形を決め、着色（ベース→影→光→細部）で
 * 色を積み、仕上げで詰める。背景を独立した工程には置かない。広い面も 1 つの
 * 色の領域として、ラフの色置きとベースカラーが引き受ける。
 */
export const Stage = {
  Rough: 0,
  LineArt: 1,
  Base: 2,
  Shadow: 3,
  Light: 4,
  Detail: 5,
  Finish: 6,
} as const;

export type StageId = (typeof Stage)[keyof typeof Stage];

export const STAGE_COUNT = 7;

export const STAGE_LABELS: Record<number, string> = {
  [Stage.Rough]: 'ラフ',
  [Stage.LineArt]: '線画',
  [Stage.Base]: 'ベースカラー',
  [Stage.Shadow]: '影',
  [Stage.Light]: '光',
  [Stage.Detail]: '細部',
  [Stage.Finish]: '仕上げ',
};

/** 着色にあたる工程（画面上のまとまりとして扱う）。 */
export const COLORING_STAGES: number[] = [Stage.Base, Stage.Shadow, Stage.Light, Stage.Detail];

/** ブラシの種類。描画時の合成方法と筆致に対応する。 */
export const Brush = {
  Flat: 0, // 平筆（面を塗る）
  Round: 1, // 丸筆（線を引く）
  Soft: 2, // ぼかし（影・光）
  Grain: 3, // かすれ（鉛筆・水彩の縁）
  /** 詰め。元画像そのものを絵の具として置く（仕上げ） */
  Refine: 4,
  /** 下塗り。すでに置かれた線の下へ潜り込ませる */
  Under: 5,
} as const;

export type BrushId = (typeof Brush)[keyof typeof Brush];

/**
 * ストローク表（SoA）。
 *
 * 1 ストローク当たり 40 バイト弱。2 万本でも 1MB 未満に収まる。
 * 座標は 2 次ベジェ（始点・制御点・終点）で保持する。
 */
export interface StrokeTable {
  count: number;
  readonly capacity: number;
  /** 始点 */
  x0: Float32Array;
  y0: Float32Array;
  /** 制御点 */
  cx: Float32Array;
  cy: Float32Array;
  /** 終点 */
  x1: Float32Array;
  y1: Float32Array;
  /** 筆幅（画像座標系のピクセル） */
  width: Float32Array;
  /** 0xRRGGBB */
  color: Uint32Array;
  /** 不透明度 0-255 */
  opacity: Uint8Array;
  /** 筆圧 0-255。幅と濃度の変調に使う */
  pressure: Uint8Array;
  /** 描画にかかる時間（tick 数） */
  duration: Uint8Array;
  /** 所属工程 */
  stage: Uint8Array;
  /** 所属レイヤー */
  layer: Uint16Array;
  /** ブラシ種別 */
  brush: Uint8Array;
}

export function createStrokeTable(capacity: number): StrokeTable {
  return {
    count: 0,
    capacity,
    x0: new Float32Array(capacity),
    y0: new Float32Array(capacity),
    cx: new Float32Array(capacity),
    cy: new Float32Array(capacity),
    x1: new Float32Array(capacity),
    y1: new Float32Array(capacity),
    width: new Float32Array(capacity),
    color: new Uint32Array(capacity),
    opacity: new Uint8Array(capacity),
    pressure: new Uint8Array(capacity),
    duration: new Uint8Array(capacity),
    stage: new Uint8Array(capacity),
    layer: new Uint16Array(capacity),
    brush: new Uint8Array(capacity),
  };
}

export interface StrokeInput {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  width: number;
  color: number;
  opacity: number;
  pressure: number;
  duration: number;
  stage: number;
  layer: number;
  brush: number;
}

/** 容量上限に達している場合は false を返す（暗黙に上限を超えない）。 */
export function pushStroke(t: StrokeTable, s: StrokeInput): boolean {
  const i = t.count;
  if (i >= t.capacity) return false;
  t.x0[i] = s.x0;
  t.y0[i] = s.y0;
  t.cx[i] = s.cx;
  t.cy[i] = s.cy;
  t.x1[i] = s.x1;
  t.y1[i] = s.y1;
  t.width[i] = s.width;
  t.color[i] = s.color >>> 0;
  t.opacity[i] = s.opacity;
  t.pressure[i] = s.pressure;
  t.duration[i] = s.duration;
  t.stage[i] = s.stage;
  t.layer[i] = s.layer;
  t.brush[i] = s.brush;
  t.count = i + 1;
  return true;
}

/** 推定されたレイヤー。 */
export interface LayerInfo {
  id: number;
  name: string;
  stage: number;
  order: number;
  strokeCount: number;
  /** 代表色 0xRRGGBB */
  color: number;
  /** 画面に占める面積比 0-1 */
  coverage: number;
}

/** 解析結果と生成されたストロークの束。これが描画工程の設計図になる。 */
export interface DrawingPlan {
  /** 画像座標系のサイズ（解析解像度） */
  width: number;
  height: number;
  /** 元画像のサイズ */
  sourceWidth: number;
  sourceHeight: number;
  /** 紙（キャンバス）の色 0xRRGGBB */
  paper: number;
  palette: Uint32Array;
  layers: LayerInfo[];
  strokes: StrokeTable;
  /** 工程ごとのストローク開始位置（累積）。stageOffset[s]..stageOffset[s+1] */
  stageOffset: Int32Array;
  /** 生成に使ったスキーマ・遷移規則の版 */
  identity: PlanIdentity;
}

export interface PlanIdentity {
  schema: string;
  transition: string;
  dynamics: string;
  /** 数値表現（丸め挙動が変われば結果が変わるため照合対象） */
  numeric: string;
  /** スタイル指定を含む生成パラメータのダイジェスト */
  params: string;
}

/** 数値の扱い方。丸めの挙動が変われば結果が変わるため、照合の対象に含める。 */
export const NUMERIC_FORMAT = 'float64/canvas2d';

export function baseIdentity(params: string): PlanIdentity {
  return {
    schema: SCHEMA_VERSION,
    transition: TRANSITION_VERSION,
    dynamics: DYNAMICS_VERSION,
    numeric: NUMERIC_FORMAT,
    params,
  };
}

export function identityKey(id: PlanIdentity): string {
  return `${id.schema}|${id.transition}|${id.dynamics}|${id.numeric}|${id.params}`;
}

export const rgb = (r: number, g: number, b: number): number =>
  (((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;

export const redOf = (c: number): number => (c >>> 16) & 255;
export const greenOf = (c: number): number => (c >>> 8) & 255;
export const blueOf = (c: number): number => c & 255;

export function cssColor(c: number, alpha: number): string {
  return `rgba(${redOf(c)},${greenOf(c)},${blueOf(c)},${alpha.toFixed(3)})`;
}

export function hexColor(c: number): string {
  return `#${c.toString(16).padStart(6, '0').toUpperCase()}`;
}
