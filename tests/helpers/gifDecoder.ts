/**
 * 検証用の GIF 読み取り。
 *
 * 書き出した GIF を実際に復号して、フレーム数・表示時間・画素の並びを確かめる。
 * 符号化側とは独立に書いてあるので、両方が同じ勘違いをしていない限り誤りは出る。
 */

export interface DecodedFrame {
  delay: number;
  width: number;
  height: number;
  /** カラーテーブルの番号 */
  indices: Uint8Array;
  /** 0xRRGGBB */
  colors: Uint32Array;
}

export interface DecodedGif {
  width: number;
  height: number;
  loops: number;
  table: Uint8Array;
  frames: DecodedFrame[];
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let p = 0;
  const u8 = (): number => bytes[p++];
  const u16 = (): number => {
    const v = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return v;
  };
  const ascii = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[p++]);
    return s;
  };

  if (ascii(6) !== 'GIF89a') throw new Error('GIF89a の署名がありません');
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // 背景色
  u8(); // 縦横比
  if (!(packed & 0x80)) throw new Error('全体カラーテーブルがありません');
  const tableSize = 2 << (packed & 7);
  const table = bytes.subarray(p, p + tableSize * 3);
  p += tableSize * 3;

  const readBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = u8();
      if (n === 0) break;
      parts.push(bytes.subarray(p, p + n));
      total += n;
      p += n;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const part of parts) {
      out.set(part, o);
      o += part.length;
    }
    return out;
  };

  const frames: DecodedFrame[] = [];
  let loops = -1;
  let pendingDelay = 0;

  for (;;) {
    const sep = u8();
    if (sep === 0x3b || p > bytes.length) break;
    if (sep === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const size = u8();
        const start = p;
        u8(); // 制御フラグ
        pendingDelay = u16();
        p = start + size;
        u8(); // 終端
      } else if (label === 0xff) {
        const size = u8();
        const name = ascii(size);
        const data = readBlocks();
        if (name === 'NETSCAPE2.0') loops = data[1] | (data[2] << 8);
      } else {
        u8();
        readBlocks();
      }
      continue;
    }
    if (sep !== 0x2c) throw new Error(`未知のブロック 0x${sep.toString(16)}`);

    u16(); // left
    u16(); // top
    const fw = u16();
    const fh = u16();
    const local = u8();
    if (local & 0x80) throw new Error('局所カラーテーブルは想定していません');
    const minCodeSize = u8();
    const data = readBlocks();
    const indices = lzwDecode(data, minCodeSize, fw * fh);
    const colors = new Uint32Array(fw * fh);
    for (let i = 0; i < indices.length; i++) {
      const t = indices[i] * 3;
      colors[i] = ((table[t] << 16) | (table[t + 1] << 8) | table[t + 2]) >>> 0;
    }
    frames.push({ delay: pendingDelay, width: fw, height: fh, indices, colors });
  }

  return { width, height, loops, table, frames };
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(pixels);
  const prefix = new Int32Array(4096);
  const suffix = new Int32Array(4096);
  const first = new Int32Array(4096);
  const stack = new Int32Array(4096);

  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }

  let bitPos = 0;
  let written = 0;
  let prev = -1;

  const readCode = (): number => {
    let v = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return eoi;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };

  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    let cur = code;
    let sp = 0;
    if (code === next && prev >= 0) {
      stack[sp++] = first[prev];
      cur = prev;
    } else if (code > next) {
      throw new Error(`不正な符号 ${code}（次は ${next}）`);
    }
    while (cur >= clear) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    const head = suffix[cur];
    stack[sp++] = head;
    while (sp > 0) {
      const v = stack[--sp];
      if (written < out.length) out[written++] = v;
    }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = head;
      first[next] = first[prev];
      next++;
      if (next >= 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }

  if (written !== pixels) throw new Error(`画素数が合いません（${written} / ${pixels}）`);
  return out;
}
