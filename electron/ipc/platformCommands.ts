/**
 * Henry AI — Cross-Platform Command Abstraction
 * Provides Mac / Windows / Linux equivalents for every system command Henry uses.
 * Import this wherever platform-specific shell commands are needed.
 */
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export const IS_MAC   = process.platform === 'darwin';
export const IS_WIN   = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

const SHELL_OPT = IS_WIN ? { shell: true } : { shell: '/bin/bash' };
// R4-Fix 3: explicit cast — execSync's options type expects shell as
// `string | undefined`, but Node accepts `true` on Windows (uses default
// cmd.exe). The branching breaks the type narrowing, so we coerce.
const enc  = (t = 3000): ExecSyncOptionsWithStringEncoding =>
  ({ encoding: 'utf8', timeout: t, ...(IS_WIN ? { shell: true } : { shell: '/bin/bash' }) }) as ExecSyncOptionsWithStringEncoding;

/** Safely run a command; return '' on failure */
export function tryExec(cmd: string, timeoutMs = 4000): string {
  try { return execSync(cmd, enc(timeoutMs)).trim(); } catch { return ''; }
}

// ── Paths ─────────────────────────────────────────────────────────────────────
export const desktopPath  = () => path.join(os.homedir(), 'Desktop');
export const downloadPath = () => path.join(os.homedir(), 'Downloads');
export const docPath      = () => path.join(os.homedir(), 'Documents');

/** Reveal a file in Finder (Mac), Explorer (Win), or Files (Linux) */
export function revealFile(p: string): string {
  if (IS_MAC) return `open -R "${p}"`;
  if (IS_WIN) return `explorer /select,"${p.replace(/\//g, '\\')}"`;
  return `xdg-open "${path.dirname(p)}"`;
}

/** Open a URL in the default browser */
export function openUrl(url: string): string {
  if (IS_MAC)   return `open "${url}"`;
  if (IS_WIN)   return `start "" "${url}"`;
  return `xdg-open "${url}"`;
}

/** Open an application by name */
export function openAppCmd(appName: string): string {
  const escapedApp = appName.replace(/"/g, '\\"');
  if (IS_MAC) {
    // For Finder specifically, just open it without -a
    if (escapedApp.toLowerCase() === 'finder') {
      return 'open';
    }
    return `open -a "${escapedApp}"`;
  }
  if (IS_WIN) {
    // For Windows, use start command
    return `start "" "${escapedApp}"`;
  }
  // Linux and others
  // Try common desktop file locations first, then fallback to executable in PATH
  return `xdg-open "${escapedApp}" 2>/dev/null || which "${escapedApp}" && "${escapedApp}" &`;
}

// ── Volume ────────────────────────────────────────────────────────────────────
/** Get current volume (0–100) as a string */
export function getVolumeCmd(): string {
  if (IS_MAC)   return `osascript -e "output volume of (get volume settings)"`;
  if (IS_WIN)   return `powershell -NoProfile -c "(New-Object -ComObject WScript.Shell).SendKeys([char]173); [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; 0"`;
  return `amixer sget Master 2>/dev/null | grep -oP '\\d+(?=%)' | head -1`;
}

/** Set volume to pct (0–100) */
export function setVolumeCmd(pct: number): string {
  const n = Math.min(100, Math.max(0, Math.round(pct)));
  if (IS_MAC)   return `osascript -e "set volume output volume ${n}"`;
  if (IS_WIN)   return `powershell -NoProfile -c "$obj = New-Object -ComObject WScript.Shell; for(\$i=0;\$i -lt 50;\$i++){\$obj.SendKeys([char]174)}; \$v = [Math]::Round(${n}/2); for(\$i=0;\$i -lt \$v;\$i++){\$obj.SendKeys([char]175)}"`;
  return `amixer sset Master ${n}%`;
}

/** Mute */
export function muteCmd(): string {
  if (IS_MAC)   return `osascript -e "set volume with output muted"`;
  if (IS_WIN)   return `powershell -NoProfile -c "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`;
  return `amixer sset Master mute`;
}

/** Unmute */
export function unmuteCmd(): string {
  if (IS_MAC)   return `osascript -e "set volume without output muted"`;
  if (IS_WIN)   return `powershell -NoProfile -c "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`;
  return `amixer sset Master unmute`;
}

// ── Brightness ────────────────────────────────────────────────────────────────
/** Set brightness 0.0–1.0 */
export function setBrightnessCmd(level: number): string {
  const pct = Math.min(100, Math.max(0, Math.round(level * 100)));
  if (IS_MAC)   return `brightness ${level.toFixed(2)}`;
  if (IS_WIN)   return `powershell -NoProfile -c "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${pct})"`;
  return `brightnessctl set ${pct}%`;
}

/** Get current brightness (returns float 0.0–1.0 as string) */
export function getBrightnessCmd(): string {
  if (IS_MAC)   return `brightness -l 2>/dev/null | grep -oE '[0-9.]+ \\(display' | grep -oE '^[0-9.]+'`;
  if (IS_WIN)   return `powershell -NoProfile -c "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness"`;
  return `cat /sys/class/backlight/*/brightness 2>/dev/null | head -1`;
}

// ── Power / Session ───────────────────────────────────────────────────────────
export function sleepCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to sleep"`;
  if (IS_WIN)   return `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`;
  return `systemctl suspend`;
}

