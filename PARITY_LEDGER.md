# Parity Ledger — Paid H.E.N.R.Y AI 1.7.0 (reference) vs Henry AI (this build)

**Status:** investigation only. Nothing in this document has been implemented. No paid
authentication, licensing, credits, billing or hosted-proprietary-AI service is proposed for
adoption; those are catalogued as a boundary, not as a work list.

## Evidence base

| Source | What it is |
|---|---|
| `/mnt/c/Users/xkali/new_ai/H.E.N.R.Y AI 1.7.0-x64/resources/app.asar` | Installed paid build, 476 MB, 41,350 entries |
| `/tmp/paid/src/` | **699 original TypeScript files recovered from shipped sourcemaps** — 58 app source files. Authoritative for main-process behaviour |
| `/tmp/paid/.vite/renderer/main_window/assets/index-fE4Tm3Ox.js` | Minified renderer, 1.82 MB, **no sourcemaps**. Mined by string/symbol grep only |
| `/home/buster/henry-ai-desktop` | This build |

Recovered main-process source of interest: `shared/contracts.ts` (111 KB — the whole IPC
contract), `main/ipc.ts`, `preload/index.ts`, `agent-core/*`, `main/voice/*`, `main/auth/*`,
`main/creators-store.ts`.

**Method caveat, stated up front:** grep is unreliable on the minified renderer bundle — a search
for `onboarding|wizard` returned no matches while `completedOnboarding` demonstrably exists. Absence
in the renderer is therefore *not* provable by grep; only positive string evidence is trusted there.
Main-process findings come from real source and are reliable.

---

## 1. The JARVIS interface — what it actually is

**Your reference image is the "Content Creators" demo mode's full-screen orb, not a general
assistant view.** Evidence:

`contracts.ts:59-63`
```ts
// How a scripted demo is played back: "voice" is the full-screen reactive orb
// overlay; "chat" replays the exchange inside a standalone mock chat UI.
export const creatorDemoModeSchema = z.enum(["chat", "voice"]);
```

Renderer bundle:
```
`Full-screen reactive orb`})]}),…{"aria-selected":e.mode===`chat`,…
  children:[(0,U.jsx)(`strong`,{children:`Chat`}),
            (0,U.jsx)(`span`,{children:`Lookalike chat window`})]
```
> "Voice fills the screen with the reactive orb (great for a hands-free feel); Chat shows a
> lookalike chat window."

### Configuration surface (`contracts.ts:102-175`)

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | Demo active |
| `mode` | `chat` \| `voice` | **`voice`** | `voice` = full-screen orb overlay |
| `triggerPhrases` | string[] | `["what's the status of my app", …]` | Spoken/written phrase that starts it |
| `turns[]` | `{role: user\|assistant, text, audio, files[]}` | 7-turn startup demo | The scripted exchange |
| `captionMode` | `typewriter` \| `none` | **`typewriter`** | **The chat bubble** |
| `fileStaggerMs` | int 0-10000 | `600` | "Screenshot timing" slider — cascades windows |
| `playIntro` | bool | `true` | Power-on intro before the turns |

### Activation (renderer bundle)
> "When you launch the demo (trigger phrase, `⌘⇧J`, or Preview), open on a 'double clap or click
> to activate' standby screen — then a clap or click rolls the [intro]"

> "**Power-on intro** — The cinematic activation moment: `<name>` powers on with the theme and a
> spoken greeting, then rolls straight into your scripted demo." … *Demo-only*

### The orb itself
Two skins, set via a `data-skin` attribute on the app root (`contracts.ts:296-300`):

| Value | Label | Copy |
|---|---|---|
| `default` | **Reactor** | "Full arc-reactor HUD with animated rings." |
| `minimalistic` | **Minimal** | "Classic Jarvis orb: clean rings, glowing voice-reactive core." |

`reactorSpeed: slow | default | fast | off`. Orb phases include `standby` and `waking`, and the
core is voice-reactive (`speaking` prop). SVG layer classes in the bundle: `hud-wrap`, `hud-svg`,
`hud-layer-reactor`, `hud-layer-minimal`, `hud-core`, `hud-reactor`, `hud-core-disc`,
`hud-core-glow`, `hud-core-dark`.

Accent `#5cdcff` (`DEFAULT_ACCENT_COLOR`, `contracts.ts:315`) — the cyan in your screenshot.
Orbitron display font is bundled.

**So "JARVIS" in the paid product is three separate things:** the default assistant *name*; the
ElevenLabs *voice* (`Jarvis — ElevenLabs`, renderer bundle); and the *name of the Minimal orb
skin*. The image you supplied is that orb rendered full-screen.

### Media subsystem behind it (`creators-store.ts`, 190 lines)
`CreatorMedia { id, fileName, originalName, kind: audio|image|file, addedAt }`. Files are copied
to randomised names in a dedicated userData dir and served over a custom `henry-media://`
protocol. `kind: "file"` exists so the demo can "open" documents as **real OS desktop windows** —
`app:openMedia` opens them in the system viewer. Allowlist blocks executables.

