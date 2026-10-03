# PARITY LEDGER — authoritative parity checklist

**This file is the authoritative record, not the comparison image.** It is updated in place as
each row progresses. A row is only closed when every stage is satisfied.

**Goal: a functional superset of paid 1.7.0 built on OUR local-first architecture — not a clone.**
Paid 1.7.0 has no local-model path (every call proxies to `app.heyhenry.ai/api/v1/responses`). We
keep Ollama, Groq, OpenRouter, OpenCode and local model selection, and add paid's useful portable
capabilities around that. **No working local capability is ever downgraded to imitate paid Henry.**

## Row lifecycle

```
PAID EVIDENCE -> OUR CURRENT -> GAP -> IMPLEMENTATION -> AUTOMATED TEST
              -> LIVE TEST -> INSTALLED-PACKAGE TEST -> CLOSED
```

**Status vocabulary (terminal states are explicit):**
`missing` · `partial` · `complete` · `different` (implemented another way) ·
`hardened/superset` (ours now exceeds the reference) · `excluded by design` (intentional terminal
state — upstream feature disabled upstream) · `commercial boundary` (excluded, identify only).

**Card gate:** a card is not complete until its rows are verified on a **freshly installed Windows
package**. Build/install is batched per card, not per row, to avoid rebuilding the same package
dozens of times — but no row is CLOSED from source inspection or unit tests alone.

Evidence base: **699 original TypeScript files recovered from the paid 1.7.0 shipped sourcemaps**
(58 app files) at `/tmp/paid/src/`; minified renderer bundle at
`/tmp/paid/.vite/renderer/main_window/assets/index-fE4Tm3Ox.js` (**no sourcemaps**).

**Method caveat:** grep on the minified renderer is unreliable — a search for `onboarding` returned
nothing while `completedOnboarding` demonstrably exists. Renderer *absence* is not provable by grep;
only positive string evidence is trusted there. Main-process findings come from real source.

**Commercial boundary — never implemented:** paid auth (email OTP), licence redemption, credits and
billing, tier entitlements, Henry's hosted AI proxy, Henry's hosted voice router, Composio's ~250
toolkits, server-enforced version gating, PostHog telemetry. 43 rows. Identify only; do not bypass.
Where a legitimate local equivalent exists, it is listed as our own implementation.

---

## PROGRESS


<!-- SUMMARY:BEGIN -->

| Card | Rows | Closed | Hardened | Partial | Missing | Unverified | Unreachable | Excluded | Commercial |
|---|---|---|---|---|---|---|---|---|---|
| 1 UI & Core | 10 | 6 | 0 | 0 | 1 | 3 | 0 | 0 | 0 |
| 2 Chat & Models | 9 | 4 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| 3 Creators & Media | 14 | 12 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| 4 Agents & Tools | 20 | 1 | 1 | 4 | 4 | 9 | 0 | 0 | 1 |
| 5 Automation | 9 | 2 | 0 | 3 | 0 | 4 | 0 | 0 | 0 |
| 6 Voice & Input | 13 | 2 | 0 | 4 | 5 | 1 | 0 | 0 | 1 |
| 7 Computer Control | 10 | 6 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| 8 Companion | 9 | 1 | 0 | 3 | 0 | 5 | 0 | 0 | 0 |
| 9 Files & Memory | 10 | 1 | 0 | 1 | 2 | 6 | 0 | 0 | 0 |
| 10 Integrations | 11 | 2 | 0 | 3 | 1 | 4 | 0 | 0 | 1 |
| 11 Settings & System | 15 | 5 | 0 | 2 | 3 | 4 | 0 | 0 | 1 |
| **TOTAL** | **130** | 42 | 3 | 23 | 16 | 41 | 0 | 1 | 4 |

> Generated from the rows by `scripts/parity-summary.mjs`. Do not edit these numbers by hand —
> edit the row status and re-run `node scripts/parity-summary.mjs --write`.

<!-- SUMMARY:END -->
| Card | Rows | Closed | In progress | Missing | Commercial |
|---|---|---|---|---|---|
| 2 Chat & Models | 9 | 5 | 0 | 0 | 0 |
| 1 UI & Core | 10 | 10 | 0 | 0 | 0 |
| 3 Creators & Media | 14 | 13 | 0 | 0 | 0 |
| 4 Agents & Tools | 20 | 2 | 0 | 9 | 4 |
| 5 Automation | 9 | 3 | 0 | 2 | 0 |
| 6 Voice & Input | 13 | 3 | 0 | 3 | 2 |
| 7 Computer Control | 16 | 0 | 0 | 3 | 0 |
| 8 Companion | 9 | 0 | 0 | 3 | 0 |
| 9 Files & Memory | 14 | 1 | 0 | 3 | 0 |
| 10 Integrations | 14 | 2 | 0 | 2 | 4 |
| 11 Settings & System | 15 | 2 | 0 | 2 | 3 |

---

# CARD 2 — CHAT & MODELS *(in progress first: finishes the live Windows/OpenCode Zen work)*

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | IMPLEMENTATION | TEST | LIVE | INSTALLED | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| 2.1 | AI Chat (Streaming) | renderer `rE` Chat mode | `src/components/chat/ChatView.tsx` | — | — | — | — | — | **complete** |
| 2.2 | **OpenCode Zen provider row** | `opencode.ai/docs/zen/`; `OPENCODE_API_KEY` | was unreachable from UI | no key row; key would not reach bridge | `PROVIDERS['opencode-zen']`, `CLOUD_PROVIDER_IDS`, `setOpencodeZenCredential`, `buildCoderChildEnv` inject, `ai.ts` dispatch | — | — | — | **live-verified** |
| 2.3 | **OpenCode model discovery** | n/a (our fix) | only probed literal `opencode` | user's CLI ships as `omp` | probe `opencode` + `omp`, bare name first, standard locations | — | `omp/18.3.2` found | **installed pkg: confirmed** | **CLOSED** |
| 2.4 | **Zen model parsing** | grouped table, ids have **no `/`** | kept whole table row as id; required `/` | all 559 ids polluted, all 105 Zen models dropped | `parseModelList` tracks group heading, accepts unprefixed ids, splits box-drawing `│` | standalone parser test vs real `omp models` | — | **installed pkg: 777 models, 0 polluted ids, 108 Zen (was 0), groups incl. opencode-zen** | **CLOSED** |
| 2.5 | Local Ollama | paid: **none** (backend only) | `callOllamaProvider`, ranked catalogue | — | keep, never downgrade | 324 suite | working | verified | **complete** |
| 2.6 | OpenRouter | paid: via opencode group | `PROVIDERS['openrouter']` | — | keep | — | — | — | **complete** |
| 2.7 | Local Model Support | paid: **absent** | Ollama + Groq + OpenCode + Relay | — | keep, never downgrade | — | — | — | **complete** |
| 2.8 | Model Catalogue (355+) | renderer model list | OpenRouter + Ollama + opencode live catalogue | — | keep | — | — | — | **complete** |
| 2.9 | Model Selector | renderer engine select | `EnginesSection`, `CoderEngineSection` | Zen ids must appear | reads live catalogue | — | **2 selectors list Zen ids: deepseek-v4-flash-free, hy3-free…** | **installed pkg** | **CLOSED** |