export function lockScreenCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to keystroke \\"q\\" using {command down, control down}"`;
  if (IS_WIN)   return `rundll32.exe user32.dll,LockWorkStation`;
  return `loginctl lock-session`;
}

export function restartCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to restart"`;
  if (IS_WIN)   return `shutdown /r /t 5`;
  return `shutdown -r now`;
}

export function shutdownCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to shut down"`;
  if (IS_WIN)   return `shutdown /s /t 5`;
  return `shutdown -h now`;
}

// ── Battery ───────────────────────────────────────────────────────────────────
/** Returns "80% — charging ⚡" style string */
export function getBatteryInfo(): string {
  try {
    if (IS_MAC) {
      const raw = tryExec('pmset -g batt', 3000);
      const pct  = (raw.match(/(\d+)%/) || ['', '?'])[1];
      const chg  = raw.includes('charging') ? 'charging ⚡' : raw.includes('discharging') ? 'on battery' : 'charged';
      const time = (raw.match(/(\d+:\d+) remaining/) || ['', ''])[1];
      return `${pct}% — ${chg}${time ? ` — ${time} remaining` : ''}`;
    }
    if (IS_WIN) {
      const raw = tryExec('WMIC Path Win32_Battery Get EstimatedChargeRemaining,BatteryStatus /value', 4000);
      const pct = (raw.match(/EstimatedChargeRemaining=(\d+)/) || ['', '?'])[1];
      const stat = (raw.match(/BatteryStatus=(\d)/) || ['', '2'])[1];
      const chg = stat === '2' ? 'charging ⚡' : stat === '1' ? 'on battery' : 'charged';
      return `${pct}% — ${chg}`;
    }
    // Linux
    const pct = tryExec('cat /sys/class/power_supply/BAT*/capacity 2>/dev/null | head -1');
    const status = tryExec('cat /sys/class/power_supply/BAT*/status 2>/dev/null | head -1');
    return `${pct || '?'}% — ${(status || 'unknown').toLowerCase()}`;
  } catch { return 'Battery info unavailable'; }
}

// ── Disk ──────────────────────────────────────────────────────────────────────
/** Returns { used, free, total } human-readable strings */
export function getDiskInfo(): { used: string; free: string; total: string } {
  try {
    if (IS_MAC || IS_LINUX) {
      const parts = tryExec('df -h / | tail -1').split(/\s+/);
      return { total: parts[1] || '?', used: parts[2] || '?', free: parts[3] || '?' };
    }
    // Windows — query C: drive
    const raw = tryExec('powershell -NoProfile -c "$d=Get-PSDrive C; Write-Output ($d.Used,$d.Free)"', 5000);
    const nums = raw.trim().split('\n').map((n: string) => parseInt(n.trim()));
    const fmt = (n: number) => n > 1e9 ? (n/1e9).toFixed(1)+'G' : (n/1e6).toFixed(0)+'M';
    return { used: fmt(nums[0]||0), free: fmt(nums[1]||0), total: fmt((nums[0]||0)+(nums[1]||0)) };
  } catch { return { used: '?', free: '?', total: '?' }; }
}

