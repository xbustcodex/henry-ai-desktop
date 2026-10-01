import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, shell, ipcMain, Notification, Tray, Menu, MenuItem, globalShortcut, nativeImage, systemPreferences, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { initDatabase, getDb } from './ipc/database';
import { registerSettingsHandlers } from './ipc/settings';
import { registerGoogleAuthHandlers } from './ipc/googleAuth';
import { registerAIHandlers } from './ipc/ai';
import { registerFilesystemHandlers } from './ipc/filesystem';
import { registerAttachmentHandlers } from './ipc/attachments';
import { registerMediaLibraryHandlers } from './ipc/mediaLibrary';
import { registerMarketplaceHandlers } from './ipc/marketplace';
import { registerHenryLocalBrainGatewayIpc } from './ipc/henryLocalBrainGateway';
import { registerOpencodeBridgeHandlers, stopOpencodeBridge } from './ipc/opencodeBridge';
import { registerRuntimeHandlers, recordStartupFailure, clearStartupFailure } from './ipc/runtimeDiagnostics';
import { registerTaskBrokerHandlers } from './ipc/taskBroker';
import { registerMemoryHandlers } from './ipc/memory';
import { registerMemoryGraphHandlers } from './ipc/memoryGraph';
import { registerQuotingHandlers } from './ipc/quoting';
import { registerMakerStudioHandlers } from './ipc/makerStudio';
import { registerLessonsHandlers } from './ipc/lessons';
import { registerOllamaHandlers } from './ipc/ollama';
import { registerOllamaCleanup } from './ipc/ollamaManager';
import { registerTerminalHandlers } from './ipc/terminal';
import { registerComputerHandlers } from './ipc/computer';
import { registerPrinterHandlers } from './ipc/printer';
import { registerSessionStoreHandlers } from './ipc/sessionStore';
import { registerApprovalHandlers } from './ipc/approvals';
import { registerBookHandlers } from './ipc/book';
import { registerPrinterDiscoveryHandlers } from './ipc/printerDiscovery';
import { registerPrinterNetworkHandlers } from './ipc/printerNetwork';
import { registerMachineHandlers } from './machines/ipc';
import { getMachineManager } from './machines/manager';
import { registerSlicerHandlers } from './ipc/slicer';
import { registerSlicerProfileHandlers } from './ipc/slicerProfiles';
import { registerAgentHandlers } from './ipc/agent';
import { registerCoderHandlers } from './coder';
import { registerSchedulerHandlers } from './ipc/scheduler';
import { HenryScheduler } from './agent/scheduler';
import { registerSyncBridgeIpc, setSyncDb, startSyncServer } from './ipc/syncBridge';
import { runDiagnostic, saveReport } from './ipc/selfRepair';
import { decryptKey } from './ipc/_keyStorage';
import { registerVoiceSttHandlers } from './voice/stt';
import { registerVoiceGreetingHandlers } from './voice/greeting';
import { registerVoiceTtsHandlers } from './voice/tts';
import { log } from './lib/log';


// Global IPC error handler — prevents any single handler crash from killing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Henry:main] Unhandled IPC rejection:', reason);
  // Don't exit — let the renderer receive the error via the normal IPC error channel
});

process.on('uncaughtException', (err) => {
  console.error('[Henry:main] Uncaught exception:', err.message);
  // Log but don't crash — try to keep running
});


let mainWindow: BrowserWindow | null = null;
const tray: Tray | null = null;
let henryScheduler: HenryScheduler | null = null;

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const wins = BrowserWindow.getAllWindows();
  return wins.find((w) => !w.isDestroyed()) || null;
}