**Row 2.2 note:** a saved Zen key must reach the CLI's child environment — it was previously only
readable from the OS environment, so a key typed into Henry would have been stored and silently
ignored. The description is honest that a key is optional; free Zen models stay reachable.

---

# CARD 1 — UI & CORE

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | IMPLEMENTATION | TEST | LIVE | INSTALLED | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| 1.1 | Main Chat Interface | renderer Chat mode | `ChatView.tsx` | — | — | — | — | — | **complete** |
| 1.2 | Sidebar Navigation | `app-shell`, `rail`, `sidebar`, `data-collapsed` | `Sidebar.tsx`, 38 destinations | broader than paid's ~10 | keep ours | — | — | — | **different (better)** |
| 1.3 | Theme / UI Customisation | `accentColor` zod field, `#5cdcff`; `customization-view` "Make it yours" | `src/henry/theme.ts`, `src/components/settings/CustomizationPanel.tsx` | — | accent presets + custom colour, density, identity (Reactor/Minimal live preview), reduced motion; theme applied to :root before first paint | typecheck + 324 suite | — | **installed pkg: accent #6366f1 -> #5cdcff live on :root, `data-skin`/`data-density` set, persisted to settings** | **CLOSED** |
| 1.4 | Panel System (22 panels) | n/a | 22 verified live | — | — | — | 22/22 | — | **complete** |
| 1.5 | JARVIS Orb Mode entry | `creators-view`, mode toggle Voice/Chat | Creators nav entry | — | see Card 3 | — | — | **installed pkg: Creators in nav, Voice/Chat stage buttons** | **CLOSED (Card 3)** |
| 1.6 | HUD / Reactor Theme | `data-skin`, `skin: default` | Reactor skin | — | see Card 3 | — | — | **installed pkg: 14-element arc-reactor SVG** | **CLOSED (Card 3)** |
| 1.7 | Minimal Orb Theme | `skin: minimalistic` | Minimal skin | — | see Card 3 | — | — | **installed pkg: 4-element clean-ring orb** | **CLOSED (Card 3)** |
| 1.8 | Onboarding Flow | `completedOnboarding`, `seenGuide`, `tutorial:get-progress` | `OnboardingWizard.tsx` + `src/components/onboarding/ProductTour.tsx` | no in-app tour | 6-step dismissible tour with "Show me" navigation; progress persisted so it resumes and never re-nags | typecheck + 324 suite | — | **installed pkg: tour appears, advances 1/6 -> 2/6, Skip closes and persists `done:true`** | **CLOSED** |
| 1.9 | Multi-window Support | — | second window (demo stage) | — | Card 3 delivered an always-on-top frameless stage window | — | — | **installed pkg: stage window opens alongside the main window** | **CLOSED (Card 3)** |
| 1.10 | Global Search | n/a | global search present | — | — | — | — | — | **complete** |

---

# CARD 3 — CREATORS & MEDIA

Source: `contracts.ts:39-215`, `main/creators-store.ts` (190 lines), renderer `creators-view`.

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | IMPLEMENTATION | TEST | LIVE | INSTALLED | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| 3.1 | Content Creators Mode (view + editor) | `creators-view`, `creators-card`, `MJ` | `src/components/creators/CreatorsPanel.tsx`, `electron/ipc/creators.ts` | — | Creators view in nav; demo schema, turn editor, trigger phrases, media, stage config | typecheck + 324 suite | panel renders; schema round-trips (7 default turns, caption typewriter, stagger 600) | **installed pkg: all sections render; malformed input sanitized not crashed** | **CLOSED** |
| 3.2 | JARVIS Voice Mode (full-screen orb) | `creatorDemoModeSchema` `voice` = "full-screen reactive orb overlay" | frameless always-on-top stage window (`creators.ts: openStage`) | — | full-screen stage window + inline orb SVG | typecheck | stage window opens over the app | **installed pkg: `Henry — Demo Stage` window opens, orb renders, accent applied** | **CLOSED** |
| 3.3 | Reactor HUD Skin | "Full arc-reactor HUD with animated rings" | arc + ring + core SVG generator | — | `default` skin: 5 rotated arc paths, 2 rings, core, halo; live rotation + glow | typecheck | — | **installed pkg: Reactor renders 14 SVG elements** | **CLOSED** |
| 3.4 | Minimal Orb Skin | "Classic Jarvis orb: clean rings, glowing voice-reactive core" | clean-ring variant | — | `minimalistic` skin: 2 rings + core + halo | typecheck | — | **installed pkg: Minimal renders 4 elements, visibly distinct from Reactor** | **CLOSED** |
| 3.5 | Caption Overlay (`typewriter`) | `captionMode: typewriter\|none`, default typewriter | typewriter caption in the stage | — | per-character render; assistant/user styling | typecheck | — | **installed pkg: caption types out the scripted turns, user turns styled differently** | **CLOSED** |
| 3.6 | Activation: trigger phrase | `triggerPhrases[]`, default "what's the status of my app" | `henry/creatorsActivation.ts` | — | matcher checked before the chat turn, so a trigger never burns a model call | typecheck | — | **installed pkg: typed the phrase in Chat + Enter → stage window opened, no model call** | **CLOSED** |
| 3.7 | Activation: keyboard shortcut | `⌘⇧J` — **paid is macOS-only** | `Ctrl/Cmd+Shift+J` | — | cross-platform: Ctrl+Shift+J on Windows/Linux, Cmd+Shift+J on macOS | typecheck | — | **installed pkg: real Ctrl+Shift+J key event opened the stage** | **CLOSED** |
| 3.8 | Activation: click/space standby | "double clap or click to activate" standby screen | standby screen | — | standby shows a live preview of the chosen skin; click, Enter or Space starts | typecheck | — | **installed pkg: standby visible, click hides it and starts playback** | **CLOSED** |
| 3.9 | Clap to wake | `clapToActivate` — **paid forces this OFF**: "ambient false positives were replaying the greeting at random" (`contracts.ts:305-309`) | none | — | **EXCLUDED BY DESIGN — terminal.** Upstream shipped it then force-disabled it for false-positive activation. Not reproduced. | n/a | n/a | n/a | **EXCLUDED BY DESIGN** |
| 3.10 | Power-on intro | `playIntro`, "cinematic activation moment… theme and a spoken greeting" | intro overlay | — | orb + assistant name + "online" rise-in, then hands over to the turns; skipped when `playIntro` is off | typecheck | — | **installed pkg: intro shows `JARVIS` + orb, hides, then turns play** | **CLOSED** |
| 3.11 | Media store (`henry-media://`) | `CreatorsStore`, randomised names, kinds audio/image/file | `CreatorsStore` + `henry-media://` | — | private dir under userData, random names, per-kind extension allowlist, `resolve()` rejects any path that is not a bare generated filename | typecheck | — | **installed pkg: imported a .txt and a .png to random names; `hosts` (no ext) and `.ini` correctly refused; traversal `../../../../Windows/.../hosts` rejected; delete removed both** | **CLOSED** |
| 3.12 | File reveal as real OS windows | `creators:open-media`, "opens in the OS default viewer"; `fileStaggerMs` | `shell.openPath` + `fileStaggerMs` slider | — | opens in the system viewer | typecheck | — | **installed pkg: `creatorsOpenMedia` returned ok on a real imported file** | **CLOSED** |
| 3.13 | Reactor speed setting | `reactorSpeed: slow\|default\|fast\|off` | speed setting + accent + name | — | `off` halts rotation entirely for a static orb | typecheck | — | **installed pkg: saved `fast`, read back persisted** | **CLOSED** |
| 3.14 | Media Generation / Video / Audio / Image Gen | paid has these | ours has video + image gen | audio gen? | assess individually | | | | partial |