// ── Printers ─────────────────────────────────────────────────────────────────
export function listPrintersCmd(): string {
  if (IS_MAC || IS_LINUX) return `lpstat -p 2>/dev/null`;
  return `powershell -NoProfile -c "Get-Printer | Select-Object -ExpandProperty Name"`;
}

export function getDefaultPrinterCmd(): string {
  if (IS_MAC || IS_LINUX) return `lpstat -d 2>/dev/null | grep -oE ' [^ ]+$'`;
  return `powershell -NoProfile -c "(Get-WmiObject -Class Win32_Printer | Where-Object {$_.Default}).Name"`;
}

/** Print a file — returns the shell command */
export function printFileCmd(filePath: string, printerName?: string): string {
  if (IS_MAC || IS_LINUX) {
    const dest = printerName ? `-d "${printerName}"` : '';
    return `lp ${dest} "${filePath}" 2>/dev/null`;
  }
  // Windows: open in default print dialog
  return `powershell -NoProfile -c "Start-Process -FilePath '${filePath}' -Verb Print"`;
}

// ── Screenshot ────────────────────────────────────────────────────────────────
export function screenshotCmd(outPath: string, format: 'png' | 'jpg' | 'jpeg' = 'png'): string {
  // Ensure the outPath has the correct extension
  const ext = format === 'png' ? 'png' : 'jpg';
  const pathWithExt = outPath.endsWith(`.${ext}`) ? outPath : `${outPath}.${ext}`;

  if (IS_MAC) {
    return `screencapture -x -t ${ext} "${pathWithExt}"`;
  }
  if (IS_WIN) {
    const esc = pathWithExt.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `powershell -NoProfile -c "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${esc}')"`;
  }
  // Linux: use scrot or import, both respect file extension for format
  return `import -window root "${pathWithExt}" 2>/dev/null || scrot "${pathWithExt}" 2>/dev/null`;
}

// ── Running apps ──────────────────────────────────────────────────────────────
export function listAppsCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to get name of every process whose background only is false"`;
  if (IS_WIN)   return `powershell -NoProfile -c "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"`;
  return `wmctrl -l 2>/dev/null | awk '{for(i=5;i<=NF;i++) printf $i" "; print ""}' | sort -u | head -20`;
}

/** Quit/kill an app by name */
export function quitAppCmd(appName: string): string {
  if (IS_MAC)   return `osascript -e "tell application \\"${appName.replace(/"/g, '\\"')}\\" to quit"`;
  if (IS_WIN)   return `taskkill /IM "${appName}.exe" /F 2>nul || taskkill /IM "${appName}" /F 2>nul`;
  return `pkill -f "${appName}"`;
}

// ── System info ───────────────────────────────────────────────────────────────
export function getOsVersion(): string {
  try {
    if (IS_MAC)   return tryExec('sw_vers -productVersion');
    if (IS_WIN)   return tryExec('powershell -NoProfile -c "[System.Environment]::OSVersion.Version"');
    return tryExec('uname -r');
  } catch { return process.platform; }
}

export function getChipInfo(): string {
  try {
    if (IS_MAC)   return tryExec('sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model');
    if (IS_WIN)   return tryExec('powershell -NoProfile -c "(Get-WmiObject Win32_Processor).Name"');
    return tryExec('cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2');
  } catch { return 'Unknown CPU'; }
}

export function getHostname(): string {
  return os.hostname().replace(/\.local$/, '');
}