IPC (`contracts.ts:2328-2330`): `creators:import-media`, `creators:delete-media`, `creators:open-media`.

### `clapToActivate` is force-disabled in the paid product
`contracts.ts:305-309`: *"When true, an always-on background microphone listener lets a double
clap wake the assistant at any time (even minimised to the tray) … **Currently forced off —
ambient false positives were replaying the greeting at random.**"*

That is the vendor documenting a false-positive failure in their own feature. Any equivalent here
should be built with hysteresis and a debounce, not copied blindly.

**Verdict: `missing`.** Nothing resembling the orb, the full-screen mode, the caption bubble, the
skin system or the creator-media store exists in this build.

---

## 2. Parity summary

Counts are from the five evidence passes; they overlap across slices and are not a single
de-duplicated total.

| Slice | Complete | Partial | Missing | Commercial |
|---|---|---|---|---|
| IPC / API surface (79 channels) | 29 | 25 | 47 | 31 |
| Agent core (37 tools, 25 automation rows) | 9 | 41 | 43 | 12 |
| Voice + integrations (25 voice, 10 integration) | 6 | 7 | 18 | 12 |
| Renderer views | ~8 | 4 | ~8 | 4 |
| Commercial boundary | — | — | — | 44 |

---

## 3. Commercial boundary — catalogued, not adopted

**43 items require Henry's paid backend and will not be implemented here.**

| Item | Evidence | Why excluded |
|---|---|---|
| Email-OTP login, session, logout | `auth:request-email-code`, `auth:verify-email-code`, `auth:logout` | Hosted auth |
| License-key redemption | `auth:redeem-license`, `shared/license-key.ts` | Commercial licensing |
| Credits + billing | `auth:redeem-credits`, `billing:event` w/ `insufficient_credits` (`main/index.ts:534`) | Paid credits |
| Tier entitlements | `auth:redeem-integrations-extras`, `-agent-automations`, `-customizations`; "Integrations Extras licence is required" (`ipc.ts:163-171`) | Tiered product |
| Hosted AI proxy | `runtime/authenticated-ai-proxy.ts:38` → `{backend}/api/v1/responses` | Proprietary inference |
| Hosted voice router | `voice:route` → `POST {backend}/voice/turn` (`voice/router.ts:19`) | Proprietary orchestrator |
| Composio integrations (~250 toolkits) | `contracts.ts:426-975`, `composio-provider.ts` | Third-party paid SaaS |
| Forced minimum-version gate | `version-policy.ts:83-92`, `main/index.ts:804` | Server-enforced |
| PostHog telemetry | `shared/posthog-config.ts` | Third-party telemetry |

**Architectural consequence worth stating plainly:** paid 1.7.0 has **no local model path and no
BYOK path**. Every model call goes loopback to `{backend}/api/v1/responses`
(`openai-runner.ts:371-375`). Without a paid account, essentially no AI feature works. This build
runs entirely on Ollama / Groq / OpenCode locally, so on that axis **we are ahead** — and that is
also why so many paid rows are "commercial" rather than "missing".

---

## 4. Highest-value gaps that are legitimately portable

Ordered by value ÷ effort. All are own-code implementations of a *capability*, not copies of
Henry's code.

