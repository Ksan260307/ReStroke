/**
 * 描画命令を記録するだけの描画面。
 *
 * Node にはラスタライザが無いため、テストでは「実際に何色の点が置かれたか」ではなく
 * 「どの順序で・どんな筆致の命令が出たか」を検証する。描画順・筆幅・色・合成方法は
 * すべてここに残るので、描画層の振る舞いは実行環境に依存せず確かめられる。
 */

import { setSurfaceFactory } from '../../src/render/surface';
import type { Surface } from '../../src/render/surface';

export interface DrawCall {
  op: string;
  args: unknown[];
  /** その命令の時点で設定されていた描画状態 */
  state: {
    strokeStyle: string;
    fillStyle: string;
    lineWidth: number;
    globalAlpha: number;
    composite: string;
  };
}

export class RecordingContext {
  calls: DrawCall[] = [];
  strokeStyle = '#000';
  fillStyle = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  lineCap = 'butt';
  lineJoin = 'miter';
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';

  constructor(readonly surface: RecordingSurface) {}

  private push(op: string, ...args: unknown[]): void {
    this.calls.push({
      op,
      args,
      state: {
        strokeStyle: String(this.strokeStyle),
        fillStyle: String(this.fillStyle),
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        composite: this.globalCompositeOperation,
      },
    });
  }

  fillRect(...a: number[]): void { this.push('fillRect', ...a); }
  clearRect(...a: number[]): void { this.push('clearRect', ...a); }
  beginPath(): void { this.push('beginPath'); }

  /** 元画像を絵の具にするための模様。実体は不要で、識別できればよい。 */
  createPattern(image: Surface): { source: Surface; toString(): string } {
    return { source: image, toString: () => `pattern(${image.width}x${image.height})` };
  }
  moveTo(...a: number[]): void { this.push('moveTo', ...a); }
  lineTo(...a: number[]): void { this.push('lineTo', ...a); }
  stroke(): void { this.push('stroke'); }
  drawImage(img: unknown, ...a: number[]): void { this.push('drawImage', img, ...a); }

  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  /** 直近の描画命令だけを取り出して記録を空にする。 */
  drain(): DrawCall[] {
    const out = this.calls;
    this.calls = [];
    return out;
  }
}

export class RecordingSurface implements Surface {
  ctx: RecordingContext;
  constructor(public width: number, public height: number) {
    this.ctx = new RecordingContext(this);
  }
  getContext(): unknown {
    return this.ctx;
  }
  toBlob(cb: (b: Blob | null) => void): void {
    cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  }
}

export interface RecordingHandle {
  surfaces: RecordingSurface[];
  /** 最初に作られた面（描画本体） */
  main(): RecordingSurface;
  restore(): void;
}

/** 記録用の描画面へ差し替える。テストの最後に restore() を呼ぶこと。 */
export function installRecordingSurface(): RecordingHandle {
  const surfaces: RecordingSurface[] = [];
  setSurfaceFactory((w, h) => {
    const s = new RecordingSurface(w, h);
    surfaces.push(s);
    return s;
  });
  return {
    surfaces,
    main: () => surfaces[0],
    restore: () => setSurfaceFactory(null),
  };
}
