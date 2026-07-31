/**
 * 決定論的な数値ユーティリティ。
 *
 * 状態遷移で使う「ゆらぎ」は、すべてここにある **状態を持たないハッシュ**から得る。
 * 内部カウンタを持つ擬似乱数生成器を使わないのは、生成器を進める順序が結果を変えて
 * しまい、評価順序や並列分割によって出力が揺れるためである。
 * (seed, tick, index) から直接引くハッシュなら、どの順で呼んでも同じ値になる。
 */

/** 32bit 整数ハッシュ。同じ引数からは常に同じ値を返す。 */
export function hash32(a: number, b = 0, c = 0): number {
  let h = (a ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** [0, 1) の決定論的な値。 */
export function rand01(a: number, b = 0, c = 0): number {
  return hash32(a, b, c) / 4294967296;
}

/** [-1, 1) の決定論的な値。 */
export function randSigned(a: number, b = 0, c = 0): number {
  return rand01(a, b, c) * 2 - 1;
}

/** [lo, hi) の決定論的な値。 */
export function randRange(lo: number, hi: number, a: number, b = 0, c = 0): number {
  return lo + rand01(a, b, c) * (hi - lo);
}

/**
 * テーブル引きの正弦。
 *
 * Math.sin の結果は実行環境ごとに最下位ビットが異なりうるため、環境をまたいだ
 * 再現性が必要な箇所ではこちらを使う。テーブル参照なので単純に速くもある。
 */
const SIN_BITS = 12;
const SIN_SIZE = 1 << SIN_BITS;
const SIN_MASK = SIN_SIZE - 1;
const SIN_TABLE = new Float32Array(SIN_SIZE + 1);
for (let i = 0; i <= SIN_SIZE; i++) {
  SIN_TABLE[i] = Math.sin((i / SIN_SIZE) * Math.PI * 2);
}
const TAU = Math.PI * 2;

export function fastSin(rad: number): number {
  const t = (rad / TAU) * SIN_SIZE;
  const i = Math.floor(t);
  const f = t - i;
  const i0 = i & SIN_MASK;
  const a = SIN_TABLE[i0];
  const b = SIN_TABLE[i0 + 1];
  return a + (b - a) * f;
}

export function fastCos(rad: number): number {
  return fastSin(rad + Math.PI / 2);
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 文字列から安定した 32bit シードを作る。 */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash32(h);
}

/**
 * 入力欄の文字列から種を決める。
 *
 * 通常は文字列から求めるが、`#` に続く 16 進数はその値をそのまま使う。
 * 記録した工程データから復元したときに、元とまったく同じ種へ戻せるようにするため。
 */
export function resolveSeed(text: string, fallback = 'restroke'): number {
  const trimmed = text.trim();
  const direct = /^#([0-9a-fA-F]{1,8})$/.exec(trimmed);
  if (direct) return parseInt(direct[1], 16) >>> 0;
  return seedFromString(trimmed || fallback);
}

/** 種を入力欄へ書き戻すときの表記。 */
export function formatSeed(seed: number): string {
  return `#${(seed >>> 0).toString(16)}`;
}
