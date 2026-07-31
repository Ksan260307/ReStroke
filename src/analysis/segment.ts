/**
 * 領域分割。
 *
 * 同じ代表色でつながっている画素の塊を 1 つの「塗る範囲」とみなす。
 * 再帰を使わず、明示的なスタックと型付き配列で走査する（画像が大きいと再帰は
 * 呼び出し段数が深くなりすぎるため）。
 *
 * 各領域について、面積・外接矩形・重心に加えて二次モーメントを取る。ここから
 * 「その形をどの向きに筆を運べば自然か」（主軸）が決まる。
 */

export interface Region {
  id: number;
  /** 代表色番号 */
  color: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  /** 主軸の角度（ラジアン） */
  angle: number;
  /** 細長さ 0-1。1 に近いほど細長い */
  elongation: number;
  /** 画面端に接しているか（背景の手がかり） */
  touchesBorder: boolean;
  meanLum: number;
}

export interface Segmentation {
  width: number;
  height: number;
  /** 画素ごとの領域番号。-1 は微小領域 */
  labels: Int32Array;
  regions: Region[];
}

export function segment(
  index: Uint8Array,
  lum: Uint8Array,
  w: number,
  h: number,
  minArea: number,
): Segmentation {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const regions: Region[] = [];

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const color = index[start];
    const id = regions.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;

    let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, slum = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    let border = false;

    while (sp > 0) {
      const p = stack[--sp];
      const y = (p / w) | 0;
      const x = p - y * w;
      area++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      slum += lum[p];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;

      if (x > 0 && labels[p - 1] === -1 && index[p - 1] === color) {
        labels[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && labels[p + 1] === -1 && index[p + 1] === color) {
        labels[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && labels[p - w] === -1 && index[p - w] === color) {
        labels[p - w] = id;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && labels[p + w] === -1 && index[p + w] === color) {
        labels[p + w] = id;
        stack[sp++] = p + w;
      }
    }

    const cx = sx / area;
    const cy = sy / area;
    const mu20 = sxx / area - cx * cx;
    const mu02 = syy / area - cy * cy;
    const mu11 = sxy / area - cx * cy;
    const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    const common = Math.sqrt(Math.max(0, (mu20 - mu02) * (mu20 - mu02) + 4 * mu11 * mu11));
    const l1 = (mu20 + mu02 + common) / 2;
    const l2 = (mu20 + mu02 - common) / 2;
    const elongation = l1 > 1e-6 ? 1 - Math.max(0, l2) / l1 : 0;

    regions.push({
      id,
      color,
      area,
      minX,
      minY,
      maxX,
      maxY,
      cx,
      cy,
      angle,
      elongation,
      touchesBorder: border,
      meanLum: slum / area,
    });
  }

  // 微小領域はノイズとして塗りの対象から外す（細部工程で拾い直す）。
  if (minArea > 1) {
    const drop = new Uint8Array(regions.length);
    for (const r of regions) if (r.area < minArea) drop[r.id] = 1;
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (l >= 0 && drop[l]) labels[i] = -1;
    }
  }

  return { width: w, height: h, labels, regions };
}
