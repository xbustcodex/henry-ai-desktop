/**
 * Content Creators — a scripted demo mode.
 *
 * This is a local capability, not a commercial one. A creator imports media
 * (screenshots, audio, documents), writes a short scripted exchange, and Henry
 * plays it back either as a full-screen reactive orb or as a lookalike chat
 * window — so a filmed interaction looks like Henry really did the work.
 *
 * Files are copied into a private directory under userData with random names
 * and served back to the renderer through the henry-media:// protocol, so the
 * renderer never gets a filesystem path it could read anything else through.
 * Only an explicit extension allowlist per kind is accepted.
 */
import { ipcMain, protocol, shell, net } from 'electron';
import { BrowserWindow, app } from 'electron';
import { copyFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────

export type CreatorMediaKind = 'audio' | 'image' | 'file';
export type CreatorCaptionMode = 'typewriter' | 'none';
export type CreatorDemoMode = 'chat' | 'voice';
export type CreatorTurnRole = 'user' | 'assistant';
export type OrbSkin = 'default' | 'minimalistic';
export type OrbSpeed = 'slow' | 'default' | 'fast' | 'off';

export interface CreatorMedia {
  id: string;
  /** Randomised name on disk. Only ever used to resolve through henry-media://. */
  fileName: string;
  /** Friendly name shown in the UI. */
  originalName: string;
  kind: CreatorMediaKind;
  addedAt: number;
}

export interface CreatorTurn {
  id: string;
  role: CreatorTurnRole;
  text: string;
  audio: CreatorMedia | null;
  files: CreatorMedia[];
}

export interface CreatorDemo {
  enabled: boolean;
  mode: CreatorDemoMode;
  triggerPhrases: string[];
  turns: CreatorTurn[];
  captionMode: CreatorCaptionMode;
  /** Milliseconds between opening each attached file, so windows cascade. */
  fileStaggerMs: number;
  playIntro: boolean;
}

/** Visual identity of the orb, shared by the settings panel and the stage. */
export interface OrbSettings {
  skin: OrbSkin;
  speed: OrbSpeed;
  accent: string;
  /** Name shown on the power-on intro. Empty means use the fallback. */
  assistantName: string;
}

const EXTENSIONS: Record<CreatorMediaKind, readonly string[]> = {
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'],
  // Documents and media a creator might "open" as a real desktop window during
  // a scripted turn. No executables, no scripts — a demo must never be able to
  // smuggle something executable into a media directory.
  file: [
    '.pdf', '.txt', '.md', '.rtf', '.doc', '.docx', '.pages',
    '.xls', '.xlsx', '.numbers', '.ppt', '.pptx', '.key', '.csv', '.json',
    '.mp4', '.mov', '.m4v', '.webm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.zip',
  ],
};

export const MEDIA_KINDS: readonly CreatorMediaKind[] = ['audio', 'image', 'file'];

// ── Defaults ──────────────────────────────────────────────────────────────

export function defaultCreatorDemo(): CreatorDemo {
  return {
    enabled: true,
    mode: 'voice',
    triggerPhrases: ["what's the status of my app", 'status of my app'],
    captionMode: 'typewriter',
    fileStaggerMs: 600,
    playIntro: true,
    turns: [
      { id: crypto.randomUUID(), role: 'assistant', text: 'Good evening, sir. All systems online. Henry at your service.', audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'user', text: "what's the status of my app", audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'assistant', text: 'Good morning. Overnight we crossed 20,374 new sign-ups — a record day. Monthly recurring revenue is now $56,992, up 34% week over week. Pulling up your live dashboard now.', audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'user', text: 'nice. any fires I should know about?', audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'assistant', text: "Nothing critical. Churn held at 1.2%, and Tuesday's payments incident is fully resolved. Here's the growth curve and the investor update I drafted for you.", audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'user', text: 'perfect. ship the investor update', audio: null, files: [] },
      { id: crypto.randomUUID(), role: 'assistant', text: "Done. It's on its way to all 14 stakeholders, and I've scheduled the follow-up calls for Thursday morning. Anything else?", audio: null, files: [] },
    ],
  };
}

export function defaultOrbSettings(): OrbSettings {
  return { skin: 'default', speed: 'default', accent: '#5cdcff', assistantName: 'Henry' };
}

// ── Validation ────────────────────────────────────────────────────────────
// Deliberately strict: this is untrusted renderer input arriving over IPC.

const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt;
  return Math.min(hi, Math.max(lo, v));
};