**Card 3 order (as instructed): 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 3.8 → 3.10 → 3.11 → 3.12 → 3.13.**

---

# CARD 4 — AGENTS & TOOLS

Paid: 37 tools in `agent-core/tool-registry.ts`. Ours: 42 model-callable tools in `electron/agent/tools/`
plus the syncBridge tool router. **Retain our extra tools.**

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 4.1 | Multi-Agent Support | agent-core | ours has agent roles | keep | complete |
| 4.2 | Agent Roles (4+) | agent-core | ours | keep | complete |
| 4.3 | Tool Execution | `tool-registry.ts` | ours | keep | complete |
| 4.4 | Shell / Terminal | `processes.ts` | ours `shell.ts` | keep | complete |
| 4.5 | File System Tools | 10 tools: `list_files`, `search_files`, `inspect_file`, `read_file`, `load_file`, `write_file`, `replace_file`, `move_file`, `copy_file`, `publish_file` (`tool-registry.ts:151-289`) | `electron/agent/tools/files.ts` — all ten added; `repo_read`/`repo_edit` kept | — | additive, not a replacement: our repo tools stay narrower and approval-gated; the new ones are confined to home, writes behind `confirm` | **23 tests**: capability + traversal + absolute paths + refuse-clobber + atomic replace leaves no temp + every `confirm` tool has a prompt | — | **installed pkg: 52 tools registered (was 42); all 10 present; write/replace/move = `confirm`, reads = `silent`; `repo_*` intact** | **CLOSED** |
| 4.6 | Git Integration | — | `repo.ts` | keep | complete |
| 4.7 | GitHub Research Tools | — | none | portable | missing |
| 4.8 | Python Tools | paid runs them **jailed** | `electron/ipc/pythonRunner.ts` | **was LESS isolated than paid, AND completely broken on Windows** — it staged to a hardcoded `/tmp/henry_<ts>.py` and ran with `shell: '/bin/zsh'`, so neither path exists on Windows, and the blocking `execSync` froze the main process for up to 12s | **HARDENED / SUPERSET** — our own jail: pre-execution source screening (14 escape classes refused before staging), scrubbed env, private cwd under tmpdir, POSIX rlimits (CPU/AS/FSIZE/NPROC/NOFILE), wall-clock timeout with SIGKILL, hard output cap, async, cross-platform interpreter. Paid's implementation not used. | **23 tests**: 14 escapes refused + legitimate exec, real script errors, timeout, no env leaks, private cwd, output cap | — | installed build boots with it; Python 3.12.10 resolves from the packaged app | **HARDENED / SUPERSET** — **PARTIAL**: jail proven by tests; the chat entry point is not yet verified end to end because "python run:" is routed to the coder engine before it reaches this branch |
| 4.9 | Network Tools | `files.ts` fetch | `web.ts` | keep | complete |
| 4.10 | Sandbox | sandbox config | partial | compare | partial |
| 4.11 | Process / System Tools | `processes.ts` | ours | keep | complete |
| 4.12 | Plan Mode | — | ours | keep | complete |
| 4.13 | Goal Planning | goal schema | none | portable | missing |
| 4.14 | Workflows | automation workflows | ours Routines | compare | partial |
| 4.15 | Triggers / Events | automation triggers | partial | portable | partial |
| 4.16 | Self-Improvement | — | none | assess | missing |
| 4.17 | Memory tools (8) | `memory_list`, `memory_search`, `memory_read`, `memory_create_page`, `memory_replace_page`, `memory_create_directory` … | `memory.ts`, FTS5 + 5-factor scoring | **ours is stronger** on search | different (better) |
| 4.18 | Composio toolkits (~250) | `contracts.ts:426-975` | none | — | **commercial** |
| 4.19 | Agent credentials | `agent-credential-store.ts` | ours `_keyStorage` | compare | partial |
| 4.20 | AI analytics | `ai-analytics.ts` | local analytics | keep local | complete |

---

# CARD 5 — AUTOMATION

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 5.1 | Task Automation | `automations.ts` 25 rows | ours | keep | complete |
| 5.2 | Scheduled Tasks | cron in automations | ours scheduler | keep | complete |
| 5.3 | Background Jobs | `smart-job-queue.ts` | ours | keep | complete |
| 5.4 | Workflows | workflow schema | Routines | compare | partial |
| 5.5 | Triggers / Events | trigger types | partial | portable | partial |
| 5.6 | Goal Planning | goal schema (`contracts.ts`) | `src/components/goals/GoalsPanel.tsx` (414 lines) + `henry/commitmentStore` + `brain/reflectiveMind` | **already implemented and richer than the reference** — goals + commitments tabs, priority/emotional/strategic significance scoring, a coaching function, and neglected-commitment detection. The gap was discoverability: Goals sat in the hidden `···` group AND shared `◎` with Reminders | moved to the primary rail with its own icon | typecheck + 499 suite | **CRUD verified live on the installed build: create, read, update all work** | **installed pkg: reachable in the visible rail; panel renders with commitments** | **COMPLETE (exceeds reference)** |
| 5.7 | Run management | runs + attachments + deep-link | runs only | no attachments, no notification deep-link | partial |
| 5.8 | Native notifications | `automation-notifications.ts`; OS permission 6-state enum; click routes to the run; per-job all/failures/none with reasons | `electron/ipc/automationNotifications.ts`; scheduler emits on success and failure/abort | the main process routed the click correctly and **nothing subscribed**, so it went nowhere | click routing into the exact run; requests queued when no window is listening yet; notify mode with an explicit reason per suppression; **App.tsx now drains the queue on mount and follows live clicks, navigating to the run** | **11 tests**: click routing, window restore/focus, no-window queue, ordering | — | **installed pkg: permission reports the OS value; fires; failures-only suppresses; listener subscribes** | **CLOSED** |
| 5.9 | Automation ideas | renderer `ideas` tab beside the automations list — *"Start quickly with ready-made ideas"* (`automation-tab`, `ideas`) | `src/henry/routineTemplates.ts` + an Ideas tab in `RoutinesPanel.tsx` | **none** — ours opened a blank form expecting the user to know cron syntax | 8 ready-made templates (Morning briefing, Daily review, Weekly review, Client follow-up check, Inbox triage, Quotes going cold, Machine and filament check, Capture review), category filter, one-click start through the same `addRoutine` path as the form so behaviour cannot drift | **14 tests**: unique ids, non-empty copy, cron validity, "at HH:MM" templates are not hourly, weekday templates are not weekend-bound, filtering, and the exact `addRoutine` input shape | — | **installed pkg: Ideas (8) tab renders all 8 cards with 8 "Start this" buttons and 4 categories; starting one created a real routine — name "Morning briefing", cron `0 7 * * 1-5`, enabled, prompt present; deleted again so no test data was left** | **CLOSED** |

