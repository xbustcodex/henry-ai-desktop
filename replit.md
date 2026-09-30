# Henry AI Desktop — Replit Setup

## Overview

Henry AI is Topher's personal AI presence — a local-first AI OS with a dual-engine architecture (Local Brain / Ollama + Cloud Brain) **plus a full iPhone/iPad companion app** (Capacitor). He has warmth, memory, and a can-do philosophy: he always finds a way to help, never dead-ends a request.

### iPhone/iPad Companion System

Desktop remains the source of truth. Sync via LAN (port 4242 HTTP+SSE) with cloud relay fallback (Cloudflare Worker KV).

- **Architecture**: `src/sync/` — types, syncClient, syncStore (Zustand), deviceLink
- **Electron server**: `electron/ipc/syncBridge.ts` — HTTP+SSE on port 4242, IPC bridge, QR token generation
- **Desktop pairing UI**: `src/components/settings/DeviceLinkPanel.tsx` — QR code, connected devices list (Settings → Companion Devices tab)
- **Mobile screens** (`src/components/mobile/`): CompanionApp (shell), CompanionHome, CompanionChat, CompanionTasks, CompanionCapture, CompanionApproval, CompanionNav, CompanionPairing
- **Mode switching**: `isCompanionMode()` in App.tsx detects `isNative + localStorage('henry:companion:config')`; "Switch to Full Henry Mode" button in CompanionHome footer
- **Cloudflare relay**: `proxy/worker.js` — `/relay/*` routes backed by KV namespace `HENRY_RELAY`
- **KV setup**: see `proxy/wrangler.toml` — run `npx wrangler kv namespace create HENRY_RELAY` then paste id into toml
- **Camera**: `@capacitor/camera` installed; configured in `capacitor.config.ts`
- **QR scanner**: `@capacitor-mlkit/barcode-scanning` (native-only, externalized from web Rollup build)

Supports OpenAI, Anthropic, Google Gemini, Groq, and Ollama. 10 built-in modes + unlimited custom modes:
- **Chat** · **Writing** · **Code** · **App Builder** · **3D / Design** · **Secretary** · **Computer** · **Coach** · **Strategic** · **Business Builder**
- **Custom Modes** — create and save your own modes with name, icon, description, system prompt, and launch with one tap

### Features

**Dev & Service Integrations** *(new — sidebar: Dev & Services section)*
- **Integrations hub** — `/integrations` panel showing all services; connect via paste-in token (GitHub, Linear, Notion, Stripe, Google Calendar, Gmail) or auto-connected via Replit OAuth (Slack)
- **GitHub panel** — repos list with search, issues (open/closed filter, create new issues), pull requests; uses GitHub REST API via `/proxy/github` with user-supplied PAT
- **Linear panel** — assigned issues grouped by team, priority filter (Urgent/High/All), links to Linear directly; uses Linear GraphQL API via `/proxy/linear`
- **Notion panel** — search and browse pages/databases; uses Notion API v1 via `/proxy/notion`
- **Slack panel** — channel list, message history, compose + send; connected via Replit OAuth connector (no manual token needed); uses `/connector/slack/*` → `@replit/connectors-sdk`
- **Service proxy routes** — all service calls go through the Vite dev server middleware (CORS-safe); proxy routes for GitHub, Linear, Notion, Stripe, Google Calendar, Gmail; Replit connector middleware for OAuth-managed services
- **Charter awareness** — Developer mode now includes connected-services guidance, code review style, and git hygiene standards; all connected services injected into system prompt context block
- **Proposed integrations** — Linear, Slack (connected), Notion, Jira, Stripe, Google Calendar, Gmail all proposed for user to connect

**Goals & Habits**
- `src/henry/goalsData.ts` — full CRUD with streaks, check-ins, milestones, habit scheduling (daily/weekly/custom)
- `GoalsPanel.tsx` — progress rings, milestone tracker, habit streaks, Ask Henry integration; sidebar entry at 🎯 Goals

**Quick Capture**
- `src/henry/quickCapture.ts` — auto-category detection (task/idea/reminder/note/journal/person/project)
- `CaptureModal.tsx` — voice input, 7 categories, launches from floating purple + button or ⌘⇧C shortcut
- Floating button at bottom-right (above mobile nav), always accessible

