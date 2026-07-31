/**
 * 画面まわり。
 *
 * ここは入力を集めて生成を呼び、結果を表示するだけに徹する。解析・生成・再生の
 * 中身は core / analysis / strokes / render に置いてある。
 */

import './style.css';
import { analyze } from './analysis/pipeline';
import { decodeImageFile } from './analysis/image';
import { STYLES, styleById } from './strokes/styles';
import { TimelapseEngine } from './core/engine';
import { FrameMetrics } from './core/metrics';
import { STAGE_LABELS, baseIdentity, hexColor } from './core/schema';
import { checkReplayable, parseLog, serializeLog } from './core/history';
import { formatSeed, resolveSeed } from './core/rng';
import { availableFormats, recordGif, recordVideo } from './export/recorder';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: ${id}`);
  return el as T;
};

const ui = {
  dropzone: $<HTMLDivElement>('dropzone'),
  fileInput: $<HTMLInputElement>('file-input'),
  preview: $<HTMLImageElement>('preview'),
  sourceFacts: $<HTMLElement>('source-facts'),
  factName: $<HTMLElement>('fact-name'),
  factSize: $<HTMLElement>('fact-size'),
  styleList: $<HTMLDivElement>('style-list'),
  lengthList: $<HTMLDivElement>('length-list'),
  lengthCustom: $<HTMLInputElement>('length-custom'),
  fps: $<HTMLSelectElement>('fps-select'),
  size: $<HTMLSelectElement>('size-select'),
  detail: $<HTMLSelectElement>('detail-select'),
  seed: $<HTMLInputElement>('seed-input'),
  generate: $<HTMLButtonElement>('generate'),
  analysisProgress: $<HTMLDivElement>('analysis-progress'),
  analysisBar: $<HTMLElement>('analysis-bar'),
  analysisLabel: $<HTMLElement>('analysis-label'),
  error: $<HTMLParagraphElement>('error'),
  result: $<HTMLElement>('panel-result'),
  stage: $<HTMLCanvasElement>('stage'),
  play: $<HTMLButtonElement>('play'),
  playIcon: document.getElementById('play-icon') as unknown as SVGPathElement,
  restart: $<HTMLButtonElement>('restart'),
  scrub: $<HTMLInputElement>('scrub'),
  time: $<HTMLElement>('time'),
  speed: $<HTMLSelectElement>('speed'),
  stageTrack: $<HTMLDivElement>('stage-track'),
  layerList: $<HTMLUListElement>('layer-list'),
  stats: $<HTMLElement>('stats'),
  format: $<HTMLSelectElement>('format-select'),
  exportBtn: $<HTMLButtonElement>('export-btn'),
  exportCancel: $<HTMLButtonElement>('export-cancel'),
  exportProgress: $<HTMLDivElement>('export-progress'),
  exportBar: $<HTMLElement>('export-bar'),
  exportLabel: $<HTMLElement>('export-label'),
  exportNote: $<HTMLElement>('export-note'),
  saveFrame: $<HTMLButtonElement>('save-frame'),
  saveLog: $<HTMLButtonElement>('save-log'),
  loadLog: $<HTMLButtonElement>('load-log'),
  logInput: $<HTMLInputElement>('log-input'),
};

const PLAY_PATH = 'M8 5.5v13l11-6.5z';
const PAUSE_PATH = 'M8 5h3.2v14H8zm5 0h3.2v14H13z';
const LENGTHS = [10, 30, 60];
const GIF_FORMAT = '__gif__';
/** 内部の時間刻み（1 秒あたり） */
const TICK_RATE = 60;
/** 現在の規則の版。工程データの照合に使う */
const CURRENT_IDENTITY = baseIdentity('');
/** GIF は色数と容量の制約が強いので控えめに落とす */
const GIF_FPS = 12;
const GIF_MAX_SIDE = 480;

interface AppState {
  bitmap: ImageBitmap | null;
  fileName: string;
  styleId: string;
  duration: number;
  engine: TimelapseEngine | null;
  playing: boolean;
  busy: boolean;
  visibility: Uint8Array | null;
}

const state: AppState = {
  bitmap: null,
  fileName: '',
  styleId: 'professional',
  duration: 30,
  engine: null,
  playing: false,
  busy: false,
  visibility: null,
};

const metrics = new FrameMetrics();
const stageCtx = ui.stage.getContext('2d', { alpha: false })!;

/* ---------------- 入力 ---------------- */

function buildStyleList(): void {
  ui.styleList.innerHTML = '';
  for (const s of STYLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-btn';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(s.id === state.styleId));
    btn.innerHTML = `<b></b><span></span>`;
    btn.querySelector('b')!.textContent = s.name;
    btn.querySelector('span')!.textContent = s.summary;
    btn.addEventListener('click', () => {
      state.styleId = s.id;
      buildStyleList();
    });
    ui.styleList.appendChild(btn);
  }
}

function buildLengthList(): void {
  ui.lengthList.innerHTML = '';
  for (const sec of LENGTHS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.textContent = `${sec} 秒`;
    btn.setAttribute('aria-checked', String(state.duration === sec));
    btn.addEventListener('click', () => {
      state.duration = sec;
      ui.lengthCustom.value = String(sec);
      buildLengthList();
    });
    ui.lengthList.appendChild(btn);
  }
}

ui.lengthCustom.addEventListener('input', () => {
  const v = Number(ui.lengthCustom.value);
  if (Number.isFinite(v) && v >= 3 && v <= 600) {
    state.duration = v;
    buildLengthList();
  }
});

ui.dropzone.addEventListener('click', () => ui.fileInput.click());
ui.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    ui.fileInput.click();
  }
});
ui.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  ui.dropzone.classList.add('over');
});
ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('over'));
ui.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.dropzone.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  if (file) void loadFile(file);
});

async function loadFile(file: File): Promise<void> {
  clearError();
  if (!file.type.startsWith('image/')) {
    showError('画像ファイルを選んでください');
    return;
  }
  try {
    const bitmap = await decodeImageFile(file);
    state.bitmap?.close();
    state.bitmap = bitmap;
    state.fileName = file.name;

    ui.preview.src = URL.createObjectURL(file);
    ui.preview.hidden = false;
    ui.dropzone.classList.add('has-image');
    ui.sourceFacts.hidden = false;
    ui.factName.textContent = file.name;
    ui.factSize.textContent = `${bitmap.width} × ${bitmap.height} px / ${formatBytes(file.size)}`;
    ui.generate.disabled = false;
  } catch (err) {
    showError(err instanceof Error ? err.message : '画像を読み込めませんでした');
  }
}

/* ---------------- 生成 ---------------- */

ui.generate.addEventListener('click', () => void generate());

async function generate(): Promise<void> {
  if (!state.bitmap || state.busy) return;
  state.busy = true;
  state.playing = false;
  clearError();
  ui.generate.disabled = true;
  ui.analysisProgress.hidden = false;
  setProgress(ui.analysisBar, 0);

  try {
    const style = styleById(state.styleId);
    const seed = resolveSeed(ui.seed.value);
    const outputSide = Number(ui.size.value);
    const analysisSide = Math.min(1152, outputSide);
    const maxStrokes = Number(ui.detail.value);

    const result = await analyze(state.bitmap, {
      style,
      seed,
      analysisSide,
      maxStrokes,
      onProgress: (phase, ratio) => {
        ui.analysisLabel.textContent = phase;
        setProgress(ui.analysisBar, ratio);
      },
    });

    const renderScale = outputSide / Math.max(result.plan.width, result.plan.height);
    state.engine = new TimelapseEngine({
      plan: result.plan,
      style,
      durationSec: state.duration,
      // 内部の時間刻みは出力 fps と切り離しておく。30fps 書き出しでも
      // 1 フレームぶんの筆運びは 2 刻み分として計算され、動きが粗くならない。
      tickRate: TICK_RATE,
      seed,
      renderScale,
      checkpoints: 8,
      sourceName: state.fileName,
      // 工程の終わりで元画像へ寄せるため、元画像そのものを渡す
      source: state.bitmap,
    });
    state.visibility = null;

    ui.stage.width = state.engine.painter.width;
    ui.stage.height = state.engine.painter.height;
    state.engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);

    buildStageTrack();
    buildLayerList();
    buildStats(result.stats, renderScale);
    buildFormatList();

    ui.result.hidden = false;
    ui.scrub.value = '0';
    updateTransport();
    setPlaying(true);
    ui.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err instanceof Error ? err.message : '生成に失敗しました');
  } finally {
    state.busy = false;
    ui.generate.disabled = false;
    ui.analysisProgress.hidden = true;
  }
}

/* ---------------- 表示 ---------------- */

function buildStageTrack(): void {
  const engine = state.engine;
  if (!engine) return;
  ui.stageTrack.innerHTML = '';
  for (const r of engine.stageRanges()) {
    const seg = document.createElement('div');
    seg.className = 'stage-seg';
    seg.dataset.stage = String(r.stage);
    seg.style.flexGrow = String(r.end - r.start);
    seg.textContent = STAGE_LABELS[r.stage] ?? '';
    seg.title = `${STAGE_LABELS[r.stage]}：${((r.end - r.start) / engine.params.tickRate).toFixed(1)} 秒`;
    ui.stageTrack.appendChild(seg);
  }
}

function buildLayerList(): void {
  const engine = state.engine;
  if (!engine) return;
  ui.layerList.innerHTML = '';
  const layers = engine.plan.layers;
  const maxId = layers.reduce((m, l) => Math.max(m, l.id), 0);

  for (const layer of layers) {
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.id = `layer-${layer.id}`;
    cb.addEventListener('change', () => {
      const vis = state.visibility ?? new Uint8Array(maxId + 1).fill(1);
      vis[layer.id] = cb.checked ? 1 : 0;
      state.visibility = vis;
      engine.setVisibility(vis);
      engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
    });

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = hexColor(layer.color);

    const name = document.createElement('label');
    name.className = 'layer-name';
    name.htmlFor = cb.id;
    name.textContent = layer.name;

    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = layer.strokeCount.toLocaleString('ja-JP');

    li.append(cb, sw, name, count);
    ui.layerList.appendChild(li);
  }
}

function buildStats(
  stats: { regionCount: number; lineCount: number; strokeCount: number; paletteSize: number; coarsened: boolean; elapsedMs: number },
  renderScale: number,
): void {
  const engine = state.engine!;
  const rows: [string, string][] = [
    ['ストローク', `${stats.strokeCount.toLocaleString('ja-JP')} 本`],
    ['色領域', `${stats.regionCount.toLocaleString('ja-JP')} 個`],
    ['代表色', `${stats.paletteSize} 色`],
    ['線', `${stats.lineCount.toLocaleString('ja-JP')} 本`],
    ['レイヤー', `${engine.plan.layers.length} 枚`],
    ['出力', `${engine.painter.width} × ${engine.painter.height} px（×${renderScale.toFixed(2)}）`],
    ['解析時間', `${(stats.elapsedMs / 1000).toFixed(2)} 秒`],
  ];
  if (stats.coarsened) rows.push(['調整', '本数の上限に合わせて筆を太くしました']);

  ui.stats.innerHTML = '';
  for (const [k, v] of rows) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    wrap.append(dt, dd);
    ui.stats.appendChild(wrap);
  }
}

function buildFormatList(): void {
  ui.format.innerHTML = '';
  for (const f of availableFormats()) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.label}（動画）`;
    ui.format.appendChild(opt);
  }
  const gif = document.createElement('option');
  gif.value = GIF_FORMAT;
  gif.textContent = 'GIF（軽量・256 色）';
  ui.format.appendChild(gif);
  updateExportNote();
}