---

# CARD 6 — VOICE & INPUT

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 6.1 | Speech-to-Text (STT) | `voice/whisper.ts:26,98-104` serialises on a promise chain | `electron/voice/stt.ts` | was **worse than paid**: a busy flag that THREW "already running", silently discarding whatever the user said — worst in hands-free use | serialised chain, nothing dropped; queue depth exposed | — | — | **installed pkg: two concurrent transcriptions both resolve, no "already running"** | **CLOSED** |
| 6.2 | Text-to-Speech (TTS) | `ttsBackend: system\|openai\|elevenlabs\|kokoro` | ours system + ElevenLabs + browser | no Kokoro local neural TTS | partial |
| 6.3 | Voice Commands | voice router | ours intents | keep + extend | partial |
| 6.4 | Wake Word | paid claims wake word | none | assess; must not reproduce broken clap | missing |
| 6.5 | Voice Panel (All OS) | renderer voice panel | ours Voice section | compare | partial |
| 6.6 | Voice Transcription | `voiceSilenceMs` 400–5000 (default 900), `micSensitivity` 0–1, `micMuted` | `src/henry/voiceEndpointing.ts` | **was push-to-talk only — you had to release the button yourself, so hands-free was impossible** | AnalyserNode watches real RMS; ends on speech-then-silence; window RESTARTS if speech resumes; speech must be detected first (no empty turns); hard max utterance so a stuck mic cannot record forever; clamped to paid's ranges, persisted, switchable off | **13 tests**: silent tap never submits, resume restarts the window, continuous noise still ends, fires once, stop() detaches, no-WebAudio fallback | — | **installed pkg: "Stop recording when you stop talking" + silence slider + sensitivity slider + guidance all render** | **CLOSED** |
| 6.7 | Audio Recording | recorder | ours | keep | complete |
| 6.8 | Live Caption (Typewriter) | `captionMode` | none | Card 3.5 | missing |
| 6.9 | Voice Integrations | ElevenLabs + OpenAI + Kokoro | ElevenLabs | OpenAI/Kokoro | partial |
| 6.10 | Voice diagnostics | `voice-diagnostics.ts` records recordingId/recordingMs/chunkCount/stopReason + redacts secrets | bare `Error.message` | **fully portable** | missing |
| 6.11 | spokenAssistantName | 3-line: strip H.E.N.R.Y → HENRY so TTS doesn't spell 5 letters | none | trivial portable | missing |
| 6.12 | autoplayPolicy override | `no-user-gesture-required` (`main/index.ts:193-196`) | ours lacks | replies start long after the gesture | missing |
| 6.13 | Hosted voice router | `voice:route` → `{backend}/voice/turn` | — | **commercial** — a local router is buildable, backend is not | commercial |

---

# CARD 7 — COMPUTER CONTROL

**Preserve all security fixes already made here** (command classification, path safety, clipboard
guarding, `_denyDangerous`).

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 7.1 | Screen Analysis / capture | renderer screen-capture surface | `computerScreenshot`, `computerCaptureSelectedText`, `computerCheckCapabilities` | — | Windows capture via PowerShell System.Drawing; region/window capture not supported on Windows (reported honestly by `capabilities`) | — | — | **CLOSED — installed pkg: `computerScreenshot` returned `ok:true` with image bytes; capabilities report clipboard/selectedText/screenCapture/inputAutomation all `ready` on win32** | **CLOSED** |
| 7.2 | UI Interaction | renderer UI-interaction surface | `computerClick`, `computerTypeText`, `computerPressKey` | — | coordinate input validated (the AppleScript injection found earlier is closed); text/key handlers now reject wrong types with a message instead of throwing a raw TypeError across IPC | added 5 tests | — | **CLOSED — installed pkg: `computerClick({x:'0; calc',y:0})` rejected by validation; `typeText`/`pressKey` with a wrong shape return `Text to type must be a non-empty string` / `A key name string is required.`** | **CLOSED** |
| 7.3 | Mouse / Keyboard | PowerShell SendKeys | ours | — | input automation reports `ready` on Windows via PowerShell SendKeys / WScript.Shell | — | — | **PARTIAL — installed pkg: capability probe reports input automation `ready`; the handlers were exercised for validation and error shape, not for actually moving the pointer/typing into another window** | **PARTIAL** |
| 7.4 | Application Control | launch/quit | `computerListApps`, `computerOpenApp`, `computerCloseApp` | — | — | — | — | **CLOSED — installed pkg: `computerListApps` returned 189 apps (was 6 before the fix); `computerOpenApp('ZZZNoSuchApp9999')` passes through to the launcher and returns a clean "The system cannot find the file" instead of being rejected by my own schema** | **CLOSED** |
| 7.5 | Window Management | — | `computerDesktopMode` | — | — | — | — | **CLOSED — installed pkg: `computerDesktopMode({enable:false,fullscreen:false})` returned `{ok:true}`** | **CLOSED** |
| 7.6 | File Operations | filesystem tools | `computerNewFolder` + `file_*` tools | **no path validation at all** — `computerNewFolder` resolved whatever it was given | `computerNewFolder` now refuses anything outside the home directory; fs handlers return errors instead of throwing | — | — | **CLOSED — installed pkg: `computerNewFolder('../../../escape-test')` refused with "Refused: ../../../escape-test is outside your home directory." The earlier run of this same test CREATED `C:\escape-test` outside home; that artifact was removed and the hole closed** | **HARDENED / SUPERSET** |
| 7.7 | Clipboard Access | — | `computerClipboardWrite`, `computerClipboardRead`, `computerCaptureSelectedText` | — | — | — | — | **CLOSED — installed pkg: wrote `henry-clip-probe-42`, read it back exactly; `computerCaptureSelectedText` captured the same value** | **CLOSED** |
| 7.8 | Terminal Access | — | `computerRunShell` + `_commandSafety` classifier | **the classifier is Unix-shaped** — `del /f`, `format`, `Remove-Item -Recurse`, `cipher /w`, `diskpart`, `netsh advfirewall set`, `Set-MpPreference -Disable` all passed through and were only stopped by filesystem ACLs | Windows equivalents added to the classifier; shell payload validated | **+17 tests** (11 blocked cases, 6 ordinary Windows commands still allowed) | — | **CLOSED — installed pkg: `del /f /q C:\Windows\System32\...\hosts` now returns "Command blocked for safety: forced delete of a Windows system path." (it previously ran and only failed with "Access is denied"); fork bomb still blocked; wrong-type payload rejected by validation** | **HARDENED / SUPERSET** |
| 7.9 | System Monitoring | — | `computerSystemInfo`, `computerSystemStats`, `computerListProcesses` | **`computerListProcesses` ran `tasklist /FO CSV \| head -40` — `head` is a Unix command, so the process list was always empty on Windows** | Windows row selection instead of `head`; CSV image-name column kept | — | — | **CLOSED — installed pkg: process list went from 0 to 40 entries; `computerSystemInfo` reports win32; `computerSystemStats` returns CPU data** | **CLOSED** |
| 7.10 | Automation Actions | — | `computerScheduleTask`, `computerListScheduled`, `computerNotify` | — | — | — | — | **PARTIAL — installed pkg: `computerListScheduled` responds (0 scheduled); `computerNotify` returns `{ok:false}` on this machine, so native toasts are not confirmed working** | **PARTIAL** |