| # | Gap | Evidence | Assessment |
|---|---|---|---|
| 1 | **Zod contract validation on every IPC channel.** Paid parses every untrusted payload with a named schema and re-parses every preload response. Ours uses bare `unknown` with ad-hoc checks. | `contracts.ts` throughout; ours `electron/ipc/settings.ts:24,33` | Largest structural gap. Root enabler of several bugs already hand-patched in this codebase. Highest leverage by far. |
| 2 | **Typed settings contract + `settings:changed` event.** Paid has a validated 24-field schema and broadcasts changes from four sites. Ours is an untyped `Record<string,string>` KV with no change notification. | `contracts.ts:250-343`, `ipc.ts:245,262,731` | Every UI that must react to settings currently polls or misses updates. |
| 3 | **File tools.** Paid exposes `list_files`, `search_files`, `inspect_file` (sha256/mime), `read_file` (line range), `load_file` (**image/PDF into the model turn**), `write_file` (create-only), `replace_file` (atomic), `move_file`, `copy_file`, `publish_file` (attach a produced file to the reply). Ours has repo-scoped `repo_read`/`repo_edit` only. | `tool-registry.ts:151-289` | `load_file` is the multimodal gap; `publish_file` is why we cannot hand a generated file back into the transcript. |
| 4 | **Native notifications for automations.** Paid probes OS notification permission into a 6-value enum and deep-links a notification click to the exact run (`automations:consume-open-request`). Ours fires `notification:show` and drops the click handler. | `automation-notifications.ts`, `ipc.ts:520,758-808` | Entirely portable, no commercial dependency. |
| 5 | **Runtime status push.** Paid broadcasts `runtime:status-changed` + `runtime:get-error`; ours only answers `runtime:get-status` synchronously, so the renderer cannot learn the agent runtime died. | `contracts.ts:2273-2274`, `ipc.ts:722` | Directly relevant to the open lag/not-responding defect. |
| 6 | **Voice ergonomics.** `voiceSilenceMs` (400-5000), `micSensitivity` (0-1), `micMuted`, `voiceRate`. We are push-to-talk only. | `contracts.ts:263-275` | A VAD endpoint is the single biggest UX unlock for a voice-first product. |
| 7 | **Voice diagnostics.** Paid records recordingId/recordingMs/chunkCount/stopReason/trackMuted/trackReadyState and redacts secrets while extracting http_status / server_request_id / provider_request_id. We throw bare `Error.message`. | `voice-diagnostics.ts:51-76` | Entirely portable, high debugging value. |
| 8 | **STT queueing.** Paid serialises transcriptions on a promise chain and never drops work. Ours sets a busy flag and *throws* "A transcription is already running", losing the second utterance. | `voice/whisper.ts:98-104` vs `electron/voice/stt.ts:366` | Concrete data-loss bug in ours. |
| 9 | **Customization view** (accent + skin editor) and **in-app tutorial mode** (`tutorial:get-progress`, gated on `seenGuide`). | renderer `customization-view`; `contracts.ts:2293` | Missing; ours only has a habit-count first-launch heuristic. |
| 10 | **Toolkit logo resolution** — Content-Type header + magic-byte sniffing, with a SimpleIcons → jsDelivr → Iconify → unavatar → Google favicon fallback chain. | `integration-logos.ts` | Self-contained utility, reusable for any list. |

### Near-misses worth noting
- **Gmail/Google is 80% built and unwired.** `electron/ipc/googleAuth.ts` implements a correct
  PKCE + loopback + `safeStorage` flow with `gmail.readonly`, `gmail.compose`, `calendar.*`,
  `drive.readonly` scopes, refresh and revocation. **No tool, panel or agent code consumes it.**
  The hard part is done; the surface is missing.
- **`memory_search` in this build is arguably stronger** than paid's: we use SQLite FTS5 with
  rank plus a 5-factor score (`electron/ipc/memory.ts:23-27`); paid uses
  `toLocaleLowerCase().includes()`.
- **Rail/sidebar breadth:** we have 38 nav destinations vs paid's ~10 modes.

---

## 5. Open release blockers (unchanged, still open)

This investigation did not address these. They remain live:

1. **Windows responsiveness / "Not Responding."** Root cause diagnosed and fixed in source
   (`e15d5ad`): the launch diagnostic ran with `autoFix=true`, and because every Windows
   dependency probe was failing it attempted five installs, each spawning `winget` then `choco`,
   blocking the Electron main process; while blocked the loopback sync server stops answering.
   **Not yet re-verified end-to-end under concurrent use on a fresh install.**
2. **Windows dependency detection.** Fixed in source (`e15d5ad`) — `2>/dev/null` under cmd.exe.
   Verified once against the installed package: node v24.21.0, git 2.55.0, ffmpeg and python3
   now report correctly. **FFmpeg and Python report `ok` with an empty version string; worth
   tightening.**
3. **OpenCode/Zen.** Fixed in source (`e15d5ad` discovery, `f0eb355` model parsing). Verified:
   `omp/18.3.2` discovered, 559 models, IDs clean of table formatting. **Zen was still
   dropped by the pre-`f0eb355` installed build; `f0eb355` has not been packaged or re-tested
   against the installed app.**

### Also observed and not yet fixed
- `sqlite3: fix_failed — Database file missing — will recreate on restart` appears on every
  diagnostic run on this machine and has not been diagnosed.
- Scheduler routines repeatedly fail with
  `Model "deepseek-r1:7b" isn't loaded in Ollama` — the routine model is not loaded in the local
  Ollama instance.
- Two `screen_recording` rows contradict each other ("check failed" vs "probe ran but produced no
  image").
- Henry opened a URL with the macOS-only `open` command, got nothing back, and then wrote
  "According to Wikipedia, …" summarising a page it had never read. A grounding rule has been
  added to the system prompt, but this is prompt-level mitigation, not a guarantee.

---

## 6. Method notes for whoever picks this up

- The renderer bundle has **no sourcemaps**; main-process source is fully recoverable, renderer
  source is not. Do not treat renderer absence as proven.
- Roughly bytes 50-139 KB of two renderer lines were unreachable through the available read
  tooling — a genuine gap in coverage.
- Scout agents are read-only and could not write report files; their ledgers were returned inline
  and are summarised here.
- The paid app is version 1.7.0 (proven in-bundle: `mJ({appVersion:`1.7.0`,environment:`production`})`),
  whereas this build is 3.0.7. Some gaps may reflect version drift rather than removal.