/** Check if a binary exists in PATH. Returns the path if found, else empty string. */
function tryExecBin(bin: string): string {
  try {
    // `which` does not exist on Windows; whichBin uses `where` there.
    const { whichBin } = require('./ipc/platformCommands') as typeof import('./ipc/platformCommands');
    return whichBin(bin) ?? '';
  } catch { return ''; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (process.env.OPEN_DEVTOOLS === 'true') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    // After renderer loads: sync SQLite settings → localStorage
    // This runs BEFORE webMock reads from localStorage, ensuring correct provider/model
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const db = (await import('./ipc/database')).getDb();
        const settings = db.prepare('SELECT key, value FROM settings').all() as {key:string, value:string}[];
        const providers = db.prepare('SELECT id, name, api_key, enabled, models FROM providers').all() as any[];

        const settingsMap: Record<string, string> = {};
        for (const { key, value } of settings) settingsMap[key] = value;

        // Keys are encrypted at rest (enc:v1:...) — inject the PLAINTEXT, never
        // the ciphertext: the renderer sends this value straight to the provider.
        const providersArr = providers.map(p => {
          const plain = decryptKey(p.api_key || '');
          return {
            id: p.id, name: p.name,
            api_key: plain, apiKey: plain,
            enabled: Boolean(p.enabled), models: p.models || '[]',
          };
        });

        const script = `
          try {
            const s = ${JSON.stringify(settingsMap)};
            const existing = JSON.parse(localStorage.getItem('henry:settings') || '{}');
            localStorage.setItem('henry:settings', JSON.stringify({...existing, ...s}));
            localStorage.setItem('henry:providers', JSON.stringify(${JSON.stringify(providersArr)}));
          } catch(e) { console.error('[Henry] localStorage sync failed:', e); }
        `;
        mainWindow!.webContents.executeJavaScript(script);

        // Inject real system paths so Henry never uses placeholder usernames
        const sysPath = await import('path');
        const sysOs = await import('os');
        const homeDir = sysOs.default.homedir();
        const macUser = homeDir.split(sysPath.default.sep).pop() || '';
        const pathScript = `
          try {
            localStorage.setItem('henry:mac_username', ${JSON.stringify(macUser)});
            localStorage.setItem('henry:mac_home', ${JSON.stringify(homeDir)});
          } catch(e) {}
        `;
        mainWindow!.webContents.executeJavaScript(pathScript);
        if (process.platform === 'darwin') {
          const { execSync } = await import('child_process');
          let accessibility = false;
          let screenRecording = false;

          try {
            execSync(`osascript -e 'tell application "System Events" to return name of first process whose frontmost is true'`, { stdio: 'ignore', timeout: 3000 });
            accessibility = true;
          } catch { /* not granted */ }

          try {
            const tmpPng = require('path').join(require('os').tmpdir(), 'henry_perm.png');
            execSync(`screencapture -x "${tmpPng}" && rm -f "${tmpPng}"`, { stdio: 'ignore', timeout: 3000 });
            screenRecording = true;
          } catch { /* not granted */ }

          if (!accessibility || !screenRecording) {
            const permScript = `
              window.__henry_permissions = ${JSON.stringify({ accessibility, screenRecording })};
              window.dispatchEvent(new CustomEvent('henry_permissions_ready', {
                detail: ${JSON.stringify({ accessibility, screenRecording })}
              }));
            `;
            mainWindow!.webContents.executeJavaScript(permScript);
          }
        }
      } catch (e) {
        console.error('[Henry] SQLite→localStorage sync error:', e);
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click context menu with copy/paste/cut/select all
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    if (params.isEditable) {
      if (params.selectionText) {
        menu.append(new MenuItem({ label: 'Cut',        role: 'cut',       accelerator: 'CmdOrCtrl+X' }));
        menu.append(new MenuItem({ label: 'Copy',       role: 'copy',      accelerator: 'CmdOrCtrl+C' }));
      }
      menu.append(new MenuItem({ label: 'Paste',        role: 'paste',     accelerator: 'CmdOrCtrl+V' }));
      menu.append(new MenuItem({ label: 'Select All',   role: 'selectAll', accelerator: 'CmdOrCtrl+A' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy',         role: 'copy',      accelerator: 'CmdOrCtrl+C' }));
    }
    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow! });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}


// ── Auto-updater setup ────────────────────────────────────────────────────────
if (app.isPackaged) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('henry-update-ready', info.version);
    });
  });
}