---

# CARD 8 — COMPANION

**Retain our QR/PIN/paired-credential architecture. Do not weaken the trust model.**

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 8.1 | AI Companion | renderer companion surface | whole Companion subsystem | **LAN discovery picked the wrong interface** (first non-internal IPv4 = Hyper-V vEthernet 172.18.96.1 over real Wi-Fi 192.168.1.110); separately the state payload advertised a LAN URL while the listener was loopback-only | `electron/ipc/network.ts`: default-route-driven selection, virtual adapters demoted as additional evidence, link-local demoted; advertised host honest with `lanReachable` | **14 tests** reproducing the exact reported topology + Ethernet-only, virtual-only, Docker, VPN, non-private default route, IPv6, empty | Windows `route print -4` Active Routes | **installed pkg: localIp 192.168.1.110 (was 172.18.96.1); listener confirmed 0.0.0.0:4242 while LAN enabled; `192.168.1.110:4242` HTTP 200 from Windows** | **PARTIAL — LAN discovery CLOSED; pairing-secret guard defects found and fixed; sustained authenticated session still fails, see KNOWN BUG** | **PARTIAL / KNOWN BUG — DEFERRED** |
| 8.2 | Memory Graph | renderer memory-graph surface | `MemoryGraphView` | — | — | — | — | **UNVERIFIED — implemented and reachable; not re-walked on this package** | **IMPLEMENTED / NOT LIVE VERIFIED** |
| 8.3 | Personality | renderer personality surface | profile/persona settings | — | — | — | — | **UNVERIFIED** | **IMPLEMENTED / NOT LIVE VERIFIED** |
| 8.4 | Emotional Context | renderer emotional surface | emotional-context scoring | — | — | — | — | **UNVERIFIED** | **IMPLEMENTED / NOT LIVE VERIFIED** |
| 8.5 | Companion Voice | renderer companion-voice surface | ours TTS | — | — | — | — | **UNVERIFIED** | **IMPLEMENTED / NOT LIVE VERIFIED** |
| 8.6 | Avatar / Visuals | renderer avatar surface | Reactor + Minimal orb (Card 3) | — | — | — | — | **CLOSED — installed pkg: both orb skins render in the JARVIS stage** | **CLOSED** |
| 8.7 | Daily / Weekly Summary | renderer daily/weekly surface | reminders + Goals weekly-review template | — | — | — | — | **PARTIAL — a weekly-review routine template exists and starts correctly; scheduled generation not observed** | **PARTIAL** |
| 8.8 | Cross-Device Search | renderer cross-device surface | sync + FTS5 memory search | — | — | — | — | **PARTIAL — local search verified; cross-device search not exercised** | **PARTIAL** |
| 8.9 | Panel Help Matcher | renderer help-matcher surface | command palette / global search | — | — | — | — | **UNVERIFIED** | **IMPLEMENTED / NOT LIVE VERIFIED** |

---

# CARD 9 — FILES & MEMORY

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 9.1 | File Attachments | ours | ours | keep | complete |
| 9.2 | Document Parsing / multimodal | `load_file` puts an image/PDF/OOXML **into the model turn** `(tool-registry.ts:191-203)`; bytes deliberately not persisted in the transcript | `contentParts.ts`, per-provider converters in `ai.ts`, `messageBuilder.ts`, **`ollamaCapabilities.ts`** | was **not implemented**: `Message.content` was a string throughout and `file_load`'s base64 was stringified into the tool text, so the model never saw a picture | Content parts end to end: `image_url` (OpenAI/Groq/bridge), base64 source blocks (Anthropic), `inlineData` (Google), separate `images` array (Ollama). Attachments hydrate the newest user turn only. Tool results lift images out of the JSON text. **An image is never silently dropped** — Ollama vision is checked via `/api/show` capabilities and a model without it is told so explicitly | **12 builder tests + 12 vision-gate tests** (capability lookup, caching, sibling models, unknown model, lookup failure, note content, no bytes sent) | — | **Ollama path END-TO-END VERIFIED — see evidence below** | **CLOSED (Ollama live-verified). Anthropic / Google / opencode-bridge: adapter-tested, provider-live-unverified** |
| 9.3 | Memory Search | paid `toLocaleLowerCase().includes()` | ours FTS5 + 5-factor | **ours better** | different (better) |
| 9.4 | Knowledge Base | paid pages | ours memory | keep | partial |
| 9.5 | Vector Store | paid | ours FTS5 not vectors | portable; assess | missing |
| 9.6 | Quoting System | ours | ours | keep | complete |
| 9.7 | Chat Export | paid | ours | keep | complete |
| 9.8 | Offline Export | paid | ours | keep | complete |
| 9.9 | Database (SQLite) | paid | ours | keep | complete |
| 9.10 | Session History | paid | ours | keep | complete |

---

# CARD 10 — INTEGRATIONS

