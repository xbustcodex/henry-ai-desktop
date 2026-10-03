# Parity Completion — Architecture, Reproduction and Continuation

Status document for the Henry AI Desktop parity programme. `PARITY_LEDGER.md` is the
authoritative row-by-row record; this file holds the things a ledger cannot express:
why the architecture is shaped the way it is, how to reproduce the verification,
what is still blocked and on what, and where to pick up.

---

## 1. The failure modes this programme exists to prevent

Every significant defect found in the completion run shared one of two shapes. Both are
recorded here because they are the reason several checks exist.

### 1.1 Code existing is not proof

Three separate features were built, tested green, and did not work:

| Feature | What existed | Why it failed |
|---|---|---|
| Ollama streaming | `streamOpenAI/Groq/Anthropic` | No `streamOllama`; Ollama fell into the non-streaming `default` branch |
| Agent tool calls | 52 tools registered, ToolRunner clean | `callAIWithTools` never routed Ollama to a tool adapter — **tools were never sent to the model at all** |
| Assistant name (6.11) | All 12 greeting variants parameterised, test passing | No setting supplied the value; `brand_name` was not read, and `creator_orb` is an orb-appearance blob |

In every case the unit tests passed. They tested the function, not the path a user reaches.

**Rule:** a test that calls an internal helper directly proves the helper. Acceptance
evidence must come from the installed package, through the same entry point the user uses.

### 1.2 Correct-looking artifacts can be empty

`npx electron-builder` was run directly instead of `npm run build`. Because
electron-builder packages `dist-electron/` and `dist/` rather than `electron/` and `src/`,
it produced a correctly-timestamped `.exe` and `.asar` containing **none** of the day's
work. The installer ran, the app booted, CDP responded — only the content was stale. The
only reason it was caught was that someone grepped the asar by hand.

**Guard:** `scripts/verify-package.mjs` compares a built asar against the current source.
Run it before accepting any evidence from a build.

```bash
npm run build -- --win nsis portable --x64   # runs vite build && electron-builder
node scripts/verify-package.mjs --release2   # must pass before accepting evidence
```

Probes are string literals and IPC channel names, never function names — bundling renames
and inlines local functions, and probes by function name produce false positives that get
the guard ignored. There is also a `FORBIDDEN` list, because a deliberately-removed symbol
still being present is itself evidence of an old build.

---

## 2. Architecture decisions worth preserving

### 2.1 The IPC validation boundary is structural, not per-file

Row 11.12 was recorded CLOSED and was wrong: 334 channels, ~27 schemas, ~8% coverage.
The fix is `installIpcBoundary()` in `electron/main.ts`, which wraps `ipcMain.handle` at
**module scope**, before any `register*Handlers()` call. Every channel is therefore covered
by construction, without editing 30+ files or depending on anyone remembering to migrate
their module.

Coverage is **measured**, not asserted: `scripts/ipc-coverage.mjs` enumerates channels and
counts per channel, never per schema definition — a family with three channels and one
shared schema must not read as fully covered.

**The preload contract is authoritative.** If preload legitimately sends a bare string, the
schema must match that; do not invent an object schema. Known mixed shapes:
`fs:readDirectory` and `fs:readFile` send bare strings, `fs:writeFile` sends an object,
`knowledge:get` and `knowledge:delete` send bare strings.

### 2.2 `confirmSilentTools` defaults to false, deliberately

Fail-closed is the right default for a switch gating a *new* capability. It is the wrong
default for a switch gating a pre-existing, deliberately-designed tier classification.
Default-true would silently change shipped behaviour for every existing user on upgrade,
collapse the meaning of the silent tier, and produce 33 prompts per agent turn — a
click-through generator that makes the product noisier without making it safer.

The panel states the consequence in both states and derives the tool count from the registry
rather than hardcoding it, because a stale constant in security copy is worse than no copy.

### 2.3 Tool calls are mined only from text the model authored

`parseInlineToolCalls` recovers tool calls that small local models emit as plain JSON prose.
It is fenced by `ToolCallTextSource = 'model-output'` — a single-member union **and** a
runtime guard that returns before any parsing.

This matters because retrieved content is attacker-influenced. A web page carrying
tool-call-shaped JSON must never become an executed tool, or every safety tier in the app is
bypassed by a single fetch. Negative tests cover tool-result and web-fetched content.

**Accepted residual:** a model that reads a poisoned page and then *echoes* the blob in its
own turn will have it mined. The boundary is about the provenance of the string, not about
whether the model was influenced. Closing the echo case would mean refusing to mine whenever
tool results are in context, which breaks the legitimate recovery path for models that only
emit calls as text.

### 2.4 Migrations are lazy, not eager

`registerMemoryHandlers` originally ran vector DDL at registration time, which broke
`memory.test.ts` 4/4 with `db.exec is not a function` for any caller holding a partial db.
Registration is now side-effect free; DDL runs on first real use. Fresh and existing
installs both land a correct schema with no destructive DDL.

Modules own their own migrations via `CREATE TABLE IF NOT EXISTS` rather than adding columns
to another owner's database — idempotent on both a fresh and a populated install.

### 2.5 Home confinement is platform-aware

