/**
 * 描画面の生成。
 *
 * 描画面の作り方を 1 か所にまとめ、差し替え可能にしてある。ブラウザでは
 * OffscreenCanvas（無ければ通常のキャンバス）を使うが、テストからは描画命令を
 * 記録するだけの実装を差し込める。描画そのものを検証するためではなく、
 * 「どの順序で・どんな筆致を出したか」を実行環境に依存せず確かめるため。
 */

export type Surface = {
  width: number;
  height: number;
  getContext(id: '2d', options?: unknown): unknown;
};

export type SurfaceFactory = (width: number, height: number) => Surface;

const browserFactory: SurfaceFactory = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height) as unknown as Surface;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c as unknown as Surface;
  }
  throw new Error('描画面を作成できる環境がありません');
};

let factory: SurfaceFactory = browserFactory;

export function setSurfaceFactory(next: SurfaceFactory | null): void {
  factory = next ?? browserFactory;
}

export function createSurface(width: number, height: number): Surface {
  return factory(width, height);
}