**Weekly Review Rituals**
- `src/henry/weeklyReview.ts` — 3 time-aware sessions: Friday EOD (4-6pm), Friday Evening (6pm+), Monday Morning (7am-noon)
- Each session has tailored system prompts, starter messages, dismiss/complete tracking
- Banner surfaces in TodayPanel at the right time; launches directly into Henry chat

**Proactive Follow-up Intelligence**
- `src/henry/proactiveNudges.ts` — scans recent message history for follow-up language patterns (follow-up, check in, reach out, remind me, etc.); generates contextual nudges
- Habit accountability nudges at 6pm+ for incomplete habits
- Goal deadline nudges (3-day warning) and stall detection (5+ days without progress)

**Google Calendar + Gmail**
- `src/henry/googleAuth.ts` — GIS (Google Identity Services) browser OAuth2 token model; no server or client secret needed; token stored in localStorage with expiry; `gcalFetch()` and `gmailFetch()` route through `/proxy/gcal` and `/proxy/gmail`
- `GoogleCalendarPanel.tsx` — step-by-step setup guide (Client ID paste-in), Today/This Week tabs, event cards with time/location/attendees/Meet links, "Ask Henry" button pre-loads events into companion context
- `GmailPanel.tsx` — inbox list with sender/subject/snippet/time, email detail pane, "Draft reply" → launches Secretary mode, "Reply" opens compose, full compose modal with "Ask Henry to draft" escape hatch
- Calendar events injected into Henry's morning briefing context (via `buildCalendarContextBlock()`)
- Both panels surfaced as 📅 Calendar and 📧 Gmail in the Home sidebar section

**Meeting Intelligence → Memory**
- Recording processor now saves meeting summary + action items to `henry:meeting_memories` (via `saveMeetingToMemory`)
- `buildRichMemoryBlock()` includes last 3 meeting summaries in every Henry system prompt for full context continuity

**Core AI**
- **Groq hardwired** — Groq is set as the permanent default engine; 8B Instant (fast) + 70B Versatile (quality) auto-routed by `modelRouter.ts`
- **Maximum memory** — `HENRY_MEMORY_CAPS` tuned for 128K context: 50 facts, 12K summary, 40 history turns, 8K chars/message
- **maxTokens wired** — passed to every stream call; each provider falls back to 4096 when a caller does not set one
- **Full web access** — `webTools.ts` tool layer: `search_web`, `open_url`, `extract_page_text`, `summarize_page`, `collect_sources`; auto-detects web intent before LLM call; injects live context into system prompt; shows source citations as clickable pills
- **⌘K Command Palette** — fuzzy search across all modes, quick actions, recent conversations, navigation
- **Rich memory** — projects, goals, and people injected into Henry's system prompt (localStorage)

**7-Layer Memory Architecture** *(Memory Blueprint — fully implemented)*
- **Layer 1** — Live Turn: current message + tool results (ChatView)
- **Layer 2** — Session Memory: DB-backed per-conversation state (`session_memory` table); `sessionLifecycle.ts` manages start/tick/end/compression; `session_end` summaries + `where_we_left_off` auto-generated
- **Layer 3** — Working Memory: DB-backed single-row state (`working_memory` table); localStorage fast cache + DB sync; commitments table for Henry's explicit promises
- **Layer 4** — Personal Memory: `personal_memory` table with 5-dimensional scoring (relevance, recency, emotional, strategic, confidence); 12 memory types (identity, preference, habit, value, frustration, goal, etc.); auto-ingested from user messages; `scoreMemoryFact()` ranks facts by combined score
- **Layer 5** — Project Memory: `projects` + `project_memory` tables; tracks status, summary, blockers, deadlines, strategic/emotional importance
- **Layer 6** — Relationship Memory: `relationship_memory` table; tracks support style patterns, overwhelm responses, communication preferences; confidence-gated updates
- **Layer 7** — Narrative Memory: `narrative_memory` table; life/work arcs with linked projects and memories; slow-changing, importance-scored
- **Memory Graph**: `memory_graph_edges` table — links projects↔files↔conversations↔commitments↔milestones↔arcs
- **Memory Summaries**: `memory_summaries` table — daily/weekly/monthly rollups, project rollups, session-end summaries, where-we-left-off
- **Bandwidth Modes**: shallow (fast/minimal) → normal (session+working+personal) → deep (+projects+relationship+narrative) → maximum (all layers + milestones + where-we-left-off + timeline)
- **Scoring formula**: `retrieval_score = (relevance×0.30) + (recency×0.20) + (emotional×0.15) + (strategic×0.25) + (confidence×0.10)` — used in `memoryRetrieval.ts` + `workingMemory.ts`
- **Key files**: `electron/ipc/database.ts` (12-table schema), `electron/ipc/memory.ts` (full CRUD + deep context builder), `src/henry/memoryRetrieval.ts` (client scoring + formatter), `src/henry/sessionLifecycle.ts` (lifecycle + personal memory ingestion), `src/henry/workingMemory.ts` (Layer 3 cache + narrative)

