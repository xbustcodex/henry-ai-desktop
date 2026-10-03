/**
 * Tests for the shared git layer.
 *
 * Testing strategy — BOTH seams, because they catch different bugs:
 *
 *   - REAL REPOS. `git init` in a temp dir exercises the genuine git binary:
 *     discovery, staged/unstaged diffs, and above all `git apply --check`
 *     actually refusing a bad patch and leaving the tree byte-identical. Mocking
 *     git there would only prove the mock is self-consistent. These tests skip
 *     (loudly, via `console.warn`, as `pythonRunner.test.ts` does without an
 *     interpreter) on a machine with no git — and the first real-repo test
 *     asserts git IS present, so the suite cannot pass vacuously.
 *
 *   - AN INJECTED RUNNER (`setGitRunner`). Used where the point is what this
 *     module does with a git RESULT: the Windows argv shape (a Linux host
 *     cannot run a Windows git), the missing-git vs not-a-repo split, the
 *     `--check`-before-`apply` ordering, and error normalisation. It is also the
 *     only way to exercise the `.git`-FILE fallback walk with git "unavailable".
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  applyPatch,
  dirOf,
  findRepoRoot,
  findRepoRootByDotGit,
  GIT_MISSING_ERROR,
  gitDiff,
  isGitAvailable,
  isWindowsPath,
  normaliseGitError,
  NOT_A_REPO_ERROR,
  resetGitProbes,
  setGitRunner,
  toGitPathArg,
  type GitResult,
  type GitRunner,
} from "./git";

const temps: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "henry-git-test-"));
  temps.push(d);
  return d;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Henry Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Henry Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** Run git for real — test setup only, never the module under test. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  });
}

const realGit = (() => {
  try {
    return /git version/.test(execFileSync("git", ["--version"], { encoding: "utf8" }));
  } catch {
    return false;
  }
})();

/** A real repository with one committed file per entry; returns its root. */
function initRepo(files: Record<string, string> = { "a.txt": "one\n" }): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body, "utf8");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function result(over: Partial<GitResult> = {}): GitResult {
  return { ok: true, stdout: "", stderr: "", code: 0, timedOut: false, spawnError: null, ...over };
}

/** An argv-recording runner: real `git --version`, then "not a repository". */
function notARepoRunner(calls: string[][]): GitRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "--version") return result({ stdout: "git version 2.53.0" });
    return result({ ok: false, stderr: "fatal: not a git repository", code: 128 });
  };
}

function noGitRunner(calls: string[][] = []): GitRunner {
  const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
  return async (args) => {
    calls.push(args);
    return result({ ok: false, spawnError: enoent, code: null });
  };
}

beforeAll(() => {
  if (!realGit) console.warn("[git] no git binary on this machine — real-repo tests will skip");
});

afterEach(() => {
  resetGitProbes();
});

/* ========================================================================= */