ui.format.addEventListener('change', updateExportNote);

function updateExportNote(): void {
  ui.exportNote.textContent =
    ui.format.value === GIF_FORMAT
      ? `GIF は 256 色・${GIF_FPS}fps・長辺 ${GIF_MAX_SIDE}px に落として書き出します。再生時間ぶんの待ち時間はありません。`
      : '動画は再生しながら記録するため、指定した長さと同じだけ時間がかかります。';
}

/* ---------------- 再生 ---------------- */

function setPlaying(on: boolean): void {
  const engine = state.engine;
  if (!engine) return;
  if (on && engine.finished) engine.advanceTo(0);
  state.playing = on;
  ui.playIcon?.setAttribute('d', on ? PAUSE_PATH : PLAY_PATH);
}

ui.play.addEventListener('click', () => setPlaying(!state.playing));
ui.restart.addEventListener('click', () => {
  const engine = state.engine;
  if (!engine) return;
  engine.advanceTo(0);
  engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
  updateTransport();
  setPlaying(true);
});

ui.scrub.addEventListener('input', () => {
  const engine = state.engine;
  if (!engine || state.busy) return;
  setPlaying(false);
  const target = Math.round((Number(ui.scrub.value) / 1000) * engine.totalTicks);
  engine.advanceTo(target);
  engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
  updateTransport(true);
});