/** Get primary non-internal IPv4 address */
export function getIPAddressCmd(): string {
  if (IS_MAC) {
    // Try common interface names in order of preference
    return `ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || ipconfig getifaddr en2 2>/dev/null || ipconfig getifaddr en3 2>/dev/null || ipconfig getifaddr en4 2>/dev/null`;
  }
  if (IS_WIN) {
    // Get IPv4 address, excluding virtual adapters
    return `for /f "tokens=2 delims=:" %i in ('ipconfig ^| findstr /r /c:"IPv4" ^| findstr /v /c:"169.254" ^| findstr /v /c:"127.0.0.1" ^| findstr /v /c:"Teredo" ^| findstr /v /c:"Bluetooth" ^| findstr /v /c:"vEthernet"') do echo %i`;
  }
  // Linux and others
  return `hostname -I 2>/dev/null | awk '{print $1}'`;
}

/** Show a notification with title and optional body */
export function showNotificationCmd(title: string, body?: string): string {
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body?.replace(/"/g, '\\"') ?? '';

  if (IS_MAC) {
    return `osascript -e 'display notification "${escapedBody}" with title "${escapedTitle}"'`;
  }
  if (IS_WIN) {
    // Use PowerShell with BurntToast if available, fallback to simple message box
    const psTitle = escapedTitle.replace(/"/g, '`"');
    const psBody = escapedBody.replace(/"/g, '`"');
    return `powershell -Command "if (Get-Module -ListAvailable -Name BurntToast) { Import-Module BurntToast; New-BurntToastNotification -Text '${psTitle}', '${psBody}' -Silent } else { [reflection.assembly]::loadwithpartialname('System.Windows.Forms') | out-null; [system.windows.forms.messagebox]::show('${psBody}', '${psTitle}') }"`;
  }
  // Linux and others
  return `notify-send "${escapedTitle}" "${escapedBody}" 2>/dev/null || true`;
}

/** Resize image while maintaining aspect ratio (similar to sips -Z) */
export function resizeImageCmd(inputPath: string, outputPath: string, maxDimension: number): string {
  if (IS_MAC) {
    return `sips -Z ${maxDimension} "${inputPath}" --out "${outputPath}" 2>/dev/null || true`;
  }
  if (IS_WIN) {
    // PowerShell image resizing using System.Drawing
    const escInput = inputPath.replace(/"/g, '`"');
    const escOutput = outputPath.replace(/"/g, '`"');
    return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${escInput}'); $ratio = Math.Min(${maxDimension} / $img.Width, ${maxDimension} / $img.Height); $newWidth = [int]($img.Width * $ratio); $newHeight = [int]($img.Height * $ratio); $thumb = New-Object System.Drawing.Bitmap $newWidth, $newHeight; $g = [System.Drawing.Graphics]::FromImage($thumb); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($img, 0, 0, $newWidth, $newHeight); $thumb.Save('${escOutput}'); $img.Dispose(); $thumb.Dispose(); $g.Dispose()"`;
  }
  // Linux and others - use ImageMagick convert or mogrify
  return `convert "${inputPath}" -resize ${maxDimension}x${maxDimension}\\> "${outputPath}" 2>/dev/null || mogrify -path "${outputPath}" -resize ${maxDimension}x${maxDimension}\\> "${inputPath}" 2>/dev/null || true`;
}

// ── Startup items ─────────────────────────────────────────────────────────────
export function getStartupItemsCmd(): string {
  if (IS_MAC)   return `osascript -e "tell application \\"System Events\\" to get the name of every login item"`;
  if (IS_WIN)   return `powershell -NoProfile -c "Get-CimInstance Win32_StartupCommand | Select-Object -ExpandProperty Name"`;
  return `ls ~/.config/autostart 2>/dev/null | sed 's/\\.desktop$//'`;
}

// ── Cloudflared ───────────────────────────────────────────────────────────────
export function getCloudflaredPath(): string {
  try {
    if (IS_WIN) {
      const p = tryExec('where cloudflared 2>nul');
      return p || '';
    }
    return tryExec('which cloudflared');
  } catch { return ''; }
}

export function installCloudflaredHint(): string {
  if (IS_MAC)   return 'brew install cloudflared';
  if (IS_WIN)   return 'winget install Cloudflare.cloudflared  (or download from cloudflare.com/products/tunnel)';
  return 'sudo apt-get install cloudflared';
}