// Single instance: a second launch would start a second sync server on 4242,
// a second reminder poller and scheduler, duplicate global hotkeys, and two
// processes writing the same henry.db.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// A throw anywhere in boot (mkdir / initDatabase / createWindow) used to be
// swallowed by the log-only handlers above, leaving a windowless zombie
// process. Fail loudly and exit instead.
app.whenReady().then(() => {
  try {
    // Registered before the database so a boot failure is still reportable.
    registerRuntimeHandlers(() => { try { return getDb(); } catch { return null; } });
    // A recorded boot failure has done its job once the app is up. Leaving it
    // set made runtimeOk report false forever, even after the underlying problem
    // (a stale native module, a transient crash) was long gone.
    clearStartupFailure();
  // Check for updates silently on launch
  if (app.isPackaged) { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); }

  const userDataPath = app.getPath('userData');
  const henryDir = path.join(userDataPath, 'henry-workspace');
  if (!fs.existsSync(henryDir)) {
    fs.mkdirSync(henryDir, { recursive: true });
  }

  const db = initDatabase(henryDir);

  createWindow();

  // ── Auto-permission setup — no user instruction needed ───────────────────────
  // Henry checks and requests all required permissions automatically on launch.
  // If Accessibility is missing: auto-trigger the macOS dialog when capture first fires.
  // User just clicks 'OK' once — never needs to navigate to System Settings.
  setTimeout(async () => {
    try {
      const hasAccessibility = systemPreferences.isTrustedAccessibilityClient(false);
      if (!hasAccessibility) {
        // Auto-request without prompting — Henry silently gets the dialog ready
        // The actual dialog fires the first time capture is attempted
        log.debug('[Henry] Accessibility not granted — will request on first use');
        getMainWindow()?.webContents.send('henry:permissions:status', {
          accessibility: false, screenRecording: false,
        });
      } else {
        log.debug('[Henry] Accessibility: granted');
        getMainWindow()?.webContents.send('henry:permissions:status', {
          accessibility: true, screenRecording: true,
        });
      }
    } catch { /* ignore on non-macOS */ }
  }, 2000);

  // IPC: renderer can request permission grants
  // Reset stale TCC entries first so macOS will re-prompt cleanly
  ipcMain.handle('henry:requestAccessibility', async () => {
    // Non-macOS: no TCC permissions to request — capabilities are inherent.
    if (process.platform !== 'darwin') {
      return { granted: true, native: true };
    }
    try {
      // First check — if already granted, no need to do anything
      if (systemPreferences.isTrustedAccessibilityClient(false)) {
        return { granted: true };
      }
      // Reset any stale TCC entry so the prompt CAN appear
      try {
        const { execSync } = await import('child_process');
        execSync('tccutil reset Accessibility ai.henry.desktop', { stdio: 'ignore' });
      } catch { /* tccutil may fail silently — not fatal */ }
      // Trigger the prompt
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      // ALSO open System Settings as a fallback so user can grant manually if dialog didn't appear
      if (!trusted && process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
      return { granted: trusted };
    } catch { return { granted: false }; }
  });
  // Mic access for voice input — packaged apps need an explicit TCC request.
  // Renderer calls this before getUserMedia so the macOS prompt fires from the
  // main process (with NSMicrophoneUsageDescription from Info.plist).
  ipcMain.handle('voice:micAccess', async () => {
    try {
      if (process.platform !== 'darwin') return { status: 'granted', granted: true };
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return { status, granted: true };
      if (status === 'not-determined') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return { status: granted ? 'granted' : 'denied', granted };
      }
      // 'denied' or 'restricted' — the prompt can't fire again; open the right panel.
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      );
      return { status, granted: false };
    } catch {
      return { status: 'unknown', granted: false };
    }
  });

  ipcMain.handle('henry:checkAccessibility', () => {
    // Non-macOS: check real capabilities instead of macOS TCC permission
    if (process.platform !== 'darwin') {
      try {
        const cp = require('child_process');
        if (process.platform === 'win32') return { granted: true };

        // Linux: check for the automation backends Henry uses
        const { execSync } = cp;
        const hasXdotool = !!tryExecBin('xdotool');
        const hasWmctrl = !!tryExecBin('wmctrl');
        const hasClipboard = !!tryExecBin('xclip') || !!tryExecBin('xsel') || !!tryExecBin('wl-copy');
        // Computer control is available if Henry has automation + clipboard tools
        const granted = hasXdotool || hasWmctrl || hasClipboard;
        return { granted, native: true, detail: { hasXdotool, hasWmctrl, hasClipboard } };
      } catch { return { granted: true }; }
    }
    try {
      // First try Electron's API
      const electronSays = systemPreferences.isTrustedAccessibilityClient(false);
      if (electronSays) return { granted: true };
      // Fallback: macOS sometimes reports false for adhoc-signed apps even when
      // the toggle is ON. Try a functional check via osascript — if we can
      // dispatch a System Events query without an error, AX is granted.
      try {
        const out = require('child_process').execSync(
          'osascript -e \'tell application "System Events" to count processes\'',
          { encoding: 'utf8', timeout: 2500 }
        ) as string;
        const granted = /^[0-9]+\s*$/.test((out || '').trim());
        return { granted };
      } catch { return { granted: false }; }
    } catch { return { granted: false }; }
  });
  ipcMain.handle('henry:checkScreenRecording', async () => {
    try {
      // Non-macOS: functional capability check
      if (process.platform !== 'darwin') {
        try {
          const cp = require('child_process');
          const fs = require('fs');
          const os = require('os');
          const tmp = `${os.tmpdir()}/henry_perm_check_${Date.now()}.png`;
          let cmd: string;
          if (process.platform === 'win32') {
            cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(100,100); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, 100, 100); $bmp.Save('${tmp}'); $bmp.Dispose()"`;
          } else {
            // Linux: try the backends Henry actually uses
            cmd = `scrot "${tmp}" 2>/dev/null || import -window root "${tmp}" 2>/dev/null || gnome-screenshot -f "${tmp}" 2>/dev/null`;
          }
          cp.execSync(cmd, { timeout: 5000, stdio: 'ignore' });
          if (fs.existsSync(tmp)) {
            const stat = fs.statSync(tmp);
            try { fs.unlinkSync(tmp); } catch { /* */ }
            return { granted: stat.size > 5000, native: true };
          }
          return { granted: false, native: true };
        } catch { return { granted: false, native: true }; }
      }
      // macOS: Electron's check first
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'granted') return { granted: true };
      // Fallback: try an actual screen capture. If it produces a non-empty
      // file with reasonable size, screen recording is granted regardless
      // of what getMediaAccessStatus claims.
      try {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const os = require('os');
        const tmp = `${os.tmpdir()}/henry_perm_check_${Date.now()}.png`;
        execSync(`screencapture -x -t png "${tmp}"`, { timeout: 3000, stdio: 'ignore' });
        const stat = fs.statSync(tmp);
        try { fs.unlinkSync(tmp); } catch { /* */ }
        // A real screen capture is hundreds of KB; a denied/empty one is < 5KB
        return { granted: stat.size > 5000 };
      } catch { return { granted: false }; }
    } catch { return { granted: false }; }
  });
  ipcMain.handle('henry:openPermissions', async () => {
    // Only open system preferences on macOS
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
    return { ok: true };
  });
  ipcMain.handle('henry:openScreenRecording', async () => {
    try {
      // Reset any stale TCC entry first — forces a fresh prompt
      try {
        const { execSync } = await import('child_process');
        execSync('tccutil reset ScreenCapture ai.henry.desktop', { stdio: 'ignore' });
      } catch { /* */ }
      // Trigger Electron's desktopCapturer which causes macOS to fire the
      // "Henry AI would like to record this computer's screen" prompt.
      try {
        const { desktopCapturer } = await import('electron');
        await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
        }).catch(() => {});
      } catch { /* */ }
      // Open System Settings to the Screen Recording pane so user can toggle Henry on
      // Only open system preferences on macOS
      if (process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  registerSettingsHandlers(db, getMainWindow);

  registerGoogleAuthHandlers(getMainWindow);

  // Re-sync SQLite providers → localStorage so the renderer picks up saves.
  ipcMain.handle('providers:resync-localStorage', () => {
    try {
      const providers = db.prepare('SELECT id, name, api_key, enabled, models FROM providers').all() as {id:string;name:string;api_key:string;enabled:number;models:string}[];
      // Same rule as the boot path: the renderer sends this value straight to
      // the provider, so it must be plaintext. Injecting the `enc:v1:`
      // ciphertext made every provider fail with an auth error.
      const providersArr = providers.map(p => {
        const plain = decryptKey(p.api_key || '');
        return {
          id: p.id, name: p.name,
          api_key: plain, apiKey: plain,
          enabled: Boolean(p.enabled), models: p.models || '[]',
        };
      });
      const script = `try { localStorage.setItem('henry:providers', JSON.stringify(${JSON.stringify(providersArr)})); } catch(e) {}`;
      getMainWindow()?.webContents.executeJavaScript(script).catch(() => {});
      return { ok: true, count: providers.length };
    } catch(e) { return { ok: false, error: String(e) }; }
  });

  registerAIHandlers(db, getMainWindow);
  registerFilesystemHandlers(henryDir);
  registerAttachmentHandlers(db);
  registerMediaLibraryHandlers(db, getMainWindow);
  registerMarketplaceHandlers(db, getMainWindow);
  // Was never registered, so the renderer's optional local-gateway probe always
  // returned undefined and the gateway URL was never used.
  registerHenryLocalBrainGatewayIpc(db);
  registerOpencodeBridgeHandlers(getMainWindow);
  registerTaskBrokerHandlers(db, getMainWindow, henryDir);
  registerMemoryHandlers(db);
  registerMemoryGraphHandlers(db);
  registerApprovalHandlers(db);
  registerBookHandlers(db);
  registerPrinterDiscoveryHandlers();
  registerPrinterNetworkHandlers();
  registerMachineHandlers(db, getMainWindow);
  registerSlicerHandlers(db);
  registerSlicerProfileHandlers(db);
  registerQuotingHandlers(db);
  registerMakerStudioHandlers(db);
  registerLessonsHandlers(db);
  registerOllamaHandlers(getMainWindow);
  registerOllamaCleanup();
  registerTerminalHandlers(getMainWindow, henryDir);
  registerComputerHandlers(getMainWindow);
  registerPrinterHandlers(getMainWindow);
  registerSessionStoreHandlers(henryDir);
  registerAgentHandlers(db, getMainWindow);
  registerCoderHandlers(db, getMainWindow);
  registerVoiceGreetingHandlers(db);
  registerVoiceSttHandlers(getMainWindow);
  registerVoiceTtsHandlers(db);

  // ── Agent Scheduler (Henry's Routines) ───────────────────────────────────
  // Registered after the agent tool kit so the registry is populated before any
  // Routine fires. init() seeds the four default Routines (disabled) on first
  // run and registers every enabled one with node-cron.
  henryScheduler = new HenryScheduler(db, getMainWindow);
  registerSchedulerHandlers(henryScheduler, db);
  henryScheduler.init();

  // ── Companion Sync Bridge ────────────────────────────────────────────────
  setSyncDb(db);
  registerSyncBridgeIpc();

  // ── First-launch detection + default habit seeding ─────────────────────────
  ipcMain.handle('henry:isFirstLaunch', () => {
    try {
      const count = (db.prepare('SELECT COUNT(*) as n FROM habits').get() as {n:number}).n
                  + (db.prepare('SELECT COUNT(*) as n FROM personal_tasks').get() as {n:number}).n;
      return { isFirst: count === 0 };
    } catch { return { isFirst: false }; }
  });

  // Seed default habits if none exist
  try {
    const habitCount = (db.prepare('SELECT COUNT(*) as n FROM habits').get() as {n:number}).n;
    if (habitCount === 0) {
      const insertHabit = db.prepare(
        "INSERT INTO habits (id, name, icon, color, target_per_day, active) VALUES (?, ?, ?, ?, ?, 1)"
      );
      const { randomUUID } = require('crypto') as typeof import('crypto');
      [
        [randomUUID(), 'Morning prayer / quiet time', '🙏', '#7c3aed', 1],
        [randomUUID(), 'Read a chapter',             '📖', '#2563eb', 1],
        [randomUUID(), 'Exercise',                    '💪', '#16a34a', 1],
        [randomUUID(), 'Drink water (8 glasses)',      '💧', '#0891b2', 8],
        [randomUUID(), 'Journal',                     '📔', '#d97706', 1],
      ].forEach(([id, name, icon, color, target]) => {
        try { insertHabit.run(id, name, icon, color, target); } catch { /* already exists */ }
      });
      log.debug('[Henry] Seeded 5 default habits');
    }
  } catch (e) { console.warn('[Henry] Could not seed habits:', e); }



  // ── Reminder notification poller ─────────────────────────────────────────────
  // Checks every 60 seconds for reminders that are due and haven't been notified.
  // Fires a native macOS notification + marks as notified in SQLite.
  const checkReminders = async () => {
    try {
      const now = new Date().toISOString();
      const due = db.prepare(
        "SELECT * FROM reminders WHERE due_at <= ? AND done=0 AND notified_at IS NULL"
      ).all(now) as { id: string; title: string; notes?: string; due_at: string }[];

      for (const rem of due) {
        // Fire macOS notification
        if (Notification.isSupported()) {
          const n = new Notification({
            title: '⏰ ' + rem.title,
            body: rem.notes || new Date(rem.due_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            silent: false,
          });
          n.show();
          n.on('click', () => {
            const win = getMainWindow();
            if (win) { win.show(); win.focus(); }
            win?.webContents.executeJavaScript(
              'try { window.__useStore?.getState?.()?.setCurrentView?.("reminders"); } catch {}'
            ).catch(() => {});
          });
        }
        // Mark as notified
        db.prepare("UPDATE reminders SET notified_at=? WHERE id=?").run(now, rem.id);
        // Also send to renderer
        getMainWindow()?.webContents.send('reminder:fired', rem);
      }
    } catch (e) {
      console.error('[Henry] Reminder check error:', e);
    }
  };
  // Check every 60 seconds
  setInterval(checkReminders, 60_000);

  // Self-diagnostic — runs on every launch, auto-fixes problems
  setTimeout(async () => {
    try {
      log.debug('[Henry] Running self-diagnostic...');
      const report = await runDiagnostic(true, db); // autoFix=true
      saveReport(db, report);
      const { fixed, failed } = report.summary;
      if (fixed > 0) log.debug(`[Henry] Self-repair: fixed ${fixed} issue(s)`);
      if (failed > 0) log.warn(`[Henry] Self-repair: ${failed} issue(s) need attention`);
      // Notify renderer so Health panel can update
      getMainWindow()?.webContents.send('henry:diagnostic:complete', report);
    } catch (e) {
      console.error('[Henry] Self-diagnostic error:', e);
    }
  }, 5000); // after sync server + tunnel start

  // Self-repair IPC — renderer can trigger and read diagnostics
  ipcMain.handle('henry:diagnostic:run', async () => {
    const report = await runDiagnostic(true, db);
    saveReport(db, report);
    return report;
  });
  ipcMain.handle('henry:diagnostic:last', () => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='last_diagnostic'").get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    } catch { return null; }
  });

  // Native notifications — works even when app is in background
  ipcMain.handle('notification:show', (_e, opts: { title: string; body?: string; silent?: boolean }) => {
    if (Notification.isSupported()) {
      new Notification({
        title: opts.title,
        body: opts.body || '',
        silent: opts.silent ?? false,
      }).show();
    }
  });

  // ── Global hotkeys ───────────────────────────────────────────────────────────
  // SIMPLE: One key to capture anything, one key to open Henry.
  //
  // ⌥Space — Henry Smart Capture  (Option + Space, works in ANY app)
  //   Select text anywhere → hit ⌥Space → Henry grabs it automatically.
  //   No need to ⌘C first. Henry simulates the copy, reads it, restores clipboard.
  //   Then processes it: ideas, prospects, tasks, insights — all extracted.
  //
  // ⌥H     — Open / focus Henry   (Option + H, simple single-modifier)

  // ── HUD window for capture feedback ─────────────────────────────────────────
  let hudWindow: BrowserWindow | null = null;

  function showHUD(text: string, charCount: number) {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.close();
      hudWindow = null;
    }

    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width } = display.workAreaSize;

    hudWindow = new BrowserWindow({
      width: 340,
      height: 68,
      x: width - 360,
      y: 20,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: true,
      webPreferences: { contextIsolation: true },
    });

    const preview = text.length > 55 ? text.slice(0, 55) + '…' : text;
    const html = `<!DOCTYPE html><html><head><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body {
        background: rgba(10,10,18,0.92);
        border: 1px solid rgba(124,58,237,0.4);
        border-radius: 14px;
        font-family: -apple-system, sans-serif;
        overflow: hidden;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        animation: slideIn 0.2s ease;
      }
      @keyframes slideIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
      .row { display:flex; align-items:center; gap:10px; padding:14px 16px; }
      .icon { font-size:20px; flex-shrink:0; }
      .info { flex:1; min-width:0; }
      .title { color:#a78bfa; font-size:11px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; }
      .preview { color:rgba(255,255,255,0.65); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
      .badge { background:rgba(124,58,237,0.25); border:1px solid rgba(124,58,237,0.4); color:#a78bfa; font-size:10px; font-weight:600; padding:2px 7px; border-radius:20px; flex-shrink:0; }
    </style></head><body>
    <div class="row">
      <span class="icon">⚡</span>
      <div class="info">
        <div class="title">Henry captured</div>
        <div class="preview">${preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</div>
      </div>
      <span class="badge">${charCount} chars</span>
    </div>
    </body></html>`;

    hudWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    hudWindow.setIgnoreMouseEvents(false);

    // Auto-close after 2.5 seconds
    setTimeout(() => {
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.close();
        hudWindow = null;
      }
    }, 2500);
  }

  // ── Smart capture function ────────────────────────────────────────────────────
  async function henrySmartCapture() {
    try {
      const { execSync } = await import('child_process');
      const { clipboard: cb } = await import('electron');

      // Save original clipboard
      const originalText = cb.readText();
      const originalHTML = cb.readHTML();

      // Simulate ⌘C to copy whatever is selected in the frontmost app
      // Requires Accessibility. If missing, Henry auto-requests it.
      const hasAccess = systemPreferences.isTrustedAccessibilityClient(false);
      if (!hasAccess) {
        // Auto-trigger the macOS permission dialog — user just clicks OK once
        log.debug('[Henry] Requesting Accessibility for capture…');
        systemPreferences.isTrustedAccessibilityClient(true);
        // Show HUD telling user to click OK
        showHUD('Grant access in the dialog — then try ⌥Space again', 0);
        return;
      }
      try {
        execSync(
          `osascript -e 'tell application "System Events" to keystroke "c" using command down'`,
          { timeout: 500, stdio: 'ignore' }
        );
        // Small delay for clipboard to update
        await new Promise(r => setTimeout(r, 120));
      } catch {
        // AppleScript failed despite permission — use existing clipboard
      }

      const captured = cb.readText().trim();

      // Restore original clipboard if nothing new was captured
      if (!captured || captured === originalText || captured.length < 2) {
        // Fall back to existing clipboard
        const fallback = originalText.trim();
        if (!fallback || fallback.length < 2) {
          // Nothing to capture — just open Henry
          const win = getMainWindow();
          if (win) { win.show(); win.focus(); }
          return;
        }
        // Use existing clipboard content
        await processCapture(fallback, 'clipboard');
        return;
      }

      // Restore original clipboard
      if (originalText) {
        cb.writeText(originalText);
      } else {
        cb.clear();
      }

      await processCapture(captured, 'selection');
    } catch (e) {
      console.error('[Henry] Smart capture error:', e);
    }
  }

  async function processCapture(text: string, source: string) {
    // Show HUD immediately
    showHUD(text, text.length);

    // ── LOCAL pattern matching (FREE, no AI quota) ──────────────────────────
    const looksLikeTask = /^(todo|task|remember to|don't forget|fix|build|write|call|email|send|create|update|check|review|finish|complete|buy|get)/i.test(text);
    const hasTime = /(at|by|before|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+:\d+\s?(am|pm)|\d+(am|pm))/i.test(text);

    if (looksLikeTask && !hasTime && text.length < 120) {
      // Looks like a task — send to renderer to create via IPC (no AI needed)
      showHUD('✓ Task: ' + text.slice(0, 50) + (text.length > 50 ? '…' : ''), 0);
      getMainWindow()?.webContents.send('henry:quick-task', { title: text.slice(0, 200) });
      return;
    }

    // POST to capture-and-process endpoint (non-blocking)
    const http = await import('http');
    const postBody = JSON.stringify({ text, source, context: 'hotkey' });
    const req = http.default.request({
      hostname: '127.0.0.1', port: 4242,
      path: '/sync/capture-and-process',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Henry-Internal': 'true',
        'Content-Length': Buffer.byteLength(postBody),
      },
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(postBody);
    req.end();

    // Navigate to captures in background (don't steal focus unless Henry is open)
    const win = getMainWindow();
    if (win?.isVisible()) {
      win.webContents.executeJavaScript(`
        try {
          if (window.__useStore) window.__useStore.getState().setCurrentView('captures');
        } catch {}
      `).catch(() => {});
    }
  }

  // ── Register hotkeys ──────────────────────────────────────────────────────────

  // macOS: Option+Space (⌥Space), Option+H (⌥H), Cmd+Shift+H (⌘⇧H) backup
  // Linux/Windows: Alt+C capture fallback when Alt+Space is unavailable,
  // Alt+H toggle, Ctrl+Shift+H (or Win+Shift+H) backup.
  const isMac = process.platform === 'darwin';
  const registeredHotkeys: Array<{ accelerator: string; label: string; description: string }> = [];

  // ⌥Space — Smart Capture (primary capture hotkey — simple, one modifier)
  const spaceOk = globalShortcut.register('Alt+Space', () => { void henrySmartCapture(); });
  if (spaceOk) {
    registeredHotkeys.push({ accelerator: 'Alt+Space', label: isMac ? '⌥Space' : 'Alt+Space', description: 'Capture selected text' });
  } else {
    // ⌥Space is taken (Spotlight?) — fall back to ⌥C
    const altCOk = globalShortcut.register('Alt+C', () => { void henrySmartCapture(); });
    if (altCOk) {
      registeredHotkeys.push({ accelerator: 'Alt+C', label: 'Alt+C', description: 'Capture selected text' });
    }
    log.info('[Henry] Alt+Space unavailable — using Alt+C for capture');
  }

  // ⌥H — Open / focus Henry (simple, one key + one modifier)
  const altHOk = globalShortcut.register('Alt+H', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isVisible() && win.isFocused()) {
        win.hide(); // Toggle: if already focused, hide
      } else {
        win.show(); win.focus();
        if (!win.isVisible()) win.restore();
      }
    }
  });
  if (altHOk) {
    registeredHotkeys.push({ accelerator: 'Alt+H', label: isMac ? '⌥H' : 'Alt+H', description: 'Open or hide Henry' });
  }

  // Keep ⌘⇧H as backup for users who prefer it
  const backupOk = globalShortcut.register('CommandOrControl+Shift+H', () => { void henrySmartCapture(); });
  if (backupOk) {
    registeredHotkeys.push({ accelerator: isMac ? 'Command+Shift+H' : 'Control+Shift+H', label: isMac ? '⌘⇧H' : 'Ctrl+Shift+H', description: 'Backup capture (reads clipboard)' });
  }

  // Expose the actually-registered hotkeys to the renderer
  ipcMain.handle('henry:getRegisteredHotkeys', () => registeredHotkeys);

  // Unregister on quit
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    henryScheduler?.shutdown();
    void getMachineManager()?.shutdown();
  });

  // Auto-start sync server so companion devices can connect immediately
  startSyncServer(4242);

  // Auto-start Cloudflare tunnel — self-installing, zero user action required
  setTimeout(async () => {
    try {
      const { execSync, exec } = await import('child_process') as typeof import('child_process');
      const db2 = await import('./ipc/database');
      const currentDb = db2.getDb();

      // Enable tunnel by default on first run
      const tunnelSetting = currentDb.prepare("SELECT value FROM settings WHERE key='auto_tunnel_enabled'").get() as {value:string} | undefined;
      if (tunnelSetting === undefined) {
        currentDb.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('auto_tunnel_enabled','true')").run();
      }
      const autoEnabled = (tunnelSetting?.value ?? 'true') !== 'false';
      if (!autoEnabled) return;

      // Resolve cloudflared through the sync bridge, which knows about the
      // bundled copy AND validates that a binary can actually run on this
      // platform. The old path only looked in PATH and auto-installed via
      // Homebrew, so on Linux/Windows the tunnel never started.
      const { startSyncTunnel } = await import('./ipc/syncBridge');
      const url = await startSyncTunnel(4242);
      if (url) {
        // startSyncTunnel already logs the tunnel URL — keep this one debug-only.
        log.debug('[Henry] Tunnel active:', url);
        currentDb.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('last_tunnel_url',?)").run(url);
        // Notify renderer so companion panel updates
        getMainWindow()?.webContents.send('henry:tunnel:active', { url });
      }
    } catch (e) {
      log.warn('[Henry] Tunnel setup error:', e instanceof Error ? e.message : String(e));
    }
  }, 3000);

  // Check for updates 30 seconds after launch (silently). Packaged builds
  // only — dev builds make electron-updater print a skip warning.
  const updaterFirstTimer = setTimeout(() => {
    if (!app.isPackaged) return;
    try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* ignore */ }
  }, 30_000);

  // R3-Fix 5: keep the interval ref so we can clear it on quit. Electron
  // tears everything down at process exit anyway, but unreferenced
  // long-running intervals make the app harder to test and clean-shutdown.
  const updaterInterval = setInterval(() => {
    if (!app.isPackaged) return;
    try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* ignore */ }
  }, 4 * 60 * 60 * 1000);
  app.on('will-quit', () => {
    clearTimeout(updaterFirstTimer);
    clearInterval(updaterInterval);
  });

  // ── Auto-updater ────────────────────────────────────────────────────────────
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', (info: any) => {
    getMainWindow()?.webContents.send('updater:update-available', info);
  });
  autoUpdater.on('update-not-available', () => {
    // Silently ignore — no need to notify
  });
  autoUpdater.on('download-progress', (progress: any) => {
    getMainWindow()?.webContents.send('updater:progress', progress);
  });
  autoUpdater.on('update-downloaded', () => {
    getMainWindow()?.webContents.send('updater:update-downloaded');
  });
  autoUpdater.on('error', (err: Error) => {
    console.error('[AutoUpdater] Error:', err.message);
  });

  ipcMain.handle('updater:check', () => {
    return autoUpdater.checkForUpdates().catch(() => null);
  });
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Check silently after 10 s so first launch isn't slowed down
  setTimeout(() => {
    if (!app.isPackaged) return;
    autoUpdater.checkForUpdates().catch(() => null);
  }, 10_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  } catch (bootErr) {
    // Boot failed — surface it instead of leaving a windowless zombie process.
    console.error('[Henry:main] Boot failed:', bootErr);
    recordStartupFailure(bootErr);
    dialog.showErrorBox(
      'Henry could not start',
      `Henry failed during startup:\n\n${bootErr instanceof Error ? bootErr.message : String(bootErr)}\n\n` +
      `Your data folder was not modified. Please restart Henry, or reinstall if this keeps happening.`
    );
    app.exit(1);
  }
}).catch((e) => {
  console.error('[Henry:main] app.whenReady() rejected:', e);
  app.exit(1);
});

app.on('will-quit', () => { stopOpencodeBridge(); });

app.on('window-all-closed', () => {
  // All platforms supported — quit on all-windows-closed
});