/**
 * GitHub read-tool tests.
 *
 * Nothing here touches the network or a real GitHub account: the HTTP seam
 * (`__setHttpFetchForTests`) is swapped for a scripted double, and the DB is a
 * stub whose `settings` row is whatever each test wants.
 *
 * What these lock down is the behaviour a consumer would actually regress:
 * refusal of malformed/hostile input, the not-configured payload, non-2xx never
 * reported as success, retryable classification, output bounding, and — the one
 * that matters most — that the stored token can never leak into a payload or an
 * error string.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `_keyStorage` imports Electron's safeStorage at module load.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

import type Database from 'better-sqlite3';
import type { AgentContext } from '../types';
import { githubTools, isValidRepo, hasPathTraversal, __setHttpFetchForTests } from './github';

const TOKEN = 'ghp_supersecrettoken0123456789';

const tools = githubTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const tool = (name: string) => {
  const t = byName.get(name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

/** A DB stub exposing exactly the one `settings` row the credential reader asks for. */
function ctxWith(stored: string | null): AgentContext {
  const db = {
    prepare(sql: string) {
      return {
        get(key: string) {
          if (!/FROM settings/.test(sql)) throw new Error(`unexpected query: ${sql}`);
          return key === 'github_token' && stored !== null ? { value: stored } : undefined;
        },
      };
    },
  } as unknown as Database.Database;
  return { db, getWindow: () => null };
}

const anonCtx = () => ctxWith(null);
const authedCtx = () => ctxWith(`enc:v1:${Buffer.from(TOKEN, 'utf8').toString('base64')}`);

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let calls: { url: string; headers: Record<string, string> }[] = [];
let respond: (url: string) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  respond = () => jsonRes({});
  __setHttpFetchForTests(async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(url);
  });
});

afterEach(() => {
  __setHttpFetchForTests(null);
  vi.restoreAllMocks();
});

describe('github tool surface', () => {
  it('exposes exactly the read-only kit, all silent', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'github_file',
      'github_issues',
      'github_repo',
      'github_search',
      'github_status',
    ]);
    for (const t of tools) {
      expect(t.safetyLevel, `${t.name} is a read`).toBe('silent');
      expect(t.category).toBe('external');
    }
  });
});

describe('validators', () => {
  it.each(['facebook/react', 'owner/name.with.dots-and_dashes', 'a-b/c_d.e'])(
    'accepts %s',
    (repo) => expect(isValidRepo(repo)).toBe(true),
  );

  it.each([
    ['no owner', 'react'],
    ['extra segment', 'facebook/react/main'],
    ['full URL', 'https://github.com/facebook/react'],
    ['empty', ''],
    ['traversal owner', '../react'],
    ['dot owner', './react'],
    ['non-string', 42],
  ])('rejects %s', (_label, repo) => expect(isValidRepo(repo)).toBe(false));

  it.each(['README.md', 'src/index.ts', 'a/b/c/d.txt', '.github/workflows/ci.yml'])(
    'allows path %s',
    (p) => expect(hasPathTraversal(p)).toBe(false),
  );

  it.each([
    '..',
    '../../etc/passwd',
    'src/../../secrets.env',
    '%2e%2e/%2e%2e/etc/passwd',
    'src\\..\\..\\windows',
    '',
    '   ',
  ])('refuses traversal in %j', (p) => expect(hasPathTraversal(p)).toBe(true));
});

