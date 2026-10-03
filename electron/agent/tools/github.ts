/**
 * GitHub tools — read-only access to Henry's own repositories (design §4.7).
 *
 * Henry is local-first and ships NO bundled GitHub token, so this kit is
 * deliberately read-only and works both ways:
 *
 *   - Token present   → authenticated REST calls (higher rate limit).
 *   - Token absent    → plain unauthenticated public reads, and every payload
 *                       carries `configured: false` so the model can tell the
 *                       user *why* results may be thin instead of inventing a
 *                       "not connected" wall.
 *
 * Safety tiers (design §5) — every tool here is `silent` because each one is a
 * pure READ of data the user can already see on github.com. Nothing in this
 * file writes: no issue comments, no PR merges, no file uploads. Anything that
 * mutates a repo is a confirm-tier design decision, not this kit's job.
 *
 *   - github_status  silent — connection state + whether the value is encrypted
 *   - github_repo    silent — repo metadata
 *   - github_issues  silent — issues or PRs
 *   - github_file    silent — read a file at a ref (bounded)
 *   - github_search  silent — code / commit / issue search
 *
 * Credential model: a personal access token lives in the `settings` table under
 * `github_token`, encrypted at rest through the same safeStorage helper used
 * for every other provider key (`_keyStorage.ts` → OS keychain / DPAPI /
 * libsecret). There is no `github_token` row in a fresh install, and that is a
 * normal state, not an error: `github_status` reports `configured: false` and
 * the read tools proceed unauthenticated.
 *
 * The token is NEVER placed in a payload, an error string, or a log line —
 * `redact()` scrubs it from anything GitHub hands back before it can surface.
 */

import type Database from "better-sqlite3";
import type { ToolDefinition, ToolResult, AgentContext } from "../types";
import { decryptKey, isEncrypted } from "../../ipc/_keyStorage";

type Row = Record<string, unknown>;

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

// ── Credential storage ───────────────────────────────────────────────────────

const TOKEN_SETTING = "github_token";

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? "";
}

interface Credential {
  /** A `github_token` row exists (value may still be unusable if undecryptable). */
  configured: boolean;
  /** The stored row is in `enc:v1:` form — i.e. encrypted at rest. */
  encryptedAtRest: boolean;
  /** Usable bearer token, or null when there is none. Never logged or echoed. */
  token: string | null;
}

/**
 * Read the stored token. A missing row is the normal fresh-install state; a row
 * we can't decrypt (encrypted value on a machine whose keychain is gone) is
 * reported as configured-but-unusable rather than silently downgraded to
 * "anonymous", so the user gets an accurate fix-me message.
 */
function readCredential(db: Database.Database): Credential {
  const stored = getSetting(db, TOKEN_SETTING);
  if (!stored) return { configured: false, encryptedAtRest: false, token: null };
  const encryptedAtRest = isEncrypted(stored);
  let token: string | null = null;
  try {
    const plain = decryptKey(stored).trim();
    token = plain ? plain : null;
  } catch {
    token = null;
  }
  return { configured: true, encryptedAtRest, token };
}