let lastTime = 0;
let tickAccumulator = 0;
let presentCounter = 0;

function loop(now: number): void {
  requestAnimationFrame(loop);
  metrics.sample(now);
  const engine = state.engine;
  if (!engine || ui.result.hidden) {
    lastTime = now;
    return;
  }

  if (state.playing && !state.busy) {
    const dt = Math.min(0.25, (now - lastTime) / 1000);
    const speed = Number(ui.speed.value) || 1;
    tickAccumulator += dt * speed * engine.params.tickRate;
    const steps = Math.floor(tickAccumulator);
    if (steps > 0) {
      tickAccumulator -= steps;
      engine.advance(steps);
      // 画面への転送は重いときだけ間引く。描かれる内容は変わらない。
      if (presentCounter++ % (metrics.presentSkip + 1) === 0 || engine.finished) {
        engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
      }
      updateTransport();
      if (engine.finished) setPlaying(false);
    }
  }
  lastTime = now;
}

function updateTransport(skipScrub = false): void {
  const engine = state.engine;
  if (!engine) return;
  const rate = engine.params.tickRate;
  if (!skipScrub) {
    ui.scrub.value = String(Math.round((engine.tick / Math.max(1, engine.totalTicks)) * 1000));
  }
  ui.time.textContent = `${(engine.tick / rate).toFixed(1)} / ${(engine.totalTicks / rate).toFixed(1)}s`;

  const current = engine.stage;
  for (const el of Array.from(ui.stageTrack.children) as HTMLElement[]) {
    const s = Number(el.dataset.stage);
    el.classList.toggle('active', s === current);
    el.classList.toggle('done', s < current);
  }
}