describe("windows path handling — pure, host-independent", () => {
  it("detects windows shapes: drive letters (either slash style) and UNC", () => {
    expect(isWindowsPath("C:\\Users\\me\\proj")).toBe(true);
    expect(isWindowsPath("c:/Users/me/proj")).toBe(true);
    expect(isWindowsPath("D:\\")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\proj")).toBe(true);
  });

  it("does not mistake a posix path for a windows one", () => {
    expect(isWindowsPath("/home/me/proj")).toBe(false);
    expect(isWindowsPath("relative/proj")).toBe(false);
    expect(isWindowsPath("proj")).toBe(false);
    expect(isWindowsPath("")).toBe(false);
    // A backslash INSIDE a posix filename is not a windows separator.
    expect(isWindowsPath("/home/weird\\name/proj")).toBe(false);
    // No drive letter: a colon in a posix path is just a character.
    expect(isWindowsPath("/home/a:b/proj")).toBe(false);
  });

  it("normalises every backslash to a forward slash for git args", () => {
    expect(toGitPathArg("C:\\Users\\me\\proj")).toBe("C:/Users/me/proj");
    expect(toGitPathArg("C:\\Users\\me\\my project\\src")).toBe("C:/Users/me/my project/src");
    expect(toGitPathArg("\\\\server\\share\\proj")).toBe("//server/share/proj");
    // Mixed separators are all normalised, not just the leading one.
    expect(toGitPathArg("C:\\Users\\me/proj\\src")).toBe("C:/Users/me/proj/src");
  });

  it("leaves a posix path completely alone", () => {
    for (const p of ["/home/me/proj", "/home/me/my project/src", "proj", "/tmp/a.b/c"]) {
      expect(toGitPathArg(p)).toBe(p);
    }
  });

  it("strips quotes a caller wrapped the path in, and rejects a NUL byte", () => {
    expect(toGitPathArg('"C:\\Users\\me\\proj"')).toBe("C:/Users/me/proj");
    expect(toGitPathArg("'/home/me/proj'")).toBe("/home/me/proj");
    expect(toGitPathArg("  /home/me/proj  ")).toBe("/home/me/proj");
    // A NUL can never be in a real path, so it is refused rather than forwarded.
    expect(toGitPathArg("/home/me/proj\0/etc/passwd")).toBe("");
    expect(toGitPathArg("")).toBe("");
  });

  it("dirname understands drive letters and UNC, not just POSIX", () => {
    expect(dirOf("C:\\Users\\me\\proj\\src\\index.ts")).toBe("C:/Users/me/proj/src");
    expect(dirOf("C:\\proj")).toBe("C:/");
    expect(dirOf("\\\\server\\share\\proj\\src")).toBe("//server/share/proj");
    expect(dirOf("/home/me/proj/src")).toBe("/home/me/proj");
  });

  it("hands git a forward-slashed single argument, never a backslashed one", async () => {
    const calls: string[][] = [];
    setGitRunner(async (args) => {
      calls.push(args);
      if (args[0] === "--version") return result({ stdout: "git version 2.53.0" });
      return result({ stdout: "C:/Users/me/proj" });
    });

    expect(await findRepoRoot("C:\\Users\\me\\proj\\src\\index.ts")).toBe("C:/Users/me/proj");
    const call = calls.find((c) => c.includes("rev-parse"))!;
    expect(call).toEqual(["-C", "C:/Users/me/proj/src", "rev-parse", "--show-toplevel"]);
    expect(call.join(" ")).not.toContain("\\");
  });

  it("passes a path that looks like a shell command as ONE inert argument", async () => {
    const calls: string[][] = [];
    setGitRunner(notARepoRunner(calls));

    await findRepoRoot("/tmp/repo; rm -rf ~");
    const call = calls.find((c) => c.includes("rev-parse"))!;
    // Nothing was ever split into two arguments, and no shell saw it.
    expect(call).toEqual(["-C", "/tmp", "rev-parse", "--show-toplevel"]);
    expect(call[1]).toBe("/tmp");
  });
});

/* ========================================================================= */

describe("git availability vs not-a-repo — two different failures", () => {
  it("reports git unavailable when the binary cannot be spawned", async () => {
    setGitRunner(noGitRunner());
    expect(await isGitAvailable()).toBe(false);
  });

  it("does not count something that merely exits 0 as a usable git", async () => {
    setGitRunner(async () => result({ stdout: "not git at all" }));
    expect(await isGitAvailable()).toBe(false);
  });

  it("falls back to the .git walk when git is missing, and finds a .git FILE", async () => {
    const dir = tempDir();
    const gitdir = path.join(dir, "real-git-dir");
    mkdirSync(gitdir);
    // Exactly what `git worktree add` and submodules write: a FILE, not a dir.
    writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    const nested = path.join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });

    setGitRunner(noGitRunner());
    expect(await findRepoRoot(path.join(nested, "file.ts"))).toBe(dir);
    expect(await findRepoRootByDotGit(dir)).toBe(dir);
  });

  it("finds a bare .git DIRECTORY through the same fallback walk", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, ".git"));
    const nested = path.join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });

    setGitRunner(noGitRunner());
    expect(await findRepoRoot(nested)).toBe(dir);
  });

  it("returns null for a non-repo, with or without git — same answer, different cause", async () => {
    const plain = tempDir();
    setGitRunner(notARepoRunner([]));
    expect(await findRepoRoot(plain)).toBeNull();

    setGitRunner(noGitRunner());
    expect(await findRepoRoot(plain)).toBeNull();
  });

  it("gives a missing git and a non-repo different, actionable messages", () => {
    const missing = normaliseGitError("spawn git ENOENT");
    const notRepo = normaliseGitError("fatal: not a git repository (or any of the parent directories): .git");
    expect(missing).toBe(GIT_MISSING_ERROR);
    expect(notRepo).toBe(NOT_A_REPO_ERROR);
    expect(missing).not.toBe(notRepo);
    expect(missing).toMatch(/install git/i);
    expect(notRepo).not.toMatch(/install git/i);
  });
});

/* ========================================================================= */