/** Strip the token out of any text that came back from GitHub. */
function redact(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

/**
 * Fresh-install payload. Returned as a SUCCESSFUL read (quickbooks'
 * `notConnected()` convention) so the model relays the guidance instead of
 * treating "no token" as a hard failure — public reads still work.
 */
function notConfigured(hint: string): ToolResult {
  return ok({
    connected: false,
    configured: false,
    status: "not_configured",
    message:
      `No GitHub token stored (Settings → "github_token"). ${hint} ` +
      "Unauthenticated public API reads still work but are rate-limited to ~60 requests/hour.",
  });
}

/**
 * A 404 while unauthenticated almost always means "private or missing", never
 * "this repo does not exist". Relaying the not-configured guidance beats
 * telling the user a repo they own has vanished.
 */
function notFoundResult(res: GhErr, cred: Credential, hint: string): ToolResult {
  if (!cred.token) return notConfigured(hint);
  return fail(res.error, res.retryable);
}

const NO_TOKEN_REPO_HINT = "Check the owner/name, or add a GitHub token if the repo is private.";
const NO_TOKEN_PATH_HINT = "Check the path and ref, or add a GitHub token if the repo is private.";
const NO_TOKEN_SEARCH_HINT = "A token is needed to search private repositories; public code still works.";

// ── Validation ───────────────────────────────────────────────────────────────

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** `owner/name`, and nothing else — no URLs, no extra path segments. */
export function isValidRepo(repo: unknown): boolean {
  if (typeof repo !== "string") return false;
  const trimmed = repo.trim();
  if (!REPO_RE.test(trimmed)) return false;
  // "." / ".." are not real names and would let a caller walk the URL.
  return !trimmed.split("/").some((part) => part === "." || part === ".." || part === "");
}

/**
 * True when a repo-relative file path tries to climb out of the repo. A GitHub
 * blob path never legitimately contains a `..` segment, so any occurrence is
 * refused outright rather than normalised — including percent-encoded forms
 * (`%2e%2e`) and backslash separators that would survive a naive split.
 */
export function hasPathTraversal(filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) return true;
  if (filePath.includes("\0") || filePath.includes("\\")) return true;
  if (/%2e/i.test(filePath)) return true;
  return filePath.split("/").some((segment) => segment === "..");
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.github.com";
const USER_AGENT = "HenryAI/1.0 (+https://henry.ai; local-first contractor assistant)";
const TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 40_000;
const HARD_MAX_BYTES = 500_000;
const MAX_DIR_ENTRIES = 100;

/** Test seam: every call goes through this indirection so specs never hit the network. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const realFetch: FetchLike = (url, init) => globalThis.fetch(url, init);
let httpFetch: FetchLike = realFetch;

/** Swap the transport for a test double. Pass null to restore the real one. */
export function __setHttpFetchForTests(fn: FetchLike | null): void {
  httpFetch = fn ?? realFetch;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await httpFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...headers },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Default-branch cache (5-minute TTL, mirrors web.ts) ─────────────────────

interface CacheEntry {
  expires: number;
  value: string;
}

const branchCache = new Map<string, CacheEntry>();

function cachedBranch(repo: string): string | undefined {
  const hit = branchCache.get(repo);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    branchCache.delete(repo);
    return undefined;
  }
  return hit.value;
}

function cacheBranch(repo: string, branch: string): void {
  branchCache.set(repo, { value: branch, expires: Date.now() + 5 * 60 * 1000 });
}

// ── GitHub API call ──────────────────────────────────────────────────────────

interface GhOk {
  ok: true;
  status: number;
  data: unknown;
}
interface GhErr {
  ok: false;
  status: number;
  error: string;
  retryable: boolean;
}
type GhResult = GhOk | GhErr;

/**
 * GET `path` (an absolute API path) with the token attached when we have one.
 *
 * A non-2xx is NEVER reported as success. Status → message mapping:
 *   401/403 — bad/expired token, or the anonymous rate limit ran out
 *   404    — repo or path not found
 *   5xx    — upstream failure, retryable so the ToolRunner backs off
 * Everything that survives into an error string is redacted of the token first.
 */
async function ghRequest(path: string, cred: Credential): Promise<GhResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cred.token) headers.Authorization = `Bearer ${cred.token}`;

  let res: Response;

  try {
    res = await fetchWithTimeout(API_BASE + path, TIMEOUT_MS, headers);
  } catch (e) {
    const aborted = e instanceof Error && /abort/i.test(e.message);
    const detail = redact(aborted ? "GitHub request timed out." : e instanceof Error ? e.message : String(e), cred.token);
    return { ok: false, status: 0, error: detail, retryable: true };
  }

  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (res.ok) return { ok: true, status: res.status, data };

  // GitHub's own `message` is the most useful part of a 4xx body.
  const apiMessage =
    data && typeof (data as Row).message === "string" ? (data as Row).message as string : "";

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: res.status,
      error: "GitHub rejected the stored token (or you are rate-limited); check Settings",
      retryable: false,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: res.status,
      error: apiMessage
        ? `GitHub: repo or path not found (${redact(apiMessage, cred.token)})`
        : "GitHub: repo or path not found",
      retryable: false,
    };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      status: res.status,
      error: `GitHub API error (HTTP ${res.status}) — retryable`,
      retryable: true,
    };
  }
  const suffix = apiMessage ? ` (${redact(apiMessage, cred.token)})` : "";
  return {
    ok: false,
    status: res.status,
    error: `GitHub rejected the request (HTTP ${res.status})${suffix}`,
    retryable: false,
  };
}

/** Resolve `repo` from params, or an explanatory refusal. */
function readRepoParam(params: Row): { repo: string } | { error: string } {
  const repo = String(params.repo ?? "").trim();
  if (!repo) return { error: "repo is required, formatted as owner/name" };
  if (!isValidRepo(repo)) {
    return { error: `invalid repo "${repo}" — expected owner/name (letters, digits, ., -, _)` };
  }
  return { repo };
}

