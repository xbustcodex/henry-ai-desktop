/**
 * Tests for the agent credential store (`electron/agent/credentials.ts`) and
 * the tool that exercises it (`electron/agent/tools/credentials.ts`).
 *
 * Two substitutions make this runnable under plain Node:
 *   - `better-sqlite3` is built against Electron's ABI here, so the DB is a
 *     `node:sqlite` DatabaseSync — the same SQL engine, and it exercises the
 *     real SQL (upsert, LIKE ESCAPE, DELETE changes) rather than a fake.
 *   - Electron's `safeStorage` is mocked with a reversible "encryption": it
 *     round-trips so a wrong implementation is caught, it is switchable OFF to
 *     reproduce the headless-Linux path, and it can be made to throw so the
 *     corrupt-value path is real rather than assumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const safe = vi.hoisted(() => ({
  available: true,
  encryptThrows: false,
  decryptThrows: false,
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => {
      if (safe.encryptThrows) throw new Error("keychain locked");
      return Buffer.from(`wrapped:${s}`, "utf8");
    },
    decryptString: (b: Buffer) => {
      if (safe.decryptThrows) throw new Error("keychain locked");
      const text = b.toString("utf8");
      if (!text.startsWith("wrapped:")) throw new Error("not a valid blob");
      return text.slice("wrapped:".length);
    },
  },
}));

import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import {
  CREDENTIAL_PREFIX,
  MAX_SECRET_LENGTH,
  credentialStatus,
  deleteCredential,
  getCredential,
  listCredentialScopes,
  setCredential,
  validateScope,
} from "./credentials";
import { credentialTools } from "./tools/credentials";

const SECRET = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

type Db = Database.Database;

function makeDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return raw as unknown as Db;
}

function rawRow(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function allKeys(db: Db): string[] {
  return (db.prepare("SELECT key FROM settings ORDER BY key").all() as Array<{ key: string }>).map(
    (r) => r.key,
  );
}

/** Runs `fn` with every console sink captured, so we can prove nothing leaks. */
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    }),
  );
  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

beforeEach(() => {
  safe.available = true;
  safe.encryptThrows = false;
  safe.decryptThrows = false;
});

describe("setCredential — encryption at rest", () => {
  it("stores the secret in enc:v1: form and never as plaintext", () => {
    const db = makeDb();
    const res = setCredential(db, "github", SECRET);
    expect(res).toEqual({ ok: true, scope: "github", encrypted_at_rest: true });

    const stored = rawRow(db, `${CREDENTIAL_PREFIX}github`);
    expect(stored).toBeDefined();
    expect(stored).toMatch(/^enc:v1:/);
    // The raw row must not contain the secret, nor a long fragment of it.
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SECRET.slice(0, 12));
    expect(getCredential(db, "github")).toBe(SECRET);
  });

  it("upserts on the same key rather than accumulating rows", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    setCredential(db, "github", "rotated_token_value");
    expect(allKeys(db)).toEqual([`${CREDENTIAL_PREFIX}github`]);
    expect(getCredential(db, "github")).toBe("rotated_token_value");
    // The superseded secret is gone from disk, not merely shadowed in memory.
    expect(JSON.stringify(allKeys(db))).not.toBe("");
    expect(rawRow(db, `${CREDENTIAL_PREFIX}github`)).not.toContain(SECRET);
  });

  it("round-trips secrets containing colons, spaces and unicode", () => {
    const db = makeDb();
    const odd = "a:b c\td\u00e9\u4e2d";
    expect(setCredential(db, "openai", odd)).toMatchObject({ ok: true });
    expect(getCredential(db, "openai")).toBe(odd);
  });

  it("stores unencrypted and says so when safeStorage is unavailable", () => {
    const db = makeDb();
    safe.available = false;
    const res = setCredential(db, "github", SECRET);
    expect(res).toMatchObject({ ok: true, scope: "github", encrypted_at_rest: false });
    // _keyStorage's documented fallback: the value is on disk in the clear.
    expect(rawRow(db, `${CREDENTIAL_PREFIX}github`)).toBe(SECRET);
    expect(credentialStatus(db, "github")).toEqual({
      scope: "github",
      configured: true,
      encrypted_at_rest: false,
      usable: true,
    });
  });

  it("falls back to plaintext (encrypted_at_rest false) when encryption throws", () => {
    const db = makeDb();
    safe.encryptThrows = true;
    const res = setCredential(db, "github", SECRET);
    expect(res).toMatchObject({ ok: true, encrypted_at_rest: false });
    expect(credentialStatus(db, "github").encrypted_at_rest).toBe(false);
  });

  it("refuses non-string, empty and whitespace-only secrets without writing a row", () => {
    const db = makeDb();
    for (const bad of [undefined, null, 42, {}, "", "   ", "\n\t"]) {
      const res = setCredential(db, "github", bad);
      expect(res.ok, `secret ${JSON.stringify(bad)} must be refused`).toBe(false);
    }
    expect(allKeys(db)).toEqual([]);
  });

  it("refuses a secret past the length bound instead of storing it", () => {
    const db = makeDb();
    const huge = "x".repeat(MAX_SECRET_LENGTH + 1);
    const res = setCredential(db, "github", huge);
    expect(res).toEqual({
      ok: false,
      error: `credential for "github" exceeds ${MAX_SECRET_LENGTH} characters`,
    });
    expect(allKeys(db)).toEqual([]);
    // A secret exactly at the bound is still accepted.
    expect(setCredential(db, "github", "y".repeat(MAX_SECRET_LENGTH)).ok).toBe(true);
  });
});

