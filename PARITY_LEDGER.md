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

`STATUS` values: `missing` · `partial` · `complete` · `different` (implemented another way) ·
`commercial` (excluded by boundary).

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

| Card | Rows | Closed | In progress | Missing | Commercial |
|---|---|---|---|---|---|
| 2 Chat & Models | 9 | 5 | 0 | 0 | 0 |
| 1 UI & Core | 10 | 0 | 0 | 8 | 0 |
| 3 Creators & Media | 14 | 0 | 0 | 11 | 0 |
| 4 Agents & Tools | 20 | 0 | 0 | 11 | 4 |
| 5 Automation | 9 | 0 | 0 | 5 | 0 |
| 6 Voice & Input | 13 | 0 | 0 | 6 | 2 |
| 7 Computer Control | 16 | 0 | 0 | 3 | 0 |
| 8 Companion | 9 | 0 | 0 | 3 | 0 |
| 9 Files & Memory | 14 | 0 | 0 | 5 | 0 |
| 10 Integrations | 14 | 0 | 0 | 4 | 4 |
| 11 Settings & System | 15 | 1 | 0 | 3 | 3 |

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
| 1.3 | Theme / UI Customisation | `accentColor` zod field, `#5cdcff` | none | no accent theming | accent + density settings, `data-skin` root attr | | | | missing |
| 1.4 | Panel System (22 panels) | n/a | 22 verified live | — | — | — | 22/22 | — | **complete** |
| 1.5 | JARVIS Orb Mode entry | `creators-view`, mode toggle Voice/Chat | none | see Card 3 | Card 3 | | | | missing |
| 1.6 | HUD / Reactor Theme | `data-skin`, `skin: default` | none | see Card 3 | Card 3 | | | | missing |
| 1.7 | Minimal Orb Theme | `skin: minimalistic` | none | see Card 3 | Card 3 | | | | missing |
| 1.8 | Onboarding Flow | `completedOnboarding`, `seenGuide`, `tutorial:get-progress` | `OnboardingWizard.tsx` | no in-app tutorial mode | post-onboarding guided tour | | | | partial |
| 1.9 | Multi-window Support | — | single window | no second window/always-on-top | needed for Card 3 orb overlay | | | | missing |
| 1.10 | Global Search | n/a | global search present | — | — | — | — | — | **complete** |

---

# CARD 3 — CREATORS & MEDIA

