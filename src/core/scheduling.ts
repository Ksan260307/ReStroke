/**
 * 重い処理の途中で画面へ制御を返すための待機。
 *
 * 描画フレームに合わせる待ち方（requestAnimationFrame）は、タブが背面にあると
 * 呼ばれなくなる。解析や書き出しは表示されていなくても進む必要があるため、
 * フレームではなくタスクキューを使って待つ。
 */

let channel: MessageChannel | null = null;
let pending: (() => void)[] = [];

function ensureChannel(): MessageChannel | null {
  if (channel) return channel;
  if (typeof MessageChannel === 'undefined') return null;
  channel = new MessageChannel();
  // ブラウザ以外（テスト実行時など）で、この待機口だけが理由でプロセスが
  // 終われなくなるのを避ける。
  (channel.port1 as { unref?: () => void }).unref?.();
  (channel.port2 as { unref?: () => void }).unref?.();
  channel.port1.onmessage = () => {
    const queue = pending;
    pending = [];
    for (const fn of queue) fn();
  };
  return channel;
}

/** 次のタスクまで待つ（表示状態に依存しない）。 */
export function yieldToUI(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ch = ensureChannel();
    if (!ch) {
      setTimeout(resolve, 0);
      return;
    }
    pending.push(resolve);
    ch.port2.postMessage(0);
  });
}

/** 指定時刻まで待つ。 */
export function waitUntil(target: number): Promise<void> {
  const remain = target - performance.now();
  if (remain <= 0) return yieldToUI();
  return new Promise<void>((resolve) => setTimeout(resolve, remain));
}