**Life Architecture**
- **Emotion Detection** — `emotionDetector.ts`: detects 9 emotional states (overwhelmed, stressed, urgent, scattered, excited, confused, discouraged, confident, focused); `buildEmotionBlock()` injected into every enriched system prompt
- **State Indicator Bar** — shows Thinking…/Planning…/Acting…/Responding…/Done ✓ with 1.5s flash; planning (spinner) + acting (dots) states added
- **Presence Phrases** — spoken via browser TTS before quality tasks; wired in `ambientBrain.ts`
- **Voice input (Groq Whisper)** — mic button → MediaRecorder → Groq Whisper STT → inserts transcript into chat
- **Document ingestion** — drag-and-drop or attach files in chat input; Henry gives multi-angle perspective
- **Status indicators** — live state bar shows Thinking…(8B/70B) → Responding… → Done with 1.5s checkmark; presence phrases spoken via browser TTS before heavy tasks

**Three New Modes**
- **Coach mode** — executive coaching approach: one focused question at a time, reflects back, challenges excuses, accountability focus, ends each session with one clear next action
- **Strategic mode** — senior advisor thinking: outcomes-first, leverage points, tradeoffs, 2-3 options, scenario planning, structured output with clear recommendations
- **Business Builder mode** — idea → offer → customer avatar → revenue model → launch plan → first customer pipeline; bias toward action and revenue

**Chat Quick Actions**
- **Message action chips** — hover any Henry response to see "Summarize", "→ Tasks", "Shorter", "Simpler" buttons; clicking any fires a follow-up prompt automatically; wired into the main handleSend flow

**Personal Assistant**
- **Reminders panel** — timed reminders with browser notifications, categories (personal/work/household/health/maker), repeat options; enabled by notification permission prompt
- **Lists panel** — grocery, hardware, household, ideas lists + custom lists with icon picker; check off items; copy full list
- **Today panel** — quick-ask input, 8-mode launcher, auto-generates morning briefing on first launch each day
- **Proactive nudges** — context-aware nudge banners (morning briefing, evening journal, stale tasks, project inactivity)
- **Clipboard AI** — detects clipboard content on focus; offers summarize/explain/improve/bullet/reply actions inline

**Business / Secretary**
- **Secretary panel** — daily briefing, email drafts, scheduling, task review, meeting prep
- **CRM panel** — clients with status (prospect/active/paused/closed), projects with pipeline, interaction log, "Brief me before meeting" button launches Henry in secretary mode with full client context
- **Finance panel** — income/expense tracker, monthly summaries (net P&L), category breakdown, CSV export, "Ask Henry to analyze" this month
- **Contacts panel** — contacts with interaction history; "Brief me" launches secretary chat

**Maker / 3D**
- **Print Studio panel** — 3 tabs: Gallery (print job log with material/settings/success), Filament tracker (spools with remaining % bar, color hex, brand), BOM (bill of materials grouped by project with status tracking)
- **Image Gen panel** — DALL-E 3 via OpenAI; size/style options; generated image gallery with download and reuse; requires OpenAI API key
- **3D Printer panel** — USB serial G-code terminal (Electron desktop build only)
- **3D/Design mode** — comprehensive slicer knowledge: material guide (PLA/PETG/ABS/ASA/TPU/Nylon/Resin), settings by use-case, failure diagnosis, Bambu/PrusaSlicer/Cura specifics, design-to-print pipeline, photo-to-3D workflows, OpenSCAD + Blender Python generation

