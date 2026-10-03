/**
 * consoleCapture.ts — route the main process's existing logging into the
 * redacting app log.
 *
 * ## Why intercept rather than ask every module to log
 *
 * Henry already logs through `lib/log.ts` (`log.info`, `log.warn`, `log.error`)
 * and, in a few places, straight to `console`. That output goes to stdout, which
 * on a packaged Windows/macOS build lands in a console the user cannot open. So
 * there was no way to answer "what happened at 3pm" from inside the app.
 *
 * Rewriting every call site to use a new API would touch dozens of files owned
 * by other agents, and would silently skip any site added later. Wrapping the
 * four console methods once means every existing log line is captured, every
 * future one is captured automatically, and nothing in the codebase has to know
 * this module exists.
 *
 * ## Redaction is inherited, not reimplemented
 *
 * Captured lines go through `capture()`, which applies the same redaction — and
 * therefore the same `registerSecret` set — as anything written explicitly. A
 * Discord bot token that Integrations registers is redacted here for the same
 * reason a provider key is: the value is opaque, so no pattern rule would ever
 * match it, only the literal comparison will.
 *
 * This is also why an error envelope that happens to contain a secret cannot
 * leak: anything reaching `console.error` — including the stringified error a
 * handler returns — passes through `capture()` on its way to being stored.
 */
import { capture, type LogLevel } from './appLog';

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

/** Levels that are always worth keeping; `debug` is filtered by the caller. */
const ALWAYS_KEEP: ReadonlySet<LogLevel> = new Set(['info', 'warn', 'error']);

let installed = false;
let includeDebug = false;

/**
 * Capture `console.debug` too.
 *
 * Off by default because debug output is chatty and the main process only emits
 * it under HENRY_DEBUG anyway; a user browsing the log wants signal, not the
 * boot transcript.
 */
export function setCaptureDebug(enabled: boolean): void {
  includeDebug = enabled;
}

/**
 * Flatten console arguments into one line.
 *
 * Errors are handled specially: `console.error(new Error('x'))` stringifies to
 * "Error: x" on most runtimes, but a custom error can carry a `stack` that
 * holds the real message — and it is the message that may contain a secret, so
 * the stack is preferred where present.
 */
function format(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.stack || `${a.name}: ${a.message}`);
    } else if (typeof a === 'string') {
      parts.push(a);
    } else {
      try {
        parts.push(JSON.stringify(a) ?? String(a));
      } catch {
        // A circular or otherwise unserialisable value must not break logging.
        parts.push(String(a));
      }
    }
  }
  return parts.join(' ');
}

/**
 * A short scope derived from the call site, so the log is filterable.
 *
 * Best-effort by design: reading a stack frame is cheap but not free, and a
 * missing scope degrades the log rather than breaking it.
 */
function inferScope(): string {
  try {
    const stack = new Error().stack;
    if (!stack) return '';
    // [0] this fn, [1] the console proxy, [2] the caller.
    const line = stack.split('\n')[3] || '';
    const m = /\(?([^()/\\]+).ts:(\d+):\d+\)?$/.exec(line.trim());
    return m ? `${m[1]}:${m[2]}` : '';
  } catch {
    return '';
  }
}

/**
 * Install the interceptor. Idempotent — a second call does not double-wrap,
 * which would double every line.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  for (const method of ['debug', 'info', 'warn', 'error'] as ConsoleMethod[]) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      // Always write through to the real console first: if formatting a log
      // line were to throw, the app must still behave normally.
      original(...args);
      try {
        const level: LogLevel = method === 'debug' ? 'debug' : method;
        if (level === 'debug' && !includeDebug) return;
        // `console.log` is aliased onto `info` by Node, so it is captured there.
        capture(level, inferScope(), format(args));
      } catch {
        /* a logging failure must never propagate into the caller's work */
      }
    };
  }
}

/** Remove the interceptor. Test seam. */
export function __uninstallConsoleCapture(): void {
  installed = false;
}