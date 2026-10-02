/**
 * A tiny async shell runner, split out so the self-repair module can use it
 * without an import cycle. Non-blocking on purpose: the main process must not
 * freeze while a diagnostic probe runs.
 */
import { exec } from 'child_process';

export function runAsync(
  command: string,
  timeoutMs = 5000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A timeout or spawn failure rejects; a non-zero exit does not, because
      // PowerShell frequently exits 0 while having written an error to stdout.
      if (err && !stdout && !stderr) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? 1 : 0 });
    });
  });
}
