/**
 * Local neural TTS — Piper, free and fully offline.
 *
 * Row 6.2 recorded `{engine: local, active: web-speech, availableEngines:
 * [web-speech]}`: the app ADVERTISED a local engine while the only thing that
 * could actually speak was the browser's SpeechSynthesis. That is the same
 * advertised-but-unreachable failure the burn-down caught, so this module is
 * built to be honest by construction:
 *
 *   - `localTtsStatus()` reports `ready` only when a real binary AND a real
 *     model file are both on disk. Nothing is optimistic.
 *   - `availableEngines` in `src/platform/tts.ts` gains `piper` only when
 *     `ready` is true, so an absent engine is never listed.
 *   - `synthesizeLocal()` throws a specific, actionable error when it cannot
 *     run, and the engine ladder falls back to web-speech.
 *
 * Piper is chosen because it is a single ONNX model plus a single static
 * binary, works identically on Windows, Linux and macOS, needs no Python and no
 * GPU, and its voices are openly licensed.
 *
 * Channels:
 *   voice:ttsLocalStatus    — binary + model presence, blockers, install hint
 *   voice:ttsLocalSetup     — download the voice model (no privileges needed)
 *   voice:ttsLocalVoices    — voices installed locally, plus the installable set
 *   voice:ttsLocalStop      — interrupt an in-flight utterance
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import { execFile, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { downloadFile, fileLooksComplete } from './_download';

const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';

export const LOCAL_TTS_ENGINE_ID = 'piper';

const ENV = IS_WINDOWS
  ? { ...process.env, HOME, USERPROFILE: HOME }
  : {
      ...process.env,
      HOME,
      PATH: `/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${process.env.PATH || ''}`,
    };

/** Piper ships as `piper`; older builds used `piper-tts`. */
const BINARY_NAMES = ['piper', 'piper-tts'];
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';

const PROBED_NAMES = IS_WINDOWS ? BINARY_NAMES.map((n) => `${n}.exe`) : BINARY_NAMES;
const PROBED_DIRS = IS_WINDOWS
  ? [
      path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links'),
      path.join(LOCAL_APP_DATA, 'Programs', 'piper'),
      path.join(PROGRAM_FILES, 'piper'),
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, 'bin'),
    ]
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, 'bin'),
    ];
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

const INSTALL_HINTS: Record<string, string> = {
  darwin: 'brew install piper-tts',
  linux: 'pipx install piper-tts   (or download a release binary from github.com/rhasspy/piper)',
  win32: 'Download the piper release zip from github.com/rhasspy/piper/releases and put piper.exe on PATH',
};

export interface LocalVoice {
  /** Piper voice id, e.g. `en_US-amy-medium`. Doubles as the file stem. */
  id: string;
  language: string;
  /** Present only when the model is on disk. */
  installed: boolean;
  /** Approximate on-disk size in bytes; 0 when not installed. */
  sizeBytes: number;
}

export interface LocalTtsStatus {
  engine: typeof LOCAL_TTS_ENGINE_ID;
  binaryPresent: boolean;
  binaryPath: string | null;
  modelPresent: boolean;
  modelPath: string;
  /** True only when binary + model are both really there. */
  ready: boolean;
  blockers: string[];
  installHint: string;
}

/**
 * Resolve a voice id to its HuggingFace path.
 *
 * `rhasspy/piper-voices` is laid out `<family>/<locale>/<name>/<quality>/`,
 * so `en_US-amy-medium` lives at `en/en_US/amy/medium/…` — the family is the
 * part before the underscore, and dropping it 404s.
 */
