/**
 * 解析の粒度。
 *
 * レベルを 1 つ上げると、解析解像度・代表色数・線の拾い方・筆の細かさ・本数の上限が
 * まとめて上がる。粒度が上がるほど工程は細かくなり、出来上がりは元画像に近づくが、
 * 解析と生成に時間がかかり、必要なメモリも増える。
 *
 * 値をここへ集めてあるので、粒度に関わる調整はこの表だけを見ればよい。
 */

export const MIN_QUALITY = 1;
export const MAX_QUALITY = 10;
export const DEFAULT_QUALITY = 6;

export interface QualityLevel {
  level: number;
  /** 解析解像度（長辺） */
  analysisSide: number;
  /** ストローク本数の上限 */
  maxStrokes: number;
  /** 筆の間隔の倍率（小さいほど細かい） */
  spacingScale: number;
  /** 代表色数の倍率 */
  paletteScale: number;
  /** 線として拾う画素の割合 */
  edgeRatio: number;
  /** 線とみなす最短の長さ（筆の間隔に対する倍率） */
  lineMinLength: number;
  /** 線をたどるとき、周囲何画素を自分のものとして確保するか */
  claimRadius: number;
  /** 細部の密度倍率 */
  detailScale: number;
  /** 仕上げで詰める網の細かさの倍率 */
  refineScale: number;
}

export function qualityFor(level: number): QualityLevel {
  const raw = Number.isFinite(level) ? level : DEFAULT_QUALITY;
  const l = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(raw)));
  const t = (l - 1) / (MAX_QUALITY - 1); // 0-1
  return {
    level: l,
    analysisSide: Math.round(640 + t * 1120),
    maxStrokes: Math.round(9000 * Math.pow(1.44, l - 1)),
    spacingScale: 1.6 - t * 1.05,
    paletteScale: 0.7 + t * 0.9,
    // 上のレベルほど弱い輪郭まで線として拾う
    edgeRatio: 0.05 + t * 0.26,
    lineMinLength: 1.0 - t * 0.72,
    claimRadius: l <= 3 ? 1 : 0,
    detailScale: 0.7 + t * 1.1,
    refineScale: 1.15 - t * 0.6,
  };
}

/** 画面に出す目安の説明。 */
export function describeQuality(q: QualityLevel): string {
  const strokes = q.maxStrokes >= 10000
    ? `${(q.maxStrokes / 10000).toFixed(1)} 万本`
    : `${q.maxStrokes.toLocaleString('ja-JP')} 本`;
  return `解析 ${q.analysisSide}px ／ 最大 ${strokes}`;
}
