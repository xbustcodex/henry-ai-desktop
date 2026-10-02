/**
 * Voice STT — whisper.cpp speech-to-text. FREE, fully local, works offline.
 *
 * Channels (uniform `{ ok, result | error }` envelope, matching machines/ipc.ts):
 *   voice:sttStatus  — whisper binary + model presence (binary detection cached)
 *   voice:sttSetup   — one-time setup: install whisper-cpp with the host
 *                      platform's package manager (brew / apt / winget) if the
 *                      binary is missing, then download the ggml-base.en model
 *                      (~148 MB). Progress streams to the renderer on
 *                      'voice:stt:setup-progress'.
 *   voice:transcribe — audio bytes (webm/opus from MediaRecorder) → temp file →
 *                      ffmpeg 16 kHz mono wav → whisper-cli → { text, ms }.
 *                      Rejects while a previous transcription is still running.
 *
 * The model lives under <userData>/voice-models/ggml-base.en.bin so it survives
 * app updates and never touches the repo.
 */

import { app, ipcMain, type BrowserWindow } from 'electron';
import { execFile, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

async function envelope<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const HOME = os.homedir();
const IS_WINDOWS = process.platform === 'win32';
// Packaged Electron apps inherit a minimal PATH, so POSIX gets the usual bin
// dirs prepended. Windows PATHs are `;`-separated and case-insensitive — a
// `:`-joined prefix would fuse the first real entry into one bogus directory —
// so there the inherited PATH is used as-is and detection probes absolute dirs.
const ENV = IS_WINDOWS
  ? { ...process.env, HOME, USERPROFILE: HOME }
  : {
    ...process.env,
    HOME,
    PATH: `/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${process.env.PATH || ''}`,
  };

export const STT_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const STT_MODEL_FILE = 'ggml-base.en.bin';
/** ggml-base.en.bin is ~148 MB — anything smaller is a truncated download. */
const STT_MODEL_MIN_BYTES = 140 * 1024 * 1024;

export interface SttStatus {
  binaryPresent: boolean;
  binaryPath: string | null;
  modelPresent: boolean;
  modelPath: string;
  /** True when both binary + model are in place — transcription will work. */
  ready: boolean;
}

export interface SttSetupProgress {
  phase: 'binary' | 'model';
  message: string;
  downloaded?: number;
  total?: number;
  pct?: number;
}

// ── Binary detection (cached) ───────────────────────────────────────────────

/** Homebrew's whisper-cpp formula installs `whisper-cli`; older builds shipped `whisper-cpp`. */
const BINARY_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper'];
// Packaged apps get a minimal PATH, so probe the real install locations per
// platform before falling back to `which`. macOS only ever checked Homebrew.
const BINARY_DIRS = [
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'bin'),
];

// Windows ships every binary with an .exe suffix and has no `which`, so the
// POSIX name list and PATH lookup above can never match there.
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

/** Names as they exist on this platform. */
const PROBED_NAMES = IS_WINDOWS ? BINARY_NAMES.map((n) => `${n}.exe`) : BINARY_NAMES;
/**
 * Where the CLI actually lands on Windows: winget links portable packages into
 * %LOCALAPPDATA%\Microsoft\WinGet\Links; manual installs use whisper.cpp's own
 * x64 release folder, scoop shims, or %LOCALAPPDATA%\Programs. None of these are
 * on a packaged app's PATH, which is why absolute probes come first.
 */
const PROBED_DIRS = IS_WINDOWS
  ? [
    path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links'),
    path.join(PROGRAM_FILES, 'whisper.cpp', 'bin'),
    path.join(PROGRAM_FILES, 'whisper.cpp'),
    path.join(PROGRAM_FILES_X86, 'whisper.cpp', 'bin'),
    path.join(LOCAL_APP_DATA, 'Programs', 'whisper.cpp', 'bin'),
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, 'scoop', 'shims'),
    path.join(HOME, 'bin'),
  ]
  : BINARY_DIRS;
/** `where` is the Windows equivalent of `which`. */
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