function voiceUrl(id: string, ext: 'onnx' | 'onnx.json'): string {
  const parts = id.split('-');
  // `en_US-amy-medium` → locale `en_US`, name `amy`, quality `medium`.
  const quality = parts[parts.length - 1];
  const name = parts[parts.length - 2];
  const locale = parts.slice(0, parts.length - 2).join('-');
  const family = locale.split('_')[0];
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${family}/${locale}/${name}/${quality}/${id}.${ext}`;
}

/**
 * Voices offered in the picker.
 *
 * Only en_US/en_GB voices, and only ones that are openly licensed and
 * genuinely present in the Piper voice bank — a catalogue listing a voice
 * whose download 404s is worse than a short one.
 */
export const INSTALLABLE_VOICES: readonly LocalVoice[] = [
  { id: 'en_US-amy-medium', language: 'en-US', installed: false, sizeBytes: 0 },
  { id: 'en_US-lessac-medium', language: 'en-US', installed: false, sizeBytes: 0 },
  { id: 'en_US-ryan-high', language: 'en-US', installed: false, sizeBytes: 0 },
  { id: 'en_GB-alba-medium', language: 'en-GB', installed: false, sizeBytes: 0 },
];

export const DEFAULT_LOCAL_VOICE = 'en_US-amy-medium';

/** Smallest plausible ONNX voice — a medium model is tens of megabytes. */
const MIN_MODEL_BYTES = 5 * 1024 * 1024;

// ── Binary detection ────────────────────────────────────────────────────────

let cachedBinary: string | null | undefined; // undefined = not probed yet

export function detectPiperBinary(refresh = false): string | null {
  if (!refresh && cachedBinary !== undefined) return cachedBinary;
  cachedBinary = null;
  for (const name of PROBED_NAMES) {
    // Absolute locations first: a packaged app inherits a minimal PATH.
    for (const dir of PROBED_DIRS) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedBinary = candidate;
        return cachedBinary;
      } catch { /* keep looking */ }
    }
    try {
      const out = execFileSync(WHICH_CMD, [name], { encoding: 'utf8', env: ENV, timeout: 3000 }).trim();
      const found = out.split(/\r?\n/)[0]?.trim() || '';
      if (found) {
        cachedBinary = found;
        return cachedBinary;
      }
    } catch { /* not on PATH */ }
  }
  return cachedBinary;
}

// ── Model management ────────────────────────────────────────────────────────

export function localTtsModelDir(): string {
  return path.join(app.getPath('userData'), 'voice-models');
}

export function localTtsModelPath(voiceId = DEFAULT_LOCAL_VOICE): string {
  return path.join(localTtsModelDir(), `${voiceId}.onnx`);
}

/**
 * Piper needs the `.onnx` weights AND the `.onnx.json` config. Weights without
 * a config will not load at all, and a half-written config (an interrupted
 * download leaves one) is just as fatal — so the config is checked by parsing
 * it and confirming it carries the sample rate, not by file size.
 */
export function localTtsVoiceConfigPresent(voiceId = DEFAULT_LOCAL_VOICE): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(`${localTtsModelPath(voiceId)}.json`, 'utf8'));
    const audio = (parsed as { audio?: { sample_rate?: unknown } } | null)?.audio;
    return typeof audio?.sample_rate === 'number';
  } catch {
    return false;
  }
}

export function localTtsModelPresent(voiceId = DEFAULT_LOCAL_VOICE): boolean {
  return (
    fileLooksComplete(localTtsModelPath(voiceId), MIN_MODEL_BYTES) &&
    localTtsVoiceConfigPresent(voiceId)
  );
}

export function getLocalTtsStatus(
  voiceId = DEFAULT_LOCAL_VOICE,
  refresh = false,
): LocalTtsStatus {
  const binaryPath = detectPiperBinary(refresh);
  const modelPresent = localTtsModelPresent(voiceId);
  const blockers: string[] = [];
  if (!binaryPath) {
    blockers.push(`Piper is not installed — expected ${PROBED_NAMES.join(' or ')}.`);
  }
  if (!modelPresent) {
    blockers.push(`The voice model ${voiceId}.onnx is not downloaded to ${localTtsModelPath(voiceId)}.`);
  }
  return {
    engine: LOCAL_TTS_ENGINE_ID,
    binaryPresent: Boolean(binaryPath),
    binaryPath,
    modelPresent,
    modelPath: localTtsModelPath(voiceId),
    ready: Boolean(binaryPath) && modelPresent,
    blockers,
    installHint: INSTALL_HINTS[process.platform] ?? '',
  };
}

/** Every catalogue voice, annotated with what is actually installed. */
export function listLocalVoices(): LocalVoice[] {
  return INSTALLABLE_VOICES.map((v) => {
    if (!localTtsModelPresent(v.id)) return { ...v, installed: false, sizeBytes: 0 };
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(localTtsModelPath(v.id)).size;
    } catch { /* reported as installed by the presence check; size is cosmetic */ }
    return { ...v, installed: true, sizeBytes };
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

export interface LocalTtsSetupProgress {
  phase: 'model' | 'config';
  message: string;
  pct?: number;
  downloaded?: number;
  total?: number;
}

let setupInFlight: Promise<LocalTtsStatus> | null = null;

/**
 * Download a voice: the `.onnx` weights and the `.onnx.json` config.
 *
 * Like the whisper model this needs no privileges, so it is offered on its own
 * rather than hidden behind the binary install — the model is the half a user
 * can always get.
 */
export function setupLocalTtsVoice(
  voiceId = DEFAULT_LOCAL_VOICE,
  onProgress?: (p: LocalTtsSetupProgress) => void,
): Promise<LocalTtsStatus> {
  if (setupInFlight) return setupInFlight;
  const safeId = INSTALLABLE_VOICES.some((v) => v.id === voiceId) ? voiceId : DEFAULT_LOCAL_VOICE;

  setupInFlight = (async () => {
    const modelPath = localTtsModelPath(safeId);
    if (!fileLooksComplete(modelPath, MIN_MODEL_BYTES)) {
      onProgress?.({ phase: 'model', message: `Downloading voice ${safeId}…`, pct: 0 });
      await downloadFile(voiceUrl(safeId, 'onnx'), {
        dest: modelPath,
        minBytes: MIN_MODEL_BYTES,
        onProgress: (p) =>
          onProgress?.({
            phase: 'model',
            message: `Downloading voice ${safeId}…`,
            pct: p.pct,
            downloaded: p.downloaded,
            total: p.total,
          }),
      });
    }
    const configPath = `${modelPath}.json`;
    if (!fileLooksComplete(configPath, 64)) {
      onProgress?.({ phase: 'config', message: 'Downloading voice config…', pct: 0 });
      await downloadFile(voiceUrl(safeId, 'onnx.json'), { dest: configPath, minBytes: 64 });
    }
    onProgress?.({ phase: 'config', message: 'Voice ready.', pct: 100 });
    return getLocalTtsStatus(safeId, true);
  })().finally(() => {
    setupInFlight = null;
  });

  return setupInFlight;
}

// ── Synthesis ───────────────────────────────────────────────────────────────

let activePiper: ChildProcess | null = null;

/**
 * Piper's `--length_scale` is a duration multiplier: higher is slower. The UI
 * speaks in words-per-minute, so convert. 200 wpm ≈ neutral, which lands near
 * piper's natural pace at length_scale 1.
 */
export function lengthScaleForRate(rate: number): string {
  const r = Number.isFinite(rate) && rate >= 80 && rate <= 450 ? rate : 200;
  return (200 / r).toFixed(3);
}

/** Cap on the produced file, so a runaway child cannot exhaust memory. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * Synthesize `text` to WAV bytes, or reject with a message saying exactly what
 * is missing.
 *
 * Async so the refusal arrives as a rejection rather than a synchronous throw:
 * every caller reaches this through `await` inside the engine ladder, and a
 * sync throw there would escape the fallback and take the whole speak() call
 * down with it.
 */
export async function synthesizeLocal(
  text: string,
  options: { voice?: string; rate?: number } = {},
): Promise<Buffer> {
  const voiceId = options.voice || DEFAULT_LOCAL_VOICE;
  const status = getLocalTtsStatus(voiceId);
  if (!status.ready) {
    throw new Error(`Local neural voice unavailable: ${status.blockers.join(' ')}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-tts-'));
  const outPath = path.join(tmpDir, 'out.wav');

  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      activePiper = null;
    };

    // execFile rather than a shell: the text goes in on stdin, never on a
    // command line, so there is nothing here for a shell to reinterpret.
    const child = execFile(
      status.binaryPath as string,
      ['--model', status.modelPath, '--output_file', outPath, '--length_scale', lengthScaleForRate(options.rate ?? 200)],
      { env: ENV, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err) => {
        if (err) {
          cleanup();
          reject(new Error(`piper failed: ${(err.stderr?.toString() || err.message).slice(0, 300)}`));
          return;
        }
        try {
          const audio = fs.readFileSync(outPath);
          cleanup();
          if (audio.byteLength === 0) {
            reject(new Error('piper produced no audio.'));
            return;
          }
          if (audio.byteLength > MAX_AUDIO_BYTES) {
            cleanup();
            reject(new Error('piper produced implausibly large audio.'));
            return;
          }
          resolve(audio);
        } catch (e) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
    activePiper = child;

    child.stdin?.on('error', () => { /* child exited early; the callback reports it */ });
    child.stdin?.end(text, 'utf8');
  });
}