**Dev Tools**
- **Builder mode live preview** — streaming partial HTML rendered live; viewport toggle; download HTML
- **Terminal panel** — shell access (desktop), AI-driven command suggestions
- **Computer panel** — Mac shell/AppleScript/app control (Electron desktop build only)
- **Workspace panel** — file workspace with context injection

**UX / Quality**
- **Journal panel** — date-stamped entries with Henry reflection on demand; sidebar search
- **Focus timer panel** — Pomodoro timer with AI check-ins
- **Meeting Recorder panel** — record → Groq Whisper → AI summary + action items → save tasks
- **Modes panel** — custom mode editor (icon, name, description, system prompt)
- **Conversation auto-naming** — 4-6 word title generated after first exchange
- **Message copy + code blocks** — hover to copy; syntax-highlighted code with language badge
- **Message timestamps** — visible on hover
- **Auto-updater** — electron-updater wired; banner notifies when update ready
- **Custom mode system prompt** — `henry_custom_mode_override` in localStorage overrides charter
- **Sidebar grouped navigation** — Home / Business / Maker / Tools sections for all 22 views

## Tech Stack

- **Framework:** React 18 + TypeScript
- **Build Tool:** Vite 5
- **Styling:** Tailwind CSS (dark theme)
- **State Management:** Zustand
- **AI SDKs:** OpenAI, Anthropic, Google Generative AI
- **Desktop:** Electron 31 + electron-builder 24 + electron-updater 6
- **Package Manager:** npm

## Project Structure

```
electron/         - Electron main process + IPC handlers
  main.ts         - App entry, auto-updater, IPC registration
  preload.ts      - Context bridge (window.henryAPI)
  ipc/            - ai, settings, database, memory, ollama, terminal, computer, printer
resources/
  icon.png        - 1024×1024 app icon (auto-converts to icns/ico by electron-builder)
  entitlements.mac.plist - Mac hardened runtime entitlements for notarization
src/
  App.tsx         - Root; setup/init logic; auto-update notification banner
  main.tsx        - React entry point (imports webMock)
  webMock.ts      - Browser-based mock for window.henryAPI (replaces Electron IPC)
  components/     - UI components organized by feature
    chat/
      ChatView.tsx        - Main chat UI; streaming, auto-naming, mode detection
      MessageBubble.tsx   - Message renderer; copy, timestamps, syntax-highlighted code
    today/
      TodayPanel.tsx      - Home screen; quick-ask input, mode cards, briefing
    settings/
      SettingsView.tsx    - Providers, Engines, General, Memory (Projects/Goals/People)
  henry/          - Core AI logic, gateway/router, workspace utilities
  store/          - Zustand global state
  global.d.ts     - CANONICAL type declarations for window.henryAPI
vite.web.config.ts  - Web-specific Vite config (no Electron plugins, port 5000)
vite.config.ts      - Original Electron Vite config (for desktop builds)
```

## Running the App

```
npm run dev        # Web preview on port 5000
npm run push       # Push to GitHub (requires GITHUB_PERSONAL_ACCESS_TOKEN)
```

## Mac DMG Build (on your Mac)

### Prerequisites
1. macOS with Xcode Command Line Tools
2. Node.js 20+ installed
3. Clone the repo and run:
```bash
npm install
npm run rebuild        # rebuild better-sqlite3 for Electron
```

### Build unsigned DMG (dev testing — no code signing required)
```bash
npm run build:mac:unsigned
```
Output: `release2/Henry AI-*.dmg`

### Build signed + notarized DMG (for distribution)
1. Have an Apple Developer ID certificate in your Keychain
2. Set env vars:
```bash
export APPLE_ID="your@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```
3. Run:
```bash
npm run build:mac
```

### Auto-updater (GitHub Releases)
- `electron-updater` is wired: it checks GitHub once on launch and then every 4 hours, with `autoInstallOnAppQuit` enabled
- To publish a release with update artifacts:
```bash
GH_TOKEN=your_github_token npm run build:mac
```
- Then create a GitHub Release from the `release2/` directory artifacts
- Future app installs will auto-download and show an in-app banner: "Henry update ready — restart to apply"

## Mobile & Cross-Platform

