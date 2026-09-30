<div align="center">
  <h1>◉ Henry AI</h1>
  <p><strong>A personal AI that talks, codes, builds, and teaches — for almost nothing.</strong></p>
  <p>Local-first · Self-healing · Voice built in · Works on Linux, Windows, and macOS — plus your phone</p>
  <br>
  <a href="https://github.com/tophercook7-maker/henry-ai-desktop/releases/latest">
    <img src="https://img.shields.io/github/v/release/tophercook7-maker/henry-ai-desktop?label=Download&color=6366f1" />
  </a>
  <img src="https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey" />
  <img src="https://img.shields.io/badge/AI-Groq%20Free%20Tier-22c55e" />
  <img src="https://img.shields.io/badge/License-MIT-white" />
</div>

---

## What Henry Is

Henry is a personal AI that runs on your computer. Not a chatbot — a companion built around seven jobs:

1. **Talks, types, and listens** — free local voice, hands-free mode, spoken replies
2. **Writes code** — powered by the Claude Code CLI on your subscription, or a free local coder
3. **Writes books and designs the covers** — real KDP-ready specs, AI art, typography
4. **Connects to your machines** — 3D printers (Bambu, Klipper, OctoPrint, Marlin) and GRBL CNC
5. **Teaches you anything** — structured courses with lessons, real-world application, and quizzes
6. **Keeps you organized** — tasks, reminders, journal, goals, finance, memory that persists
7. **Runs your maker shop** — filament stock, production runs, waste, machine maintenance

All of it local-first: your key, your data, no subscription to Henry itself.

## Voice

Henry listens with **whisper.cpp** running locally on your machine — free, offline, private. First tap of the mic runs a one-time setup (~150MB model, installed automatically). Replies speak through the built-in system voice, or through ElevenLabs automatically if you add a key.

- Tap the mic, talk, edit the transcript, send
- **Hands-free mode**: speak → Henry answers out loud
- Works in every mode — dictate a chapter, ask what your printer's doing

## Code

In Code mode, Henry hands work to the **Claude Code CLI** — your Claude subscription, huge context window, real file edits in a sandboxed workspace with approval gating — or to **opencode**, whose full model catalogue (including the opencode zen gateway) appears in the same Settings model picker as every other provider. No CLI or offline? Henry falls back to a **free local coder** via Ollama (qwen2.5-coder). A chip in the chat picks: Auto / Claude Code / opencode / Local.

## Books & Covers

The Book panel captures your story into chapters — and now finishes the job with **Cover Studio**:

- Enter title, author, genre, page count → Henry computes your exact KDP specs (trim, bleed, spine width to the thousandth of an inch)
- **Do it for me**: AI cover art + genre-aware title typography, exported as ebook (1600×2560) and print-resolution PNGs, plus a print-specs sheet for the full wrap
- **Teach me**: a step-by-step guide tailored to your exact book, using free tools

## Machines

Add your printers and CNC in the Machines panel — Henry speaks their language:

| Machine | Protocol | Status |
|---|---|---|
| Bambu Lab (X1/P1/A1) | LAN MQTT | Live status, pause/resume/stop |
| Klipper (Voron, Prusa, modded Enders) | Moonraker | Full: upload, print, control |
| OctoPrint | REST API | Full: upload, print, control |
| Marlin (stock Enders) | USB serial | One-time setup: `npm i serialport && npm run rebuild` |
| GRBL CNC (Shapeoko etc.) | USB serial | Same one-time setup; jog, home, stream G-code |

Ask in chat: *"What's my printer doing?"* — Henry answers with live temps and progress. Pause/stop go through his approval gate.

Plus the full maker suite: filament/materials stock, production runs, waste log, maintenance history, Print Studio, slicer integration, and the 3D Model Generator (describe an object or drop a photo → real STL/3MF at correct millimeter scale).

## Lessons

Tell Henry what you want to learn — *"how MQTT works"*, *"Rust ownership"*, *"photo composition"* — pick a depth and length, and he builds a real course: lessons unlock in order, each with teaching, real-world application, and a quiz that unlocks the next lesson at 60%.

## Organization

| Panel | What it does |
|---|---|
| Today | Daily briefing, cost tracker |
| Tasks | todo / doing / done, priorities |
| Journal | Daily entries, mood, full-text search |
| Reminders | Native notifications, repeating |
| Goals + Weekly | Long-term goals, weekly review |
| Finance | Income/expense by category, monthly P&L |
| Captures | Voice/text notes with AI extraction |
| Memory | Henry learns facts from conversation, forever |
| Recorder | Meeting recording & transcription |

## Computer Control

From chat or the computer panel:

```
"Create a folder called Work on my Desktop"
"Open Chrome and go to gmail.com"
"Take a screenshot"  ·  "What apps are running?"  ·  "Set volume to 50"
```