/** Interrupt an in-flight utterance. Returns false when nothing is speaking. */
export function stopLocalSpeech(): boolean {
  if (!activePiper) return false;
  try {
    activePiper.kill();
  } catch { /* already gone */ }
  activePiper = null;
  return true;
}

// ── IPC ─────────────────────────────────────────────────────────────────────

export function registerLocalTtsHandlers(): void {
  // The voice model is tens of megabytes, so progress has to reach the
  // renderer the way the STT model's does. Broadcast rather than take a
  // window getter: this is registered from the TTS wrapper, which has none.
  const sendProgress = (p: LocalTtsSetupProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('voice:ttsLocal:setup-progress', p);
    }
  };
  const envelope = <T>(fn: () => T | Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .then((result) => ({ ok: true as const, result }))
      .catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));

  ipcMain.handle('voice:ttsLocalStatus', (_e, opts?: { voice?: string; refresh?: boolean }) =>
    envelope(() => getLocalTtsStatus(opts?.voice, Boolean(opts?.refresh))),
  );

  ipcMain.handle('voice:ttsLocalVoices', () => envelope(() => listLocalVoices()));

  ipcMain.handle('voice:ttsLocalSetup', (_e, opts?: { voice?: string }) =>
    envelope(() => setupLocalTtsVoice(opts?.voice, sendProgress)),
  );

  ipcMain.handle('voice:ttsLocalStop', () => envelope(() => ({ stopped: stopLocalSpeech() })));
}