requestAnimationFrame(loop);

/* ---------------- 書き出し ---------------- */

let exportSignal = { cancelled: false };

ui.exportCancel.addEventListener('click', () => {
  exportSignal.cancelled = true;
});

ui.exportBtn.addEventListener('click', () => void runExport());

async function runExport(): Promise<void> {
  const engine = state.engine;
  if (!engine || state.busy) return;
  setPlaying(false);
  state.busy = true;
  exportSignal = { cancelled: false };
  ui.exportBtn.disabled = true;
  ui.exportCancel.hidden = false;
  ui.exportProgress.hidden = false;
  setProgress(ui.exportBar, 0);
  clearError();

  const fps = Number(ui.fps.value);
  const base = `restroke-${state.fileName.replace(/\.[^.]+$/, '') || 'timelapse'}-${state.styleId}`;

  try {
    if (ui.format.value === GIF_FORMAT) {
      ui.exportLabel.textContent = 'GIF を書き出しています…';
      const blob = await recordGif(engine, {
        fps: GIF_FPS,
        maxSide: GIF_MAX_SIDE,
        signal: exportSignal,
        onProgress: (r) => {
          setProgress(ui.exportBar, r);
          ui.exportLabel.textContent = `GIF を書き出しています… ${Math.round(r * 100)}%`;
        },
      });
      if (!exportSignal.cancelled) download(blob, `${base}.gif`);
    } else {
      const format = availableFormats().find((f) => f.id === ui.format.value);
      if (!format) throw new Error('この環境では動画を書き出せません');
      const blob = await recordVideo(engine, {
        fps,
        format,
        quality: 1,
        signal: exportSignal,
        onProgress: (r) => {
          setProgress(ui.exportBar, r);
          const remain = Math.max(0, (1 - r) * (engine.totalTicks / engine.params.tickRate));
          ui.exportLabel.textContent = `記録中… ${Math.round(r * 100)}%（残り約 ${remain.toFixed(0)} 秒）`;
        },
      });
      if (!exportSignal.cancelled) download(blob, `${base}.${format.extension}`);
    }
    ui.exportLabel.textContent = exportSignal.cancelled ? '中止しました' : '完了しました';
  } catch (err) {
    showError(err instanceof Error ? err.message : '書き出しに失敗しました');
    ui.exportLabel.textContent = '失敗しました';
  } finally {
    state.busy = false;
    ui.exportBtn.disabled = false;
    ui.exportCancel.hidden = true;
    engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
    updateTransport();
  }
}