export function sanitizeDemo(input: unknown): CreatorDemo {
  const base = defaultCreatorDemo();
  if (typeof input !== 'object' || input === null) return base;
  const r = input as Record<string, unknown>;
  const turns: CreatorTurn[] = Array.isArray(r.turns)
    ? r.turns.slice(0, 200).map((t) => {
        const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
        const role: CreatorTurnRole = o.role === 'user' ? 'user' : 'assistant';
        const text = typeof o.text === 'string' ? o.text.slice(0, 4000) : '';
        const audio = isMedia(o.audio) ? o.audio : null;
        const files = Array.isArray(o.files) ? o.files.filter(isMedia).slice(0, 10) : [];
        return { id: typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : crypto.randomUUID(), role, text, audio, files };
      })
    : base.turns;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    mode: r.mode === 'chat' ? 'chat' : 'voice',
    triggerPhrases: Array.isArray(r.triggerPhrases)
      ? r.triggerPhrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim().slice(0, 120)).slice(0, 12)
      : base.triggerPhrases,
    turns,
    captionMode: r.captionMode === 'none' ? 'none' : 'typewriter',
    fileStaggerMs: clamp(r.fileStaggerMs, 0, 10_000, base.fileStaggerMs),
    playIntro: typeof r.playIntro === 'boolean' ? r.playIntro : base.playIntro,
  };
}

export function sanitizeOrb(input: unknown): OrbSettings {
  const base = defaultOrbSettings();
  if (typeof input !== 'object' || input === null) return base;
  const r = input as Record<string, unknown>;
  return {
    skin: r.skin === 'minimalistic' ? 'minimalistic' : 'default',
    speed: r.speed === 'slow' || r.speed === 'fast' || r.speed === 'off' ? r.speed : 'default',
    accent: typeof r.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.accent) ? r.accent : base.accent,
    assistantName: typeof r.assistantName === 'string' ? r.assistantName.trim().slice(0, 32) : base.assistantName,
  };
}

function isMedia(v: unknown): v is CreatorMedia {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.fileName === 'string' &&
    typeof m.originalName === 'string' &&
    typeof m.kind === 'string' &&
    MEDIA_KINDS.includes(m.kind as CreatorMediaKind)
  );
}

// ── Store ─────────────────────────────────────────────────────────────────

export class CreatorsStore {
  constructor(private readonly dir: string) {}

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Resolve a stored filename to an absolute path, or null if unsafe. */
  resolve(fileName: string): string | null {
    if (typeof fileName !== 'string' || !fileName) return null;
    // Reject anything that is not a bare generated filename. This is the only
    // place a renderer-supplied string becomes a path, so traversal must die here.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(fileName)) return null;
    const full = path.join(this.dir, fileName);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) return null;
    return existsSync(resolved) ? resolved : null;
  }

  async importFromPaths(paths: string[], kind: CreatorMediaKind): Promise<CreatorMedia[]> {
    await this.ensureDir();
    const out: CreatorMedia[] = [];
    for (const p of paths.slice(0, 40)) {
      const originalName = path.basename(p);
      const ext = path.extname(originalName).toLowerCase();
      if (!EXTENSIONS[kind].includes(ext)) continue;
      try {
        const st = await stat(p);
        if (!st.isFile() || st.size === 0) continue;
        // Keep a single demo asset from being enormous.
        if (st.size > 256 * 1024 * 1024) continue;
        const fileName = `${crypto.randomBytes(12).toString('hex')}${ext}`;
        await copyFile(p, path.join(this.dir, fileName));
        out.push({ id: crypto.randomUUID(), fileName, originalName, kind, addedAt: Date.now() });
      } catch {
        /* skip anything we could not read or copy */
      }
    }
    return out;
  }

  async list(): Promise<CreatorMedia[]> {
    await this.ensureDir();
    const out: CreatorMedia[] = [];
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const fileName of names) {
      const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$/.exec(fileName);
      if (!m) continue;
      const ext = `.${m[2].toLowerCase()}`;
      const kind = (MEDIA_KINDS.find((k) => EXTENSIONS[k].includes(ext)) ?? 'file') as CreatorMediaKind;
      let addedAt = Date.now();
      try {
        addedAt = (await stat(path.join(this.dir, fileName))).mtimeMs;
      } catch { /* keep default */ }
      out.push({ id: fileName, fileName, originalName: fileName, kind, addedAt });
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  async delete(fileName: string): Promise<void> {
    const full = this.resolve(fileName);
    if (!full) return;
    try {
      await unlink(full);
    } catch { /* already gone */ }
  }
}