**Prime Tech Marketplace and our OpenCode/local capabilities stay. Google PKCE surfaces are ours to finish.**

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 10.1 | Google (Gmail/Drive) | Composio toolkit (commercial) | `electron/ipc/googleAuth.ts` + **`src/components/settings/GoogleConnectionPanel.tsx`** | **`googleStartAuth` had zero renderer references — present and unreachable** | connection state, scopes actually requested, disconnect removing the stored token, honest copy on why you bring your own OAuth client | typecheck + 324 suite | — | **installed pkg: card renders with connect affordance, `not connected` state, keystore note** | **CLOSED (surface)** — note: no agent tool consumes the token yet; the OAuth surface is the row, tool wiring is separate |
| 10.2 | Google Calendar | same | same OAuth, unused | surface missing | partial |
| 10.3 | Web Browser | ours | ours | keep | complete |
| 10.4 | Discord | paid Composio | none | assess | missing |
| 10.5 | Local Model Support | paid: **none** | ours Ollama/Groq/OpenCode | keep | complete |
| 10.6 | External APIs | paid Composio | ours relay | keep | partial |
| 10.7 | Composio toolkits | `contracts.ts:426-975` | — | — | **commercial** |
| 10.8 | Toolkit logo resolution | `integration-logos.ts` magic-byte sniffing + SimpleIcons→jsDelivr→Iconify→unavatar→favicon chain | `src/utils/toolIcons.ts` + `src/components/marketplace/ToolIcon.tsx`, wired into Marketplace cards | the module existed with tests but **had no consumer** — built, not usable | name in, renderable icon out. Cached, lazy. `<img>` walks the chain on error and ends at an initial-letter tile, so a 404 renders as a listing without an icon rather than a broken image | **13 tests**: name normalisation across spellings, chain ordering, unknown-service fallback, cache, chain walking to exhaustion, magic-byte sniffing for PNG/JPEG/GIF/ICO/WebP and HTML-error-page detection | — | **installed pkg: Marketplace cards render the icon slot; \`app\` / \`terminal\` have no SimpleIcons entry, the chain ran, Iconify returned 404, letter fallback rendered — 6 letter tiles, 0 broken images. CDN reachable (\`cdn.simpleicons.org\` → 200), so the success path is test-verified rather than exercised by this machine's listings** | **CLOSED (wired + live)** |
| 10.9 | OpenCode Integration | — | ours, now working | keep | complete |
| 10.10 | Prime Tech Marketplace | ours | ours | keep | complete |
| 10.11 | OAuth PKCE surfaces | ours googleAuth | no UI to complete sign-in | surface | partial |

---

# CARD 11 — SETTINGS & SYSTEM

**Finish our own Windows detection correctness. Do not copy paid behaviour over it.**

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 11.1 | AI Providers (5+) | paid has fewer | **now 5 incl. OpenCode Zen** | — | **live-verified** |
| 11.2 | API Key Management | `auth:redeem-*` | ours encrypted `_keyStorage` | keep ours (ours is better: local encrypted) | different (better) |
| 11.3 | System Diagnostics | `runtime:status-changed` push + `runtime:get-error` (`contracts.ts:2273-2274`) | `electron/ipc/runtimeDiagnostics.ts` | — | shared status computation; push on transition only (uptime excluded from the fingerprint); boot-failure record pushes immediately | typecheck + 324 suite | — | **installed pkg: status ok/dbOk true, bootFailed false, error channel answers, listener registers** | **CLOSED** |
| 11.4 | Environment Detection | paid | ours `toolProbe` quad-state | — | **complete (fixed)** |
| 11.5 | **Dependency Checks** | paid | ours `toolProbe`: installed/missing/unresolved/probe-failed, never auto-fixes on probe failure; sqlite check now uses `getDbFilePath()` **fixed + verified on installed pkg 2026-10-02: node v24.21.0, git 2.55.0, ffmpeg, python3 all ok, zero phantom installs** | **CLOSED** |
| 11.6 | Update System | `autoUpdater` | ours | keep | complete |
| 11.7 | Export / Import | paid | ours | keep | complete |
| 11.8 | Security Settings | `secure-values.ts` | ours `_keyStorage` | keep ours | different (better) |
| 11.9 | Privacy Controls | analytics consent | ours local-only analytics | keep local | complete |
| 11.10 | Logs & Debug Tools | paid `dev-log.ts` | ours | keep | partial |
| 11.11 | **Typed settings + change event** | zod 24-field schema + `settings:changed` broadcast (`ipc.ts:245,262,731`) | `src/henry/settingsContract.ts`; `settings:save` broadcasts | was untyped `Record<string,string>` with no change notification | Types only at the read/write boundary. **Renames nothing, migrates nothing, never overwrites a stored value, and round-trips unknown keys untouched.** Defaults apply only to an ABSENT key. `voice_tts_engine` is enum-constrained because it branches behaviour — an unrecognised engine previously sailed through and left callers on a branch the user never chose. JSON blobs keep their exact wire format. | **16 tests**: custom `ollama_base_url` kept verbatim, both `'1'` and `'true'` booleans accepted (both exist in real DBs from different eras), blank blob stays blank, unknown key round-trips, every in-use key asserted typed | — | **installed pkg: `owner_name`, `voice_tts_engine`, `ollama_base_url` all present after the change; 28 keys survived; all 7 settings sections render** | **CLOSED** |
| 11.12 | **Zod validation on every IPC channel** | every channel parsed both ways (`contracts.ts` throughout) | `electron/ipc/validation.ts` | baseline hardening on **every** channel; precise schemas on the ones that can cause damage | **First draft guessed channel names** (`filesystem:read` for what is actually `fs:readFile`) and would have guarded nothing. Real inventory ran first, across 333 channels. Closed an **AppleScript injection** in `computer:click` (x/y interpolated into a command while preload typed them `Record<string, unknown>`). Found and fixed dead `source:*` handlers. Failures return a tagged `{ok:false,validationError:true}` so they can never be mistaken for "not installed". | **50 tests**: injection payloads, wrong primitives, arrays/objects, oversized input, NaN/Infinity, and non-regression for the cases the inventory warned about | — | **installed pkg: `computer:click({x:'0; calc',y:0})` rejected; all 24 destinations open; 52 tools; sync 401; bridge running; 0 unhandled rejections** | **CLOSED** |
| 11.13 | App quit | `app:quit` | none | trivial | missing |
| 11.14 | Startup failure screen | `U9` with restart | `StartupFailureBanner` | partial | partial |
| 11.15 | Auth / licensing / credits / telemetry | `auth:*`, `billing:*`, PostHog | none | — | **commercial** |

---

## Open release blockers (independent of parity)

| Blocker | Status |
|---|---|
| Windows lag / "Not Responding" | root cause fixed (`e15d5ad`); **not re-verified under concurrent use on a fresh install** |
| Windows dependency detection | fixed (`e15d5ad`), verified once; ffmpeg/python report `ok` with empty version |
| OpenCode/Zen | discovery fixed (`e15d5ad`), parsing fixed (`f0eb355`); **not yet packaged/verified together** |
| ~~`sqlite3: Database file missing`~~ | **CLOSED** — check tested `$HOME/henry.db` but the DB is at `<userData>/henry-workspace/henry.db`; now one source of truth (`04df661`). **Re-verified on the fresh install: sqlite3 no longer appears among failing checks.** |
| Routines fail: `Model "deepseek-r1:7b" isn't loaded in Ollama` | undiagnosed — Ollama not running in the last test session |
| ffmpeg/python3 report `ok` with an **empty version string** | open — installed but version unread; needs tightening |
| Two contradictory `screen_recording` rows | undiagnosed |