ui.saveFrame.addEventListener('click', () => void saveFrame());

async function saveFrame(): Promise<void> {
  const engine = state.engine;
  if (!engine || state.busy) return;
  setPlaying(false);
  engine.advanceTo(engine.totalTicks);
  engine.painter.present(stageCtx, ui.stage.width, ui.stage.height);
  updateTransport();
  const blob = await engine.painter.toBlob('image/png');
  download(blob, `restroke-${state.fileName.replace(/\.[^.]+$/, '') || 'frame'}.png`);
}

ui.saveLog.addEventListener('click', () => {
  const engine = state.engine;
  if (!engine) return;
  const blob = new Blob([serializeLog(engine.log)], { type: 'application/json' });
  download(blob, `restroke-${state.styleId}-log.json`);
});

ui.loadLog.addEventListener('click', () => ui.logInput.click());
ui.logInput.addEventListener('change', () => {
  const file = ui.logInput.files?.[0];
  if (file) void loadLog(file);
  ui.logInput.value = '';
});

/**
 * 工程データを読み込んで設定を復元する。
 *
 * 絵そのものは入っていないので、同じ画像を入れ直して生成し直すと同じ結果になる。
 * 記録した規則の版が現在と違う場合は、同じ結果にならないため読み込みを断る。
 */
async function loadLog(file: File): Promise<void> {
  clearError();
  try {
    const log = parseLog(await file.text());
    const check = checkReplayable(
      { ...log.identity, params: CURRENT_IDENTITY.params },
      CURRENT_IDENTITY,
    );
    if (!check.ok) {
      throw new Error(`この工程データは再現できません（${check.reason}）`);
    }

    const [styleId, , analysisSide, maxStrokes] = log.identity.params.split(':');
    if (STYLES.some((s) => s.id === styleId)) {
      state.styleId = styleId;
      buildStyleList();
    }
    const duration = Math.round(log.totalTicks / (log.tickRate || TICK_RATE));
    if (duration >= 3 && duration <= 600) {
      state.duration = duration;
      ui.lengthCustom.value = String(duration);
      buildLengthList();
    }
    if ([...ui.size.options].some((o) => o.value === analysisSide)) ui.size.value = analysisSide;
    if ([...ui.detail.options].some((o) => o.value === maxStrokes)) ui.detail.value = maxStrokes;
    ui.seed.value = formatSeed(log.seed);

    ui.analysisLabel.textContent = `設定を復元しました（${log.meta?.sourceName || '不明な画像'}）。同じ画像を読み込んで生成してください。`;
    ui.analysisProgress.hidden = false;
    setProgress(ui.analysisBar, 1);
  } catch (err) {
    showError(err instanceof Error ? err.message : '工程データを読み込めませんでした');
  }
}

/* ---------------- 補助 ---------------- */

function setProgress(bar: HTMLElement, ratio: number): void {
  bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = false;
}

function clearError(): void {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

buildStyleList();
buildLengthList();