## Mobile Companion

Open `http://[your-computer-ip]:4242` on any phone or tablet: full chat with voice input, remote commands, live screen view. Works anywhere via the auto-started Cloudflare tunnel; devices pair once and reconnect automatically.

## The Iron Gateway

Every chat request routes to the cheapest capable AI:

| What you say | How it's handled | Cost |
|---|---|---|
| "Hi", "thanks", time, math | Local — no API | **$0.00** |
| Simple questions | Groq 8b-instant | **$0.05/1M tokens** |
| Writing, analysis, deep work | Groq 70b-versatile | **$0.59/1M tokens** |
| Coding | Claude Code (your subscription) or local | **$0 marginal** |
| Voice in/out | whisper.cpp + system voice | **$0.00** |
| Image generation | DALL-E 3 (optional key) | $0.04/image |

## Self-Repair

Henry checks and fixes himself on every launch: cloudflared, ffmpeg, yt-dlp, and whisper-cpp auto-install through the platform's package manager (Homebrew on macOS, apt on Linux, winget then Chocolatey on Windows); missing capabilities open the right settings app; missing keys tell you exactly where to add them.

## Installation

1. [Download the latest release](https://github.com/tophercook7-maker/henry-ai-desktop/releases/latest) and pick your platform:
   - **Linux x64:** `henry-ai_<version>_amd64.deb` (or the AppImage — just run it, no install)
   - **Windows x64 / arm64:** `Henry-AI-Setup-<version>-<arch>.exe`, or the portable `.exe`
   - **macOS (Apple Silicon or Intel):** `Henry AI-<version>.dmg` — drag Henry AI to Applications
2. Open Henry AI and follow the 60-second onboarding
3. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys) — no credit card

### From Source

```bash
git clone https://github.com/tophercook7-maker/henry-ai-desktop.git
cd henry-ai-desktop
npm install
npm run dev:electron
```

**Requirements:** a desktop OS (Linux x64, Windows x64, or macOS) · Node.js 20+ (source builds)

## Optional

- **Claude Code CLI** — best-in-class coding on your Claude subscription (`npm i -g @anthropic-ai/claude-code`)
- **opencode** — a second first-class Coder Engine with its own model catalogue, including the opencode zen gateway
- **Ollama** — free local chat + coding fallback
- **Anthropic / OpenAI keys** — Claude vision for the 3D generator, DALL-E 3 for images and covers
- **ElevenLabs key** — premium speaking voice (local voice works without it)
- **serialport** (one-time `npm i serialport && npm run rebuild`) — USB Marlin printers and GRBL CNC

## Architecture

```
Electron (main process)
├── coder/        — Claude Code CLI runner · opencode runner + loopback bridge · local Ollama fallback
├── machines/     — Bambu MQTT · Moonraker · OctoPrint · Marlin/GRBL serial
├── voice/        — whisper.cpp STT · say/ElevenLabs TTS · spoken greeting
├── ipc/
│   ├── syncBridge.ts          — mobile companion server :4242 + tunnel
│   ├── selfRepair.ts          — health checks, platform-aware auto-fix
│   ├── runtimeDiagnostics.ts  — startup/runtime failure reporting + StartupFailureBanner
│   ├── memoryGraph.ts         — memory:getGraph for the Memory Graph view
│   ├── marketplace.ts         — PrimeTech marketplace catalogue
│   ├── mediaLibrary.ts        — local media library (import, list, open, reveal, delete)
│   ├── opencodeBridge.ts      — OpenAI-compatible loopback over opencode
│   ├── scheduler.ts           — Routine/automation execution + run history (automation_runs, automation:*)
│   └── …                    — SQLite: tasks, journal, finance, memory, lessons, ...
└── python/        — bundled Python bridge (session store, proxy)

React (renderer)
├── henry/gateway.ts    — Iron Gateway cost router
├── henry/coverSpecs.ts — KDP trim/spine/bleed math
├── henry/appLinks.ts   — app deep links: intent → web URL to jump straight into another app
├── components/memory/MemoryGraphView.tsx — interactive memory graph
└── components/         — all panels

SQLite: <Electron userData>/henry-workspace/henry.db
```

## Building for Distribution

```bash
npm run build:linux      # AppImage + deb, x64              → release2/
npm run build:win        # NSIS + portable, x64              → release2/
npm run build:win:arm64  # NSIS, arm64                       → release2/
npm run build:mac        # signed DMG + zip, arm64 and x64   → release2/
```

## Auto-Update

Henry checks GitHub Releases every 4 hours and installs updates on next quit. No action required.

---

Built by [Topher Cook](https://github.com/tophercook7-maker) · MIT License