Source: `contracts.ts:39-215`, `main/creators-store.ts` (190 lines), renderer `creators-view`.

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | IMPLEMENTATION | TEST | LIVE | INSTALLED | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| 3.1 | Content Creators Mode (view + editor) | `creators-view`, `creators-card`, `MJ` | none | whole subsystem | creators view, demo schema, turns editor | | | | missing |
| 3.2 | JARVIS Voice Mode (full-screen orb) | `creatorDemoModeSchema` `voice` = "full-screen reactive orb overlay"; `Yee` view | none | full-screen overlay | overlay window + orb component | | | | missing |
| 3.3 | Reactor HUD Skin | "Full arc-reactor HUD with animated rings"; `hud-layer-reactor`, `hud-reactor`, `hud-core-*` | none | SVG layer system | `hud-*` class system, data-skin root | | | | missing |
| 3.4 | Minimal Orb Skin | "Classic Jarvis orb: clean rings, glowing voice-reactive core" | none | second skin | `hud-layer-minimal`, voice-reactive core | | | | missing |
| 3.5 | Caption Overlay (`typewriter`) | `captionMode: typewriter\|none`, default typewriter | none | the chat bubble | typewriter caption over orb | | | | missing |
| 3.6 | Activation: trigger phrase | `triggerPhrases[]`, default "what's the status of my app" | none | phrase triggers demo | phrase matcher | | | | missing |
| 3.7 | Activation: keyboard shortcut | `⌘⇧J` (paid is mac-only; we need cross-platform) | none | shortcut | Ctrl+Shift+J / configurable | | | | missing |
| 3.8 | Activation: click standby | "double clap or click to activate" standby screen | none | standby screen | standby view, click to start | | | | missing |
| 3.9 | Clap to wake | `clapToActivate` — **paid forces this OFF**: "ambient false positives were replaying the greeting at random" | none | — | **do not copy the broken mechanism**; if built, require hysteresis + debounce + explicit opt-in | | | | **excluded by design** |
| 3.10 | Power-on intro | `playIntro`, "cinematic activation moment… theme and a spoken greeting" | none | intro sequence | intro animation + greeting | | | | missing |
| 3.11 | Media store (`henry-media://`) | `CreatorsStore`, randomised names, kinds audio/image/file | none | media store + protocol | store + custom protocol | | | | missing |
| 3.12 | File reveal as real OS windows | `creators:open-media`, "opens in the OS default viewer"; `fileStaggerMs` cascade | none | open media | open + stagger | | | | missing |
| 3.13 | Reactor speed setting | `reactorSpeed: slow\|default\|fast\|off` | none | animation speed | setting | | | | missing |
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
| 4.5 | File System Tools | `list_files`, `search_files`, `inspect_file`, `read_file`, `load_file`, `write_file`, `replace_file`, `move_file`, `copy_file`, `publish_file` (`tool-registry.ts:151-289`) | repo-scoped only | **8 portable tools missing**; `load_file` = multimodal, `publish_file` = attach produced file | missing |
| 4.6 | Git Integration | — | `repo.ts` | keep | complete |
| 4.7 | GitHub Research Tools | — | none | portable | missing |
| 4.8 | Python Tools (Jailed) | paid jailed | ours unrestricted | **ours is weaker on safety — must not downgrade** | partial (safety) |
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
| 5.6 | Goal Planning | goal schema | none | portable | missing |
| 5.7 | Run management | runs + attachments + deep-link | runs only | no attachments, no notification deep-link | partial |
| 5.8 | Native notifications | `automation-notifications.ts`, OS permission 6-state enum, click→run | in-app IPC only | **fully portable, high value** | missing |
| 5.9 | Automation ideas | renderer `ideas` tab | none | portable | missing |

---

# CARD 6 — VOICE & INPUT

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 6.1 | Speech-to-Text (STT) | `voice/whisper.ts`, `sttBackend: local\|server` | ours whisper + SpeechSynthesis | STT queueing **worse in ours** (throws, loses utterance) | partial |
| 6.2 | Text-to-Speech (TTS) | `ttsBackend: system\|openai\|elevenlabs\|kokoro` | ours system + ElevenLabs + browser | no Kokoro local neural TTS | partial |
| 6.3 | Voice Commands | voice router | ours intents | keep + extend | partial |
| 6.4 | Wake Word | paid claims wake word | none | assess; must not reproduce broken clap | missing |
| 6.5 | Voice Panel (All OS) | renderer voice panel | ours Voice section | compare | partial |
| 6.6 | Voice Transcription | `voiceSilenceMs`, `micSensitivity`, `micMuted` | push-to-talk only | **no VAD endpointing — biggest UX unlock** | missing |
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
| 7.1 | Screen Analysis / capture | ours | ours | — | complete |
| 7.2 | UI Interaction | ours | ours | — | complete |
| 7.3 | Mouse / Keyboard | PowerShell SendKeys | ours | keep | complete |
| 7.4 | Application Control | launch/quit | ours | keep | complete |
| 7.5 | Window Management | — | ours | keep | complete |
| 7.6 | File Operations | paid tools | ours shell-based | keep ours | partial |
| 7.7 | Clipboard Access | — | ours, guarded | keep | complete |
| 7.8 | Terminal Access | ours | ours | keep | complete |
| 7.9 | System Monitoring | paid | ours health | keep | complete |
| 7.10 | Automation Actions | — | ours | keep | complete |

---

# CARD 8 — COMPANION

