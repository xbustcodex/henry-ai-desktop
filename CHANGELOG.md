# Changelog

## Parity completion campaign — 130 rows, 88 closed

The verification and burn-down phase is finished and every actionable row has been
driven to its truthful state. `PARITY_LEDGER.md` is the authoritative row-by-row
record; `docs/PARITY_COMPLETION.md` holds the architecture decisions, reproduction
procedure and unresolved prerequisites.

| | Rows | Closed | Hardened | Partial | Missing | Unverified | Unreachable | Excluded | Commercial |
|---|---|---|---|---|---|---|---|---|---|
| **Total** | **130** | **88** | **1** | **26** | **0** | **9** | **1** | **1** | **4** |

MISSING is now zero. Automated suite: **1935 tests across 103 files**, typecheck clean.

### What the campaign found

Every significant defect shared one of two shapes, and both are now documented in
`docs/PARITY_COMPLETION.md` because they are the reason several checks exist.

**Code existing is not proof.** Three features were built, tested green, and did not
work, because the tests exercised internal functions rather than the path a user
reaches:

- Ollama never streamed — there was no `streamOllama`, so it fell into the
  non-streaming `default` branch. Live: **117 chunks over an 11.5s spread**, versus
  the recorded defect of one chunk with `firstChunkMs == lastChunkMs`.
- The agent tool-call blocker was **none of the three hypothesised causes**.
  `callAIWithTools` switched on openai/groq/anthropic only, so Ollama never had
  tools sent to the model at all — structural, not a parsing miss. Live: a real
  agent turn where the model emitted `file_list`, the tool ran, the result returned
  and the model answered correctly.
- The assistant's spoken name was parameterised in all twelve greeting variants and
  nothing supplied the value. `brand_name` is not read by the greeting and
  `creator_orb` is an appearance blob. Live: `assistant_name=Zorblax` produces
  *"Still going, JARVIS. Zorblax is awake and ready."*, survives restart, and
  restores.

**A correctly-timestamped artifact can be empty.** Running `electron-builder`
without the Vite build packaged `dist-electron/` and produced an .exe and .asar
containing none of the day's work — the installer ran and the app booted.
`scripts/verify-package.mjs` now compares a built asar against the current source
and is verified in both directions: passes on a good build, fails with eleven misses
against a stale simulator, and flags forbidden symbols.

### Live defects found by acceptance and fixed

- **Windows home confinement refused the user's own home.** A blanket drive-path
  guard — correct on Linux, wrong on Windows, where the home directory *is* a drive
  path — meant `C:/Users/<name>/Documents` was rejected as "outside your home
  directory". A correct tool produced an incorrect answer that the model then
  reported to the user.
- **The shell-confirmation gate was unsatisfiable.** `securityApproveChannel` had
  zero callers, so five gated channels were permanently refused on every default
  install; HQPanel's shell auto-execution and PrinterPanel's G-code were dead behind
  a swallowed `.catch`.
- **App lock could brick the application** — no unlock screen, while the boundary
  refuses every non-exempt channel while locked.
- **Two delete handlers swallowed refusals.** `media:delete` and `attachments:delete`
  wrapped their path resolution inside an unlink `catch` intended for ENOENT, which
  also swallowed the invalid-reference refusal — deleting the row, leaving the bytes
  on disk, and returning `{ok:true}`.
- **A transient Ollama error permanently changed the embedding space**, so recall
  silently degraded to fallback-versus-fallback comparison.
- Anthropic 400 on parallel tool calls, system-prompt overwrite and ignored stream
  errors; a relay that could send its bearer token toward `api.openai.com`; OAuth
  `error=` acted on before `state`; interval triggers that double-fired; a Logs panel
  that would have rendered empty forever.

### Regressions this campaign introduced, and found

Recorded because they are the honest cost of the work:

- The seven destructive `computer:*` file channels had **no schema at all**, and a
  generic `invoke(channel, ...)` preload passthrough made every registered channel
  reachable regardless of whether preload named it — so those schemas were the only
  validation those channels received. The passthrough is removed.
- Two claimed results had to be **retracted**: a false regression claim about
  attachments (a probe called without its required argument), and a false diagnosis
  that the streaming join was broken (the test was wrong, not the wiring).

### Removals