`resolveUserPath` blanket-refused any `^[a-zA-Z]:[\\/]` string. That is correct on Linux,
where such a string is a relative filename, and **wrong on Windows**, where the user's home
directory *is* a drive path — so the tools could not reach the user's own files by absolute
path, and a correct tool produced an incorrect answer that the model then reported to the
user. The guard is now applied only when `process.platform !== 'win32'`; on Windows those
paths fall through to the same containment and symlink checks as everything else.

Same defect class as the earlier `tasklist ... | head -40` failure: one platform's assumption
applied to another.

---

## 3. Reproducing the verification

```bash
npm run typecheck
npm test
npm run build -- --win nsis portable --x64     # vite build FIRST — see §1.2
node scripts/verify-package.mjs --release2     # must pass

# install the real artifact, then launch it
cp release2/Henry-AI-Setup-3.0.7-x64.exe /mnt/c/Users/xkali/AppData/Local/Temp/henry-setup.exe
/mnt/c/Windows/System32/cmd.exe /c "C:\\Users\\xkali\\AppData\\Local\\Temp\\henry-setup.exe /S"

node scripts/acceptance/drive.mjs launch       # start + wait for readiness
node scripts/acceptance/drive.mjs eval "<js>"  # drive the real UI over CDP
node scripts/acceptance/drive.mjs restart      # persistence checks need a real restart
node scripts/acceptance/drive.mjs state        # dump settings + runtime for diffing

node scripts/acceptance/security-regression.mjs   # all probes must be refused
node scripts/acceptance/cleanup-audit.mjs          # must find no residue
```

`drive.mjs` enables focus emulation before every expression. The installed window is not
foregrounded when driven headlessly, and without it the renderer freezes its timers and
every `await`-based probe hangs until the driver times out.

**Tool-call timing on this machine:** cold Ollama model load takes minutes under load; warm
rounds are seconds. Measure `firstChunkMs` versus `lastChunkMs`, not absolute duration.

---

## 4. Unresolved prerequisites

### 4.1 Requires a real credential

| Rows | Prerequisite |
|---|---|
| 2.3, 2.4, 11.1 | OpenAI / Anthropic key. Adapter shape is test-proven; no live call was ever made. |
| 10.1, 10.2 | Google account. Note: accounts connected before `gmail.send`/`drive.file` were added will 403 on send/upload — reconnect. |
| 10.4 | Discord bot token plus a server with the bot invited and Message Content enabled. |
| 10.11 | Same Google credential, to prove the upstream OAuth leg. |
| 6.9 | ElevenLabs API key. |

No credential was ever fabricated and no external call was ever faked.

### 4.2 Requires hardware

- **6.8** — physical microphone for interim/caption results.
- **7.3** — acceptance drives the **real mouse and keyboard** (`SetCursorPos`/`SendInput` on
  Windows). Warn the user before running it. Expect the first call to take 1–3 s while the
  `Add-Type` shim compiles; it is resident afterwards.

### 4.3 Deliberately not exercised

- **11.6 updater** — verifying it means downloading and installing a binary. The surface
  exists and is tested; installation is left to an explicit decision.
- **11.14 failure screen** — the healthy hide-path is verified (`startupGetFailure()` →
  `null`, `bootFailed: false`). Forcing a boot failure risks corrupting the install.

### 4.4 Deferred bug

- **8.1 AI Companion, physical Android QR.** LAN discovery, listener binding and the
  pair-token guard defects were all fixed and verified. The device still dies after the
  Companion UI first renders; the remaining boundary is undiagnosed. `sync_allow_lan` is
  restored to `false`, the listener is loopback-only, the test token was revoked and
  `linkedDevices` is empty. **Do not spend time here during other work.**

---

## 5. Known gaps deliberately left visible

These are real, recorded in their ledger rows, and must not be quietly closed:

1. **6.11 assistant name** — the greeting variants are parameterised, but until an
   authoritative persisted setting supplies the value, no configuration reaches them.
2. **Tool-stream renderer subscriber** — provider, ToolRunner and preload are proven;
   if nothing in `src/` subscribes, an agent turn still displays as one block. A channel
   with no consumer is not a feature. This is the **fourth** instance of that pattern here,
   after the knowledge tools, the `knowledge:*` preload surface, and the opencode bridge.
3. **`confirmDeleteOutsideHome`** — if it still has no call site, the Security panel contains
   a switch that changes UI state only.

---

## 6. Working on this codebase

- Renderer code must not import Node built-ins (`os`, `fs`, `child_process`). Use the
  preload/contextBridge API and `src/utils/platform.ts`.
- `src/platform/tts.ts` is **main-process code despite living under `src/`** — it imports
  `ipcMain`, `child_process` and `_keyStorage`. It is safe only because nothing in the
  renderer import graph reaches it. Do not import it from renderer code.
- Never `git commit` from a sub-agent. Assign explicit file ownership; concurrent agents
  editing one file is how the preload bridge gets broken.
- A rejection from an IPC call is a fact about **the call that was made**, not proof of a
  defect. Two false findings in this run — one committed as a regression — came from reading
  a rejection without reproducing it. Check the preload signature before calling.