### Mobile (iPhone, iPad, Android) — Works Today via PWA
Visit the deployed Henry URL in Safari (iOS) or Chrome (Android) → tap Share → **Add to Home Screen**. Henry launches as a standalone app with the Henry icon, full-screen with no browser chrome.

**Mobile layout:**
- On `< 768px` screens: sidebar is hidden; a **bottom tab bar** appears with Today, Chat, Secretary, People, and a **More** drawer
- More drawer contains all remaining sections (Tasks, Files, Settings, etc.) + recent conversations
- All panels have responsive padding and grid layouts for small screens
- Chat input does not auto-focus on touch (prevents keyboard popping on load)
- Voice input (microphone) works on iOS Safari and Android Chrome

**What works on mobile:**
| Feature | iOS/Android |
|---|---|
| All 8 Henry modes | ✅ |
| Today, Chat, Secretary, Contacts | ✅ |
| Voice input | ✅ (Web Speech API) |
| Memory, projects, people | ✅ |
| Morning briefing | ✅ |
| OpenAI / Anthropic / Google AI | ✅ |
| Ollama local models | ❌ (runs on Mac only) |
| Terminal / Computer / File system | ❌ (desktop only) |

**Ollama from mobile:** Go to Settings → AI Providers → Ollama, set URL to `http://[Mac-IP]:11434`. Both devices will use the same Ollama instance on your Mac.

### Windows / Linux

**Electron desktop app** — builds with:
```bash
npm run build:win      # Windows NSIS installer (.exe)
npm run build:linux    # Linux AppImage
```
Run these on the target OS. All features work except Mac-specific automation (AppleScript).

**Web PWA on Windows/Linux** — opens in any browser, all cloud AI features work. Add to home screen (Chrome: three-dot menu → "Install Henry AI") for desktop app feel.

### iOS/Android Native App (Capacitor — Ready to build)
Capacitor wraps the existing React app into a true App Store / Play Store app with zero rewrite.

**First-time native project setup (run on your Mac):**
```bash
npx cap add ios      # creates ios/ Xcode project
npx cap add android  # creates android/ Android Studio project
```

**Every build thereafter:**
```bash
npm run cap:build    # builds web assets + syncs to native
npm run cap:ios      # opens Xcode → Archive → App Store
npm run cap:android  # opens Android Studio → Build → AAB
```

**Mobile proxy (required for AI calls on native):**
iOS/Android apps don't have a local server, so AI API calls need a proxy:
1. Deploy `proxy/worker.js` to Cloudflare Workers (free, ~2 min — see `proxy/README.md`)
2. In Henry on mobile: Settings → AI Providers → Mobile Proxy URL → paste worker URL

**Best free AI for mobile:**
| Provider    | Free tier               | Setup |
|-------------|------------------------|-------|
| Groq        | Llama 3.3 70B, Mistral | groq.com → free API key |
| Google Gemini | Gemini Flash          | aistudio.google.com → free key |
| OpenRouter  | 50+ free models        | openrouter.ai → free key |
| Ollama (Mac)| Unlimited, local       | Point mobile to Mac IP in settings |

### Desktop CI/CD (GitHub Actions)
Push a version tag and all three desktop builds run automatically:
```bash
git tag v1.0.0 && git push origin v1.0.0
```
GitHub Actions builds Mac DMG, Windows NSIS installer, and Linux AppImage + deb — artifacts attached to the GitHub Release automatically. See `.github/workflows/desktop-release.yml`.

## Web Adaptation

The app uses `window.henryAPI` (Electron IPC bridge) everywhere. In web mode, `src/webMock.ts` provides a full browser-based implementation using `localStorage` and direct API fetch calls.

### Supported in Web Mode:
- Settings, conversations, messages (localStorage)
- AI providers: OpenAI, Anthropic, Google Gemini, Ollama (direct API calls)
- Streaming responses from all providers
- Tasks, memory facts, conversation summaries (localStorage)
- Virtual file system (localStorage)

### Limitations in Web Mode:
- Terminal execution (disabled — shows friendly message)
- Ollama requires CORS headers (`OLLAMA_ORIGINS=*`)

## Engine Configuration

### Two-Brain Architecture
- **Companion (Local Brain):** primary + fallback model slots. If primary fails mid-stream, fallback is tried automatically.
- **Worker (Cloud Brain):** for code/research tasks; runs async, injects result back into the active conversation.