`confirmDeleteOutsideHome` was **removed rather than wired**. Investigation proved
it could only ever add attribution and never permission, so shipping it would have
meant weakening home confinement to make a toggle look live. The seven file-channel
schemas it was investigated alongside were kept, being an independent mutation-proven
fix.

### Deliberately unverified

No credential, microphone, Piper binary, updater binary or destructive test was
fabricated. Rows requiring a real Google account, Discord bot, OpenAI/Anthropic key,
ElevenLabs key, physical microphone, or the deferred physical-Android Companion bug
(8.1) remain explicitly unproven, each with its prerequisite named in the ledger.


## Known bug — Companion QR / Android session failure (deferred)

Fixed and verified:
- LAN discovery selected a Hyper-V virtual adapter (172.18.96.1) over the real
  Wi-Fi (192.168.1.110) because it took the first non-internal IPv4.
  Now default-route driven; 14 regression tests.
- The state payload advertised a LAN URL while the listener was loopback-only.
- Two pairing-token guard defects stopped a phone pairing at all: LAN pairing was
  impossible by construction (the PIN route was loopback-only), and the guard then
  validated against the paired-device session tokens instead of the QR pair token.

Still broken: the physical Android retest fails and the session dies the same way.
The remaining failure boundary is undiagnosed. The affected Card 8 lifecycle rows
are recorded as PARTIAL / KNOWN BUG — DEFERRED and are not marked closed.

Test environment was restored: sync_allow_lan off, pairing token revoked, no
linked devices, listener back on 127.0.0.1:4242.

## 3.0.7 — Feature integration + Linux hardening

Two tracks of work: a full audit of the Linux port with every confirmed defect
fixed, and the integration of features from the upstream 1.7.0 build that were
missing here. Paid/licensed upstream capabilities (license redemption, credits,
hosted AI proxy) were deliberately **not** ported; everything shipped here runs
locally on the user's own keys and local Ollama.

### New features

- **Chat attachments** — attach any file to a message. Bytes are stored outside
  the renderer under `<userData>/attachments` and indexed in
  `message_attachments`; the renderer only ever holds an opaque id. 25 MB cap,
  image preview, open externally, delete. Paperclip in the composer, chips on
  the message bubble. Attachment-only messages are allowed.
- **Memory graph** (`Memory → Graph`) — a force-laid-out map of how projects,
  goals, facts, commitments, milestones and narratives relate. Edges come only
  from relationships actually stored (`commitments.project_id`,
  `milestones.project_id`, narrative link arrays, explicit
  `memory_graph_edges`) — never invented, so a fresh install shows an honest
  empty map rather than fabricated connections.
- **Routine run history** — `automation_runs` records every execution with
  status, trigger, result/error and read state. Abort a running Routine, unread
  badge, mark read / mark all read, clear. Previously a Routine only remembered
  `lastRunAt`, so there was no record of what it did.
- **App deep links** — a local catalogue that turns "show me my inbox" or
  "search youtube for lofi beats" into a concrete URL, so Henry lands on the
  right screen instead of merely launching the app. No third-party service.
- **Optional hosted relay** — route requests through any OpenAI-compatible
  endpoint you control. Off unless a URL is configured in
  `Settings → Engines`; `backendStatus` never counts it as ready otherwise.
- **Media library** (`Media`) — import images, audio and documents through the
  native picker into Henry's own storage; browse, preview, play, reveal in the
  file manager, delete.
- **Spoken greeting** — time-aware, personalised, synthesised once and cached on
  disk. Off by default; toggle in the voice settings.
- **Runtime & startup diagnostics** — a boot failure is recorded durably and
  surfaced in a banner with details and a one-click restart, instead of leaving
  a silent windowless process. `runtime:get-status` reports version, Electron /
  Chromium / Node, platform, uptime and database health.
- **About panel** (`About`) — version and runtime facts, working update
  check/install (the updater API existed but nothing rendered it), and a
  getting-started checklist.

### opencode integration

- **opencode is now a first-class Coder Engine** (`electron/coder/opencode.ts`).
  Selectable in `Settings → Coder Engine` alongside Claude Code and the local
  Ollama coder, and included in `auto` (tried after Claude Code, before the
  local model). It drives `opencode run --format json` and translates that
  stream into the same `CoderStreamEvent` vocabulary the other engines emit, so
  the renderer needed no per-engine knowledge.