let cachedBinary: string | null | undefined; // undefined = not probed yet

export function detectWhisperBinary(refresh = false): string | null {
  if (!refresh && cachedBinary !== undefined) return cachedBinary;
  cachedBinary = null;
  for (const name of PROBED_NAMES) {
    // Absolute locations first (packaged apps have a minimal PATH).
    for (const dir of PROBED_DIRS) {
      const p = path.join(dir, name);
      try {
        // Windows has no executable bit, so X_OK there only means "exists".
        fs.accessSync(p, fs.constants.X_OK);
        cachedBinary = p;
        return cachedBinary;
      } catch { /* keep looking */ }
    }
    try {
      // `where` prints one path per line; the first one is the one that wins.
      const out = execSync(`${WHICH_CMD} ${name}`, { encoding: 'utf8', env: ENV, timeout: 3000 }).trim();
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

export function sttModelDir(): string {
  return path.join(app.getPath('userData'), 'voice-models');
}

export function sttModelPath(): string {
  return path.join(sttModelDir(), STT_MODEL_FILE);
}

export function sttModelPresent(): boolean {
  try {
    const stat = fs.statSync(sttModelPath());
    return stat.isFile() && stat.size >= STT_MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

export function getSttStatus(refresh = false): SttStatus {
  const binaryPath = detectWhisperBinary(refresh);
  const modelPresent = sttModelPresent();
  return {
    binaryPresent: Boolean(binaryPath),
    binaryPath,
    modelPresent,
    modelPath: sttModelPath(),
    ready: Boolean(binaryPath) && modelPresent,
  };
}

/** Follow-redirects GET (HuggingFace 302s to its CDN). */
function httpsGetFollow(
  url: string,
  onResponse: (res: import('http').IncomingMessage) => void,
  onError: (err: Error) => void,
  redirectsLeft = 5,
): void {
  const req = https.get(url, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
      res.resume();
      httpsGetFollow(new URL(res.headers.location, url).toString(), onResponse, onError, redirectsLeft - 1);
      return;
    }
    if (status !== 200) {
      res.resume();
      onError(new Error(`Model download failed: HTTP ${status}`));
      return;
    }
    onResponse(res);
  });
  req.on('error', onError);
}

let downloadInFlight: Promise<void> | null = null;

/**
 * Download ggml-base.en.bin into the voice-models dir. Streams to a .part file,
 * verifies the size, then renames into place. Concurrent calls share one download.
 */
export function downloadSttModel(
  onProgress?: (p: SttSetupProgress) => void,
): Promise<void> {
  if (sttModelPresent()) return Promise.resolve();
  if (downloadInFlight) return downloadInFlight;

  downloadInFlight = new Promise<void>((resolve, reject) => {
    const dir = sttModelDir();
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = sttModelPath();
    const partPath = finalPath + '.part';

    const fail = (err: Error) => {
      try { fs.unlinkSync(partPath); } catch { /* already gone */ }
      reject(err);
    };

    httpsGetFollow(
      STT_MODEL_URL,
      (res) => {
        const total = Number(res.headers['content-length'] || 0);
        let downloaded = 0;
        const out = fs.createWriteStream(partPath);

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          onProgress?.({
            phase: 'model',
            message: 'Downloading speech model…',
            downloaded,
            total,
            pct: total > 0 ? Math.round((downloaded / total) * 100) : 0,
          });
        });
        res.pipe(out);

        out.on('finish', () => {
          out.close(() => {
            try {
              const size = fs.statSync(partPath).size;
              if (size < STT_MODEL_MIN_BYTES || (total > 0 && size !== total)) {
                fail(new Error(`Model download incomplete (${size} bytes) — try again.`));
                return;
              }
              fs.renameSync(partPath, finalPath);
              onProgress?.({ phase: 'model', message: 'Speech model ready.', downloaded: size, total: size, pct: 100 });
              resolve();
            } catch (e) {
              fail(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });
        out.on('error', fail);
        res.on('error', fail);
      },
      fail,
    );
  }).finally(() => {
    downloadInFlight = null;
  });

  return downloadInFlight;
}

/**
 * Install the whisper.cpp CLI using the host platform's package manager.
 *
 * This was Homebrew-only, so the voice setup flow could never complete on
 * Linux or Windows — it always failed with "Homebrew not found".
 */
async function installWhisperBinary(onProgress?: (p: SttSetupProgress) => void): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    const BREW = '/opt/homebrew/bin/brew';
    let brewPath = BREW;
    try {
      fs.accessSync(BREW, fs.constants.X_OK);
    } catch {
      try {
        brewPath = execSync('which brew', { encoding: 'utf8', env: ENV, timeout: 3000 }).trim();
      } catch {
        throw new Error('Homebrew not found — install whisper-cpp manually: brew install whisper-cpp');
      }
    }
    onProgress?.({ phase: 'binary', message: 'Installing whisper-cpp via Homebrew…' });
    await new Promise<void>((resolve, reject) => {
      execFile(brewPath, ['install', 'whisper-cpp'], { env: ENV, timeout: 300_000 }, (err) => {
        if (err) reject(new Error(`brew install whisper-cpp failed: ${err.message.slice(0, 200)}`));
        else resolve();
      });
    });
  } else if (platform === 'linux') {
    // apt needs root. Prefer pkexec so the desktop shows a normal auth prompt;
    // fall back to sudo when pkexec is not installed.
    onProgress?.({ phase: 'binary', message: 'Installing whisper-cpp (apt)…' });
    const hasPkexec = (() => {
      try { execSync('which pkexec', { encoding: 'utf8', env: ENV, timeout: 3000 }); return true; }
      catch { return false; }
    })();
    const runner = hasPkexec ? 'pkexec' : 'sudo';
    await new Promise<void>((resolve, reject) => {
      execFile(runner, ['apt-get', 'install', '-y', 'whisper-cpp'], { env: ENV, timeout: 300_000 }, (err) => {
        if (err) {
          reject(new Error(
            `${runner} apt-get install whisper-cpp failed (${err.message.slice(0, 120)}). ` +
            'Install manually: sudo apt-get install whisper-cpp',
          ));
        } else resolve();
      });
    });
  } else if (platform === 'win32') {
    onProgress?.({ phase: 'binary', message: 'Installing whisper-cpp (winget)…' });
    try {
      execSync(`${WHICH_CMD} winget`, { encoding: 'utf8', env: ENV, timeout: 5000 });
    } catch {
      throw new Error(
        'winget not found — it ships with the App Installer on Windows 10 1809+. ' +
        'Otherwise download whisper.cpp from github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH.',
      );
    }
    // --accept-package-agreements and --disable-interactivity matter: without
    // them winget opens a prompt with nobody there to answer it and the
    // install hangs until the 5-minute timeout.
    await new Promise<void>((resolve) => {
      execFile(
        'winget',
        ['install', '--id', 'ggml.whisper', '--exact', '--silent',
          '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
        { env: ENV, timeout: 300_000 },
        // A non-zero exit is not fatal here: winget reports "already installed"
        // that way, and the detection check below is the real arbiter.
        () => resolve(),
      );
    });
  } else {
    throw new Error(`Unsupported platform: ${platform}. Install whisper-cpp manually and make sure \`${PROBED_NAMES[0]}\` is on PATH.`);
  }

  detectWhisperBinary(true);
  if (!detectWhisperBinary()) {
    throw new Error(
      'whisper-cpp installed but its binary was not found. ' +
      `Expected one of: ${PROBED_NAMES.join(', ')} on PATH.`,
    );
  }
}

// ── Transcription ───────────────────────────────────────────────────────────

/**
 * Transcriptions are serialised rather than refused.
 *
 * This used to be a boolean that threw "A transcription is already running"
 * when a second utterance arrived while the first was still going. In
 * hands-free use — which is exactly when people talk over each other — that
 * silently threw away what the user actually said. whisper.cpp is
 * single-threaded here anyway, so serialising costs nothing and loses nothing.
 *
 * `queueDepth` is exposed so the UI can tell "still working through what you
 * said" apart from "not listening".
 */
let chain: Promise<unknown> = Promise.resolve();
let pendingCount = 0;

function run(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${(stderr || err.message).slice(0, 300)}`));
      else resolve({ stdout, stderr });
    });
  });
}

export function transcriptionQueueDepth(): number {
  return pendingCount;
}

export async function transcribeAudio(audio: Uint8Array): Promise<{ text: string; ms: number }> {
  pendingCount++;
  // Chain onto whatever is already running; each caller still gets its own
  // result, and none of them are dropped.
  const run = chain.then(
    () => transcribeNow(audio),
    () => transcribeNow(audio)
  );
  // Keep the chain alive regardless of how this one ended.
  chain = run.then(
    () => { pendingCount--; },
    () => { pendingCount--; }
  );
  return run;
}

async function transcribeNow(audio: Uint8Array): Promise<{ text: string; ms: number }> {
  const status = getSttStatus();
  if (!status.binaryPresent) throw new Error('whisper-cli not installed — run voice setup first.');
  if (!status.modelPresent) throw new Error('Speech model not downloaded — run voice setup first.');
  if (!audio || audio.byteLength < 100) throw new Error('No audio captured.');

  const t0 = Date.now();

  // Everything after the busy flag must live inside the try, otherwise a
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-voice-'));
    const inPath = path.join(tmpDir, 'in.webm');
    const wavPath = path.join(tmpDir, 'in.wav');
    const outBase = path.join(tmpDir, 'out');

    try {
      fs.writeFileSync(inPath, Buffer.from(audio));

      // whisper.cpp wants 16 kHz mono PCM wav — ffmpeg is a managed dependency.
      await run('ffmpeg', ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], 30_000);

      // -otxt/-of writes plain text to out.txt — robust across whisper-cli versions
      // (stdout mixes logs with text on some builds). -np keeps logs quiet.
      await run(
        status.binaryPath as string,
        ['-m', status.modelPath, '-f', wavPath, '-l', 'en', '-np', '-otxt', '-of', outBase],
        120_000,
      );

      // Strip whisper's non-speech markers ([BLANK_AUDIO], [MUSIC PLAYING],
      // (silence), etc.) so quiet recordings come back empty, not as literal text.
      let raw: string;
      try {
        raw = fs.readFileSync(outBase + '.txt', 'utf8');
      } catch {
        throw new Error(
          `${status.binaryPath} ran but wrote no ${outBase}.txt. ` +
          'The installed whisper-cpp may not support -otxt/-of — reinstall with: sudo apt-get install whisper-cpp',
        );
      }
      const text = raw
        .replace(/\[[A-Z0-9 _]+\]/g, ' ')
        .replace(/\((?:silence|music|noise|inaudible)[^)]*\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { text, ms: Date.now() - t0 };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } finally {
    // queue bookkeeping is handled by the caller
  }
}

// ── IPC registration ────────────────────────────────────────────────────────

export function registerVoiceSttHandlers(getWindow: () => BrowserWindow | null): void {
  const sendProgress = (p: SttSetupProgress) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('voice:stt:setup-progress', p);
  };

  ipcMain.handle('voice:sttStatus', (_e, opts?: { refresh?: boolean }) =>
    envelope(() => getSttStatus(Boolean(opts?.refresh))),
  );

  let setupInFlight: Promise<SttStatus> | null = null;
  ipcMain.handle('voice:sttSetup', () =>
    envelope(() => {
      if (!setupInFlight) {
        setupInFlight = (async () => {
          if (!detectWhisperBinary(true)) await installWhisperBinary(sendProgress);
          if (!sttModelPresent()) await downloadSttModel(sendProgress);
          return getSttStatus(true);
        })().finally(() => {
          setupInFlight = null;
        });
      }
      return setupInFlight;
    }),
  );

  ipcMain.handle('voice:transcribe', (_e, audio: Uint8Array) =>
    envelope(() => transcribeAudio(audio)),
  );
}