### Conversation Auto-Naming
After the first assistant response in a new conversation, Henry fires a background non-blocking call to the same model with a simple prompt: "Create a 4-6 word title." The sidebar updates silently within a few seconds.

### Model Priority Order
- **Companion:** Llama 3.3 70B → Qwen 2.5 7B → Phi-4 → Mistral Nemo → Gemma 2 9B
- **Worker:** DeepSeek-R1 14B → DeepSeek-R1 7B → Qwen 2.5 72B → Llama 3.3 70B

## electron-builder Config Notes

- `"icon": "resources/icon.png"` at top level — electron-builder auto-converts to `.icns` on Mac, `.ico` on Windows
- `"hardenedRuntime": true` + entitlements file required for Mac notarization
- `"publish"` config points to GitHub for auto-updater
- `"identity": null` in `build:mac:unsigned` skips code signing for local dev builds

## Key Files

| File | Purpose |
|------|---------|
| `src/global.d.ts` | CANONICAL type declarations — edit this, not `src/types/globals.d.ts` |
| `src/webMock.ts` | Browser implementation of `window.henryAPI` |
| `electron/preload.ts` | Electron IPC bridge |
| `electron/main.ts` | Electron app entry + auto-updater |
| `src/henry/richMemory.ts` | Projects, goals, people storage |
| `resources/icon.png` | 1024×1024 app icon (programmatically generated) |
| `resources/entitlements.mac.plist` | Mac hardened runtime entitlements |

---

# Henry AI Desktop — handoff notes (Replit / collaborators)

*(Merged from legacy `REPLIT.md` to avoid case-collision on macOS.)*

## What this repo is

- **Electron + React + Vite + TypeScript** desktop app.
- **SQLite** (`better-sqlite3`) and **IPC** in `electron/` — the renderer talks only through `preload.ts` → `window.henryAPI`.

Henry is intentionally **not** a generic chat wrapper: identity, lean memory, Writing / 3D-Design / Coach / Strategic modes, task bridge, export packs, and session recovery are first-class.

## Running locally (intended path)

```bash
npm install
npm run dev
```

Requires **Node 18+** and a desktop OS. The full app needs **Electron**; `henryAPI` is undefined in a plain browser tab.

## Smoke check (no installer)

```bash
npm run smoke
```

Runs TypeScript checks and a **Vite production build** (renderer + main + preload bundles). It does **not** run `electron-builder`.

## Replit / web-only constraints

- **Replit cannot replace Electron** for this project without a major fork. There is no separate HTTP backend; SQLite and AI calls live in the **main process**.
- A future Replit phase might add a **remote API** or **mock `henryAPI`** for UI demos — that would be **new architecture**, not what ships today.
- Safe enhancement targets on Replit: docs, design tokens, copy, or a **parallel** web prototype that does not delete IPC code paths.

## Preserved product pillars (do not regress)

- Henry voice: calm, wise, strong, direct (`src/henry/charter.ts` and related prompts).
- Lean memory (`src/henry/memoryContext.ts`, memory IPC).
- Writer and Design3D modes, workspace context honesty (`src/henry/workspaceContext.ts`).
- Task ↔ workspace linkage, export packs (`src/henry/exportBundle.ts`, `exportManifest.ts`), session recovery (`src/henry/sessionResume.ts`).
- Command layer: `src/henry/commandLayer.ts`, `src/henry/commandActions.ts`, wired in `ChatView` (try `/help`).

## Known gaps / follow-ups

- **Installers**: `npm run build` runs `electron-builder` — needs platform tooling and signing for release.
- **Workspace path**: Settings → General → **Workspace hint** stores `workspace_path` for UI gates and prompts; filesystem sandbox remains under app userData (see `electron/main.ts`).
- **Automated E2E**: no Playwright/Cypress in repo; manual smoke on chat, tasks, files, export pack, session restore after restart.

## Files to read first

| Area        | Location |
|------------|----------|
| IPC bridge | `electron/preload.ts`, `electron/main.ts` |
| AI stream  | `electron/ipc/ai.ts` |
| Chat       | `src/components/chat/ChatView.tsx` |
| Store      | `src/store/index.ts` |
| Henry logic| `src/henry/*.ts` |