describe("error normalisation", () => {
  it("maps the raw git failures a user actually hits to one short line", () => {
    expect(normaliseGitError("fatal: not a git repository (or any of the parent directories): .git")).toBe(NOT_A_REPO_ERROR);
    expect(normaliseGitError("fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.")).toMatch(
      /unknown git revision/i,
    );
    expect(normaliseGitError("fatal: bad revision 'HEAD~9'")).toMatch(/unknown git revision/i);
    expect(normaliseGitError("error: pathspec 'ghost.txt' did not match any file(s) known to git")).toMatch(/does not exist/i);
    expect(normaliseGitError("error: patch failed: src/a.ts:12")).toMatch(/does not apply/i);
    expect(normaliseGitError("error: cannot apply binary patch to 'a.txt' without full index line")).toMatch(/does not apply/i);
    expect(normaliseGitError("fatal: detected dubious ownership in repository at '/x'")).toMatch(/safe\.directory/);
    expect(normaliseGitError("fatal: Unable to create '/x/.git/index.lock': File exists.")).toMatch(/lock/i);
    expect(normaliseGitError("fatal: your current branch 'main' does not have any commits yet")).toMatch(/no commits yet/i);
  });

  it("never leaks a raw stack or an unbounded blob to the model", () => {
    const message = normaliseGitError(`error: something odd\n${"x".repeat(50_000)}`);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message.split("\n")).toHaveLength(1);
    expect(message).not.toContain("    at ");

    expect(normaliseGitError(new Error("fatal: broken pipe"))).toMatch(/git failed/i);
    expect(normaliseGitError(undefined)).toBe("The git command failed.");
    expect(normaliseGitError(undefined, "custom fallback")).toBe("custom fallback");
  });
});

/* ========================================================================= */

describe("findRepoRoot against real repositories", () => {
  it("has git to test with — the suite must not pass vacuously", async () => {
    if (!realGit) {
      console.warn("[git] no git binary — skipping");
      return;
    }
    expect(await isGitAvailable()).toBe(true);
  });

  it("finds the root from a directory, a file inside it, a nested path, and a not-yet-created file", async () => {
    if (!realGit) return;
    const root = initRepo({ "src/a/b/c.txt": "deep\n" });
    const real = await fs.realpath(root);

    expect(await findRepoRoot(root)).toBe(real);
    expect(await findRepoRoot(path.join(root, "src", "a", "b", "c.txt"))).toBe(real);
    expect(await findRepoRoot(path.join(root, "src"))).toBe(real);
    expect(await findRepoRoot(path.join(root, "src", "brand-new.ts"))).toBe(real);
  });

  it("finds a worktree root, whose .git is a FILE rather than a directory", async () => {
    if (!realGit) return;
    const main = initRepo({ "a.txt": "one\n" });
    const wt = path.join(tempDir(), "linked");
    git(main, "worktree", "add", "-q", wt, "-b", "side");

    // Prove this is precisely the case the old literal-entry walk missed.
    const real = await fs.realpath(wt);
    expect((await fs.stat(path.join(real, ".git"))).isFile()).toBe(true);

    expect(await findRepoRoot(wt)).toBe(real);
  });

  it("returns null for a directory that is not a repository at all", async () => {
    if (!realGit) return;
    expect(await findRepoRoot(tempDir())).toBeNull();
  });

  it("handles a bare repository, which has no working tree to walk into", async () => {
    if (!realGit) return;
    const work = initRepo({ "a.txt": "one\n" });
    const bare = path.join(tempDir(), "mirror.git");
    git(work, "clone", "-q", "--bare", work, bare);

    expect(await findRepoRoot(bare)).toBe(await fs.realpath(bare));
  });

  it("refuses an empty or NUL-bearing path rather than guessing", async () => {
    expect(await findRepoRoot("")).toBeNull();
    expect(await findRepoRoot("/tmp/x\0y")).toBeNull();
  });
});

/* ========================================================================= */