- **Runtime resolution.** A packaged app inherits a minimal `PATH`, and
  opencode is usually installed by a version manager (nvm/fnm/volta/bun) into a
  per-user directory. `buildCoderChildEnv()` now enumerates those install
  locations from disk and joins them with `path.delimiter` instead of a
  hardcoded `:` — that hardcoded colon was silently producing one malformed
  `PATH` entry on Windows. The Claude Code engine now shares this builder.

### Removed: ✝ Scripture

The Scripture feature is gone end to end — not just hidden. The `✝ Scripture`
nav entry, the Scripture panel, the lessons/curriculum UI, the seven
`scripture:*` IPC channels, the preload surface, the SQLite tables
(`scripture_entries`, `saved_verses`) and the supporting modules
(`scriptureStore/Lookup/Import/Reference`, `biblicalProfiles`, `biblicalLabels`,
`bibleCorpus`, `crossReferences`, `formatBiblicalResponse`, `studyNoteScaffold`,
the sample fixture) are all deleted.

Also removed because it existed only to serve Scripture: the `biblical`
operating mode (its prompt, mode detection from Bible references, the
Cmd+Shift+B shortcut, the "Study a passage" palette action, the
`biblical_study_pack` export preset, the bible source-profile plumbing) and the
Scripture-only code inside the companion bridge (the `BIBLE_LOOKUP:` shortcut,
the verse-search and save-verse endpoints, the `/sync/mac/bible` route and its
allow-list entry, the "✝ Scripture" panel-routing entry, and the "download KJV"
voice trigger). Leaving any of those would have meant a half-removed feature
that the phone companion could still invoke.

**Prayer was kept at this point** (it still had its own `scripture_ref`
free-text field), but was removed in full later — see *Removed: Prayer* below. The lessons/course `bible` course-kind enum was also
left in place; it is a separate AI-course-subject enum and removing it would be
a data-model change outside this scope.

### PrimeTech marketplace

- **A `Marketplace` panel backed by the real `marketplace.json` manifest** used
  by the PrimeTech apps, now vendored at `resources/marketplace/marketplace.json`
  and shipped via `extraResources` so the catalogue has one definition across the
  family. 6 entries: PrimeTech Terminal, Buster, Android Dev Toolbox, Termux
  File Manager, OhMyTermux and PrimeTech Marketplace.
- Catalogue browsing with search and type/category filters; the
  installed / available / no-download badge is **real runtime state** from the
  main process, never inferred in the UI. Fetched artefacts are recorded in a
  `marketplace_fetches` table so the badge survives a restart.
- Fetching streams to `Downloads/prime-tech-marketplace/` with a size cap, a
  `.part` file plus atomic rename, and records the artefact. It **never installs
  or executes anything** — most entries are Android packages, so the honest
  desktop behaviour is to fetch the file and say what it is.
- Malformed manifest entries are skipped and reported in a visible
  "problems" banner rather than poisoning the list, and `marketplace:reveal`
  only ever reveals files inside the marketplace folders.

### OpenCode: full model integration

`opencode` (v1.18.31) is now a first-class source of models, and it is not
locked to any particular one. The CLI reports **287 models** reachable from
this machine — all 8 of opencode's own "zen" service plus the OpenRouter
catalogue — and every one of them is selectable in the same Settings model list
as OpenAI, Anthropic, Google and Ollama, with no separate picker.

- **Loopback OpenAI-compatible bridge** (`electron/ipc/opencodeBridge.ts`,
  127.0.0.1:11540). Henry's provider layer speaks OpenAI shapes while opencode
  only speaks its CLI, so the bridge translates one chat completion into one
  `opencode run --format json`. It starts lazily, runs in the background, is
  never visible, and is guarded by a per-process bearer token plus a loopback
  peer check. `electron/ipc/ai.ts` then treats it as `case 'opencode'`.
- **Model discovery, not a hardcoded list.** `listOpencodeModels()` shells out
  to `opencode models` and classifies each entry, so anything opencode can
  reach today — or later — works without a code change here.
- **Credentials are no longer stripped.** `buildCoderChildEnv()` deleted every
  `OPENCODE_*` variable, which removed `OPENCODE_API_KEY` — the bearer
  credential for the zen gateway. That silently cut the catalogue to the
  unauthenticated subset (139 models). Only session/state markers are stripped
  now, and the full catalogue is reachable.
