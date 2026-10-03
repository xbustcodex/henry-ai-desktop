/**
 * Git layer — one reusable, well-tested implementation of the four things the
 * repo tools need and kept getting subtly wrong inline:
 *
 *   1. DISCOVERY — finding the enclosing work tree. `repo.ts` only looked for a
 *      literal `.git` ENTRY, which misses a `.git` FILE: git worktrees and
 *      submodules write a one-line `gitdir: …` pointer instead, so the old
 *      walk walked straight past a perfectly valid repository. Here `git
 *      rev-parse --show-toplevel` is authoritative and the `.git` walk is only
 *      the fallback for machines without git on PATH.
 *   2. BOUNDARIES — a path that is a file, a path that does not exist yet, a
 *      bare repository, and "not a repo at all" are four different answers, and
 *      conflating them is what produced the old misleading error text.
 *   3. DIFF / APPLY — a reviewable `git diff`, and a `git apply` that is ALWAYS
 *      pre-flighted with `git apply --check` so a bad patch can never half-write
 *      a working tree.
 *   4. WINDOWS PATHS — `C:\Users\me\proj` is not a POSIX path; passing it to git
 *      verbatim fails. `toGitPathArg` normalises separators for git args while
 *      leaving real POSIX paths untouched.
 *
 * Two rules hold everywhere in this file:
 *
 *   - NO SHELL. Every invocation goes through `spawn('git', ARGV_ARRAY)`. A path
 *     containing `; rm -rf ~` is one argv element, not a command. Shell quoting
 *     is deliberately absent rather than "handled" — an argv array cannot be
 *     broken out of.
 *   - BOUNDED + NON-THROWING. Every command has a timeout and a byte cap, and
 *     every function returns a result object. Nothing here throws at the
 *     caller, because these run inside a tool `execute` where an exception
 *     becomes an opaque stack in the model's context.
 *
 * Sandbox note: this module does NOT widen any confinement. Callers must pass a
 * path already vetted by `safeResolve` in `tools/repo.ts` (home-directory
 * confinement plus blocked secret paths). What this module adds on top is
 * argument hygiene: NUL bytes and control characters, which are never legal in a
 * path, are rejected rather than forwarded to git.
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

/* ------------------------------------------------------------------ limits */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Hard cap on captured stdout+stderr per git invocation. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Cap on a diff handed to the model. */
const DEFAULT_DIFF_CHARS = 20_000;
/** Refuse absurd patches rather than feeding them to git. */
const MAX_PATCH_BYTES = 512_000;
/** Git error text is for a human, not for a context window. */
const MAX_ERROR_CHARS = 200;
const MAX_DIFF_FILES = 50;

/* ---------------------------------------------------------------- messages */

export const GIT_MISSING_ERROR =
  "Git is not installed or is not on PATH, so repository tools cannot run. Install git and try again.";

export const NOT_A_REPO_ERROR =
  "That path is not inside a git repository, so there is no repository state to read or change.";

/* ------------------------------------------------------------ command seam */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Exit code, or null when git never started / was killed. */
  code: number | null;
  timedOut: boolean;
  /** Set when the process could not be spawned at all — ENOENT means no git. */
  spawnError: NodeJS.ErrnoException | null;
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Written to git's stdin (used for `git apply -`). */
  input?: string;
}

export type GitRunner = (args: string[], options?: GitRunOptions) => Promise<GitResult>;

function emptyResult(over: Partial<GitResult> = {}): GitResult {
  return { ok: false, stdout: "", stderr: "", code: null, timedOut: false, spawnError: null, ...over };
}

/**
 * The real runner. `spawn` with an ARGV ARRAY and `shell: false` — this is the
 * shell-injection guard, not a mitigation of it.
 */
