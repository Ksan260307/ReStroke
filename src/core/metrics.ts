/**
 * 計測。
 *
 * ここで取る値は **表示側の調整にしか使わない**。フレーム時間や実時刻をもとに
 * シミュレーションの中身を変えると、同じ入力から違う動画が出てしまう。
 * 計測が影響してよいのは「画面へ何回転送するか」までで、描かれる絵は変えない。
 */

export class FrameMetrics {
  private samples = new Float32Array(30);
  private cursor = 0;
  private filled = 0;
  private last = 0;

  /** 直近フレームの所要時間(ms) */
  frameMs = 16.7;
  /** 表示の間引き段階。0 = 毎フレーム転送 */
  presentSkip = 0;

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.last = 0;
    this.frameMs = 16.7;
    this.presentSkip = 0;
  }

  sample(now: number): void {
    if (this.last > 0) {
      const dt = now - this.last;
      if (dt > 0 && dt < 1000) {
        this.samples[this.cursor] = dt;
        this.cursor = (this.cursor + 1) % this.samples.length;
        if (this.filled < this.samples.length) this.filled++;
      }
    }
    this.last = now;

    if (this.filled >= 8) {
      let sum = 0;
      for (let i = 0; i < this.filled; i++) sum += this.samples[i];
      this.frameMs = sum / this.filled;
      // 重いときは画面転送だけ間引く（描画内容は変えない）
      if (this.frameMs > 40) this.presentSkip = 2;
      else if (this.frameMs > 26) this.presentSkip = 1;
      else this.presentSkip = 0;
    }
  }

  get fps(): number {
    return this.frameMs > 0 ? 1000 / this.frameMs : 0;
  }
}
