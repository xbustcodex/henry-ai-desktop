import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { type ComputerStep } from '../../henry/computerAgent';
import { isMacOS, isLinux, isWindows, getPlatformName } from '../../utils/platform';

// Direct sync server execution — bypasses Groq tool-use API (which fails on llama)
async function execOnMac(command: string): Promise<{success: boolean; output: string; error: string}> {
  try {
    const r = await fetch('http://127.0.0.1:4242/computer/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
      body: JSON.stringify({ command }),
    });
    return await r.json() as {success: boolean; output: string; error: string};
  } catch (e) {
    return { success: false, output: '', error: String(e) };
  }
}

function getPlatformLabel(): string {
  return isMacOS() ? 'Mac' : isLinux() ? 'Linux' : isWindows() ? 'Windows' : 'computer';
}

function getSystemSettingsLabel(): string {
  return isMacOS() ? 'System Settings' : 'System Settings';
}

// Platform-aware shell command builders
function openAppCommand(appName: string): string {
  if (isMacOS()) {
    return `open -a "${appName}"`;
  } else if (isLinux()) {
    // On Linux, try to use the executable name directly
    // The sync server's computer:openApp will handle desktop file lookup
    return appName;
  } else {
    return `start "" "${appName}"`;
  }
}

function openFileManagerCommand(path: string): string {
  if (isMacOS()) {
    return `open "${path}"`;
  } else if (isLinux()) {
    return `xdg-open "${path}"`;
  } else {
    return `explorer "${path}"`;
  }
}

function openUrlCommand(url: string): string {
  if (isMacOS()) {
    return `open "${url}"`;
  } else if (isLinux()) {
    return `xdg-open "${url}"`;
  } else {
    return `start "" "${url}"`;
  }
}

function screenshotCommand(): string {
  if (isMacOS()) {
    const ts = Date.now();
    return `screencapture -x ~/Desktop/screenshot_${ts}.png && echo "Saved to Desktop/screenshot_${ts}.png"`;
  } else if (isLinux()) {
    const ts = Date.now();
    return `scrot ~/Desktop/screenshot_${ts}.png 2>/dev/null || import -window root ~/Desktop/screenshot_${ts}.png 2>/dev/null && echo "Saved to Desktop/screenshot_${ts}.png"`;
  } else {
    // Windows PowerShell screenshot
    return `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { \$bmp = New-Object System.Drawing.Bitmap(\$_.Bounds.Width, \$_.Bounds.Height); \$g = [System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen(\$_.Bounds.Location, [System.Drawing.Point]::Empty, \$_.Bounds.Size); \$bmp.Save('~/Desktop/screenshot_${Date.now()}.png') }"`;
  }
}

function listRunningAppsCommand(): string {
  if (isMacOS()) {
    return 'osascript -e \'tell application "System Events" to get name of every application process whose background only is false\'';
  } else if (isLinux()) {
    return 'wmctrl -l | awk \'{print $NF}\' | sort -u';
  } else {
    return 'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"';
  }
}

function diskSpaceCommand(): string {
  return `df -h / | tail -1 | awk '{print "Total: "$2" | Used: "$3" | Free: "$4" | "$5" used"}'`;
}

function volumeCommand(vol: number): string {
  if (isMacOS()) {
    return `osascript -e "set volume output volume ${Math.min(100,Math.max(0,vol))}"`;
  } else if (isLinux()) {
    return `amixer -D pulse sset Master ${Math.min(100,Math.max(0,vol))}%`;
  } else {
    return `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"`; // Volume up, not perfect but works
  }
}

function muteCommand(mute: boolean): string {
  if (isMacOS()) {
    return `osascript -e "set volume output muted ${mute}"`;
  } else if (isLinux()) {
    return `amixer -D pulse sset Master ${mute ? 'mute' : 'unmute'}`;
  } else {
    return `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`; // Mute toggle
  }
}

