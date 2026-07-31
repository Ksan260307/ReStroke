/**
 * 画風プリセット。
 *
 * 同じ解析結果でも、筆の太さ・重ね方・工程の時間配分を変えると別人の描き方に見える。
 * ここを差し替えるだけで描き方が変わるよう、生成側はこの表以外の定数を持たない。
 */

import type { DynamicsProfile } from '../core/dynamics';
import { STYLE_DYNAMICS_DEFAULT } from '../core/dynamics';
import { STAGE_COUNT, Stage } from '../core/schema';

export interface StyleProfile {
  id: string;
  name: string;
  summary: string;
  /** 代表色の数 */
  paletteSize: number;
  /** 筆の間隔（画像 1024px 基準のピクセル） */
  spacing: number;
  /** 筆幅 = 間隔 × この係数 */
  widthFactor: number;
  /** 1 ストロークの最大長 */
  maxLength: number;
  /** 面塗りの重ね回数 */
  fillPasses: number;
  fillOpacity: number;
  /** 線画を描くか */
  lineArt: boolean;
  lineWidth: number;
  lineOpacity: number;
  /** ラフの量 0-1 */
  rough: number;
  /** 細部の密度 0-1 */
  detail: number;
  /** 手ぶれ */
  jitter: number;
  /** 筆の反り */
  bow: number;
  /** 色のばらつき */
  colorJitter: number;
  /** 元画像の色をどれだけ拾うか 0-1 */
  colorFidelity: number;
  /** 入り抜きの強さ */
  taper: number;
  grain: number;
  softness: number;
  fillComposite: GlobalCompositeOperation;
  inkComposite: GlobalCompositeOperation;
  /** 紙の色。null なら画像から推定 */
  paper: number | null;
  /** 筆の運び速度（px/tick） */
  speed: number;
  /** 工程ごとの時間配分 */
  stageWeights: number[];
  dynamics: DynamicsProfile;
}

const W = (bg: number, rough: number, line: number, base: number, shadow: number, light: number, detail: number, finish: number): number[] => {
  const w = new Array(STAGE_COUNT).fill(0);
  w[Stage.Background] = bg;
  w[Stage.Rough] = rough;
  w[Stage.LineArt] = line;
  w[Stage.Base] = base;
  w[Stage.Shadow] = shadow;
  w[Stage.Light] = light;
  w[Stage.Detail] = detail;
  w[Stage.Finish] = finish;
  return w;
};

const dyn = (o: Partial<DynamicsProfile>): DynamicsProfile => ({ ...STYLE_DYNAMICS_DEFAULT, ...o });