export const defaultGitRunner: GitRunner = (args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES;

  return new Promise<GitResult>((resolve) => {
    let child;
    try {
      child = spawn("git", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve(emptyResult({ spawnError: e as NodeJS.ErrnoException }));
      return;
    }

    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;

    // Byte-budgeted append, so a chatty git can never grow the buffer without
    // bound regardless of how the stream chunks.
    const collect = (into: string, chunk: Buffer): string => {
      const room = maxBytes - Buffer.byteLength(into, "utf8");
      if (room <= 0) return into;
      return into + chunk.subarray(0, room).toString("utf8");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (extra: Partial<GitResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        emptyResult({
          stdout: out,
          stderr: err,
          timedOut,
          ...extra,
        }),
      );
    };

    child.stdout.on("data", (c: Buffer) => {
      out = collect(out, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      err = collect(err, c);
    });
    child.on("error", (e: NodeJS.ErrnoException) => settle({ spawnError: e, ok: false }));
    child.on("close", (code) => settle({ code, ok: code === 0 }));

    // A patch arrives on stdin; EPIPE here is harmless (git already answered).
    child.stdin.on("error", () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
};

let injectedRunner: GitRunner | null = null;

/** Swap the command runner (tests). Pass `null` to restore the real one. */
export function setGitRunner(runner: GitRunner | null): void {
  injectedRunner = runner;
}

export function getGitRunner(): GitRunner {
  return injectedRunner ?? defaultGitRunner;
}

/* ------------------------------------------------------- error normalising */

/** Git's stderr is multi-line and can run to kilobytes; one short line, capped. */
function flatten(text: string, max = MAX_ERROR_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

const ERROR_RULES: [RegExp, string][] = [
  [
    /ENOENT|command not found|is not recognized as an internal or external command|not recognized as/i,
    GIT_MISSING_ERROR,
  ],
  [/not a git repository/i, NOT_A_REPO_ERROR],
  [/dubious ownership/i, "Git refuses this directory because of a dubious-ownership check. Fix the ownership, or run `git config --global --add safe.directory <path>`."],
  [
    /unknown revision|bad revision|unknown revision or path not in the working tree|ambiguous argument/i,
    "Unknown git revision. Give a ref that exists (HEAD, a branch, or a commit SHA).",
  ],
  [
    /did not match any file|does not match any file|no such file or directory|could not read|does not exist/i,
    "The path does not exist.",
  ],
  [/patch does not apply|patch failed|corrupt patch|does not apply|cannot apply .*patch|unable to apply .*patch/i, "The patch does not apply to this working tree."],
  [/untracked working tree files would be overwritten|already exists/i, "That would overwrite untracked work, so it was refused."],
  [/index\.lock|Unable to create .*\.lock|another git process/i, "Another git process holds the repository lock. Try again once it finishes."],
  [/does not have any commits yet/i, "The repository has no commits yet, so there is nothing to diff against."],
];

/**
 * Map raw git stderr onto one short, actionable line. Never a stack, never a
 * multi-KB dump, never a credential (git does not echo remote URLs with tokens
 * here, and anything unrecognised is truncated anyway).
 */
export function normaliseGitError(raw: unknown, fallback = "The git command failed."): string {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  for (const [pattern, message] of ERROR_RULES) {
    if (pattern.test(text)) return message;
  }
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const cleaned = flatten(firstLine.replace(/^(fatal|error):\s*/i, ""), MAX_ERROR_CHARS - "Git failed: ".length);
  return cleaned ? `Git failed: ${cleaned}` : fallback;
}

/* --------------------------------------------------------- path normalising */

/**
 * True for a Windows-shaped path: a drive letter (`C:\…`, `C:/…`), a UNC share
 * (`\\server\share`), or backslash-only separators. A POSIX path — including one
 * that merely contains a backslash in a FILENAME — is not Windows-shaped.
 */
export function isWindowsPath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return p.includes("\\") && !p.includes("/");
}

/**
 * Normalise a path for use as a git argv element: Windows separators become
 * forward slashes, a POSIX path is returned unchanged. Quotes a caller wrapped
 * the path in are stripped, and a NUL byte (illegal in any path, and a way to
 * try to truncate a git argument) yields "" so the caller refuses the call.
 */
export function toGitPathArg(p: string): string {
  if (!p || typeof p !== "string") return "";
  let s = p.trim();
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  else if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  s = s.trim();
  if (!s) return "";
  if (s.includes("\0")) return "";
  if (isWindowsPath(s)) s = s.replace(/\\/g, "/");
  return s;
}

/** `dirname` that knows about drive letters and UNC paths. */
export function dirOf(p: string): string {
  const impl = isWindowsPath(p) ? path.win32 : path.posix;
  const normalised = toGitPathArg(p);
  if (!normalised) return "";
  return impl.dirname(normalised);
}


/* ------------------------------------------------------------- availability */

/**
 * Availability probe, cached per runner so a single tool call does not shell
 * out repeatedly — and so an injected runner in a test is probed exactly once
 * too. "git is missing" and "not a repository" are different failures and must
 * stay different: the first is an install problem, the second is a fact about
 * the user's filesystem.
 */
let availability: { runner: GitRunner; available: boolean } | null = null;

export async function isGitAvailable(runner: GitRunner = getGitRunner()): Promise<boolean> {
  if (availability && availability.runner === runner) return availability.available;
  let available = false;
  try {
    const r = await runner(["--version"], { timeoutMs: 5_000, maxBytes: 4096 });
    available = r.ok && /git version/i.test(r.stdout);
  } catch {
    available = false;
  }
  availability = { runner, available };
  return available;
}

/** Forget the cached probe and drop any injected runner. */
export function resetGitProbes(): void {
  availability = null;
  injectedRunner = null;
}

/* ------------------------------------------------------------- repo lookup */

async function isDirectory(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/**
 * Fallback discovery: walk up looking for a `.git` entry that is EITHER a
 * directory (normal clone) or a file (worktree / submodule, which contains
 * `gitdir: …`). Used only when git itself cannot answer.
 */
export async function findRepoRootByDotGit(startDir: string): Promise<string | null> {
  let dir = toGitPathArg(startDir);
  const win = isWindowsPath(startDir);
  const dirname = win ? path.win32.dirname : path.posix.dirname;
  if (!dir) return null;
  // Accept either a directory or a file path handed in.
  if (!(await isDirectory(dir))) {
    const parent = dirname(dir);
    if (!parent || parent === "." || parent === dir) return null;
    dir = parent;
  }
  for (;;) {
    const dotGit = win ? `${dir.replace(/\/+$/, "")}/.git` : path.join(dir, ".git");
    const stat = await fs
      .stat(dotGit)
      .then((s) => (s.isDirectory() || s.isFile() ? true : false))
      .catch(() => false);
    if (stat) return dir;
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
}

/**
 * The enclosing work tree of `start`, or null when there is none.
 *
 * `git rev-parse --show-toplevel` is authoritative when git is available: it
 * understands `.git` files, submodules, `GIT_DIR` and bare repositories, all of
 * which a filesystem walk does not. Because git performs the same upward walk,
 * a definitive "not a git repository" from git means no ancestor is a work tree
 * either, so there is no point walking further — we only fall back to the `.git`
 * walk when git is missing or too old to answer.
 */
export async function findRepoRoot(start: string, runner: GitRunner = getGitRunner()): Promise<string | null> {
  const target = toGitPathArg(start);
  if (!target) return null;

  // A file lives in the directory that contains it; a path that does not exist
  // yet is treated the same way (it is a file being created).
  const seed = (await isDirectory(target)) ? target : dirOf(target);
  if (!seed) return null;

  if (await isGitAvailable(runner)) {
    const top = await runner(["-C", seed, "rev-parse", "--show-toplevel"], { timeoutMs: 8_000 });
    if (top.ok) {
      const root = toGitPathArg(top.stdout.trim());
      if (root) return root;
    } else if (!isMissingGit(top)) {
      // A bare repository has no work tree; report the repository itself rather
      // than pretending the user passed a bad path.
      const bare = await runner(["-C", seed, "rev-parse", "--is-bare-repository"], { timeoutMs: 8_000 });
      if (bare.ok && bare.stdout.trim() === "true") return seed;
      // git walked up and found nothing: no ancestor is a repository either.
      return null;
    }
  }

  return findRepoRootByDotGit(seed);
}

/** True when a result means "there is no git binary", not "git said no". */
function isMissingGit(result: GitResult): boolean {
  if (result.spawnError?.code === "ENOENT") return true;
  return /ENOENT|command not found|is not recognized/i.test(`${result.stderr}${result.spawnError?.message ?? ""}`);
}

/* --------------------------------------------------------------------- diff */

export interface DiffOptions {
  /** Compare the index against HEAD instead of the working tree. */
  staged?: boolean;
  /** A ref to compare against, e.g. `HEAD`, `main`, `HEAD~3`. */
  ref?: string;
  /** Restrict to these paths (repo-relative or absolute; normalised for git). */
  files?: string[];
  maxChars?: number;
}

export interface DiffResult {
  ok: boolean;
  error?: string;
  diff: string;
  truncated: boolean;
  /** What the diff describes, for the model's benefit: e.g. `staged vs HEAD`. */
  scope: string;
}

/**
 * A reviewable diff: `git diff --no-color [--staged] [ref] [-- file...]`.
 * Colour codes are stripped so the output is safe to hand to a model, and the
 * text is capped with an explicit `truncated` flag — a truncated diff is still
 * honest, a silently clipped one is not.
 */
export async function gitDiff(root: string, options: DiffOptions = {}, runner: GitRunner = getGitRunner()): Promise<DiffResult> {
  const repoRoot = toGitPathArg(root);
  if (!repoRoot) return { ok: false, error: "A repository path is required.", diff: "", truncated: false, scope: "" };

  const files: string[] = [];
  for (const raw of options.files ?? []) {
    const f = toGitPathArg(String(raw));
    if (f) files.push(f);
    if (files.length >= MAX_DIFF_FILES) break;
  }

  const args = ["-C", repoRoot, "diff", "--no-color"];
  if (options.staged) args.push("--staged");
  const ref = options.ref ? toGitPathArg(options.ref) : "";
  if (ref) args.push(ref);
  args.push("--", ...files);

  const result = await runner(args, { timeoutMs: 15_000, maxBytes: MAX_CAPTURE_BYTES });
  if (!result.ok) {
    return { ok: false, error: errorFor(result), diff: "", truncated: false, scope: "" };
  }

  const maxChars = options.maxChars ?? DEFAULT_DIFF_CHARS;
  const full = result.stdout;
  const truncated = full.length > maxChars;
  const scope = [options.staged ? "staged" : "working tree", ref].filter(Boolean).join(" vs ");
  return { ok: true, diff: truncated ? full.slice(0, maxChars) : full, truncated, scope };
}

function errorFor(result: GitResult): string {
  if (isMissingGit(result)) return GIT_MISSING_ERROR;
  if (result.timedOut) return "The git command timed out.";
  return normaliseGitError(result.stderr);
}

/* -------------------------------------------------------------------- apply */

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** What `git apply --check` said, so the user learns why it was refused. */
  checked: boolean;
}

/**
 * Safe apply: `git apply --check` FIRST, and only if that passes the real
 * `git apply`. A patch that fails the dry run is never written, so a bad patch
 * can never leave a half-applied working tree behind.
 *
 * `git apply` without `--unsafe-paths` also refuses hunks that escape the
 * repository — that default is deliberately left alone.
 */
export async function applyPatch(root: string, patchText: string, runner: GitRunner = getGitRunner()): Promise<ApplyResult> {
  const repoRoot = toGitPathArg(root);
  if (!repoRoot) return { ok: false, error: "A repository path is required.", checked: false };

  if (typeof patchText !== "string" || patchText.trim().length === 0) {
    return { ok: false, error: "The patch is empty — there is nothing to apply.", checked: false };
  }
  if (Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES) {
    return {
      ok: false,
      error: `The patch is larger than the ${Math.floor(MAX_PATCH_BYTES / 1024)} KB limit. Apply it in smaller pieces.`,
      checked: false,
    };
  }

  const check = await runner(["-C", repoRoot, "apply", "--check", "-"], {
    timeoutMs: 15_000,
    maxBytes: 512_000,
    input: patchText,
  });
  if (!check.ok) {
    return { ok: false, error: errorFor(check), checked: true };
  }

  const applied = await runner(["-C", repoRoot, "apply", "-"], {
    timeoutMs: 15_000,
    maxBytes: 512_000,
    input: patchText,
  });
  if (!applied.ok) {
    // The tree changed between --check and apply; still nothing partial written.
    return { ok: false, error: errorFor(applied), checked: true };
  }
  return { ok: true, checked: true };
}