- **Run failures are no longer silent.** opencode reports a failed run as a
  *top-level* `error` event whose message is a JSON string nested two levels
  down, e.g. `Streaming response failed: [503] Upstream error from Nvidia`.
  The parsers only looked inside `part`, so a failed run produced no text and
  was reported as an empty success. Both parsers now unwrap every observed
  error shape, and a run that yields no text is an explicit error carrying the
  tail of stdout and stderr.
- **Picking a model actually configures the engine.** The opencode branch of the
  settings picker now persists an `opencode` provider row, because every chat
  surface resolves the engine with `providers.find(p => p.id === <provider>)`;
  saving only the setting left them all reporting "No model configured".
- A **Test this model** action sits next to the picker and round-trips a real
  completion, so a model can be confirmed before committing to it.
- Fixed a collision between opencode's `openrouter/...` ids and the static ones
  (duplicate `<option>` values and mis-routing), the bridge using the app's
  launch directory as the working directory, an aborted request leaving the
  spawned CLI running for up to 10 minutes, and hardcoded zero token usage.

Verified live in the running app: all 8 zen models discovered, and
`opencode/space-bunny-free`, `opencode/big-pickle` and
`opencode/nemotron-3.5-lightning-free` each returned `PONG` end to end through
the bridge, including via the normal `sendMessage` provider path.

### Bugs fixed — correctness

- **TTS was completely broken.** `voice:speak` / `voice:stopSpeaking` /
  `voice:ttsStatus` returned raw values while the renderer reads `res.ok` and
  `res.result`, so every call saw `ok === undefined` and threw. Henry could
  never speak.
- eSpeak was spawned without `--stdout`, so it tried to open the audio device
  itself and produced nothing; audio is now captured and played by the renderer.
  `stopSpeaking()` was a no-op placeholder; it now kills the live process.
- **Delegation was 100% broken.** `executeDelegation` (renderer) called
  `platform/launcher`, a main-process module that imports `child_process` and
  throws in the renderer. "Open ChatGPT and tell it X" never even opened the app.
  Now routed through `computer:openApp` / `computer:openUrl`, and the result is
  checked so a failed launch is no longer reported as success.
- **`App.tsx` returned early from its main effect**, orphaning ~40 lines:
  reminders never notified, the permissions prompt never appeared, the capture
  shortcut and all in-app shortcuts were dead, and the intended cleanup never
  ran.
- Cancelling a background task left the row stuck at `status='running'` — the
  `AbortError` path returned before the DB write, so the single-slot broker
  could wedge until restart. Now written back as `cancelled`.
- Milestones saved from the Memory panel silently discarded the chosen type and
  score (snake_case payload into a camelCase handler), so every milestone stored
  as "win" at 0.7.
- `data:export-backup` copied a live WAL database with `copyFileSync` (silently
  losing any un-checkpointed transaction) and wrote the DB — including provider
  credentials — unencrypted to the Desktop. Now a consistent `db.backup()`
  snapshot with keys redacted and `VACUUM`ed, and no dependency on the `zip`
  binary.
- `providers:resync-localStorage` injected `enc:v1:` ciphertext into the
  renderer, which sends the value straight to the provider.
- Three local-router intents (finance summary, reminders, journal) called a
  `window.electronAPI` that does not exist, so they always returned nothing.
- `workspaceIndex` hardcoded `'/workspace'` (a macOS/container path), so
  indexing failed outside the sandbox and silently produced an empty index.
- Groq 404 handling silently answered with a **different model than the user
  selected**, recursed up to ~64 requests, and masked 401/403 auth errors
  behind "no fallback models are available". Replaced with an honest error.
- Ollama auto-install used asset names that no longer exist (Linux
  `ollama-linux-<arch>` 404s) and `renameSync`'d the archive as if it were an
  executable. Now uses the real release assets and extracts them.
- System stats reported a **random** CPU percentage on Linux (`top -l 1` and
  `pmset` are macOS-only). CPU, battery and running-apps are now measured per
  platform.
- The two phone-pairing panels discovered the LAN IP with
  `ipconfig getifaddr en0` (macOS-only) and fell back to a literal
  `192.168.1.1`, so pairing on Linux pointed at the wrong address. Both now use
  the address the sync server already reports.
- Region screenshots always failed: `scrot` was given `-X,Y,W,H` instead of
  `-a X,Y,W,H`, and ImageMagick's flags were passed as a single argv token.
  Capture now walks an ordered backend ladder that matches what
  `checkCapabilities` advertises.