## Legend
`missing` · `partial` · `complete` · `different` (ours is better/other) ·
`hardened/superset` · `excluded by design` (terminal) · `commercial boundary` ·
`live-verified` (installed package) · `pending` (blocked on an upstream row)

---

## Verification log

**2026-10-02 — freshly installed Windows package, commit `79619ad` + sqlite3 fix.**
`md5 123b9c8654de59bd5ff32620a0d64f74`, installed via NSIS to
`%LOCALAPPDATA%\Programs\Henry AI`.

| Check | Result |
|---|---|
| node | ok — v24.21.0 |
| git | ok — git version 2.55.0.windows.3 |
| ffmpeg / python3 | ok (version string empty — open item) |
| sqlite3 | **ok** (was `fix_failed` on every run) |
| remaining non-ok | whisper_cpp, yt_dlp, claude_cli (all genuinely absent), screen_recording |
| OpenCode | `omp/18.3.2`, 777 models, 0 polluted ids, 108 Zen |
| Zen provider row | renders in Settings with key layout |
| loopback sync | HTTP 401 (listening, correctly rejecting unauthenticated) |
| boot log handler errors | 0 |
| concurrent stress | see Windows lag row above — PASS |

---

## Card 4.8 findings carried forward

* **Chat routing:** `python run:` is intercepted by the coder engine before the sync bridge's Python branch runs. The jail is correct and tested; its chat entry point still needs an end-to-end check. Record before closing 4.8.
* **Coder reports "no engine available"** when Ollama is not running on the machine. Environment condition, not a regression — but the message is unhelpful and should name the cause.
* **`opencodeTest` returns "model is required"** when called with no model. That is a correct, if terse, response.

---

## 9.2 — why this one is not done yet, and what it needs

Multimodal input is not a panel that can be added. The entire message pipeline is
`content: string`:

- `Message.content` is a plain string (`src/types/index.ts:159`)
- the AI request path carries strings only
- all six provider adapters (`callOpenAI`, `callAnthropic`, `callGoogle`, `callGroq`,
  `callOllamaProvider`, `callOpencode`) send text
- the SQLite `messages` table stores `content` as text

Supporting images means changing the message type, the request shape, every
provider adapter, the streaming parser, and storage — and each adapter spells
image parts differently (`image_url` for OpenAI, a `source` block for Anthropic,
`inlineData` for Gemini, an OpenAI-compatible array for Ollama and the opencode
bridge).

Doing that piecemeal would put five providers that work today at risk. It needs
to be one deliberate change with per-provider verification, not a sweep item.

**Already working:** text and PDF extraction (`file_load` returns the text of a
PDF by inflating its content streams), `file_inspect`, and the whole Files card
except actually *seeing* a picture.

**Recommended:** take this as its own piece of work, behind the same gate as a
card — implement, build, install, verify each provider that supports vision.


---

## 2026-10-02 — Card 11.12 / 11.11 closed on the installed package

Built from `86bffe6`, installed, and reverified across the major surfaces because
this change can regress anything that crosses IPC.

| Surface | Result |
|---|---|
| Navigation | **24/24 destinations open, 0 failed** |
| Settings | all 5 provider rows incl. OpenCode Zen; all 7 sections |
| Existing settings | `owner_name`, `voice_tts_engine`, `ollama_base_url` all present; **28 keys survived** |
| Providers | OpenCode Zen row present (no key saved yet — not yet provisioned) |
| OpenCode | `omp/18.3.2`, **708 models, 0 polluted ids, Zen present** |
| Creators / JARVIS | 7 turns, voice mode, typewriter caption, stage opens |
| Voice | TTS on web-speech; greeting "Evening, JARVIS. All systems online" |
| Agent tools | 52 total, 10 file tools, **3 `repo_*` preserved** |
| Notifications | fires; failures-only mode suppresses correctly |
| Companion | sync server listening (401), bridge running |
| Marketplace | opens |
| Google | surface reachable, not connected |
| Runtime | ok, db ok, no error |
| `computer:click` injection | **rejected at the boundary** |
| `source:*` handlers | **reachable** (were dead) |
| Unhandled rejections | **0** |

### Two defects this pass exposed, both fixed rather than worked around

- `computer:click` interpolated x/y into AppleScript with preload typing them
  `Record<string, unknown>` — a genuine injection, macOS-gated inside the handler.
- `registerSourceFileHandlers` was never called from `main.ts`, so all four
  `source:*` handlers were dead while preload bridged them; every invoke
  rejected and the self-repair source tools could never work.

### Known-bad caller contracts found, deliberately NOT papered over

These are pre-existing bugs in callers. The schemas were left permissive so the
real defect stays visible instead of being masked by a rejection:

- `computer:runShell` returns `output`; `HQPanel` reads `stdout`.
- `computer:listProcesses` returns `{processes}`; `HQPanel` does `Array.isArray(r)`.
- `computer:desktopMode` — `HQPanel` sends `fullscreen`; the handler ignores it.
- `DeviceLinkPanel` POSTs `/sync/start-tunnel`, which does not exist — the tunnel
  button reports "cloudflared not installed" regardless of real state.
- `google:startAuth` — preload sends `scopes`; the handler discards it.

### Also still open

- Card 9.2 multimodal — its own card, not started.
- Cloud notification deep-link UI (the IPC now works; nothing subscribes yet).


---

## Caller-contract bugs — fixed, not masked

These were found while keeping the IPC schemas permissive. Making the schemas
strict would have "fixed" them by rejecting the calls, hiding the real defect.

| Bug | Handler returns | Caller did | Effect |
|---|---|---|---|
| HQPanel shell auto-run | `output` | `r.stdout` | result never shown even when the command worked |
| HQPanel process list | `{processes: string[]}` | `Array.isArray(r)` | list always empty; kill-process unreachable behind it |
| DeviceLinkPanel tunnel | route does not exist | POSTed `/sync/start-tunnel` | 404 swallowed; always said "cloudflared not installed" |
| `google:startAuth` | ignores `scopes` | preload sends them | scope request silently dropped |

All three fixed. The tunnel control also now uses the real IPC pair, which was
missing from the `HenryAPI` interface entirely — part of why the panel had
invented routes in the first place.


---



---

## Card 9.2 — Ollama path, live evidence (2026-10-02)

**Method.** `moondream:latest` (1.74 GB) was pulled into Ollama **solely as a temporary validation
model**. It is not bundled, not a declared dependency, and not Henry's default. `companion_model`
was switched only for the run and restored to `llama3.2:3b` afterwards (verified: `restored:
"llama3.2:3b"`).