describe("gitDiff against real repositories", () => {
  it("reports unstaged working-tree changes", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n" });
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n", "utf8");

    const d = await gitDiff(root);
    expect(d.ok).toBe(true);
    expect(d.diff).toContain("+two");
    expect(d.diff).toContain("@@");
    expect(d.scope).toBe("working tree");
    expect(d.truncated).toBe(false);
    expect(d.diff).not.toMatch(/\u001b\[/); // no colour escapes for a model
  });

  it("separates staged from unstaged, and from a ref", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n", "b.txt": "keep\n" });

    writeFileSync(path.join(root, "a.txt"), "staged\n", "utf8");
    git(root, "add", "a.txt");
    writeFileSync(path.join(root, "b.txt"), "unstaged\n", "utf8");

    const staged = await gitDiff(root, { staged: true });
    expect(staged.diff).toContain("+staged");
    expect(staged.diff).not.toContain("unstaged");

    const unstaged = await gitDiff(root);
    expect(unstaged.diff).toContain("+unstaged");
    expect(unstaged.diff).not.toContain("+staged");

    const vsHead = await gitDiff(root, { ref: "HEAD" });
    expect(vsHead.diff).toContain("+staged");
    expect(vsHead.diff).toContain("+unstaged");
    expect(vsHead.scope).toBe("working tree vs HEAD");
  });

  it("restricts the diff to the named files", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n", "b.txt": "one\n" });
    writeFileSync(path.join(root, "a.txt"), "A\n", "utf8");
    writeFileSync(path.join(root, "b.txt"), "B\n", "utf8");

    const onlyA = await gitDiff(root, { files: ["a.txt"] });
    expect(onlyA.diff).toContain("a.txt");
    expect(onlyA.diff).not.toContain("b.txt");
  });

  it("truncates a huge diff and SAYS so, instead of silently clipping", async () => {
    if (!realGit) return;
    const root = initRepo({ "big.txt": "start\n" });
    writeFileSync(path.join(root, "big.txt"), "line\n".repeat(5_000), "utf8");

    const d = await gitDiff(root, { maxChars: 500 });
    expect(d.ok).toBe(true);
    expect(d.truncated).toBe(true);
    expect(d.diff).toHaveLength(500);
  });

  it("returns a short actionable error for a bad ref, not git's raw stderr", async () => {
    if (!realGit) return;
    const d = await gitDiff(initRepo(), { ref: "no-such-ref-xyz" });
    expect(d.ok).toBe(false);
    expect(d.diff).toBe("");
    expect(d.error).toMatch(/unknown git revision/i);
    expect(d.error!.length).toBeLessThanOrEqual(200);
  });

  it("refuses a non-repo root with the not-a-repo message", async () => {
    if (!realGit) return;
    const d = await gitDiff(tempDir());
    expect(d.ok).toBe(false);
    expect(d.error).toBe(NOT_A_REPO_ERROR);
  });
});

/* ========================================================================= */

describe("applyPatch — the --check preflight is the safety net", () => {
  const PATCH = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+patched", ""].join(
    "\n",
  );

  it("applies a valid patch, having reported that the check ran", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n" });

    const r = await applyPatch(root, PATCH);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("patched\n");
  });

  it("runs `apply --check` strictly BEFORE `apply`, so nothing is written speculatively", async () => {
    const calls: string[][] = [];
    setGitRunner(async (args) => {
      calls.push(args);
      return result();
    });

    expect((await applyPatch("/tmp/anywhere", PATCH)).ok).toBe(true);
    expect(calls).toEqual([
      ["-C", "/tmp/anywhere", "apply", "--check", "-"],
      ["-C", "/tmp/anywhere", "apply", "-"],
    ]);
  });

  it("does NOT apply a patch that fails the check, and writes nothing", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "completely different content\n" });
    const before = await fs.readFile(path.join(root, "a.txt"), "utf8");

    const r = await applyPatch(root, PATCH);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(true); // it reached the dry run, which caught it
    expect(r.error).toMatch(/does not apply/i);
    expect(r.error!.length).toBeLessThanOrEqual(200);

    // The proof that matters: the working tree is byte-identical and clean.
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(before);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  it("refuses a patch touching a file that does not exist, creating nothing", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n" });

    const r = await applyPatch(root, PATCH.replace(/a\.txt/g, "ghost.txt"));
    expect(r.ok).toBe(false);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    await expect(fs.stat(path.join(root, "ghost.txt"))).rejects.toThrow();
  });

  it("refuses a patch whose path escapes the repository", async () => {
    if (!realGit) return;
    const root = initRepo({ "a.txt": "one\n" });
    const escapeTarget = path.join(root, "..", "..", "..", "..", "..", "tmp", "henry-git-escape-probe.txt");
    const traversal = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/../../../../../../../tmp/henry-git-escape-probe.txt",
      "@@ -1 +1 @@",
      "-one",
      "+pwned",
      "",
    ].join("\n");

    expect((await applyPatch(root, traversal)).ok).toBe(false);
    await expect(fs.stat(escapeTarget)).rejects.toThrow();
  });

  it("stops at the check and never reaches the apply when git is missing", async () => {
    const calls: string[][] = [];
    setGitRunner(noGitRunner(calls));

    const r = await applyPatch("/tmp/x", PATCH);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(GIT_MISSING_ERROR);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--check");
  });

  it("rejects an empty or oversized patch without invoking git at all", async () => {
    const calls: string[][] = [];
    setGitRunner(async (args) => {
      calls.push(args);
      return result();
    });

    expect((await applyPatch("/tmp/x", "   ")).error).toMatch(/empty/i);
    expect((await applyPatch("/tmp/x", "x".repeat(600_000))).error).toMatch(/limit/i);
    expect((await applyPatch("", PATCH)).error).toMatch(/repository path is required/i);
    expect(calls).toHaveLength(0);
  });

  it("feeds the patch through stdin, so a patch is never a command line", async () => {
    const seen: (string | undefined)[] = [];
    setGitRunner(async (_args, options) => {
      seen.push(options?.input);
      return result();
    });

    await applyPatch("/tmp/x", PATCH);
    expect(seen).toEqual([PATCH, PATCH]);
  });
});