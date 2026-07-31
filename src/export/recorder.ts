/**
 * 動画の書き出し。
 *
 * 1 フレームずつ状態を進めて描き、そのつどキャンバスの内容を録画ストリームへ渡す。
 * フレームの内容は tick 番号だけで決まるので、何度書き出しても同じ映像になる。
 */

import type { TimelapseEngine } from '../core/engine';
import { GifWriter } from './gif';
import { waitUntil, yieldToUI } from '../core/scheduling';

export interface RecordFormat {
  id: string;
  label: string;
  mimeType: string;
  extension: string;
}

const CANDIDATES: RecordFormat[] = [
  { id: 'mp4', label: 'MP4', mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { id: 'mp4-plain', label: 'MP4', mimeType: 'video/mp4', extension: 'mp4' },
  { id: 'webm-vp9', label: 'WebM (VP9)', mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { id: 'webm-vp8', label: 'WebM (VP8)', mimeType: 'video/webm;codecs=vp8', extension: 'webm' },
  { id: 'webm', label: 'WebM', mimeType: 'video/webm', extension: 'webm' },
];

/** この環境で使える動画形式を返す（同じ拡張子は 1 つに絞る）。 */
export function availableFormats(): RecordFormat[] {
  if (typeof MediaRecorder === 'undefined') return [];
  const seen = new Set<string>();
  const out: RecordFormat[] = [];
  for (const f of CANDIDATES) {
    if (seen.has(f.extension)) continue;
    if (MediaRecorder.isTypeSupported(f.mimeType)) {
      seen.add(f.extension);
      out.push(f);
    }
  }
  return out;
}

export interface RecordOptions {
  fps: number;
  format: RecordFormat;
  /** 出力の長辺（px）。省略時は描画解像度のまま */
  maxSide?: number;
  quality: number;
  onProgress?: (ratio: number) => void;
  signal?: { cancelled: boolean };
}

export async function recordVideo(
  engine: TimelapseEngine,
  options: RecordOptions,
): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('この環境では動画の書き出しに対応していません');
  }

  const srcW = engine.painter.width;
  const srcH = engine.painter.height;
  const scale = options.maxSide ? Math.min(1, options.maxSide / Math.max(srcW, srcH)) : 1;
  // 動画コーデックの都合で偶数に揃える。
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('書き出し用のキャンバスを用意できませんでした');

  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const manual = typeof track.requestFrame === 'function';

  const bitrate = Math.round(w * h * options.fps * 0.11 * options.quality);
  const recorder = new MediaRecorder(stream, {
    mimeType: options.format.mimeType,
    videoBitsPerSecond: Math.max(1_000_000, Math.min(bitrate, 40_000_000)),
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('録画中にエラーが発生しました'));
  });

  const totalTicks = engine.totalTicks;
  const ticksPerFrame = engine.params.tickRate / options.fps;
  const frames = Math.max(1, Math.round(totalTicks / ticksPerFrame));

  engine.dropCache();
  engine.rewind();
  engine.painter.present(ctx, w, h);

  recorder.start();
  const startedAt = performance.now();

  try {
    for (let f = 0; f <= frames; f++) {
      if (options.signal?.cancelled) break;
      engine.advanceTo(Math.min(totalTicks, Math.round(f * ticksPerFrame)));
      engine.painter.present(ctx, w, h);
      if (manual) track.requestFrame?.();
      options.onProgress?.(f / frames);
      // 映像の再生時間は実時間で決まるため、フレーム間隔を実時間に合わせる。
      const target = startedAt + ((f + 1) * 1000) / options.fps;
      await waitUntil(target);
    }
  } finally {
    // 最後のフレームが確実に含まれるよう、少し待ってから止める。
    await waitUntil(performance.now() + 120);
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  }

  await done;
  return new Blob(chunks, { type: options.format.mimeType.split(';')[0] });
}

interface CanvasCaptureMediaStreamTrack extends MediaStreamTrack {
  requestFrame?: () => void;
}

export interface GifExportOptions {
  fps: number;
  maxSide: number;
  onProgress?: (ratio: number) => void;
  signal?: { cancelled: boolean };
}

/**
 * GIF の書き出し。
 *
 * 録画と違い実時間で待つ必要がないため、計算が終わり次第どんどん進める。
 * ただし色数と解像度の制約が強いので、長辺と fps は控えめに設定する。
 */
export async function recordGif(engine: TimelapseEngine, options: GifExportOptions): Promise<Blob> {
  const srcW = engine.painter.width;
  const srcH = engine.painter.height;
  const scale = Math.min(1, options.maxSide / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));

  const writer = new GifWriter({
    width: w,
    height: h,
    delay: Math.max(2, Math.round(100 / options.fps)),
    palette: engine.plan.palette,
  });

  const totalTicks = engine.totalTicks;
  const ticksPerFrame = engine.params.tickRate / options.fps;
  const frames = Math.max(1, Math.round(totalTicks / ticksPerFrame));

  engine.dropCache();
  engine.rewind();

  for (let f = 0; f <= frames; f++) {
    if (options.signal?.cancelled) break;
    engine.advanceTo(Math.min(totalTicks, Math.round(f * ticksPerFrame)));
    writer.addFrame(engine.painter.readScaled(w, h).data);
    options.onProgress?.(f / frames);
    if (f % 4 === 0) await yieldToUI();
  }
  return writer.finish();
}