describe("scope validation", () => {
  it("rejects empty, whitespace, colon-bearing and over-long scopes", () => {
    for (const bad of [
      "",
      "   ",
      "a:b",
      "a b",
      "a\tb",
      "GitHub",
      "a/b",
      "a'b",
      "a%b",
      "x".repeat(65),
      42,
      null,
      undefined,
    ]) {
      expect(validateScope(bad).ok, `scope ${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  it("accepts lowercase dotted/dashed/underscored scopes", () => {
    for (const good of ["github", "openai", "stripe_test", "acme-inc", "v1.api", "a", "0"]) {
      expect(validateScope(good)).toEqual({ ok: true, scope: good });
    }
  });

  it("cannot be used to write a row that collides with another namespace", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    // "github:evil" would address a different prefix if it were interpolated.
    expect(setCredential(db, "github:evil", "attacker_value").ok).toBe(false);
    expect(getCredential(db, "github:evil")).toBeNull();
    expect(rawRow(db, `${CREDENTIAL_PREFIX}github`)).not.toContain("attacker_value");
    expect(allKeys(db)).toEqual([`${CREDENTIAL_PREFIX}github`]);
  });
});

describe("credentialStatus — renderer-safe metadata", () => {
  it("contains no secret material at all", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    const status = credentialStatus(db, "github");
    expect(Object.keys(status).sort()).toEqual([
      "configured",
      "encrypted_at_rest",
      "scope",
      "usable",
    ]);
    const json = JSON.stringify(status);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(SECRET.slice(0, 8));
    // Not even the length, which narrows a brute force far more than it helps.
    expect(json).not.toContain(String(SECRET.length));
  });

  it("reports plaintext-stored credentials as not encrypted at rest", () => {
    const db = makeDb();
    safe.available = false;
    setCredential(db, "github", SECRET);
    expect(credentialStatus(db, "github").encrypted_at_rest).toBe(false);
    expect(JSON.stringify(credentialStatus(db, "github"))).not.toContain(SECRET);
  });

  it("treats an unknown scope as not configured instead of throwing", () => {
    const db = makeDb();
    expect(credentialStatus(db, "never_set")).toEqual({
      scope: "never_set",
      configured: false,
      encrypted_at_rest: false,
      usable: false,
    });
    expect(getCredential(db, "never_set")).toBeNull();
    expect(deleteCredential(db, "never_set")).toBe(false);
  });

  it("reports a corrupt row as configured-but-unusable", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      `${CREDENTIAL_PREFIX}github`,
      "enc:v1:bm90LWEtcmVhbC1ibG9i",
    );
    expect(credentialStatus(db, "github")).toEqual({
      scope: "github",
      configured: true,
      encrypted_at_rest: true,
      usable: false,
    });
  });
});

describe("getCredential — main-process read path", () => {
  it("returns null (never throws) for a corrupt encrypted value", async () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    // Replace the ciphertext with something the keychain cannot unwrap.
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      "enc:v1:bm90LWEtcmVhbC1ibG9i",
      `${CREDENTIAL_PREFIX}github`,
    );
    const { result } = await captureConsole(() => getCredential(db, "github"));
    expect(result).toBeNull();
    // Still encrypted at rest even though it is unusable.
    expect(credentialStatus(db, "github").usable).toBe(false);
  });

  it("returns null when the row is encrypted but the machine can no longer decrypt", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    safe.available = false;
    expect(getCredential(db, "github")).toBeNull();
  });

  it("tolerates a legacy plaintext row and flags it as unencrypted", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      `${CREDENTIAL_PREFIX}github`,
      SECRET,
    );
    expect(getCredential(db, "github")).toBe(SECRET);
    const status = credentialStatus(db, "github");
    expect(status).toMatchObject({ configured: true, encrypted_at_rest: false, usable: true });
  });

  it("returns null for an out-of-shape scope without touching the DB", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    for (const bad of ["", "a:b", "A", 42, null, undefined]) {
      expect(getCredential(db, bad)).toBeNull();
    }
  });

  it("never logs the secret on any path", async () => {
    const db = makeDb();
    const { output } = await captureConsole(() => {
      setCredential(db, "github", SECRET);
      getCredential(db, "github");
      credentialStatus(db, "github");
      listCredentialScopes(db);
      deleteCredential(db, "github");
      // Force the noisy failure path inside _keyStorage too.
      setCredential(db, "github", SECRET);
      safe.decryptThrows = true;
      getCredential(db, "github");
    });
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(SECRET.slice(0, 10));
  });
});

describe("deleteCredential", () => {
  it("removes the row and flips status to not configured", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    expect(credentialStatus(db, "github").configured).toBe(true);

    expect(deleteCredential(db, "github")).toBe(true);
    expect(rawRow(db, `${CREDENTIAL_PREFIX}github`)).toBeUndefined();
    expect(getCredential(db, "github")).toBeNull();
    expect(credentialStatus(db, "github")).toEqual({
      scope: "github",
      configured: false,
      encrypted_at_rest: false,
      usable: false,
    });
    // Second delete reports honestly instead of claiming another wipe.
    expect(deleteCredential(db, "github")).toBe(false);
  });

  it("refuses a malformed scope and leaves every row intact", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    expect(deleteCredential(db, "github:evil")).toBe(false);
    expect(deleteCredential(db, "  ")).toBe(false);
    expect(getCredential(db, "github")).toBe(SECRET);
  });
});

describe("listCredentialScopes", () => {
  it("lists only agent credential scopes, sorted, never their values", () => {
    const db = makeDb();
    setCredential(db, "stripe_test", SECRET);
    setCredential(db, "github", "other_secret");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("theme", "dark");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("github_token", "enc:v1:x");

    expect(listCredentialScopes(db)).toEqual(["github", "stripe_test"]);
    // A LIKE wildcard in a hand-written row must not widen the listing.
    expect(listCredentialScopes(db).every((s) => !s.includes("%"))).toBe(true);
  });

  it("skips a hand-edited row whose scope does not pass validation", () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      `${CREDENTIAL_PREFIX}Bad Scope`,
      "x",
    );
    expect(listCredentialScopes(db)).toEqual(["github"]);
  });

  it("is empty on a fresh database", () => {
    expect(listCredentialScopes(makeDb())).toEqual([]);
  });
});

describe("credential_status tool", () => {
  const ctx = (db: Db) => ({ db, getWindow: () => null }) as never;

  it("is registered silent, and reports metadata without any secret", async () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    const tools = credentialTools();
    const tool = tools.find((t) => t.name === "credential_status");
    expect(tool).toBeDefined();
    expect(tool!.safetyLevel).toBe("silent");
    expect(tool!.inputSchema.additionalProperties).toBe(false);

    const res = await tool!.execute({}, ctx(db));
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res.data);
    expect(json).not.toContain(SECRET);
    expect(res.data).toMatchObject({
      credentials: [{ scope: "github", configured: true, encrypted_at_rest: true, usable: true }],
      plaintext_scopes: [],
    });
  });

  it("lists plaintext-backed scopes so the user learns the secret is not protected", async () => {
    const db = makeDb();
    safe.available = false;
    setCredential(db, "github", SECRET);
    const tool = credentialTools().find((t) => t.name === "credential_status")!;
    const res = await tool.execute({}, ctx(db));
    expect(res.ok).toBe(true);
    expect((res.data as { plaintext_scopes: string[] }).plaintext_scopes).toEqual(["github"]);
    expect(JSON.stringify(res.data)).not.toContain(SECRET);
  });

  it("scopes to one credential when asked, and rejects a malformed scope", async () => {
    const db = makeDb();
    setCredential(db, "github", SECRET);
    const tool = credentialTools().find((t) => t.name === "credential_status")!;

    const one = await tool.execute({ scope: "github" }, ctx(db));
    expect(one.ok).toBe(true);
    expect((one.data as { count: number }).count).toBe(1);
    expect(JSON.stringify(one.data)).not.toContain(SECRET);

    const bad = await tool.execute({ scope: "github:evil" }, ctx(db));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it("reports an empty store as a hint rather than an error", async () => {
    const tool = credentialTools().find((t) => t.name === "credential_status")!;
    const res = await tool.execute({}, ctx(makeDb()));
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ credentials: [], count: 0 });
  });

  it("returns a failure instead of throwing when the DB read blows up", async () => {
    const broken = {
      prepare() {
        throw new Error("database is closed");
      },
    } as unknown as Db;
    const tool = credentialTools().find((t) => t.name === "credential_status")!;
    const res = await tool.execute({}, ctx(broken));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("database is closed");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