- The workspace indexer, the capture HUD, and the health checks leaked
  `/bin/sh: ...: not found` noise into the console.

### Bugs fixed — Linux capability honesty

- `checkCapabilities` advertised `gnome-screenshot`, `xfce4-screenshooter` and
  `grim` that the capture path never invoked, so "ready" could mean a backend
  that would not run. Capability reporting and capture now share one list.
- The system-prompt capability block hardcoded `YES` for typing, clicking and
  screenshots on every platform, so Henry told the model it could drive the
  machine even with no xdotool/scrot installed. It now reports what
  `computer:checkCapabilities` actually measured, and says "unknown" until the
  probe runs.
- Whisper setup was Homebrew-only, so voice setup could never complete on Linux
  or Windows. Binary detection now probes the real Linux install locations and
  the installer uses apt (via pkexec/sudo) or winget.
- The embedded PATH hardcoded `/opt/homebrew/bin` first on every platform.
- The bundled `cloudflared` / `openscad` are macOS Mach-O binaries shipped into
  the Linux package; the resolver now verifies a binary is actually runnable on
  the host before preferring it.

### Bugs fixed — security

- Shell injection in `computer:typeText`, `computer:activateApplication` and
  `computer:pressKey` (the last was completely unquoted), and an unvalidated
  PID in `computer:killProcess`. All now use argv-based `execFile` with no
  shell, plus runtime PID validation.
- The `POST /sync/auto-pair` route minted a permanent full-scope companion token
  and returned the HMAC secret with no token check and no loopback guard — and
  had zero callers. Removed.
- The 24-route `companionWebPaths` allow-list granted unauthenticated access,
  including arbitrary shell execution via `/sync/prompt`, and was reachable
  through the auto-started cloudflared tunnel. Now gated to the LAN (explicitly
  not through the tunnel), and the prompt route runs the catastrophic-command
  classifier.
- `GET /sync/tunnel-url` disclosed the public hostname to any caller; now
  loopback-only.
- The capture HUD interpolated raw clipboard text into HTML with a no-op
  "escape" (`replace(/</g,'<')`).

### Bugs fixed — build & packaging

- The AppImage shipped a desktop entry with `--no-sandbox` (electron-builder's
  default when `executableArgs` is unset), disabling the Chromium sandbox for
  every Linux user.
- The `.deb` used electron-builder's Debian-buster-era default dependencies, so
  `apt install` failed outright on Kali (t64 systems have no `libgtk-3-0` /
  `libatspi2.0-0`), and `libasound2` was undeclared. Now an explicit `depends`
  list with `t64` alternatives.
- `postinstall` ran `npx @electron/rebuild || true`, swallowing a failed native
  rebuild — the usual cause of a packaged `better_sqlite3.node` ABI mismatch
  that throws on every database open.
- Two dead electron-builder configs (one of them 0 bytes, and the one scanned
  first by the resolver) claimed to be authoritative while `package.json` was
  the config actually in use. Deleted.
- The tunnel had two independent cloudflared implementations with separate
  state; the surviving one spawned the bare name `cloudflared`, throwing an
  unhandled `ENOENT` on Linux. Consolidated to one, with a spawn-error handler
  and corrected `--no-autoupdate` argument order.
- A throw during boot was swallowed, leaving a windowless zombie process. Boot
  is now wrapped with a visible error and a recorded failure.
- No single-instance lock: a second launch started a second sync server, a
  second scheduler and duplicate global hotkeys.

### Tests