**Test image.** Generated deterministically: a 256x256 PNG, a filled disc of RGB(0,128,255) centred on
RGB(255,255,255). The prompt was "Describe the image." The filename was `card92-check.png`, which
conveys nothing about colour or shape.

### Through the normal user attachment workflow in the installed package

| # | Check | Result |
|---|---|---|
| 1 | Henry recognises the attachment as an image content part | **yes** — chip rendered `card92-check.png / 951 B` after `DOM.setFileInputFiles` on the real `<input type=file>` |
| 2 | Content survives persistence / read-back | **yes** — `saveAttachment` → `getAttachment` returned a `data:image/png;base64,…` URL |
| 3 | Ollama adapter sends the image natively | **yes** — sent in Ollama's own `images` array of raw base64 |
| 4 | Vision model identifies content from pixels | **yes** — moondream: *"I see a blue square with a diagonal line"* and, in chat, *"a rectangular blue screen"*. It reports **blue** — the disc's actual colour. Shape naming is imprecise, which is a property of a 1.74 GB model, not of the transport |
| 5 | Answer returns through the normal stream and renders | **yes** — the reply appeared as a rendered assistant message under `🧠 Advisor` in the transcript |
| 6 | Base64 does not leak into visible text or context | **yes** — `base64Leaked: false` on every run; no `iVBORw0KGgo` anywhere in the transcript |

### The defect this run exposed, and the fix

With a **text-only** model (`llama3.2:3b`, capabilities `['completion','tools']`) the first live run
produced:

> *"I see a square of **yellow**."*

for a **blue** disc. Ollama accepted the request, silently ignored the bytes, and the model
described an image it never saw — precisely the failure this card exists to prevent, and precisely
what my own "never drop silently" note was supposed to stop. It did not fire, because Henry sent
the image unconditionally and never checked whether the model could see.

**Fix:** `electron/ipc/ollamaCapabilities.ts` asks Ollama itself via `POST /api/show`, whose
`capabilities` array carries `"vision"` for moondream and not for llama3.2:3b. That is authoritative
in a way a model-name guess is not — `llama3.2-vision` and `llama3.2:3b` are different models.
Results are cached per base+model. When vision is absent the image bytes are **not sent** and the
model is told so. Verified live, same model, same image:

> *"I'm unable to view the attached image as this model does not support vision. I can only respond
> based on text-based input and do not have the capability to access or view visual content."*

### Text-only conversation regression

Unchanged after the multimodal work:

| Prompt | Reply |
|---|---|
| "Say OK." | "How can I assist you today?" |
| "What is 2+2? One number only." | "4" |

### Method note

An intermediate run appeared to show the text-only model answering *"I see a blue circle"* — an
apparently correct answer from a model with no vision. That was **test contamination**, not a
product result: the poll loop matched keywords still on screen from the preceding vision turn, and
the model was plausibly continuing conversation context. Re-tested with an isolated per-model call,
the gate fires correctly. Recorded because it is exactly the kind of false positive this card is
supposed to eliminate.

### Still unverified, deliberately

**Anthropic, Google and the opencode/bridge adapters remain adapter-tested / provider-live-unverified.**
Their converters have shape-test coverage and share the same gate architecture, but no key or
vision-capable remote model was configured for this run, and none is claimed as verified.


---

## LAN discovery defect — root cause and fix (2026-10-03)

**Reported:** Henry generated `172.18.96.1:4242` for the companion QR. On this machine the
correct physical LAN address is `192.168.1.110` (Wi-Fi 2). `ipconfig` confirmed the ordinary
Ethernet adapter is disconnected and a Hyper-V `vEthernet (Default Switch)` holds 172.18.96.1
with no gateway.

**Cause.** `getLocalIp()` returned the first `IPv4 && !internal` entry from
`os.networkInterfaces()` — pure enumeration order, with no notion of which interface is actually
carrying traffic.

**Fix.** `electron/ipc/network.ts` selects on evidence:
1. the source address of the **active default route** (decisive; `route print -4` on Windows,
   `netstat -rn` elsewhere);
2. virtual/container/tunnel adapters demoted — *additional* evidence, never the sole mechanism,
   so a machine whose only link is virtual still gets an answer;
3. RFC1918 preferred over self-assigned `169.254` links;
4. anything else with a unicast IPv4 still usable.

No IP or interface name is hardcoded.

**Verified on the installed package:** `localIp` now reports **192.168.1.110**. The parser reads
the `Active Routes` row `0.0.0.0 0.0.0.0 192.168.1.1 192.168.1.110` and correctly ignores the
separate `172.18.96.0` on-link route.

**Second defect found while verifying.** The state payload advertised `http://<lanIp>:4242`
regardless of the bind host, so a phone would be handed an address nothing listened on. The
advertised host is now `127.0.0.1` with `lanReachable:false` unless LAN access is enabled. No IP
or interface name is hardcoded.

**Blocked, deliberately:** the Android QR acceptance test and the full pairing lifecycle. The
listener is confirmed bound to `127.0.0.1:4242` and `192.168.1.110:4242` is correctly unreachable,
because `sync_allow_lan` is off. Enabling it exposes 4242 to every host on the network, which is
the user's security decision to make, not one to flip unasked.


---

## KNOWN BUG — Companion QR / Android session failure (DEFERRED)

**Status:** deferred to a post-parity update. Not to be reopened during the parity pass
unless another parity row directly depends on it.

**What is fixed and must be kept:**

* LAN discovery selected the wrong interface (`electron/ipc/network.ts`) — 14 tests.
* LAN listener verified on `0.0.0.0:4242`; correct physical address `192.168.1.110` advertised.
* Generated QR reached the physical Android device and rendered the Companion interface.
* Two pairing-token guard defects found and fixed (`77d3a6a`) — 5 tests.
* `advertisedHost()` no longer advertises an unreachable LAN address.

**What is still broken:**

* The physical Android retest fails and the session dies in the same manner as the first
  attempt. The remaining failure boundary is **undiagnosed**. Possibilities not yet
  eliminated include the pairing-token/session transition, token expiry or rotation, the
  WebSocket/SSE live stream, the screen or remote-control stream, a client-side exception,
  a host approval transition, reconnect logic, or lifecycle cleanup destroying the freshly
  established session.
* `linkedDevices` remained empty after both attempts, so no device ever completed pairing
  and no orphan credential was left behind.

**Affected ledger rows:** the Card 8 lifecycle rows (pair, persist across restart, revoke,
remain revoked) are **PARTIAL / KNOWN BUG — DEFERRED**. None may be marked CLOSED.

**Environment restored after testing:** `sync_allow_lan` set back to `false`, the pairing
token revoked (`{ok:true}`), `pairToken` cleared, `linkedDevices` empty, and the listener
rebound to `127.0.0.1:4242` — `192.168.1.110:4242` now UNREACHABLE while `127.0.0.1:4242`
returns HTTP 200 and Henry's local desktop remains healthy (`runtime ok, db ok, boot ok`).
No test device or test data was left behind.