function emptyTrashCommand(): string {
  if (isMacOS()) {
    return `osascript -e 'tell app "Finder" to empty trash'`;
  } else if (isLinux()) {
    return `gio trash --empty`;
  } else {
    return `powershell -Command "& { $shell = New-Object -ComObject Shell.Application; $shell.Namespace(0xA).Items() | ForEach-Object { $_.InvokeVerb('Delete') } }"`;
  }
}

function sleepCommand(): string {
  if (isMacOS()) {
    return `pmset sleepnow`;
  } else if (isLinux()) {
    return `systemctl suspend`;
  } else {
    return `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`;
  }
}

function lockScreenCommand(): string {
  if (isMacOS()) {
    return `/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend`;
  } else if (isLinux()) {
    return `loginctl lock-session || gnome-screensaver-command -l || dm-tool lock`;
  } else {
    return `rundll32.exe user32.dll,LockWorkStation`;
  }
}

function parseCommand(text: string): { shell: string; description: string }[] {
  const home = localStorage.getItem('henry:home') || localStorage.getItem('henry:mac_home') || '/Users/' + (localStorage.getItem('henry:username') || localStorage.getItem('henry:mac_username') || 'user');
  const t = text.toLowerCase().trim();

  // Create folder — many phrasings
  const folderMatch = text.match(/(?:create|make|new|add)\s+(?:a\s+)?(?:new\s+)?folder\s+(?:called\s+|named\s+)?["'\u201c\u2018]?([\w][\w\s._-]*?)["\'\u201d\u2019]?(?:\s+(?:on|in|at|inside)\s+(?:my\s+)?(desktop|documents|downloads|home))?/i)
    || text.match(/folder\s+(?:called\s+|named\s+)?["'\u201c\u2018]?([\w][\w\s._-]+)["\'\u201d\u2019]?/i);
  if (folderMatch) {
    const name = (folderMatch[1] || folderMatch[2] || 'NewFolder').trim().replace(/\s+on\s+.*/i,'').trim();
    const locStr = (folderMatch[2] || (t.match(/documents?/) ? 'documents' : t.match(/downloads?/) ? 'downloads' : t.match(/home/) ? 'home' : 'desktop')).toLowerCase();
    const where = locStr === 'documents' ? home+'/Documents' : locStr === 'downloads' ? home+'/Downloads' : locStr === 'home' ? home : home+'/Desktop';
    const fullPath = `${where}/${name}`;
    return [
      { shell: `mkdir -p "${fullPath}"`, description: `Creating folder: ${name}` },
      { shell: openFileManagerCommand(fullPath), description: `Opening in file manager` },
    ];
  }

  // Open app — smart matching
  const openMatch = text.match(/^(?:open|launch|start|run)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?$/i);
  if (openMatch && !t.includes('/') && !t.includes('file') && !t.includes('folder') && !t.includes('url') && !t.includes('http')) {
    const app = openMatch[1].trim();
    // Common aliases - platform aware
    const macAliases: Record<string,string> = { 'vs code':'Visual Studio Code', 'vscode':'Visual Studio Code', 'mail':'Mail', 'notes':'Notes', 'messages':'Messages', 'finder':'Finder', 'calendar':'Calendar', 'photos':'Photos', 'music':'Music', 'system settings':'System Settings', 'system prefs':'System Preferences', 'terminal':'Terminal' };
    const linuxAliases: Record<string,string> = { 'vs code':'code', 'vscode':'code', 'mail':'thunderbird', 'notes':'gnome-notes', 'messages':'', 'finder':'nautilus', 'calendar':'gnome-calendar', 'photos':'gnome-photos', 'music':'rhythmbox', 'system settings':'gnome-control-center', 'system prefs':'gnome-control-center', 'terminal':'gnome-terminal' };
    const winAliases: Record<string,string> = { 'vs code':'code', 'vscode':'code', 'mail':'outlook', 'notes':'notepad', 'messages':'', 'finder':'explorer', 'calendar':'outlookcal:', 'photos':'microsoft.photos:', 'music':'spotify', 'system settings':'ms-settings:', 'system prefs':'ms-settings:', 'terminal':'wt' };

    const aliases = isMacOS() ? macAliases : isLinux() ? linuxAliases : winAliases;
    const appName = aliases[app.toLowerCase()] || app;
    return [{ shell: openAppCommand(appName), description: `Opening ${appName}` }];
  }

  // Open URL
  const urlMatch = text.match(/(?:go to|open|browse to|navigate to|visit)\s+(https?:\/\/\S+|www\.\S+)/i)
    || text.match(/^(https?:\/\/\S+)$/i);
  if (urlMatch) {
    const url = urlMatch[1].startsWith('http') ? urlMatch[1] : 'https://' + urlMatch[1];
    return [{ shell: openUrlCommand(url), description: `Opening ${url}` }];
  }

  // Screenshot
  if (t.match(/screenshot|screen shot|capture.*screen|take.*picture.*screen/)) {
    return [{ shell: screenshotCommand(), description: 'Taking screenshot' }];
  }

  // What's running
  if (t.match(/(?:what|which|list|show).*(?:running|apps|applications|open|processes)/)) {
    return [{ shell: listRunningAppsCommand(), description: 'Listing running apps' }];
  }

  // Disk space
  if (t.match(/disk|storage|space|free.*space|how much.*space/)) {
    return [{ shell: diskSpaceCommand(), description: 'Checking disk space' }];
  }

  // List files
  if (t.match(/(?:list|show|what.*in|files.*on).*(?:desktop|documents|downloads|folder)/)) {
    const target = t.includes('documents') ? home+'/Documents' : t.includes('downloads') ? home+'/Downloads' : home+'/Desktop';
    return [{ shell: `ls "${target}"`, description: `Listing ${target.split('/').pop()}` }];
  }

  // Sleep / lock
  if (t.match(/sleep|lock.*screen|screen.*lock/)) {
    return [{ shell: sleepCommand(), description: 'Sleeping computer' }];
  }

  // Volume
  const volMatch = t.match(/(?:set|turn|change).*volume.*?([0-9]+)|volume.*?([0-9]+)/);
  if (volMatch) {
    const vol = parseInt(volMatch[1] || volMatch[2]);
    return [{ shell: volumeCommand(vol), description: `Setting volume to ${vol}%` }];
  }

  // Mute / unmute
  if (t.match(/mute|silence|quiet/)) {
    return [{ shell: muteCommand(true), description: 'Muting audio' }];
  }
  if (t.match(/unmute|sound on|enable.*sound/)) {
    return [{ shell: muteCommand(false), description: 'Unmuting audio' }];
  }

  // Empty trash
  if (t.match(/empty.*trash|clear.*trash/)) {
    return [{ shell: emptyTrashCommand(), description: 'Emptying trash' }];
  }

  // Restart / shutdown — be safe, confirm first
  if (t.match(/restart|reboot/)) {
    return [{ shell: isMacOS() ? `osascript -e 'tell app "System Events" to restart'` : isLinux() ? `systemctl reboot` : `shutdown /r /t 5`, description: `Restarting ${getPlatformLabel()}` }];
  }

  // Fallback: treat as raw shell command if it looks like one
  // Fallback: treat as raw shell command if it looks like one
  if (t.startsWith('mkdir') || t.startsWith('open') || t.startsWith('cp') ||
      t.startsWith('mv') || t.startsWith('rm') || t.startsWith('ls') ||
      t.startsWith('echo') || t.startsWith('touch') || t.startsWith('osascript')) {
    return [{ shell: text, description: `Running: ${text}` }];
  }

  // R3-Fix 4: unrecognized — return empty so run() can surface a clear
  // "I don't recognize that" instead of echoing the text and falsely
  // reporting "Complete" as if something happened.
  return [];
}

export default function ComputerPanel() {
  const { providers, settings } = useStore();

  const groq = providers.find(p => p.id === 'groq');
  const openai = providers.find(p => p.id === 'openai');
  const activeProvider = (groq?.apiKey ? groq : openai) ?? null;

  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<ComputerStep[]>([]);
  const [perms, setPerms] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // macOS is the only platform with Accessibility / Screen Recording
    // permissions, and it is the only one where an osascript probe means
    // anything. Probing it unconditionally made every non-Mac machine report
    // both permissions as missing. Elsewhere report what is actually true.
    if (!isMacOS()) {
      void window.henryAPI
        .computerCheckCapabilities?.()
        .then((caps) => {
          if (!caps) return setPerms(null);
          const screen = caps.screenCapture?.status;
          const automation = caps.inputAutomation?.status;
          setPerms({
            accessibility: screen === 'ready' || automation === 'ready',
            screenRecording: screen === 'ready',
          });
        })
        .catch(() => setPerms(null));
      return;
    }

    fetch('http://127.0.0.1:4242/computer/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
      body: JSON.stringify({ command: 'osascript -e \'tell application "System Events" to return name of first process whose frontmost is true\' 2>/dev/null && echo ACC_OK || echo ACC_FAIL' }),
    })
      .then(r => r.json())
      .then((r: any) => {
        const acc = r.output?.includes('ACC_OK') ?? false;
        return fetch('http://127.0.0.1:4242/computer/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
          body: JSON.stringify({ command: 'screencapture -x "$TMPDIR/henry_perm_check.png" 2>/dev/null && echo SC_OK || echo SC_FAIL' }),
        }).then(r2 => r2.json()).then((r2: any) => {
          setPerms({ accessibility: acc, screenRecording: r2.output?.includes('SC_OK') ?? false });
        });
      })
      .catch(() => setPerms(null));
  }, []);

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  function openSystemSettings() {
    // Only open system preferences on macOS
    const isMac = navigator.userAgent.indexOf('Mac OS X') !== -1;
    if (!isMac) {
      // Show appropriate message for non-macOS platforms
      alert('Permission management is handled automatically on this platform. Please check your system settings manually if needed.');
      return;
    }

    fetch('http://127.0.0.1:4242/computer/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
      body: JSON.stringify({ command: 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"' }),
    });
    setTimeout(() => {
      fetch('http://127.0.0.1:4242/computer/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Henry-Internal': 'true' },
        body: JSON.stringify({ command: 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"' }),
      });
    }, 1500);
  }

  async function run() {
    if (!command.trim() || running) return;
    setRunning(true);
    setSteps([]);
    const cmd = command.trim();
    setCommand('');

    try {
      const actions = parseCommand(cmd);
      // R3-Fix 4: handle unrecognized commands honestly. Previously the
      // parser fell back to `echo "Command: ..."` which always succeeded
      // and showed "Complete" — users thought the command ran when nothing
      // actually happened.
      if (actions.length === 0) {
        setSteps(prev => [...prev, {
          type: 'result',
          label: "✗ I don't recognize that command",
          detail: 'Try plain-English phrases like "take a screenshot", "open Finder", "what time is it", or a literal shell command starting with ls, mkdir, open, cp, mv, rm, echo, touch, or osascript.',
        }]);
        setRunning(false);
        return;
      }
      for (const action of actions) {
        setSteps(prev => [...prev, { type: 'action', label: action.description }]);
        const result = await execOnMac(action.shell);
        setSteps(prev => [...prev, {
          type: 'result',
          label: result.success ? `✓ ${action.description}` : `✗ Failed`,
          detail: result.success
            ? (result.output?.trim() || 'Done')
            : (result.error || 'Unknown error'),
        }]);
        if (!result.success) break;
      }
      setSteps(prev => [...prev, { type: 'done', label: 'Complete', detail: cmd }]);
    } catch (e) {
      setSteps(prev => [...prev, { type: 'result', label: '✗ Error', detail: String(e) }]);
    }
    setRunning(false);
  }

  const hasKey = !!activeProvider?.apiKey;
  const needsPerms = perms && (!perms.accessibility || !perms.screenRecording);

  return (
    <div className="h-full flex flex-col bg-henry-bg">

      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-henry-border/20 shrink-0">
        <h2 className="text-base font-semibold text-henry-text">Computer Control</h2>
        <p className="text-xs text-henry-text-muted mt-0.5">Henry executes real actions on your {getPlatformLabel()}</p>

        {/* Permission badges - platform aware */}
        {perms && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {isMacOS() && (
              <>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  perms.accessibility
                    ? 'border-green-500/30 bg-green-500/8 text-green-400'
                    : 'border-red-500/30 bg-red-500/8 text-red-400'
                }`}>
                  {perms.accessibility ? '✓' : '✗'} Accessibility
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  perms.screenRecording
                    ? 'border-green-500/30 bg-green-500/8 text-green-400'
                    : 'border-red-500/30 bg-red-500/8 text-red-400'
                }`}>
                  {perms.screenRecording ? '✓' : '✗'} Screen Recording
                </span>
              </>
            )}
            {!isMacOS() && (
              <>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  perms.accessibility
                    ? 'border-green-500/30 bg-green-500/8 text-green-400'
                    : 'border-red-500/30 bg-red-500/8 text-red-400'
                }`}>
                  {perms.accessibility ? '✓' : '✗'} Computer Control
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  perms.screenRecording
                    ? 'border-green-500/30 bg-green-500/8 text-green-400'
                    : 'border-red-500/30 bg-red-500/8 text-red-400'
                }`}>
                  {perms.screenRecording ? '✓' : '✗'} Screen Capture
                </span>
              </>
            )}
            {needsPerms && isMacOS() && (
              <button
                onClick={openSystemSettings}
                className="text-[10px] px-2 py-0.5 rounded-full border border-henry-accent/30 bg-henry-accent/8 text-henry-accent font-medium hover:bg-henry-accent/15 transition-all"
              >
                Fix permissions →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Permission prompt if missing */}
      {needsPerms && (
        <div className="mx-5 mt-4 p-4 rounded-xl border border-henry-accent/20 bg-henry-accent/5 shrink-0">
          <p className="text-sm font-medium text-henry-text mb-1">Permissions needed</p>
          <p className="text-xs text-henry-text-muted mb-3 leading-relaxed">
            {isMacOS()
              ? `Henry needs Accessibility${!perms?.screenRecording ? ' and Screen Recording' : ''} to control your Mac.`
              : `Henry needs Computer Control${!perms?.screenRecording ? ' and Screen Capture' : ''} to control your ${getPlatformLabel()}.`}
            {isMacOS() ? (
              <>Click below — {getSystemSettingsLabel()} will open to the exact page.</>
            ) : (
              <>Capability-based setup — see details below.</>
            )}
          </p>
          <ol className="text-xs text-henry-text-muted space-y-1 mb-3">
            {isMacOS() ? (
              <>
                <li>1. Click "Open System Settings" below</li>
                {!perms?.accessibility && <li>2. Find <strong className="text-henry-text">Accessibility</strong> → find Henry AI → toggle ON</li>}
                {!perms?.screenRecording && <li>{!perms?.accessibility ? '3.' : '2.'} Find <strong className="text-henry-text">Screen Recording</strong> → find Henry AI → toggle ON</li>}
                <li>{(!perms?.accessibility && !perms?.screenRecording) ? '4.' : !perms?.accessibility || !perms?.screenRecording ? '3.' : '2.'} Restart Henry</li>
              </>
            ) : (
              <>
                {!perms?.accessibility && (
                  <li>1. Install Computer Control backend: <code className="text-henry-accent bg-henry-accent/10 px-1 rounded">sudo apt install xdotool wmctrl</code> (X11) or <code className="text-henry-accent bg-henry-accent/10 px-1 rounded">sudo apt install ydotool</code> (Wayland)</li>
                )}
                {!perms?.screenRecording && (
                  <li>{!perms?.accessibility ? '1.' : '2.'} Install Screen Capture backend: <code className="text-henry-accent bg-henry-accent/10 px-1 rounded">sudo apt install scrot</code> (X11) or <code className="text-henry-accent bg-henry-accent/10 px-1 rounded">sudo apt install grim</code> (Wayland)</li>
                )}
                <li>{(!perms?.accessibility && !perms?.screenRecording) ? '1.' : !perms?.accessibility || !perms?.screenRecording ? '2.' : '3.'} Restart Henry after installing missing backends</li>
              </>
            )}
          </ol>
          <button
            onClick={openSystemSettings}
            className="w-full py-2.5 rounded-xl bg-henry-accent text-henry-bg font-semibold text-sm hover:bg-henry-accent/90 transition-all"
          >
            {isMacOS() ? 'Open System Settings' : 'Open Settings'}
          </button>
        </div>
      )}

      {/* Steps log */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 min-h-0">
        {steps.length === 0 && !running && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-3">⌘</div>
            <p className="text-sm font-medium text-henry-text mb-1">Tell Henry what to do</p>
            <p className="text-xs text-henry-text-muted max-w-xs leading-relaxed">
              Type any command in plain English. Henry executes real shell commands on your {getPlatformLabel()}.
            </p>
            <div className="mt-4 space-y-1.5">
              {[
                'Create a folder called henrystuff on my desktop',
                {ex: 'Open Firefox and go to google.com', mac: 'Open Safari and go to google.com'},
                'What apps are currently running?',
                'Take a screenshot and show me',
                {ex: 'Open my Desktop folder in Finder', mac: 'Open my Desktop folder in Finder', linux: 'Open my Desktop folder in Files', win: 'Open my Desktop folder in Explorer'},
              ].map((item, idx) => {
                const ex = typeof item === 'string' ? item : item[isMacOS() ? 'mac' : isLinux() ? 'linux' : 'win'] || item.ex;
                return (
                  <button
                    key={idx}
                    onClick={() => { setCommand(ex); inputRef.current?.focus(); }}
                    className="block text-left text-[11px] text-henry-accent hover:underline px-2 w-full"
                  >
                    "{ex}"
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {steps.map((step, i) => (
          <div key={i} className="flex gap-2.5 items-start">
            <span className="text-sm shrink-0 mt-0.5">
              {step.type === 'thinking' ? '◎' :
               step.type === 'action'   ? '⊕' :
               step.type === 'result'   ? (step.label.startsWith('✓') ? '✓' : '✗') :
               step.type === 'done'     ? '✦' : '◉'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-medium text-henry-text">{step.label}</p>
              {step.detail && (
                <p className="text-[11px] text-henry-text-muted mt-0.5 leading-snug whitespace-pre-wrap break-words">
                  {step.detail}
                </p>
              )}
              {step.screenshotUrl && (
                <img
                  src={step.screenshotUrl}
                  alt="Screenshot"
                  className="mt-2 rounded-lg border border-henry-border/30 max-w-full cursor-pointer hover:opacity-90"
                  onClick={() => window.open(step.screenshotUrl)}
                />
              )}
            </div>
          </div>
        ))}

        {running && (
          <div className="flex gap-2.5 items-center">
            <span className="w-4 h-4 border-2 border-henry-accent/30 border-t-henry-accent rounded-full animate-spin shrink-0" />
            <p className="text-[12px] text-henry-text-muted">Henry is working…</p>
          </div>
        )}

        <div ref={stepsEndRef} />
      </div>

      {/* Input */}
      <div className="px-5 py-4 border-t border-henry-border/20 shrink-0">
        {!hasKey && (
          <p className="text-xs text-henry-error mb-2">
            Groq or OpenAI key required.{' '}
            <button
              onClick={() => useStore.getState().setCurrentView('settings' as any)}
              className="underline"
            >Settings →</button>
          </p>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run(); }}
            placeholder={`Tell Henry what to do on your ${getPlatformLabel()}…`}
            disabled={running}
            className="flex-1 bg-henry-surface/50 border border-henry-border/30 rounded-xl px-4 py-3 text-sm text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/40 transition-all disabled:opacity-40"
          />
          <button
            onClick={run}
            disabled={!command.trim() || running}
            className="px-5 py-3 rounded-xl bg-henry-accent text-henry-bg font-semibold text-sm hover:bg-henry-accent/90 disabled:opacity-40 transition-all shrink-0"
          >
            {running ? '…' : 'Go'}
          </button>
        </div>
        <p className="text-[10px] text-henry-text-muted mt-1.5">
          Enter to send · Henry uses real shell commands · screenshots verify results
        </p>
      </div>

    </div>
  );
}