- 14 new tests for the app-link resolver, covering action-vs-search precedence,
  alias specificity, URL encoding and catalogue integrity. Three of them caught
  real defects while being written (a missing `actions` array, and "search X
  **for** Y" leaving the connective in the search term).


---

## Bug hunt — follow-up pass

A second audit pass over the code changed above, with six parallel deep-dive
reviews. Fixed:

- **Screenshot capability lied again.** The probe ran `which` per backend and
  reported the first one *present*, so on this machine it advertised
  `import (ImageMagick)` — which exists but cannot grab a frame in any
  invocation under ImageMagick 7. Both the probe and `computer:screenshot` now
  share one exported backend ladder (`screenshotCandidates`) and the capability
  is only reported "ready" after a **real test capture** succeeds. This also
  closed the gap where the probe advertised grim / gnome-screenshot /
  xfce4-screenshooter while the live handler only ever ran `scrot || import`.
- `gnome-screenshot`'s area option takes `WIDTHxHEIGHT+X+Y`, not scrot's
  `X,Y,W,H`; region captures through that backend always failed.
- **`XDG_SESSION_TYPE` is unset on many systems** (including this one), so
  Wayland detection fell through to "not Wayland" and picked X11 tools — correct
  here only by accident of XWayland, and silently broken on native Wayland.
  Added `electron/ipc/sessionDetect.ts`, which also consults `WAYLAND_DISPLAY`
  and `XDG_CURRENT_DESKTOP`, and used it everywhere.
- **A Routine could be permanently wedged.** The `automation_runs` INSERT sat
  *outside* the `try` in `fire()`, so a throw skipped the `finally` and left
  `firing` set for the life of the process — every later tick short-circuited,
  `isRunning()` stayed true and `abort()` had nothing to abort.
- An abort landing *between* model rounds was dropped: the listener was added
  to an `AbortSignal` that was already aborted (a signal only fires once), so
  the run finished and was recorded as `succeeded` instead of `aborted`.
- Runs orphaned at `status='running'` by a crash or a quit were never reconciled;
  they are now closed out on startup. `shutdown()` also clears `firing`.
- The six `automation:*` handlers had no error handling — a DB error rejected
  the invoke, and the renderer's single bare `catch` silently disabled the whole
  Runs feature. All wrapped now.
- `automation:runs` dropped `unreadOnly` whenever a `taskId` was supplied, and
  `automation:clear-runs` excluded in-flight runs on one branch but not the
  other — clearing a run mid-flight lost its outcome.
- **Cancelling a background task was silently reverted.** `task:cancel` wrote
  `cancelled`, then the success path overwrote it with `completed` for task
  types that ignore the abort signal (notably file execution).
- **`conversations:delete` could not delete a conversation.** `memory_facts` and
  `conversation_summaries` reference `conversations` without `ON DELETE CASCADE`
  and foreign keys are ON, so the delete threw — and because the message delete
  had already run outside a transaction, the thread was left half-deleted and
  permanently undeletable. Now cleared explicitly inside a transaction.
- **Every imported image was classified as a document.** The "Files" filter group
  in the media library re-declared `png`/`jpg`, and its loop ran after the image
  loop, overwriting the kind — so image preview never triggered and the counts
  were permanently wrong.
- **App deep links hijacked unrelated words.** Alias matching used a bare
  substring test, so 2-char aliases matched inside other words: `ig` in
  "design"/"configure", `wa` in "draw", `gh` in "neighbour" — "open figma"
  resolved to a Facebook search. Now word-boundary anchored.
- The Gmail compose recipient regex had no leading word boundary, so the "to "
  inside "**pho**to" matched and silently misaddressed the message.
- A failed `attachments:save` left up to 25 MB of unindexed bytes on disk that
  nothing could ever delete; the file is now removed when the insert fails.
- `computer:pressKey` interpolated the key into a PowerShell single-quoted
  string with no escaping, so a key containing `'` executed arbitrary
  PowerShell.
- `computer:killProcess` fired `execFile` without awaiting it, so it reported
  `{ok:true}` even for `ESRCH`/`EPERM` and the UI removed the row anyway.
- The Linux `xdotool search --name X windowactivate` fallback exits 0 even when
  it matched nothing, so activation reported success and the delegation then
  typed into whatever window had focus.
- HQPanel built `pkill -f "<window title>"` in the renderer and POSTed it to
  `/computer/shell`. Window titles come from `wmctrl`, i.e. arbitrary window
  content, so a title containing a quote or `$(...)` became shell input. Added
  a shell-free `computer:closeApp` that closes the window via `wmctrl -c`.

### API contract parity

A dedicated pass over the four surfaces that must agree — `electron/preload.ts`,
`src/global.d.ts`, `src/webMock.ts`, and every `ipcMain.handle` — found and fixed:

- **`google:getToken` / `google:refreshToken` threw a `TypeError` on every
  call.** The handlers destructured `{ clientId, clientSecret }` from their
  first argument, but the preload invoked them with no argument at all. Now the
  credentials are passed through, and the calls return `null` / a real
  "No refresh token stored" instead of crashing.
- **`henry:localGatewayStatus` was never registered** *and* had no preload
  method, so the renderer's optional probe in `resolveLocalOllamaBaseUrl` was
  permanently `undefined` and the gateway URL was never used. Both halves are
  now wired; the probe reports the truth (`active: false` when it is not
  started).
- **`memory:searchFacts` accepted one spelling of its query field.** The
  declared renderer type said `query.query` while the handler read
  `query.text`, so whichever the caller used, the other was an empty search.
  Both are accepted now.
- **`attachments:save` returned a partial row** against its own declared
  `MessageAttachment` type (missing `conversation_id` and `message_id`).
- **Web mode was missing its whole sync surface.** `syncMock` was declared but
  never merged into the fallback API, so `syncStart` / `syncGetState` and
  friends were simply `undefined` in the PWA build.
- **Web-mode attachment upload crashed on any real file** —
  `String.fromCharCode(...bytes)` spreads the entire array as function
  arguments and throws a `RangeError`. Now chunked.
- **Web-mode `linkAttachmentsToMessage` dropped the conversation id**, so a
  file queued before its conversation existed was never linked to it.
- **Two listener leaks.** `PrinterPanel` discarded the unsubscribe returned by
  `onPrinterData`, and `App.tsx` never unsubscribed `uChat` — both left a live
  IPC listener behind on every mount (doubled under React StrictMode).
- `Sidebar` duplicated the `ViewType` union with only a "keep this in sync"
  comment as protection, and had already drifted enough to fail the build when
  a view was added. It now imports the real type.

### SOCKS5 proxy now honours the existing Companion trust boundary

The Henry VPN proxy (`electron/ipc/proxyServer.ts`) was an **open relay**: it
answered the SOCKS5 greeting with "no authentication required" and forwarded
any destination for any client that could reach port 1080. Because the
companion server treats a connection from `127.0.0.1` as trusted
(`_isLoopback`), a random LAN client could `CONNECT 127.0.0.1:4242` through the
proxy and arrive as loopback — unlocking the loopback-only routes, including
the shell-exec route. In other words the proxy handed out a *more* privileged
position than a paired device has.

The fix reuses the credential that pairing already issues. **No new pairing
system and no second identity mechanism were introduced**, and the QR code,
6-digit PIN with its rotation timer, manual Rotate, `/companion/pair` endpoint,
remembered-device behaviour, the "Generate Pairing Code" flow and the
host-side approval for starting Remote Control are all unchanged. The result is
one trust model end to end:

    QR / PIN → paired device → remembered device credential
             → authenticated LAN access (HTTP server and VPN both)
             → explicit host approval for sensitive remote control

- Only username/password auth (method `0x02`) is offered; "no auth" (`0x00`) is
  no longer advertised, so an unauthenticated client never reaches the relay
  stage. The companion token is accepted as either the username or the
  password, so a client can use whichever field its UI prefers.
- `startProxy` now **requires** an `isPairedToken` validator and refuses to
  start without one, so it cannot silently regress to an open relay. The sync
  bridge injects the same `companionTokens` map that backs the HTTP server.
- Denied attempts are logged with the peer address, so an unpaired client is
  visible rather than silent.
- Replaced the `once('data')` framing with an explicit buffered state machine.
  A client may pipeline the greeting, auth and CONNECT into a single TCP
  segment, and a message may be split across reads; the old framing dropped the
  tail and the client hung.
- Failure replies now use `end()` rather than `destroy()`. `destroy()`
  discards an unflushed write, so a client asking for an unreachable host waited
  until it timed out instead of receiving "host unreachable".

Verified live against the running app: no-auth is refused at the handshake, a
wrong token and empty credentials are refused, a paired token is accepted and
relays to the companion server, a pipelined greeting+auth+CONNECT succeeds, and
an unresolvable hostname returns a clean `rep=5`. (A connect to a *closed
loopback port* cannot be demonstrated as failing on this machine because the
host does not send a TCP RST for closed loopback ports — a raw socket to the
same port also times out — so the proxy has no error to report there.)

### Two forgotten features recovered

A pass comparing every `ipcMain.handle` registration against the preload surface
found two features that were fully built but **silently unreachable**, because
the preload never exposed their channels:

- **Quoting / invoicing.** `QuotingPanel.tsx` is a live 1121-line UI whose
  `api()` probe calls twelve `quote:*` methods, and every handler already
  existed in `electron/ipc/quoting.ts`. With no bridge methods, `api()` resolved
  to `null` and every call was a no-op — the panel rendered permanently empty
  with no error anywhere. All twelve are now exposed
  (`quoteList` … `quoteExportMarkdown`), with each return shape matched
  field-for-field against the panel's `QuotingAPI` interface.
- **The agent's source-file tools.** `selfRepairTools.ts` calls
  `readSourceFile` / `writeSourceFile` for the `henry_read_source_file` and
  `henry_write_source_file` tools. The handlers existed in
  `electron/ipc/sourceFiles.ts` but were never on the bridge, so both tools threw
  every time they were used. Both are now exposed (optional, Electron-only,
  since the call sites already guard on `isElectron()`).

### Contract cleanups found alongside them

- `memory:getSummary` was declared `Promise<string | null>` but always returned a
  full row. It has no callers; the declaration is now truthful
  (`HenryConversationSummary | null`) and `.get()`'s `undefined` is normalised to
  `null` so the contract actually holds.
- `memory:saveSummary`'s catch returned bare `null as any`, but its only caller
  destructures `saved.id` / `saved.error` — so any database error threw a
  `TypeError` in `MemoryAwarenessPanel` instead of surfacing the error. It now
  returns `{ id: null, error }`.
- `getLocalGatewayStatus` was declared twice on `HenryAPI` with incompatible
  types; the wrong one was removed.
- Genuinely unreachable registrations removed after grep evidence (0 preload
  methods and 0 renderer references): `memory:deleteFact`,
  `memory:clearConversation`, `providers:delete`, plus five dead `HenryAPI`
  declarations with no preload implementation and no callers.

### Voice stack

- `speakAssistantReply` was called with a bare `void`, so the rejection produced
  when a user presses Stop mid-utterance surfaced as an unhandled rejection.
  Both call sites now classify the error: an abort/stop is silent, a genuine
  engine failure raises one toast.
- `prepareSpeechText` imposed no length cap, and its output is later passed to
  espeak as an argv element, so a long reply could hit the per-argument ceiling
  and fail the spawn. It now caps at 2000 characters, rewinding to the last
  sentence end so Henry never stops mid-sentence.
- Whisper detection and installation now work on Windows: `.exe` names, the
  Windows install directories, `where` instead of `which`, and `winget` with
  `--disable-interactivity` (without it winget blocks on a prompt nobody can
  answer until the five-minute timeout). POSIX behaviour is unchanged.

### Removed: Prayer

The Prayer feature is gone entirely — not repaired, migrated or replaced.

- `electron/ipc/prayer.ts` deleted: all twelve `prayer:*` handlers
  (`log:add|delete|list`, `requests:create|delete|get|list|setStatus|update`,
  `stats:answered|summary`, `context:forChat`) and the two tables they created,
  `prayer_requests` and `prayer_log`, with their indexes.
- `src/components/prayer/PrayerPanel.tsx` and the directory deleted.
- `'prayer'` removed from `ViewType`; the `Layout` import and render removed;
  `registerPrayerHandlers` removed from `electron/main.ts`.
- The Prayer entry in the panel catalogue (`henrySelfKnowledge.ts`) and the
  Prayer capability card in the onboarding wizard removed.
- In the companion bridge, removed the three prayer voice commands (add / count
  / show prayer requests), the `#prayer` hashtag shortcut and its
  `prayer_requests` insert, the prayer section of the cross-store search, the
  prayer line in the weekly summary, the `prayer` entry in the panel-help
  matcher and in the `HENRY_PANELS` switch map, the `prayer requests` option in
  the office-export matcher, and the `🙏 **Prayer**` bullet in the capability
  list the phone app reads. Each of these would otherwise have written to or
  advertised a table and panel that no longer exist.

Prayer was already unreachable before this removal: the preload exposed no
prayer methods at all, so `PrayerPanel`'s `api()` probe resolved to `null` and
every call was a silent no-op. There was no API surface, type declaration or
web stub to clean up — those were never added.

**Deliberately kept**, because they are health-habit and life-area
functionality rather than the Prayer feature: `prayer` as a habit keyword in
habit detection and normalisation, the seeded habit "Morning prayer / quiet
time", the "Prayer / Devotion" habit preset in the health panel, habit copy in
the Today panel, and the `faith` life area.

Note: an existing installation's SQLite file still contains the now-unused
`prayer_requests` and `prayer_log` tables. They are inert data rather than code,
and no migration drops them — dropping tables would destroy any rows a user had
entered, which this removal was not asked to do. New installations never create
them.