function clampLimit(raw: unknown, max = MAX_LIMIT): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), max);
}

function clampBytes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(n), HARD_MAX_BYTES);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** `["bug", "p1"]` → `"bug,p1"`. Blank entries dropped. */
function parseLabels(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((l) => String(l).trim()).filter(Boolean).join(",");
  return String(raw ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(",");
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => str((l as Row)?.name))
    .filter((n): n is string => !!n);
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function githubTools(): ToolDefinition[] {
  return [
    // ── github_status ────────────────────────────────────────────────────────
    {
      name: "github_status",
      description:
        "Report whether Henry has a GitHub personal access token configured, " +
        "without revealing any part of it. Use this BEFORE promising a repo " +
        "lookup will be complete — with no token Henry can only read public " +
        "repositories and is rate-limited to ~60 requests/hour. Returns " +
        "{connected, configured, encrypted_at_rest} and nothing else.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, { db }: AgentContext) {
        try {
          const cred = readCredential(db);
          return ok({
            connected: !!cred.token,
            configured: cred.configured,
            encrypted_at_rest: cred.encryptedAtRest,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // ── github_repo ──────────────────────────────────────────────────────────
    {
      name: "github_repo",
      description:
        "Fetch metadata for one GitHub repository: description, default branch, " +
        "primary language, stars, forks, open issue count, last push, license " +
        "and topics. Use this to orient yourself in a repo before reading files " +
        "or listing issues, and to answer questions like \"what is this project\" " +
        "or \"is it still maintained\". Read-only.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: 'Repository as "owner/name", e.g. "facebook/react".' },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      async execute(params, { db }: AgentContext) {
        const parsed = readRepoParam(params);
        if ("error" in parsed) return fail(parsed.error);
        let cred: Credential | null = null;
        try {
          cred = readCredential(db);
          const res = await ghRequest(`/repos/${parsed.repo}`, cred);
          if (!res.ok) {
            return res.status === 404
              ? notFoundResult(res, cred, NO_TOKEN_REPO_HINT)
              : fail(res.error, res.retryable);
          }
          const r = (res.data ?? {}) as Row;

          const payload: Row = {
            repo: parsed.repo,
            full_name: str(r.full_name),
            description: str(r.description),
            default_branch: str(r.default_branch),
            language: str(r.language),
            stars: num(r.stargazers_count),
            forks: num(r.forks_count),
            open_issues: num(r.open_issues_count),
            pushed_at: str(r.pushed_at),
            license: str((r.license as Row)?.spdx_id) ?? str((r.license as Row)?.name),
            topics: Array.isArray(r.topics) ? (r.topics as unknown[]).filter((t) => typeof t === "string") : [],
            html_url: str(r.html_url),
            private: r.private === true,
            archived: r.archived === true,
            configured: cred.configured,
          };
          if (!cred.token) payload.note = "No GitHub token configured — read anonymously (rate-limited).";
          return ok(payload);
        } catch (e) {
          return fail(redact(e instanceof Error ? e.message : String(e), cred?.token ?? null), true);
        }
      },
    },

    // ── github_issues ────────────────────────────────────────────────────────
    {
      name: "github_issues",
      description:
        "List issues or pull requests for a repository, newest activity first. " +
        "Use this for \"what's open\", \"what bugs are filed\", \"what PRs are " +
        "waiting\", \"has anyone reported X bug\". Set pulls: true to hit the real " +
        "pull-request endpoint (GitHub's issue list mixes both, but PR fields " +
        "like merge state are only correct from the pulls endpoint). Read-only.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: 'Repository as "owner/name".' },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Which issues to list (default open).",
          },
          labels: { type: "string", description: 'Comma-separated label filter, e.g. "bug,p1".' },
          pulls: { type: "boolean", description: "List pull requests instead of issues (default false)." },
          limit: { type: "number", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      async execute(params, { db }: AgentContext) {
        const parsed = readRepoParam(params);
        if ("error" in parsed) return fail(parsed.error);

        const stateParam = String(params.state ?? "open").trim().toLowerCase();
        const state = stateParam === "closed" || stateParam === "all" ? stateParam : "open";
        const labels = parseLabels(params.labels);
        const limit = clampLimit(params.limit);
        const isPulls = params.pulls === true || params.pulls === "true";
        let cred: Credential | null = null;

        const qs = new URLSearchParams({ state, per_page: String(limit) });
        if (labels) qs.set("labels", labels);
        const endpoint = isPulls ? "pulls" : "issues";

        try {
          cred = readCredential(db);
          const res = await ghRequest(`/repos/${parsed.repo}/${endpoint}?${qs.toString()}`, cred);
          if (!res.ok) {
            return res.status === 404
              ? notFoundResult(res, cred, NO_TOKEN_REPO_HINT)
              : fail(res.error, res.retryable);
          }
          const list = Array.isArray(res.data) ? (res.data as Row[]) : [];

          const items = list.slice(0, limit).map((it) => ({
            number: num(it.number),
            title: str(it.title),
            state: str(it.state),
            labels: labelNames(it.labels),
            user: str((it.user as Row)?.login),
            comments: isPulls
              ? num(it.comments) + num(it.review_comments)
              : num(it.comments),
            created_at: str(it.created_at),
            updated_at: str(it.updated_at),
            html_url: str(it.html_url),
            is_pull_request: typeof it.pull_request === "object" && it.pull_request !== null,
            draft: it.draft === true,
          }));

          const payload: Row = {
            repo: parsed.repo,
            kind: isPulls ? "pulls" : "issues",
            state,
            labels: labels ? labels.split(",") : [],
            count: items.length,
            issues: items,
            configured: cred.configured,
          };
          if (!cred.token) payload.note = "No GitHub token configured — read anonymously (rate-limited).";
          return ok(payload);
        } catch (e) {
          return fail(redact(e instanceof Error ? e.message : String(e), cred?.token ?? null), true);
        }
      },
    },

    // ── github_file ──────────────────────────────────────────────────────────
    {
      name: "github_file",
      description:
        "Read one file from a GitHub repository at a given ref (branch, tag or " +
        "commit SHA — defaults to the repo's default branch). Use this to check " +
        "how something is actually implemented, read a dependency's manifest, or " +
        "confirm a version pin, instead of guessing. Content is capped " +
        `(default ${DEFAULT_MAX_BYTES} chars; raise max_bytes deliberately) and ` +
        "`truncated: true` tells you the file was cut off. Listing a directory " +
        "returns its entries instead of content. Read-only — never writes.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: 'Repository as "owner/name".' },
          path: { type: "string", description: "File path inside the repo, e.g. \"src/index.ts\"." },
          ref: { type: "string", description: "Branch, tag or SHA (default: the repo's default branch)." },
          max_bytes: { type: "number", description: `Max characters of content to return (default ${DEFAULT_MAX_BYTES}).` },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
      async execute(params, { db }: AgentContext) {
        const parsed = readRepoParam(params);
        if ("error" in parsed) return fail(parsed.error);

        const rawPath = String(params.path ?? "").trim();
        if (!rawPath) return fail("path is required (e.g. \"README.md\")");
        if (hasPathTraversal(rawPath)) {
          return fail(`refusing path "${rawPath}" — \"..\" segments are not allowed in a repo-relative path`);
        }
        const path = rawPath.replace(/^\/+/, "");
        const maxBytes = clampBytes(params.max_bytes);
        let cred: Credential | null = null;
        try {
          cred = readCredential(db);
          // Resolve the default branch when the caller didn't pin a ref.
          let ref = str(params.ref)?.trim() || "";
          if (!ref) {
            const cached = cachedBranch(parsed.repo);
            if (cached) {
              ref = cached;
            } else {
              const meta = await ghRequest(`/repos/${parsed.repo}`, cred);
              if (!meta.ok) {
                return meta.status === 404
                  ? notFoundResult(meta, cred, NO_TOKEN_REPO_HINT)
                  : fail(meta.error, meta.retryable);
              }
              ref = str((meta.data as Row)?.default_branch) ?? "";
              if (!ref) return fail(`GitHub did not report a default branch for ${parsed.repo}`);
              cacheBranch(parsed.repo, ref);
            }
          }

          const qs = new URLSearchParams({ ref });
          const res = await ghRequest(
            `/repos/${parsed.repo}/contents/${path}?${qs.toString()}`,
            cred,
          );
          if (!res.ok) {
            return res.status === 404
              ? notFoundResult(res, cred, NO_TOKEN_PATH_HINT)
              : fail(res.error, res.retryable);
          }

          const body = res.data as Row | Row[];

          // A directory listing comes back as an array.
          if (Array.isArray(body)) {
            const entries = body.slice(0, MAX_DIR_ENTRIES).map((e) => ({
              name: str(e.name),
              path: str(e.path),
              type: str(e.type),
              size: num(e.size),
              html_url: str(e.html_url),
            }));
            return ok({
              repo: parsed.repo,
              path,
              ref,
              type: "directory",
              count: entries.length,
              truncated: body.length > MAX_DIR_ENTRIES,
              entries,
              configured: cred.configured,
            });
          }

          // Submodule / symlink / unknown shape — no content to show.
          if (str(body?.type) !== "file") {
            return ok({
              repo: parsed.repo,
              path,
              ref,
              type: str(body?.type) ?? "unknown",
              size: num(body?.size),
              html_url: str(body?.html_url),
              message: "No file content at this path (symlink, submodule or oversized file).",
              configured: cred.configured,
            });
          }

          const encoding = str(body.encoding);
          const raw = str(body.content) ?? "";
          const content = encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
          const truncated = content.length > maxBytes;

          return ok({
            repo: parsed.repo,
            path: str(body.path) ?? path,
            ref,
            type: "file",
            size: num(body.size),
            truncated,
            max_bytes: maxBytes,
            ...(truncated ? { truncated_at: maxBytes, content: content.slice(0, maxBytes) } : { content }),
            sha: str(body.sha),
            html_url: str(body.html_url),
            configured: cred.configured,
          });
        } catch (e) {
          return fail(redact(e instanceof Error ? e.message : String(e), cred?.token ?? null), true);
        }
      },
    },

    // ── github_search ────────────────────────────────────────────────────────
    {
      name: "github_search",
      description:
        "Search GitHub: kind \"code\" for where a symbol is used, \"commits\" " +
        "for history that explains a change, \"issues\" for problems filed " +
        "anywhere (not just one repo). Use this when you need to know that " +
        "something is true across the ecosystem rather than in a repo Henry " +
        "already has open — e.g. \"which library should I use for X\". Queries " +
        "accept GitHub's normal qualifiers, e.g. \"react hooks repo:facebook/react\". Read-only.",
      category: "external",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: 'GitHub search query, e.g. "useState repo:facebook/react".' },
          kind: {
            type: "string",
            enum: ["code", "commits", "issues"],
            description: "What to search (default code).",
          },
          limit: { type: "number", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
        required: ["q"],
        additionalProperties: false,
      },
      async execute(params, { db }: AgentContext) {
        const q = String(params.q ?? "").trim();
        if (!q) return fail("q is required (a GitHub search query)");

        const kindParam = String(params.kind ?? "code").trim().toLowerCase();
        const kind: "code" | "commits" | "issues" =
          kindParam === "commits" || kindParam === "issues" ? kindParam : "code";
        const limit = clampLimit(params.limit);
        let cred: Credential | null = null;
        const qs = new URLSearchParams({ q, per_page: String(limit) });
        try {
          cred = readCredential(db);
          const res = await ghRequest(`/search/${kind}?${qs.toString()}`, cred);
          if (!res.ok) {
            return res.status === 404
              ? notFoundResult(res, cred, NO_TOKEN_SEARCH_HINT)
              : fail(res.error, res.retryable);
          }

          const body = (res.data ?? {}) as Row;
          const raw = Array.isArray(body.items) ? (body.items as Row[]) : [];
          const items = raw.slice(0, limit).map((it) => {
            const base: Row = {
              repository: str((it.repository as Row)?.full_name),
              html_url: str(it.html_url),
              score: num(it.score),
            };
            if (kind === "code") {
              return { ...base, name: str(it.name), path: str(it.path) };
            }
            if (kind === "commits") {
              const commit = (it.commit ?? {}) as Row;
              const author = (commit.author ?? {}) as Row;
              const message = str(commit.message) ?? "";
              return {
                ...base,
                sha: str(it.sha),
                message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
                author: str((it.author as Row)?.login) ?? str(author.name),
                date: str(author.date),
              };
            }
            return {
              ...base,
              number: num(it.number),
              title: str(it.title),
              state: str(it.state),
              user: str((it.user as Row)?.login),
              comments: num(it.comments),
              created_at: str(it.created_at),
              updated_at: str(it.updated_at),
              is_pull_request: typeof it.pull_request === "object" && it.pull_request !== null,
            };
          });

          const payload: Row = {
            q,
            kind,
            total_count: num(body.total_count),
            count: items.length,
            items,
            configured: cred.configured,
          };
          if (!cred.token) payload.note = "No GitHub token configured — read anonymously (rate-limited).";
          return ok(payload);
        } catch (e) {
          return fail(redact(e instanceof Error ? e.message : String(e), cred?.token ?? null), true);
        }
      },
    },
  ];
}