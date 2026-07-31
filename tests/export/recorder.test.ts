import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableFormats, recordVideo } from '../../src/export/recorder';
import type { TimelapseEngine } from '../../src/core/engine';

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globals.MediaRecorder;
  vi.restoreAllMocks();
});

describe('動画の書き出し', () => {
  it('対応していない環境では形式を 1 つも返さない', () => {
    expect(availableFormats()).toEqual([]);
  });

  it('対応していない環境では書き出しを断る', async () => {
    await expect(
      recordVideo({} as TimelapseEngine, {
        fps: 30,
        format: { id: 'x', label: 'x', mimeType: 'video/webm', extension: 'webm' },
        quality: 1,
      }),
    ).rejects.toThrow('対応していません');
  });

  it('環境が対応している形式だけを返す', () => {
    globals.MediaRecorder = {
      isTypeSupported: (t: string) => t.startsWith('video/webm'),
    };
    const formats = availableFormats();
    expect(formats.length).toBeGreaterThan(0);
    expect(formats.every((f) => f.mimeType.startsWith('video/webm'))).toBe(true);
    for (const f of formats) {
      expect(f.extension).toBe('webm');
      expect(f.label).toContain('WebM');
    }
  });

  it('同じ拡張子は 1 つに絞る', () => {
    globals.MediaRecorder = { isTypeSupported: () => true };
    const formats = availableFormats();
    const extensions = formats.map((f) => f.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
    // MP4 が使えるならそちらを優先する
    expect(formats[0].extension).toBe('mp4');
  });
});
