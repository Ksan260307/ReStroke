/**
 * GIF の書き出し（外部ライブラリなし）。
 *
 * 色数を 256 に落として LZW 圧縮する。フレームごとに色を選び直すと重いので、
 * 解析で得た代表色から共通のカラーテーブルを一度だけ作り、各フレームは
 * 5bit×3 の索引表を引くだけにしている。
 */

export interface GifOptions {
  width: number;
  height: number;
  /** 1 フレームの表示時間（1/100 秒） */
  delay: number;
  palette: Uint32Array;
}

export class GifWriter {
  private bytes: Uint8Array;
  private length = 0;
  private lut: Uint8Array;
  private table: Uint8Array;
  private opts: GifOptions;
  private started = false;
  /** フレームごとの色番号。毎回確保せず使い回す */
  private indices: Uint8Array;

  constructor(options: GifOptions) {
    this.opts = options;
    this.bytes = new Uint8Array(1 << 20);
    const built = buildColorTable(options.palette);
    this.table = built.table;
    this.lut = built.lut;
    this.indices = new Uint8Array(options.width * options.height);
  }

  private ensure(n: number): void {
    if (this.length + n <= this.bytes.length) return;
    let cap = this.bytes.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  private u8(v: number): void {
    this.ensure(1);
    this.bytes[this.length++] = v & 255;
  }

  private u16(v: number): void {
    this.u8(v & 255);
    this.u8((v >> 8) & 255);
  }

  private raw(data: Uint8Array): void {
    this.ensure(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  private header(): void {
    for (const ch of 'GIF89a') this.u8(ch.charCodeAt(0));
    this.u16(this.opts.width);
    this.u16(this.opts.height);
    this.u8(0xf7); // 全体カラーテーブルあり・256 色
    this.u8(0);
    this.u8(0);
    this.raw(this.table);
    // 無限ループ指定
    this.u8(0x21);
    this.u8(0xff);
    this.u8(0x0b);
    for (const ch of 'NETSCAPE2.0') this.u8(ch.charCodeAt(0));
    this.u8(0x03);
    this.u8(0x01);
    this.u16(0);
    this.u8(0);
    this.started = true;
  }

  /** RGBA のフレームを 1 枚追加する。 */
  addFrame(rgba: Uint8ClampedArray): void {
    if (!this.started) this.header();
    const n = this.opts.width * this.opts.height;
    const indices = this.indices;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      indices[i] =
        this.lut[
          ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3)
        ];
    }

    // 画像制御拡張
    this.u8(0x21);
    this.u8(0xf9);
    this.u8(0x04);
    this.u8(0x04); // 描画後は前フレームを残さない指定なし（上書き）
    this.u16(this.opts.delay);
    this.u8(0);
    this.u8(0);

    // 画像記述子
    this.u8(0x2c);
    this.u16(0);
    this.u16(0);
    this.u16(this.opts.width);
    this.u16(this.opts.height);
    this.u8(0);

    this.u8(8); // LZW 最小符号長
    this.raw(lzwEncode(indices, 8));
    this.u8(0);
  }

  finish(): Blob {
    if (!this.started) this.header();
    this.u8(0x3b);
    return new Blob([this.bytes.slice(0, this.length)], { type: 'image/gif' });
  }
}

/** 代表色から 256 色のテーブルと、5bit×3 → 色番号の索引表を作る。 */
function buildColorTable(palette: Uint32Array): { table: Uint8Array; lut: Uint8Array } {
  const colors: number[] = [];
  const seen = new Set<number>();
  const push = (c: number): void => {
    if (colors.length >= 256 || seen.has(c)) return;
    seen.add(c);
    colors.push(c);
  };
  for (let i = 0; i < palette.length; i++) push(palette[i] >>> 0);
  // 明暗と混色の余地を残すため、階調とグレーで埋める。
  for (let i = 0; i < 32 && colors.length < 256; i++) {
    const v = Math.round((i / 31) * 255);
    push(((v << 16) | (v << 8) | v) >>> 0);
  }
  const steps = [0, 51, 102, 153, 204, 255];
  outer: for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        if (colors.length >= 256) break outer;
        push(((r << 16) | (g << 8) | b) >>> 0);
      }
    }
  }
  while (colors.length < 256) colors.push(0);

  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    table[i * 3] = (colors[i] >>> 16) & 255;
    table[i * 3 + 1] = (colors[i] >>> 8) & 255;
    table[i * 3 + 2] = colors[i] & 255;
  }

  const lut = new Uint8Array(32768);
  for (let bin = 0; bin < 32768; bin++) {
    // 箱の代表点は下端ではなく中央にする。下端で比べると、たとえば白 (255) が
    // 248 として扱われ、テーブルに白があるのに手前の灰色へ寄ってしまう。
    const r = (((bin >> 10) & 31) << 3) | 4;
    const g = (((bin >> 5) & 31) << 3) | 4;
    const b = ((bin & 31) << 3) | 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = table[i * 3] - r;
      const dg = table[i * 3 + 1] - g;
      const db = table[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    lut[bin] = best;
  }
  return { table, lut };
}

/** LZW 圧縮（GIF のサブブロック形式で返す）。 */
function lzwEncode(data: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map<number, number>();

  const out: number[] = [];
  let block: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const flushBlock = (): void => {
    if (block.length === 0) return;
    out.push(block.length, ...block);
    block = [];
  };
  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block.push(bitBuffer & 255);
      bitBuffer >>= 8;
      bitCount -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  writeCode(clearCode);
  let prefix = data.length > 0 ? data[0] : -1;

  for (let i = 1; i < data.length; i++) {
    const k = data[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    writeCode(prefix);
    if (nextCode === 4096) {
      // 辞書が一杯になったら初期化を指示して作り直す。
      writeCode(clearCode);
      dict = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    } else {
      // 符号長の切り上げは、その長さで表せない番号を登録する直前に行う。
      if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++;
      dict.set(key, nextCode++);
    }
    prefix = k;
  }

  if (prefix >= 0) writeCode(prefix);
  writeCode(eoiCode);
  if (bitCount > 0) {
    block.push(bitBuffer & 255);
    if (block.length === 255) flushBlock();
  }
  flushBlock();
  return Uint8Array.from(out);
}