export const STYLES: StyleProfile[] = [
  {
    id: 'beginner',
    name: '初心者',
    summary: '線がぶれ、塗りにむらが残る。工程の戻りも多い',
    paletteSize: 14,
    spacing: 9,
    widthFactor: 1.5,
    maxLength: 46,
    fillPasses: 2,
    fillOpacity: 0.5,
    lineArt: true,
    lineWidth: 2.6,
    lineOpacity: 0.72,
    rough: 0.5,
    detail: 0.5,
    jitter: 1.9,
    bow: 0.28,
    colorJitter: 0.1,
    colorFidelity: 0.45,
    taper: 0.2,
    grain: 0.35,
    softness: 0.5,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0xfdfcf8,
    speed: 13,
    stageWeights: W(10, 8, 26, 22, 14, 6, 10, 4),
    dynamics: dyn({ swayAmplitude: 0.5, pauseChance: 0.009, pauseTicks: 18, fatigueGain: 0.0006 }),
  },
  {
    id: 'intermediate',
    name: '中級者',
    summary: '手順は整っているが、迷いと描き直しが少し残る',
    paletteSize: 20,
    spacing: 7,
    widthFactor: 1.4,
    maxLength: 58,
    fillPasses: 2,
    fillOpacity: 0.6,
    lineArt: true,
    lineWidth: 2.0,
    lineOpacity: 0.8,
    rough: 0.4,
    detail: 0.65,
    jitter: 1.1,
    bow: 0.22,
    colorJitter: 0.07,
    colorFidelity: 0.6,
    taper: 0.35,
    grain: 0.2,
    softness: 0.5,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0xfdfcfa,
    speed: 16,
    stageWeights: W(9, 8, 22, 22, 15, 8, 12, 4),
    dynamics: dyn({ swayAmplitude: 0.38, pauseChance: 0.006 }),
  },
  {
    id: 'professional',
    name: 'プロ',
    summary: '少ない筆数で大きく面を取り、迷いなく詰めていく',
    paletteSize: 26,
    spacing: 6.5,
    widthFactor: 1.55,
    maxLength: 86,
    fillPasses: 1,
    fillOpacity: 0.86,
    lineArt: true,
    lineWidth: 1.7,
    lineOpacity: 0.85,
    rough: 0.55,
    detail: 0.8,
    jitter: 0.5,
    bow: 0.3,
    colorJitter: 0.05,
    colorFidelity: 0.75,
    taper: 0.5,
    grain: 0.12,
    softness: 0.55,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0xfcfbf7,
    speed: 22,
    stageWeights: W(8, 10, 18, 20, 16, 10, 13, 5),
    dynamics: dyn({ swayAmplitude: 0.28, pauseChance: 0.0035, fatigueGain: 0.00022 }),
  },
  {
    id: 'manga',
    name: '漫画家',
    summary: '線画を主役に、影は細かい平行線で入れる',
    paletteSize: 12,
    spacing: 5.5,
    widthFactor: 1.2,
    maxLength: 70,
    fillPasses: 1,
    fillOpacity: 0.9,
    lineArt: true,
    lineWidth: 2.4,
    lineOpacity: 0.95,
    rough: 0.35,
    detail: 0.7,
    jitter: 0.5,
    bow: 0.18,
    colorJitter: 0.03,
    colorFidelity: 0.5,
    taper: 0.7,
    grain: 0.1,
    softness: 0.2,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0xfffffd,
    speed: 24,
    stageWeights: W(6, 8, 34, 16, 16, 5, 11, 4),
    dynamics: dyn({ swayAmplitude: 0.24, pauseChance: 0.004 }),
  },
  {
    id: 'anime',
    name: 'アニメ制作',
    summary: '均一な線とフラットな塗り分け。影は硬く落とす',
    paletteSize: 16,
    spacing: 7,
    widthFactor: 1.7,
    maxLength: 96,
    fillPasses: 1,
    fillOpacity: 1,
    lineArt: true,
    lineWidth: 1.9,
    lineOpacity: 1,
    rough: 0.25,
    detail: 0.55,
    jitter: 0.25,
    bow: 0.1,
    colorJitter: 0.015,
    colorFidelity: 0.35,
    taper: 0.15,
    grain: 0,
    softness: 0.05,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0xffffff,
    speed: 26,
    stageWeights: W(7, 6, 30, 22, 16, 7, 8, 4),
    dynamics: dyn({ swayAmplitude: 0.2, pauseChance: 0.003, fatigueGain: 0.00018 }),
  },
  {
    id: 'watercolor',
    name: '水彩',
    summary: '薄く重ね、にじみを残す。線は最後に軽く',
    paletteSize: 18,
    spacing: 9,
    widthFactor: 1.9,
    maxLength: 74,
    fillPasses: 3,
    fillOpacity: 0.3,
    lineArt: true,
    lineWidth: 1.4,
    lineOpacity: 0.45,
    rough: 0.45,
    detail: 0.4,
    jitter: 1.6,
    bow: 0.36,
    colorJitter: 0.12,
    colorFidelity: 0.7,
    taper: 0.45,
    grain: 0.5,
    softness: 0.9,
    fillComposite: 'multiply',
    inkComposite: 'multiply',
    paper: 0xfbf8f0,
    speed: 18,
    stageWeights: W(12, 10, 12, 26, 18, 8, 10, 4),
    dynamics: dyn({ swayAmplitude: 0.45, pauseChance: 0.007, pauseTicks: 16 }),
  },
  {
    id: 'impasto',
    name: '厚塗り',
    summary: '線画を持たず、面と面のぶつかりで形を出す',
    paletteSize: 30,
    spacing: 8,
    widthFactor: 1.8,
    maxLength: 64,
    fillPasses: 2,
    fillOpacity: 0.8,
    lineArt: false,
    lineWidth: 2.2,
    lineOpacity: 0.6,
    rough: 0.8,
    detail: 0.9,
    jitter: 1.3,
    bow: 0.3,
    colorJitter: 0.14,
    colorFidelity: 0.85,
    taper: 0.3,
    grain: 0.15,
    softness: 0.6,
    fillComposite: 'source-over',
    inkComposite: 'source-over',
    paper: 0x8d8880,
    speed: 19,
    stageWeights: W(12, 16, 0, 24, 18, 12, 14, 4),
    dynamics: dyn({ swayAmplitude: 0.4, pauseChance: 0.005 }),
  },
  {
    id: 'pencil',
    name: '色鉛筆',
    summary: '細い線を何度も重ねて色を作る',
    paletteSize: 22,
    spacing: 3.6,
    widthFactor: 0.9,
    maxLength: 40,
    fillPasses: 2,
    fillOpacity: 0.34,
    lineArt: true,
    lineWidth: 1.3,
    lineOpacity: 0.6,
    rough: 0.3,
    detail: 0.6,
    jitter: 0.9,
    bow: 0.2,
    colorJitter: 0.09,
    colorFidelity: 0.7,
    taper: 0.6,
    grain: 0.85,
    softness: 0.2,
    fillComposite: 'multiply',
    inkComposite: 'multiply',
    paper: 0xfcfaf4,
    speed: 15,
    stageWeights: W(10, 8, 18, 26, 16, 8, 10, 4),
    dynamics: dyn({ swayAmplitude: 0.34, pauseChance: 0.006 }),
  },
];

export function styleById(id: string): StyleProfile {
  return STYLES.find((s) => s.id === id) ?? STYLES[2];
}
