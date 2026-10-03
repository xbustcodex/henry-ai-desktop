/**
 * Command-safety classifier for Henry's shell-exec surface.
 *
 * This is defense-in-depth, not a sandbox. A denylist can never be complete,
 * and these commands ultimately run with the user's own privileges. The point
 * is to catch the small set of catastrophic, irreversible commands an AI could
 * be tricked (via prompt injection) into emitting — wiping the disk, formatting
 * a volume, a fork bomb, powering the machine off — so a single bad generation
 * can't brick the user's computer.
 *
 * The old code did `command.toLowerCase().includes('rm -rf /')`, which misses
 * `rm -fr /`, `rm -rf ~`, `rm  -rf  /*`, `rm -r -f /usr`, and everything else.
 * This classifier normalizes whitespace and matches the dangerous *shape*.
 */

export interface CommandVerdict {
  /** True when the command should be refused. */
  blocked: boolean;
  /** Human-readable reason, present when blocked. */
  reason?: string;
}

/** Top-level system directories that should never be recursively force-deleted. */
const SENSITIVE_ROOTS = [
  'etc', 'usr', 'bin', 'sbin', 'lib', 'var', 'opt', 'boot', 'dev', 'proc', 'sys',
  'system', 'users', 'library', 'applications',
];

/**
 * Classify a shell command. Returns `{ blocked: true, reason }` for commands
 * that match a catastrophic pattern, `{ blocked: false }` otherwise.
 *
 * Conservative by design: ordinary project commands (`rm -rf node_modules`,
 * `rm -rf ./build`) are allowed; only deletes targeting `/`, `~`, `*`, `.`,
 * `..`, `$HOME`, or a system root are blocked.
 */
export function classifyCommand(rawCommand: string): CommandVerdict {
  if (!rawCommand || !rawCommand.trim()) return { blocked: false };

  const lower = rawCommand.toLowerCase();
  const compact = lower.replace(/\s+/g, ' ').trim();
  const nospace = lower.replace(/\s+/g, '');

  // Fork bomb — `:(){ :|:& };:` and close variants.
  if (nospace.includes(':(){:|:&};:') || /\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}/.test(compact)) {
    return { blocked: true, reason: 'fork bomb' };
  }

  // Format a filesystem.
  if (/\bmkfs\b/.test(compact)) {
    return { blocked: true, reason: 'mkfs (formats a filesystem)' };
  }

  // Raw writes to a block device.
  if (/\bdd\b[^\n]*\bof=\/dev\//.test(compact)) {
    return { blocked: true, reason: 'dd writing directly to a device' };
  }
  if (/>\s*\/dev\/(sd|disk|nvme|hd|rdisk|mmcblk)/.test(compact)) {
    return { blocked: true, reason: 'redirect overwriting a raw disk device' };
  }

  // Power-state changes.
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(compact)) {
    return { blocked: true, reason: 'power-state change (shutdown/reboot)' };
  }

  // Recursive, forced delete of a sensitive root.
  if (isRecursiveForceDeleteOfRoot(compact)) {
    return { blocked: true, reason: 'recursive force-delete of a system or home root' };
  }

  // ── Windows equivalents ────────────────────────────────────────────────
  // The classifier above is Unix-shaped. On Windows none of it matched, so a
  // forced delete of a system file passed straight through and was only
  // stopped by the filesystem ACL — which is not a boundary, it is luck.
  // `del /f /q <system path>` ran and returned "Access is denied" during the
  // Card 7 walk.
  if (/\bdel\b[^\n]*\/(?:f|force)\b/.test(compact) && /[a-z]:\\|\bwindows\b|\bprogram files\b/.test(compact)) {
    return { blocked: true, reason: 'forced delete of a Windows system path' };
  }
  if (/\bformat\b\s+[a-z]:/.test(compact)) {
    return { blocked: true, reason: 'format of a Windows volume' };
  }
  // `rd`/`rmdir` take SLASH flags on Windows (/s /q), PowerShell takes DASH ones.
  const winRecursiveDelete =
    /\b(rd|rmdir)\b[^\n]*\/s\b/.test(compact) ||
    /\b(remove-item)\b[^\n]*\s-[a-z]*r/i.test(compact);
  if (winRecursiveDelete && /\bwindows\b|\bprogram files\b|[a-z]:\\/.test(compact)) {
    return { blocked: true, reason: 'recursive delete of a Windows system path' };
  }
  if (/\bcipher\b[^\n]*\/(?:w|r)\b/.test(compact)) {
    return { blocked: true, reason: 'wiping free space with cipher' };
  }
  if (/\bvssadmin\b[^\n]*\bdelete\b/.test(compact)) {
    return { blocked: true, reason: 'deleting shadow copies' };
  }
  if (/\bbcdedit\b/.test(compact) || /\bdiskpart\b/.test(compact)) {
    return { blocked: true, reason: 'boot or disk configuration change' };
  }
  // Disabling the firewall or Defender is not a routine thing to do on
  // Henry's behalf.
  if (/\bnetsh\b[^\n]*\badvfirewall\b[^\n]*\b(set|delete)\b/.test(compact)) {
    return { blocked: true, reason: 'firewall configuration change' };
  }
  if (/\bset-mppreference\b[^\n]*-\s*disable/.test(compact)) {
    return { blocked: true, reason: 'disabling Windows Defender' };
  }

  return { blocked: false };
}

/** Convenience boolean wrapper. */
export function isDangerousCommand(rawCommand: string): boolean {
  return classifyCommand(rawCommand).blocked;
}

function isRecursiveForceDeleteOfRoot(compact: string): boolean {
  // Inspect each shell segment independently (split on ; & | && ||) so that a
  // chained command can't hide an `rm` from the matcher.
  const segments = compact.split(/&&|\|\||[;&|]/);
  for (const seg of segments) {
    const m = seg.match(/(^|\s)rm\b(.*)$/);
    if (!m) continue;
    const rest = m[2];

    const hasRecursive = /(^|\s)-[a-z]*r[a-z]*(\s|$)/.test(rest) || /--recursive/.test(rest);
    const hasForce = /(^|\s)-[a-z]*f[a-z]*(\s|$)/.test(rest) || /--force/.test(rest);
    if (!hasRecursive || !hasForce) continue;

    // Everything that isn't a flag is a target.
    const targets = rest.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    for (const raw of targets) {
      const clean = raw.replace(/['"]/g, '');
      if (
        clean === '/' || clean === '/*' ||
        clean === '~' || clean === '~/' || clean.startsWith('~/') ||
        clean === '$home' || clean.startsWith('$home') ||
        clean === '.' || clean === './' ||
        clean === '..' || clean === '../' ||
        clean === '*'
      ) {
        return true;
      }
      // Absolute system root, e.g. /usr, /etc/*, /System/...
      const sysRoot = clean.match(/^\/([a-z]+)(\/|$|\*)/);
      if (sysRoot && SENSITIVE_ROOTS.includes(sysRoot[1])) {
        return true;
      }
    }
  }
  return false;
}