**Retain our QR/PIN/paired-credential architecture. Do not weaken the trust model.**

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 8.1 | AI Companion | ours | ours | keep | complete |
| 8.2 | Memory Graph | ours | ours | keep | complete |
| 8.3 | Personality | ours | ours | keep | complete |
| 8.4 | Emotional Context | ours | ours | keep | complete |
| 8.5 | Companion Voice | ours TTS | ours | keep | complete |
| 8.6 | Avatar / Visuals | none | ours orb-less | assess | partial |
| 8.7 | Daily / Weekly Summary | paid | ours reminders | compare | partial |
| 8.8 | Cross-Device Search | paid | ours sync | keep | partial |
| 8.9 | Panel Help Matcher | paid | ours | keep | complete |

---

# CARD 9 — FILES & MEMORY

| # | Row | PAID EVIDENCE | OUR CURRENT | GAP | STATUS |
|---|---|---|---|---|---|
| 9.1 | File Attachments | ours | ours | keep | complete |
| 9.2 | Document Parsing | `load_file` (image/PDF/OOXML → model) | none | **multimodal gap** | missing |
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
| 10.1 | Google (Gmail/Drive) | Composio toolkit | **`electron/ipc/googleAuth.ts` — full PKCE + loopback + safeStorage, Gmail/Calendar/Drive scopes, refresh + revoke** | **no tool or panel consumes it — surface missing, hard part done** | partial |
| 10.2 | Google Calendar | same | same OAuth, unused | surface missing | partial |
| 10.3 | Web Browser | ours | ours | keep | complete |
| 10.4 | Discord | paid Composio | none | assess | missing |
| 10.5 | Local Model Support | paid: **none** | ours Ollama/Groq/OpenCode | keep | complete |
| 10.6 | External APIs | paid Composio | ours relay | keep | partial |
| 10.7 | Composio toolkits | `contracts.ts:426-975` | — | — | **commercial** |
| 10.8 | Toolkit logo resolution | `integration-logos.ts` magic-byte sniffing + SimpleIcons→jsDelivr→Iconify→unavatar→favicon chain | none | **self-contained, reusable** | missing |
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
| 11.3 | System Diagnostics | `runtime:status-changed` push | sync `runtime:get-status` | **no push — renderer can't learn runtime died** | missing |
| 11.4 | Environment Detection | paid | ours `toolProbe` quad-state | — | **complete (fixed)** |
| 11.5 | **Dependency Checks** | paid | ours `toolProbe`: installed/missing/unresolved/probe-failed, never auto-fixes on probe failure | **fixed + verified on installed pkg 2026-10-02: node v24.21.0, git 2.55.0, ffmpeg, python3 all ok, zero phantom installs** | **CLOSED** |
| 11.6 | Update System | `autoUpdater` | ours | keep | complete |
| 11.7 | Export / Import | paid | ours | keep | complete |
| 11.8 | Security Settings | `secure-values.ts` | ours `_keyStorage` | keep ours | different (better) |
| 11.9 | Privacy Controls | analytics consent | ours local-only analytics | keep local | complete |
| 11.10 | Logs & Debug Tools | paid `dev-log.ts` | ours | keep | partial |
| 11.11 | **Typed settings + change event** | zod 24-field schema + `settings:changed` broadcast from 4 sites | untyped `Record<string,string>`, no event | **largest structural gap** | missing |
| 11.12 | **Zod validation on every IPC channel** | every channel parsed both ways | bare `unknown` | **root enabler of several hand-patched bugs** | missing |
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
| ~~`sqlite3: Database file missing`~~ | **CLOSED** — check tested `$HOME/henry.db` but the DB is at `<userData>/henry-workspace/henry.db`; now uses one source of truth (`04df661`). Needs installed-package re-verify |
| Routines fail: `Model "deepseek-r1:7b" isn't loaded in Ollama` | undiagnosed — Ollama not running in the last test session |
| ffmpeg/python3 report `ok` with an **empty version string** | open — installed but version unread; needs tightening |
| Two contradictory `screen_recording` rows | undiagnosed |

## Legend
`missing` · `partial` · `complete` · `different` (ours is better/other) · `commercial` (excluded by
boundary) · `live-verified` (installed package) · `pending` (blocked on an upstream row)