/**
 * 前処理。
 *
 * 解析は縮小した作業画像の上で行う。元画像が 8000px あっても、輪郭や色領域の
 * 判定に必要な情報は 1000px 程度で十分に残るため、計算量を 1/60 以下に落とせる。
 * 出力の解像度は別に持つので、動画の見た目は縮小の影響を受けない。
 */

export const MAX_SOURCE_SIDE = 8192;

export interface WorkImage {
  width: number;
  height: number;
  /** RGBA 連続（元の画素） */
  rgba: Uint8ClampedArray;
  /** 平滑化した RGBA。色の分類はこちらを使う */
  smooth: Uint8ClampedArray;
  /** 輝度 0-255 */
  lum: Uint8Array;
}

export async function decodeImageFile(file: File): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(file);
  if (bitmap.width > MAX_SOURCE_SIDE || bitmap.height > MAX_SOURCE_SIDE) {
    bitmap.close();
    throw new Error(`画像が大きすぎます（上限 ${MAX_SOURCE_SIDE}×${MAX_SOURCE_SIDE}）`);
  }
  return bitmap;
}

export function fitSize(w: number, h: number, maxSide: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxSide) return { width: Math.max(2, w | 0), height: Math.max(2, h | 0) };
  const k = maxSide / long;
  return { width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)) };
}

export function toWorkImage(bitmap: ImageBitmap, maxSide: number): WorkImage {
  const { width, height } = fitSize(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画像を読み込めませんでした');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const lum = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  // 写真のような粒状の画像は、そのまま色分けすると微小な塊に砕けてしまう。
  // 分類用に平滑化した版を別に持ち、実際に塗る色は元の画素から拾う。
  const radius = Math.max(1, Math.round(Math.min(width, height) / 340));
  const smooth = blurRgba(rgba, width, height, radius);
  return { width, height, rgba, smooth, lum };
}

/** RGB を分離型ボックスぼかしでならす（アルファは触らない）。 */
export function blurRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  if (radius < 1) return out;
  const tmp = new Float32Array(w * h * 3);
  const win = radius * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let r = 0, g = 0, b = 0;
    for (let x = -radius; x <= radius; x++) {
      const p = (row + clampIdx(x, w)) * 4;
      r += src[p];
      g += src[p + 1];
      b += src[p + 2];
    }
    for (let x = 0; x < w; x++) {
      const t = (row + x) * 3;
      tmp[t] = r / win;
      tmp[t + 1] = g / win;
      tmp[t + 2] = b / win;
      const add = (row + clampIdx(x + radius + 1, w)) * 4;
      const sub = (row + clampIdx(x - radius, w)) * 4;
      r += src[add] - src[sub];
      g += src[add + 1] - src[sub + 1];
      b += src[add + 2] - src[sub + 2];
    }
  }

  for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let y = -radius; y <= radius; y++) {
      const t = (clampIdx(y, h) * w + x) * 3;
      r += tmp[t];
      g += tmp[t + 1];
      b += tmp[t + 2];
    }
    for (let y = 0; y < h; y++) {
      const p = (y * w + x) * 4;
      out[p] = r / win;
      out[p + 1] = g / win;
      out[p + 2] = b / win;
      const add = (clampIdx(y + radius + 1, h) * w + x) * 3;
      const sub = (clampIdx(y - radius, h) * w + x) * 3;
      r += tmp[add] - tmp[sub];
      g += tmp[add + 1] - tmp[sub + 1];
      b += tmp[add + 2] - tmp[sub + 2];
    }
  }
  return out;
}

/** 分離型ボックスぼかし。ガウシアンより粗いが、領域判定には十分で速い。 */
export function boxBlur(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius < 1) return src.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[row + clampIdx(x, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / win) | 0;
      sum += src[row + clampIdx(x + radius + 1, w)] - src[row + clampIdx(x - radius, w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clampIdx(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (sum / win) | 0;
      sum += tmp[clampIdx(y + radius + 1, h) * w + x] - tmp[clampIdx(y - radius, h) * w + x];
    }
  }
  return out;
}

const clampIdx = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);

export interface EdgeMap {
  width: number;
  height: number;
  /** 勾配の強さ 0-255 */
  mag: Uint8Array;
  /** 勾配方向（x,y 成分） */
  gx: Int16Array;
  gy: Int16Array;
  /** 線とみなす閾値 */
  threshold: number;
}

/** 輪郭抽出。線画の下敷きになる。 */
export function detectEdges(lum: Uint8Array, w: number, h: number, blurRadius = 1): EdgeMap {
  const src = blurRadius > 0 ? boxBlur(lum, w, h, blurRadius) : lum;
  const mag = new Uint8Array(w * h);
  const gx = new Int16Array(w * h);
  const gy = new Int16Array(w * h);
  const hist = new Int32Array(256);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = src[i - w - 1], b = src[i - w], c = src[i - w + 1];
      const d = src[i - 1], f = src[i + 1];
      const g = src[i + w - 1], j = src[i + w], k = src[i + w + 1];
      const sx = a + 2 * d + g - c - 2 * f - k;
      const sy = a + 2 * b + c - g - 2 * j - k;
      gx[i] = sx;
      gy[i] = sy;
      const m = Math.min(255, Math.hypot(sx, sy) >> 2);
      mag[i] = m;
      hist[m]++;
    }
  }

  // 上位 7% を線候補とする（画像ごとに線の量が違うので比率で決める）。
  const total = (w - 2) * (h - 2);
  const target = total * 0.07;
  let acc = 0;
  let threshold = 40;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= target) {
      threshold = Math.max(18, v);
      break;
    }
  }
  return { width: w, height: h, mag, gx, gy, threshold };
}

/** 画像の平均輝度と彩度。工程の割り当て基準に使う。 */
export function imageStats(img: WorkImage): { meanLum: number; meanSat: number } {
  const { rgba, lum } = img;
  let sl = 0;
  let ss = 0;
  const n = lum.length;
  const step = Math.max(1, Math.floor(n / 40000));
  let cnt = 0;
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    ss += mx === 0 ? 0 : (mx - mn) / mx;
    sl += lum[i];
    cnt++;
  }
  return { meanLum: sl / cnt, meanSat: (ss / cnt) * 255 };
}