describe('github_status', () => {
  it('reports not configured for a fresh install without inventing anything', async () => {
    const r = await tool('github_status').execute({}, anonCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ connected: false, configured: false, encrypted_at_rest: false });
    expect(calls).toHaveLength(0);
  });

  it('reports configured + encrypted at rest, and never a slice of the token', async () => {
    const r = await tool('github_status').execute({}, authedCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ connected: true, configured: true, encrypted_at_rest: true });
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('ghp_');
  });

  it('flags a plaintext-stored token as configured but not encrypted', async () => {
    const r = await tool('github_status').execute({}, ctxWith(TOKEN));
    expect(r.data).toMatchObject({ connected: true, configured: true, encrypted_at_rest: false });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('github_repo', () => {
  it('rejects a malformed repo before any request', async () => {
    const r = await tool('github_repo').execute({ repo: 'facebook' }, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/owner\/name/i);
    expect(calls).toHaveLength(0);
  });

  it('returns metadata and attaches the auth header when a token exists', async () => {
    respond = () =>
      jsonRes({
        full_name: 'facebook/react',
        description: 'The library for web and native user interfaces',
        default_branch: 'main',
        language: 'JavaScript',
        stargazers_count: 220000,
        forks_count: 45000,
        open_issues_count: 700,
        pushed_at: '2026-09-30T10:00:00Z',
        license: { spdx_id: 'MIT' },
        topics: ['react', 'javascript'],
      });
    const r = await tool('github_repo').execute({ repo: 'facebook/react' }, authedCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      full_name: 'facebook/react',
      default_branch: 'main',
      stars: 220000,
      forks: 45000,
      open_issues: 700,
      license: 'MIT',
      topics: ['react', 'javascript'],
      configured: true,
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/facebook/react');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers.Accept).toBe('application/vnd.github+json');
  });

  it('reads anonymously and flags configured:false rather than failing', async () => {
    respond = () => jsonRes({ full_name: 'owner/name' });
    const r = await tool('github_repo').execute({ repo: 'owner/name' }, anonCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ configured: false });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe('github_issues', () => {
  it('clamps limit to the API maximum', async () => {
    respond = () => jsonRes([]);
    await tool('github_issues').execute({ repo: 'o/n', limit: 5000 }, anonCtx());
    expect(calls[0].url).toContain('per_page=100');
  });

  it('defaults to open state and passes the label filter through', async () => {
    respond = () => jsonRes([]);
    await tool('github_issues').execute({ repo: 'o/n', labels: 'bug, p1 ' }, anonCtx());
    expect(calls[0].url).toContain('state=open');
    expect(calls[0].url).toContain('labels=bug%2Cp1');
  });

  it('hits the real pulls endpoint when asked, and maps its comment shape', async () => {
    respond = () =>
      jsonRes([
        {
          number: 42,
          title: 'Fix the thing',
          state: 'open',
          labels: [{ name: 'ready' }],
          user: { login: 'octocat' },
          comments: 2,
          review_comments: 3,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          html_url: 'https://github.com/o/n/pull/42',
        },
      ]);
    const r = await tool('github_issues').execute({ repo: 'o/n', pulls: true }, anonCtx());
    expect(calls[0].url).toContain('/repos/o/n/pulls?');
    expect(r.ok).toBe(true);
    const data = r.data as { kind: string; issues: Record<string, unknown>[] };
    expect(data.kind).toBe('pulls');
    expect(data.issues[0]).toMatchObject({
      number: 42,
      labels: ['ready'],
      user: 'octocat',
      comments: 5, // review comments count too, unlike the issues endpoint
    });
  });

  it('marks issues that are really pull requests', async () => {
    respond = () => jsonRes([{ number: 7, title: 'x', pull_request: { url: 'u' } }]);
    const r = await tool('github_issues').execute({ repo: 'o/n' }, anonCtx());
    const data = r.data as { issues: Record<string, unknown>[] };
    expect(data.issues[0].is_pull_request).toBe(true);
  });
});

describe('github_file', () => {
  it('refuses a traversal path before building a URL', async () => {
    const r = await tool('github_file').execute({ repo: 'o/n', path: '../../secrets.env' }, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\.\./);
    expect(calls).toHaveLength(0);
  });

  it('requires a path', async () => {
    const r = await tool('github_file').execute({ repo: 'o/n' }, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/path is required/i);
  });

  it('decodes base64 content and pins an explicit ref without resolving the default branch', async () => {
    respond = (url) => {
      if (url.includes('/contents/')) {
        return jsonRes({
          type: 'file',
          encoding: 'base64',
          size: 12,
          sha: 'abc',
          path: 'README.md',
          content: Buffer.from('# hello\n', 'utf8').toString('base64'),
        });
      }
      throw new Error(`unexpected call ${url}`);
    };
    const r = await tool('github_file').execute({ repo: 'o/n', path: 'README.md', ref: 'v2' }, anonCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ ref: 'v2', type: 'file', truncated: false, content: '# hello\n' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('ref=v2');
  });

  it('resolves the default branch when no ref is given', async () => {
    // A repo of its own: the default-branch lookup is cached per repo, so this
    // must not share a key with a sibling test.
    respond = (url) => {
      if (url.endsWith('/repos/branchy/proj')) return jsonRes({ default_branch: 'trunk' });
      return jsonRes({ type: 'file', encoding: 'base64', content: Buffer.from('x').toString('base64') });
    };
    const r = await tool('github_file').execute({ repo: 'branchy/proj', path: 'a.txt' }, anonCtx());
    expect(r.data).toMatchObject({ ref: 'trunk' });
    expect(calls[0].url).toBe('https://api.github.com/repos/branchy/proj');
  });

  it('clamps content and flags it as truncated', async () => {
    const big = 'y'.repeat(500);
    respond = () =>
      jsonRes({ type: 'file', encoding: 'base64', content: Buffer.from(big, 'utf8').toString('base64') });
    const r = await tool('github_file').execute({ repo: 'o/n', path: 'a.txt', ref: 'm', max_bytes: 100 }, anonCtx());
    expect(r.data).toMatchObject({ truncated: true, max_bytes: 100, truncated_at: 100 });
    expect((r.data as { content: string }).content).toHaveLength(100);
  });

  it('enforces a hard ceiling on max_bytes', async () => {
    respond = () => jsonRes({ type: 'file', encoding: 'base64', content: '' });
    const r = await tool('github_file').execute(
      { repo: 'o/n', path: 'a.txt', ref: 'm', max_bytes: 99_999_999 },
      anonCtx(),
    );
    expect((r.data as { max_bytes: number }).max_bytes).toBe(500_000);
  });

  it('lists a directory instead of pretending it has content', async () => {
    respond = () => jsonRes([{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 10 }]);
    const r = await tool('github_file').execute({ repo: 'o/n', path: 'src', ref: 'm' }, anonCtx());
    expect(r.data).toMatchObject({ type: 'directory', count: 1 });
  });
});

describe('github_search', () => {
  it('requires a query', async () => {
    const r = await tool('github_search').execute({}, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/q is required/i);
  });

  it('URL-encodes the query and defaults to code search', async () => {
    respond = () => jsonRes({ total_count: 1, items: [{ name: 'useState', path: 'src/a.ts', repository: { full_name: 'o/n' } }] });
    const r = await tool('github_search').execute({ q: 'useState repo:o/n' }, anonCtx());
    expect(calls[0].url).toBe('https://api.github.com/search/code?q=useState+repo%3Ao%2Fn&per_page=20');
    expect(r.data).toMatchObject({ kind: 'code', total_count: 1 });
    expect((r.data as { items: Record<string, unknown>[] }).items[0]).toMatchObject({
      name: 'useState',
      path: 'src/a.ts',
      repository: 'o/n',
    });
  });

  it('maps commit results, bounding the message', async () => {
    respond = () =>
      jsonRes({
        total_count: 1,
        items: [{ sha: 'deadbeef', commit: { message: 'z'.repeat(900), author: { name: 'Sam', date: '2026-05-01' } } }],
      });
    const r = await tool('github_search').execute({ q: 'fix', kind: 'commits' }, anonCtx());
    expect(calls[0].url).toContain('/search/commits?');
    const item = (r.data as { items: Record<string, unknown>[] }).items[0];
    expect(item.author).toBe('Sam');
    expect(String(item.message)).toHaveLength(501);
  });

  it('falls back to code for an unknown kind', async () => {
    respond = () => jsonRes({ total_count: 0, items: [] });
    const r = await tool('github_search').execute({ q: 'x', kind: 'wiki' }, anonCtx());
    expect(calls[0].url).toContain('/search/code?');
    expect(r.data).toMatchObject({ kind: 'code' });
  });
});

describe('HTTP failure mapping', () => {
  it.each([401, 403])('maps %i to a settings-clean error, not a success', async (status) => {
    respond = () => jsonRes({ message: 'Bad credentials' }, status);
    const r = await tool('github_repo').execute({ repo: 'o/n' }, authedCtx());
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.error).toMatch(/rejected the stored token|rate-limited/i);
    expect(r.retryable).toBe(false);
  });

  it('maps an authenticated 404 to a not-found error', async () => {
    respond = () => jsonRes({ message: 'Not Found' }, 404);
    const r = await tool('github_file').execute({ repo: 'o/n', path: 'nope.md', ref: 'm' }, authedCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  // Without a token a 404 is ambiguous — "private" looks identical to "missing".
  // Telling the user their own repo vanished would be a lie.
  it('answers an anonymous 404 with not-configured guidance, not "repo not found"', async () => {
    respond = () => jsonRes({ message: 'Not Found' }, 404);
    const r = await tool('github_repo').execute({ repo: 'acme/private' }, anonCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'not_configured', configured: false });
    expect((r.data as { message: string }).message).toMatch(/token/i);
    expect(JSON.stringify(r)).not.toMatch(/not found/i);
  });

  it('marks 5xx retryable so the runner backs off', async () => {
    respond = () => new Response('boom', { status: 503 });
    const r = await tool('github_repo').execute({ repo: 'o/n' }, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('marks a network failure retryable', async () => {
    __setHttpFetchForTests(async () => {
      throw new Error('ECONNRESET');
    });
    const r = await tool('github_search').execute({ q: 'x' }, anonCtx());
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('never leaks the token into an error, even when GitHub echoes it', async () => {
    // A hostile/misconfigured upstream that reflects the Authorization header.
    respond = () => jsonRes({ message: `Bad credentials for ${TOKEN}` }, 401);
    const r = await tool('github_repo').execute({ repo: 'o/n' }, authedCtx());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);

    // 422 is the branch that surfaces the upstream `message` verbatim.
    respond = () => jsonRes({ message: `Validation failed: ${TOKEN}` }, 422);
    const r2 = await tool('github_search').execute({ q: 'x' }, authedCtx());
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain(TOKEN);
    expect(r2.error).toContain('[redacted]');
  });

  it('survives a tool that throws rather than propagating out of execute', async () => {
    respond = () => jsonRes({ nonsense: true });
    const db = {
      prepare() {
        throw new Error('database is closed');
      },
    } as unknown as Database.Database;
    const r = await tool('github_repo').execute({ repo: 'o/n' }, { db, getWindow: () => null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/database is closed/);
  });
});