// ── Registration ──────────────────────────────────────────────────────────

let store: CreatorsStore | null = null;
let stageWindow: BrowserWindow | null = null;

export function creatorsDir(): string {
  return path.join(app.getPath('userData'), 'creators-media');
}

/** Must run before app ready. */
export function registerCreatorsProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'henry-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves henry-media://<fileName> out of the private creators directory. */
export function attachCreatorsProtocol(): void {
  protocol.handle('henry-media', async (request) => {
    if (!store) return new Response('not ready', { status: 503 });
    let name = '';
    try {
      name = decodeURIComponent(new URL(request.url).hostname || new URL(request.url).pathname.replace(/^\/+/, ''));
    } catch {
      return new Response('bad url', { status: 400 });
    }
    const full = store.resolve(name);
    if (!full) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileUrl(full));
  });
}

function pathToFileUrl(p: string): string {
  const f = p.replace(/\\/g, '/');
  return `file://${f.startsWith('/') ? '' : '/'}${encodeURI(f)}`;
}

export function registerCreatorsHandlers(db: import('better-sqlite3').Database): void {
  store = new CreatorsStore(creatorsDir());
  void store.ensureDir();

  const readSetting = (key: string): string | undefined => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  };
  const writeSetting = (key: string, value: string): void => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(key, value);
  };

  ipcMain.handle('creators:getDemo', () => {
    try {
      return sanitizeDemo(JSON.parse(readSetting('creator_demo') ?? 'null'));
    } catch {
      return defaultCreatorDemo();
    }
  });

  ipcMain.handle('creators:saveDemo', (_e, input: unknown) => {
    const demo = sanitizeDemo(input);
    writeSetting('creator_demo', JSON.stringify(demo));
    return { ok: true, demo };
  });

  ipcMain.handle('creators:getOrb', () => {
    try {
      return sanitizeOrb(JSON.parse(readSetting('creator_orb') ?? 'null'));
    } catch {
      return defaultOrbSettings();
    }
  });

  ipcMain.handle('creators:saveOrb', (_e, input: unknown) => {
    const orb = sanitizeOrb(input);
    writeSetting('creator_orb', JSON.stringify(orb));
    return { ok: true, orb };
  });

  ipcMain.handle('creators:listMedia', async () => ({ media: await store!.list() }));

  ipcMain.handle('creators:importMedia', async (_e, input: unknown) => {
    const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const kind = MEDIA_KINDS.includes(r.kind as CreatorMediaKind) ? (r.kind as CreatorMediaKind) : 'file';
    const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : [];
    return { media: await store!.importFromPaths(paths, kind) };
  });

  ipcMain.handle('creators:deleteMedia', async (_e, input: unknown) => {
    const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    await store!.delete(typeof r.fileName === 'string' ? r.fileName : '');
    return { ok: true };
  });

  // Opens in the OS viewer so a filmed demo shows it as a real desktop item
  // rather than an in-app overlay.
  ipcMain.handle('creators:openMedia', async (_e, input: unknown) => {
    const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const full = store!.resolve(typeof r.fileName === 'string' ? r.fileName : '');
    if (!full) return { ok: false, error: 'Media not found' };
    try {
      await shell.openPath(full);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('creators:launchStage', (_e, input: unknown) => {
    const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    return openStage(r.mode === 'chat' ? 'chat' : 'voice', currentConfig(db));
  });

  ipcMain.handle('creators:closeStage', () => {
    closeStage();
    return { ok: true };
  });
}

/**
 * The full-screen orb stage. Always-on-top and frameless; it is the window the
 * demo is filmed from, so it has to be able to sit above everything else.
 */
export interface StageConfig {
  demo: CreatorDemo;
  orb: OrbSettings;
}

/** Read the sanitised demo + orb settings the stage should play back. */
function currentConfig(db: import('better-sqlite3').Database): StageConfig {
  const read = (key: string): unknown => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
      return row?.value ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  };
  return { demo: sanitizeDemo(read('creator_demo')), orb: sanitizeOrb(read('creator_orb')) };
}

export function openStage(mode: 'voice' | 'chat', config?: StageConfig): { ok: boolean; error?: string } {
  try {
    if (stageWindow && !stageWindow.isDestroyed()) {
      stageWindow.focus();
      return { ok: true };
    }
    const { screen } = require('electron') as typeof import('electron');
    const bounds = screen.getPrimaryDisplay().bounds;
    stageWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: mode === 'voice',
      backgroundColor: mode === 'voice' ? '#05060c' : '#0b0c14',
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: false,
      hasShadow: false,
      fullscreenable: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // The config is embedded rather than fetched afterwards: the stage is a
    // data: document with no preload, so it cannot call back for it. Without
    // this the orb rendered empty and the caption never typed.
    const html = stageHtml(mode, config ?? { demo: defaultCreatorDemo(), orb: defaultOrbSettings() });
    stageWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    stageWindow.on('closed', () => {
      stageWindow = null;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function closeStage(): void {
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.close();
  stageWindow = null;
}

export function isStageOpen(): boolean {
  return !!stageWindow && !stageWindow.isDestroyed();
}

/**
 * The stage is a self-contained document rather than a route in the main
 * renderer: it has to own the whole screen with nothing else on it, and it must
 * still work when the main window is behind something else.
 */
function stageHtml(mode: 'voice' | 'chat', config: StageConfig): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Henry — Demo Stage</title>
<style>
  :root { --accent: #5cdcff; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; background:#05060c; overflow:hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  #wrap { height:100%; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:28px; }
  #stage { position:relative; width:min(52vh,420px); height:min(52vh,420px); }
  #stage svg { width:100%; height:100%; overflow:visible; }
  .ring { fill:none; stroke:var(--accent); opacity:.55; }
  .core { fill:var(--accent); opacity:.9; }
  #caption { color:#e8ecf7; font-size:clamp(18px,2.4vh,30px); text-align:center;
    max-width:70vw; min-height:1.4em; line-height:1.4; letter-spacing:.01em; }
  #caption.user { color:#8fa3c8; }
  #hint { position:fixed; left:0; right:0; bottom:22px; text-align:center;
    color:rgba(232,236,247,.45); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  #standby { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    flex-direction:column; gap:24px; cursor:pointer; }
  #standby.hidden { display:none; }
  #intro { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    flex-direction:column; gap:20px; background:#05060c; z-index:5; }
  #intro.hidden { display:none; }
  #introName { color:#e8ecf7; font-size:clamp(28px,5vh,54px); font-weight:700; letter-spacing:.22em;
    text-transform:uppercase; opacity:0; transform:translateY(10px);
    animation:rise 1.1s ease forwards .5s; }
  @keyframes rise { to { opacity:1; transform:none; } }
  #introSub { color:rgba(232,236,247,.5); font-size:12px; letter-spacing:.3em; text-transform:uppercase;
    opacity:0; animation:rise 1s ease forwards 1.3s; }
  .pulse { animation:pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
</style></head><body>
<div id="intro" class="hidden">
  <div id="introOrb"></div>
  <div id="introName"></div>
  <div id="introSub">online</div>
</div>
<div id="standby">
  <div id="standbyOrb"></div>
  <div style="color:#e8ecf7;font-size:15px;letter-spacing:.14em;text-transform:uppercase" class="pulse">
    ${mode === 'voice' ? 'Click or press Space to activate' : 'Click to start the demo'}
  </div>
</div>
<div id="wrap" style="display:none">
  <div id="stage"></div>
  <div id="caption"></div>
</div>
<div id="hint">ESC to exit</div>
<script type="application/json" id="cfg">${JSON.stringify({
    mode,
    demo: config.demo,
    orb: config.orb,
  }).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var demo = null, orb = null, idx = -1, timer = null, started = false;
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var mode = cfg.mode;
  demo = cfg.demo;
  orb = cfg.orb;
  var stage = document.getElementById('stage');
  var caption = document.getElementById('caption');
  var standby = document.getElementById('standby');
  function svg(name){
    if(name === 'minimalistic'){
      return '<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="74" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity=".35"/>'
        + '<circle cx="100" cy="100" r="46" fill="none" stroke="var(--accent)" stroke-width="2" opacity=".6"/>'
        + '<circle class="core" cx="100" cy="100" r="16" opacity=".9"/>'
        + '<circle cx="100" cy="100" r="30" fill="none" stroke="var(--accent)" stroke-width="1" opacity=".3"/></svg>';
    }
    // default: full arc-reactor HUD
    var arcs = '';
    for (var i=0;i<5;i++){
      var rot = i*36, rr = 58 + (i%2)*18;
      arcs += '<g transform="rotate('+rot+' 100 100)"><path d="M '+(100-rr)+' 100 A '+rr+' '+rr+' 0 0 1 '+(100+rr)+' 100" '
        + 'fill="none" stroke="var(--accent)" stroke-width="'+(i%2?1:2)+'" opacity="'+(0.25+0.1*i)+'"/></g>';
    }
    return '<svg viewBox="0 0 200 200">' + arcs
      + '<circle class="ring" cx="100" cy="100" r="34" stroke-width="2"/>'
      + '<circle class="ring" cx="100" cy="100" r="20" stroke-width="1"/>'
      + '<circle class="core" cx="100" cy="100" r="9"/>'
      + '<circle cx="100" cy="100" r="66" fill="none" stroke="var(--accent)" stroke-width=".6" opacity=".2"/></svg>';
  }

  function skin(){ return orb && orb.skin === 'minimalistic' ? 'minimalistic' : 'default'; }
  function speedMs(){ var s = orb && orb.speed; return s==='slow'?34:s==='fast'?8:s==='off'?0:16; }
  function accent(){ return (orb && orb.accent) || '#5cdcff'; }

  var phase = 0;
  function animate(){
    var ms = speedMs();
    if(ms===0) return;
    phase += 1;
    var el = document.querySelector('#stage svg g');
    if(el) el.style.transform = 'rotate('+(phase%360*1.2)+'deg)';
    stage.style.filter = 'drop-shadow(0 0 '+(10+Math.sin(phase/6)*8)+'px var(--accent))';
    setTimeout(animate, ms);
  }

  function typewrite(text){
    if(!demo || demo.captionMode === 'none'){ caption.textContent = text; return; }
    caption.textContent = '';
    var i = 0;
    (function step(){
      if(i>=text.length){ return; }
      caption.textContent += text[i++];
      setTimeout(step, 22);
    })();
  }

  function showTurn(){
    if(!demo) return;
    idx++;
    if(idx >= demo.turns.length){ caption.textContent = ''; return; }
    var t = demo.turns[idx];
    caption.className = t.role === 'user' ? 'user' : '';
    typewrite(t.text || '');
    stage.style.setProperty('--accent', accent());
    stage.innerHTML = svg(skin());
  }

  function playIntro(){
    return new Promise(function(resolve){
      var intro = document.getElementById('intro');
      var name = (orb && orb.assistantName) || '';
      document.getElementById('introOrb').innerHTML =
        '<div style="width:min(28vh,220px);height:min(28vh,220px)">' + svg(skin()) + '</div>';
      document.getElementById('introName').textContent = name;
      intro.classList.remove('hidden');
      setTimeout(function(){ intro.classList.add('hidden'); resolve(); }, 3200);
    });
  }

  function start(){
    if(started) return;
    started = true;
    standby.classList.add('hidden');
    document.getElementById('wrap').style.display = 'flex';
    document.documentElement.style.setProperty('--accent', accent());
    stage.innerHTML = svg(skin());
    idx = -1;
    animate();
    if(!demo || demo.playIntro !== false){
      playIntro().then(function(){ showTurn(); timer = setInterval(showTurn, 4200); });
    } else {
      showTurn();
      timer = setInterval(showTurn, 4200);
    }
  }

  // The standby screen shows a preview of the chosen skin, so the operator can
  // see which orb they are about to start.
  document.getElementById('standbyOrb').innerHTML =
    '<div style="width:min(30vh,240px);height:min(30vh,240px)">' + svg(skin()) + '</div>';
  standby.addEventListener('click', start);
  document.addEventListener('keydown', function(e){
    if(e.key === ' ' || e.key === 'Enter'){ e.preventDefault(); start(); }
    if(e.key === 'Escape'){ window.close(); }
  });

  window.__henryStart = start;
  window.__henryDemo = function(d){ demo = d; if(started) showTurn(); };
})();
</script></body></html>`;
}