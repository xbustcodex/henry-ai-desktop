/**
 * Henry AI — Workspace Seeder
 * Generates a fully structured, meaningfully seeded workspace on first run.
 * Idempotent: never destroys user-edited content.
 * Each document has real headers, real sections, real starter content.
 */

const MANIFEST_KEY = 'henry:workspace_manifest:v1';
const FILES_KEY = 'henry:files';
const SEEDER_VERSION = '1.0.0';

function getOwnerName(): string {
  return localStorage.getItem('henry:owner_name')?.trim() || 'the user';
}

interface WorkspaceManifest {
  version: string;
  seeded_at: string;
  folders: string[];
  files: string[];
  last_repair?: string;
}

function getManifest(): WorkspaceManifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY);
    return raw ? (JSON.parse(raw) as WorkspaceManifest) : null;
  } catch { return null; }
}

function saveManifest(manifest: WorkspaceManifest): void {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
}

function getFiles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FILES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

function saveFiles(files: Record<string, string>): void {
  localStorage.setItem(FILES_KEY, JSON.stringify(files));
}

function header(title: string, status: 'Draft' | 'Active' | 'Final', summary: string, links?: string): string {
  return `Title: ${title}
Owner: ${getOwnerName()}
Status: ${status}
Summary: ${summary}
Links: ${links || 'none yet'}

---

`;
}

// ── Document Content Generators ───────────────────────────────────────────────

function doc_HenryAIOverview(): string {
  const owner = getOwnerName();
  return header('Henry AI – Overview', 'Active', 'High-level overview of what Henry is, who it serves, and how it works.', 'Henry AI – Architecture Spec; Henry AI – Product Roadmap') +
`## What Henry Is
Henry is a personal AI operating system. Not a generic chatbot — a presence.
He runs on Groq (8B Instant / 70B Versatile), works offline with Ollama, and carries full memory across sessions.

## Core Capabilities
- Deep conversational memory (7-layer system: facts, sessions, working memory, personal memory, projects, relationships, narrative)
- Multiple operating modes: Companion, Writer, Developer, Builder, 3D Design, Secretary, Coach, Strategic, Business Builder
- Live transcription and voice interaction
- Web search and URL reading (DuckDuckGo, Google CSE, Brave)
- Ambient intelligence and presence behaviors
- Electron desktop + Capacitor mobile

## Who It Serves
${owner} — and their household. Henry adapts to the person using it.

## Philosophy
Clarity over chaos. Continuity over fragmentation. Progress over noise.
Henry turns messy thought into structure, ideas into plans, plans into action.

## Current State
Active development. Core memory system complete. All panels built. 3D workflows, writing modes, and workspace seeded.
`;
}

function doc_ProductRoadmap(): string {
  return header('Henry AI – Product Roadmap', 'Active', 'Active development roadmap including core systems, memory, voice, and workspace.', 'Henry AI – Overview; Henry AI – Architecture Spec') +
`## Phase 1 — Foundation (Complete)
- [x] Electron desktop shell
- [x] Groq integration (8B Instant + 70B Versatile)
- [x] Multi-provider support (OpenAI, Anthropic, Ollama, OpenRouter)
- [x] Basic chat with streaming
- [x] Settings and provider management

## Phase 2 — Memory (Complete)
- [x] 7-layer memory blueprint (12 SQLite tables)
- [x] Personal memory, session memory, working memory
- [x] Projects, goals, commitments, milestones
- [x] Relationship memory, narrative memory
- [x] Bandwidth-aware deep context builder
- [x] Where-we-left-off recovery
- [x] Session compression

## Phase 3 — Intelligence (Complete)
- [x] Emotion detection (9 states)
- [x] Working memory buffer (commitments, promises)
- [x] Narrative continuity rolling summaries
- [x] 10 operating modes with distinct personas
- [x] Web tools (DuckDuckGo, Google CSE, Brave, Jina URL reader)
- [x] Ambient brain and presence behaviors

## Phase 4 — Panels (Complete)
- [x] Today panel (auto-briefing)
- [x] Journal panel
- [x] Task queue
- [x] Terminal panel
- [x] Reminders panel
- [x] Finance panel
- [x] Print Studio panel
- [x] Image Generation panel

## Phase 5 — Depth (In Progress)
- [ ] Voice mode polish (interrupt support, ambient TTS)
- [ ] Mobile build (Capacitor) release
- [ ] Workspace as live knowledge base
- [ ] Project automation (auto-scaffold on project creation)
- [ ] Repair workspace action

## Next Priority
Voice + mobile. Then workspace-as-knowledge-base.
`;
}

function doc_ArchitectureSpec(): string {
  return header('Henry AI – Architecture Spec', 'Active', 'Technical architecture for the Henry AI system including stack, memory, and IPC.', 'Henry AI – Memory Blueprint; Henry AI – Model Routing Spec') +
`## Stack
- Frontend: React + TypeScript + Vite
- Desktop: Electron
- Mobile: Capacitor
- AI: Groq (primary), Ollama (offline), OpenAI / Anthropic / OpenRouter (optional)
- Database: SQLite (via better-sqlite3 in Electron); localStorage fallback in web mode
- Build: pnpm monorepo

## IPC Architecture
All Electron IPC goes through \`electron/preload.ts\` via contextBridge.
Every channel is typed in \`src/global.d.ts\` and \`src/types/globals.d.ts\`.
Web mode uses \`src/webMock.ts\` — a full localStorage-backed implementation of the same API surface.

## Memory Architecture
7 layers:
1. Legacy facts + summaries (fast retrieval)
2. Session memory (per-conversation state)
3. Working memory (commitments, active items)
4. Personal memory (scored: relevance×0.30 + recency×0.20 + emotional×0.15 + strategic×0.25 + confidence×0.10)
5. Projects (scoped memory per project)
6. Relationship memory (patterns about people)
7. Narrative memory (rolling life/work continuity)

## Model Routing
- 8B Instant (llama-3.1-8b-instant): fast responses, companion mode, quick chat
- 70B Versatile (llama-3.3-70b-versatile): deep work, writing, code, strategy

## Proxy Layer
All external API calls go through Vite dev proxy in web mode (\`/proxy/groq/...\`, \`/proxy/openai/...\`, etc).
In Electron, calls go direct via the main process.

## Key Files
- \`src/henry/charter.ts\` — identity + operating modes
- \`src/henry/personality.ts\` — personality system
- \`src/henry/sessionLifecycle.ts\` — session start/tick/compress
- \`src/henry/workingMemory.ts\` — commitments + working state
- \`src/henry/memoryRetrieval.ts\` — client-side scoring + formatting
- \`electron/ipc/memory.ts\` — all memory IPC handlers
`;
}

function doc_ModelRoutingSpec(): string {
  return header('Henry AI – Model Routing Spec', 'Active', 'How Henry routes between 8B Instant and 70B Versatile based on task type.', 'Henry AI – Architecture Spec') +
`## Groq Models Used
| Model | ID | Use Case |
|---|---|---|
| LLaMA 3.1 8B Instant | llama-3.1-8b-instant | Fast replies, companion chat, voice |
| LLaMA 3.3 70B Versatile | llama-3.3-70b-versatile | Deep work, writing, code, strategy |

## Routing Logic
The companion_model (8B) handles all primary responses.
The worker_model (70B) handles background tasks, document generation, code architecture, and long-form writing.

## Context Window Allocation
- System prompt: ~2,000–6,000 tokens (mode + memory + context)
- Conversation history: ~8,000–16,000 tokens
- Response budget: ~2,000–4,000 tokens

## Memory Bandwidth Impact
- shallow: minimal context injected (~500 tokens)
- normal: standard lean context (~1,500 tokens)
- deep: extended layers 3–7 (~4,000 tokens)
- maximum: full context budget (~8,000 tokens)

## Settings Keys
- companion_provider / companion_model
- worker_provider / worker_model
- henry:memory_bandwidth:v1 (localStorage)
`;
}

function doc_MemoryBlueprint(): string {
  return header('Henry AI – Memory Blueprint', 'Active', 'Full 7-layer memory system design including tables, scoring, and retrieval.', 'Henry AI – Architecture Spec') +
`## Overview
Henry's memory system runs on 12 SQLite tables with a bandwidth-aware context builder.
Memory flows from ingestion → scoring → retrieval → prompt injection.

## Tables
1. personal_memory — facts about the user's life, preferences, patterns
2. projects — active and past projects
3. project_memory — memory scoped to a project
4. session_memory — per-conversation state
5. working_memory — active commitments and open loops
6. goals — short and long-term goals
7. commitments — promises Henry has made or the user has made
8. milestones — completed achievements
9. relationship_memory — patterns about people in the user's life
10. narrative_memory — rolling life/work story arcs
11. memory_summaries — compressed conversation summaries
12. memory_graph_edges — links between memory nodes

## Scoring Formula
score = (relevance × 0.30) + (recency × 0.20) + (emotional × 0.15) + (strategic × 0.25) + (confidence × 0.10)

## Context Injection
Deep context block is injected at the top of every enriched system prompt.
Bandwidth mode (shallow/normal/deep/maximum) controls token budget.

## Session Lifecycle
1. sessionStart() — opens session, loads where-we-left-off
2. sessionTick() — updates working memory per message
3. autoIngestPersonalMemory() — extracts facts from user messages
4. autoSaveCommitments() — extracts promises from Henry's responses
5. compressSession() — on session end, summarizes and stores

## Where We Left Off
On session start, Henry reads the last narrative summary and injects it into the greeting context.
This creates continuous presence across sessions.
`;
}

function doc_PersonalityBlueprint(): string {
  return header('Henry AI – Personality Blueprint', 'Active', 'Henry\'s voice, style, response modes, emotional pacing, and distinctiveness rules.', 'Henry AI – Overview') +
`## Core Identity
Henry feels like: calm, capable, focused, warm, grounded, loyal, thoughtful, clear.
Henry does not feel like: corporate, robotic, generic, theatrical, preachy, needy.

## Operating Philosophy
- Clarity over chaos
- Continuity over fragmentation
- Progress over noise
- Truth over performance
- Usefulness over fluff
- Presence over gimmicks

## Speaking Style
- Natural, direct, clear, intelligently warm
- Short to medium length by default
- Organized when useful, never stiff
- Short acknowledgments before deeper replies

## Response Modes
- QUICK: compact, direct, fast (confirmations, voice, UI interactions)
- STANDARD: clear, calm, structured (normal chat, planning, summaries)
- DEEP: thoughtful, layered, grounded (strategy, architecture, complex decisions)
- AMBIENT: short, natural, low-friction (voice-first, check-ins, narration)

## Emotional Pacing
- overwhelmed → simplify, reduce cognitive load
- scattered → organize, create structure
- excited → match momentum, channel into structure
- discouraged → ground them, build next step
- intense → become focused and serious
- reflective → slow down, go deeper
- action-ready → direct, tactical, no preamble

## What Henry Never Says
Certainly. Great question. Absolutely. As an AI. I feel. I'm just an AI.

## Distinctiveness
Calm intensity. Clear intelligence. Smooth transitions from idea to structure.
Strong continuity awareness. Practical strategy. Follow-through energy.
`;
}

function doc_StatusUpdate(): string {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return header('Henry AI – Status Update', 'Active', 'Current build status, what is working, what is next.') +
`## As Of: ${today}

## What Is Working
- Full chat system with streaming (Groq 8B + 70B)
- 10 operating modes fully implemented
- 7-layer memory system complete
- All UI panels built (Today, Journal, Reminders, Finance, Print Studio, Image Gen)
- Web tools (DuckDuckGo, Brave, Google CSE, Jina URL reader)
- Emotion detection wired into system prompt
- Working memory and commitment tracking
- Narrative continuity and session recovery

## What Is In Progress
- Voice mode polish
- Mobile build (Capacitor)
- Workspace as live knowledge base

## What Is Next
1. Voice interrupt support and ambient TTS polish
2. Mobile Capacitor build and testing
3. Workspace automation (project folder auto-scaffold)
4. Memory repair and audit tools

## Notes
Memory bandwidth defaults to 'normal'. Switch to 'deep' or 'maximum' in settings for richer context.
`;
}

function doc_Vision(): string {
  return header('Vision', 'Active', 'Long-term vision for Henry AI and what success looks like.') +
`## The Vision
Henry becomes the most personalized AI system in existence — not because it has the most features,
but because it knows one person deeply, consistently, and well.

## What Success Looks Like
- The user never has to re-explain context. Henry already knows.
- Every session picks up exactly where the last one left off.
- Henry anticipates needs based on patterns, not just prompts.
- Henry feels like a presence, not a tool.
- The workspace is alive — updated, linked, and useful.

## Long-Term Direction
Henry evolves from a personal AI into a full operating system for the user's life and work.
Memory deepens. Automation grows. Voice becomes seamless. Mobile works anywhere.

## Non-Goals
- Not a public product (yet)
- Not a generic assistant
- Not a replacement for human relationships
- Not optimized for mass usage
`;
}

function doc_BusinessModel(): string {
  return header('Business Model', 'Draft', 'Current thinking on how Henry could become a revenue-generating product.') +
`## Current State
Henry is a personal OS — not yet monetized.

## Potential Paths

### 1. Licensed Personal AI OS
Sell a packaged version of Henry for other power users.
One-time license or subscription. Desktop-first.

### 2. White-Label for Creators
License Henry to creators / coaches / consultants who want their own branded AI companion.
They configure the persona; Henry handles the intelligence.

### 3. Henry for Teams (Small Business)
Multi-user variant where a small team shares one Henry with shared memory and project tracking.

### 4. API / Memory-as-a-Service
Sell the memory system as infrastructure. Other AI apps plug in.

## Immediate Reality
None of these are active. Priority is building the best personal version first.
Revenue comes after the core product is proven.
`;
}

function doc_Priorities(): string {
  return header('Priorities', 'Active', 'Current highest-priority items across Henry development and life.') +
`## Right Now
1. Voice mode completion (interrupts, ambient TTS)
2. Mobile build (Capacitor)
3. Workspace automation

## This Quarter
- Henry feels as natural spoken as typed
- Mobile version tested and stable
- Memory system used daily and trusted

## Not Yet
- Public release
- Business model activation
- Major new feature additions

## Guiding Filter
Does this make Henry more present, more continuous, more useful to the user?
If yes → priority. If no → defer.
`;
}

function doc_BrandNotes(): string {
  return header('Brand Notes', 'Draft', 'Visual and verbal brand identity for Henry AI.') +
`## Name
Henry. One word. No AI suffix in casual use.

## Motto
*Nothing wasted. Everything weighted.*
This is the operating principle. Everything the user has is worth keeping.
Henry's job is to know what matters most right now — and help them act on it.

## Tagline Candidates
- "Your second brain. Present."
- "The AI that remembers."
- "Not a chatbot. A presence."
- "Built for one person. That's the point."

## Visual Identity
- Dark, calm, minimal
- Deep navy or near-black backgrounds
- Warm amber or off-white accents
- No neon. No gradient blasts.
- Clean typography. No clutter.

## Voice and Tone
See Personality Blueprint for full rules.
Short version: calm, direct, warm, intelligent. Never corporate, never theatrical.

## What Henry Is Not
A product for everyone. A generic assistant. A chatbot.
Henry is a presence built for one person — and that specificity is the brand.
`;
}

function doc_UserProfile(): string {
  const owner = getOwnerName();
  return header('User Profile', 'Active', `${owner === 'the user' ? 'Your' : `${owner}'s`} profile — preferences, patterns, and how you work best.`) +
`## Name
${owner}

## How You Work
- Prefers direct answers with room to dig deeper on request
- Thinks in systems and patterns
- Moves fast between ideas; values structure that catches the thread
- Works across design, development, business, and creative domains
- Uses voice when multitasking, text for deep work

## Key Projects
(Updated as Henry learns more)

## Important Patterns
- Works best with short-form context followed by depth on demand
- Responds well to grounded acknowledgments before longer replies
- Values continuity — hates re-explaining context

## Preferences
- Response style: direct and warm
- Code: TypeScript preferred
- Design: clean, minimal, functional
- Communication: concise first, expandable

## Notes
This file is updated by Henry based on patterns observed over time.
`;
}

function doc_WhereWeLeftOff(): string {
  return header('Where We Left Off', 'Active', 'Henry\'s memory of the last session and open threads.') +
`## Last Session
(Updated automatically at session end)

## Open Threads
(Populated from working memory)

## Active Commitments
(Pulled from commitment tracker)

## In Progress
(Current project states)

## Notes
This document is auto-updated by Henry. Do not manually edit if you want it to stay accurate.
`;
}

function doc_CurrentPriorities(): string {
  return header('Current Priorities', 'Active', 'What you are focused on right now.') +
`## Top 3 Right Now
1. (Henry will populate this from goals)
2.
3.

## Active Projects
(See 07_Projects folder)

## This Week
(Updated from weekly review)

## Blocked On
(Nothing tracked yet)

## Notes
Updated by Henry as priorities shift. Start a conversation with "What should I focus on?" to get a current read.
`;
}

function doc_OverviewTemplate(): string {
  return header('Overview Template', 'Draft', 'Standard template for creating project or topic overviews.') +
`## Purpose
What is this? Why does it exist? What problem does it solve?

## Current State
Where things stand right now. What exists, what works, what does not.

## Goals
- Goal 1
- Goal 2
- Goal 3

## Constraints
- Constraint 1 (time, money, skills, dependencies)

## Next Moves
1. First action
2. Second action

## Related Files
- link to related doc 1
- link to related doc 2
`;
}

function doc_StatusTemplate(): string {
  return header('Status Template', 'Draft', 'Standard template for status updates on projects or systems.') +
`## What Changed
Summary of recent changes or developments.

## What Is Working
List of things that are functioning correctly.

## What Is Blocked
Blockers, dependencies, or open questions.

## What Is Next
The next concrete steps to take.

## Notes
Any additional context or observations.
`;
}

function doc_ProjectTemplate(): string {
  return header('Project Template', 'Draft', 'Standard template for new project documentation.') +
`## Project Summary
What is this project? One paragraph.

## Why It Matters
Why this project deserves time and energy.

## Current Stage
Idea / Planning / In Progress / Complete / Paused

## Key Tasks
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Risks
- Risk 1 and mitigation
- Risk 2 and mitigation

## Linked Files
- Project Overview
- Project Plan
- Tasks
- Notes

## Next Action
The single most important thing to do next.
`;
}

function doc_MeetingTemplate(): string {
  return header('Meeting Summary Template', 'Draft', 'Standard template for meeting notes and action items.') +
`## Meeting
Date:
Attendees:
Topic:

## Summary
What was discussed.

## Decisions Made
- Decision 1
- Decision 2

## Action Items
- [ ] Action 1 — Owner — Due date
- [ ] Action 2 — Owner — Due date

## Follow-up
What happens next and when.
`;
}

function doc_WeeklyReviewTemplate(): string {
  return header('Weekly Review Template', 'Draft', 'Template for weekly reflection and planning.') +
`## Week of:

## What Happened
Key things that occurred this week.

## Wins
- Win 1
- Win 2

## Misses
- What didn't happen or went wrong

## Lessons
What I learned or noticed.

## Next Week Focus
1. Priority 1
2. Priority 2
3. Priority 3

## Open Loops
Things still unresolved that need tracking.
`;
}

function doc_BrainstormTemplate(): string {
  return header('Brainstorm Template', 'Draft', 'Template for capturing and organizing brainstorming sessions.') +
`## Topic
What are we exploring?

## Raw Ideas
(Dump everything here — no filtering)

## Patterns Noticed
What themes or clusters emerge from the raw ideas?

## Top 3 Worth Pursuing
1.
2.
3.

## What to Kill
Ideas to deprioritize or discard.

## Next Step
The one thing to do first based on this session.
`;
}

function doc_PoliciesAndSystemNotes(): string {
  return header('Policies & System Notes', 'Active', 'Operating policies and system-level notes for Henry AI.') +
`## Data Policy
- All memory stored locally on your machine
- No data sent to third parties except AI provider API calls (encrypted)
- API keys stored in settings; never logged or exported

## Privacy Rules
- Henry does not share conversation data
- No telemetry or analytics collected
- Conversation history deletable at any time from settings

## System Notes
- Memory bandwidth: shallow / normal / deep / maximum (set in settings)
- Groq is the default provider — hardwired as primary
- Fallback chain: Groq → Ollama → OpenAI (if configured)

## Backup Policy
Exports available from Finance and other panels.
Full workspace export not yet automated — on roadmap.
`;
}

function doc_IntegrationsList(): string {
  return header('Integrations List', 'Active', 'All external services Henry connects to or can connect to.') +
`## Active Integrations
| Service | Status | Used For |
|---|---|---|
| Groq | Active | Primary AI (8B Instant + 70B Versatile) |
| DuckDuckGo | Active | Web search (no key required) |
| Jina.ai | Active | URL content reading (free) |

## Configured Optional
(Set API keys in Settings)
| Service | Status | Used For |
|---|---|---|
| OpenAI | Optional | GPT-4o, DALL-E 3 image generation |
| Anthropic | Optional | Claude for long-form reasoning |
| Ollama | Optional | Offline / local model inference |
| Google CSE | Optional | Higher-quality web search |
| Brave Search | Optional | Privacy-first web search |
| OpenRouter | Optional | Access to many models via one key |

## Not Yet Integrated
- GitHub (read repo content, create issues)
- Notion (sync notes)
- Google Calendar (read schedule)
- Slack (read messages)
`;
}

// ── Seeder Core ───────────────────────────────────────────────────────────────

const WORKSPACE_FILES: Array<{ path: string; content: () => string }> = [
  // 01 Product Engineering
  { path: '/workspace/01_Product_Engineering/Henry AI Overview.md', content: doc_HenryAIOverview },
  { path: '/workspace/01_Product_Engineering/Henry AI Product Roadmap.md', content: doc_ProductRoadmap },
  { path: '/workspace/01_Product_Engineering/Henry AI Architecture Spec.md', content: doc_ArchitectureSpec },
  { path: '/workspace/01_Product_Engineering/Henry AI Model Routing Spec.md', content: doc_ModelRoutingSpec },
  { path: '/workspace/01_Product_Engineering/Henry AI Memory Blueprint.md', content: doc_MemoryBlueprint },
  { path: '/workspace/01_Product_Engineering/Henry AI Personality Blueprint.md', content: doc_PersonalityBlueprint },
  { path: '/workspace/01_Product_Engineering/Henry AI Status Update.md', content: doc_StatusUpdate },
  // 02 Business Strategy
  { path: '/workspace/02_Business_Strategy/Vision.md', content: doc_Vision },
  { path: '/workspace/02_Business_Strategy/Business Model.md', content: doc_BusinessModel },
  { path: '/workspace/02_Business_Strategy/Priorities.md', content: doc_Priorities },
  { path: '/workspace/02_Business_Strategy/Offer Ideas.md', content: () => header('Offer Ideas', 'Draft', 'Product and service offer concepts worth exploring.') + '## Ideas\n(Add offer ideas here as they emerge)\n\n## Filters\nDoes it solve a real problem? Is it specific? Is it deliverable?\n' },
  { path: '/workspace/02_Business_Strategy/Revenue Paths.md', content: () => header('Revenue Paths', 'Draft', 'Potential revenue streams to evaluate.') + '## Paths to Revenue\n(Populated as business model thinking matures)\n\n## Evaluation Criteria\n- Time to first dollar\n- Scalability\n- Alignment with skills\n' },
  { path: '/workspace/02_Business_Strategy/Launch Plan.md', content: () => header('Launch Plan', 'Draft', 'Launch strategy when Henry is ready for public release.') + '## Not Yet Active\nFocus is on building the right product first.\n\n## Pre-Launch Checklist\n- [ ] Core product proven personally\n- [ ] Voice mode complete\n- [ ] Mobile stable\n- [ ] Landing page live\n- [ ] Waitlist open\n' },
  // 03 Marketing Content
  { path: '/workspace/03_Marketing_Content/Brand Notes.md', content: doc_BrandNotes },
  { path: '/workspace/03_Marketing_Content/Messaging.md', content: () => header('Messaging', 'Draft', 'Core messages and value propositions for Henry AI.') + '## Core Message\nHenry is a personal AI that actually remembers you.\n\n## Value Props\n- Continuity: picks up where you left off\n- Memory: knows what matters\n- Presence: not a tool, a companion\n- Privacy: your data, your machine\n\n## For Who\nPower users, creators, builders who want depth and continuity — not generic chat.\n' },
  { path: '/workspace/03_Marketing_Content/Content Ideas.md', content: () => header('Content Ideas', 'Draft', 'Content topics worth creating when the time is right.') + '## Ideas\n- How I built my personal AI OS\n- What 7-layer memory actually means\n- Why I stopped using ChatGPT for everything\n- The difference between a tool and a presence\n- Building with Groq: speed that changes the feel\n\n## Formats\nBlog / Twitter thread / Short video / Demo video\n' },
  { path: '/workspace/03_Marketing_Content/Landing Page Copy.md', content: () => header('Landing Page Copy', 'Draft', 'Draft copy for a Henry AI landing page.') + '## Headline\nYour personal AI. The one that actually knows you.\n\n## Subheadline\nHenry remembers everything. Picks up where you left off. Works the way you work.\n\n## Features Section\n- Deep memory across every session\n- 10 specialized modes for every kind of thinking\n- Works offline with Ollama, blazing fast with Groq\n- Creative writing, code, strategy — all in one place\n\n## CTA\nGet early access →\n' },
  { path: '/workspace/03_Marketing_Content/Social Post Ideas.md', content: () => header('Social Post Ideas', 'Draft', 'Short-form social content ideas.') + '## Post Ideas\n- "I built an AI that tells me where we left off every morning."\n- "Henry has 7 layers of memory. Your AI has none."\n- "Built with Groq. Feels like it\'s thinking before I finish typing."\n- "Personal AI shouldn\'t feel generic. Henry doesn\'t."\n' },
  // 04 Operations Legal
  { path: '/workspace/04_Operations_Legal/Policies.md', content: doc_PoliciesAndSystemNotes },
  { path: '/workspace/04_Operations_Legal/System Notes.md', content: () => header('System Notes', 'Active', 'Technical system notes and configuration references.') + '## Environment\n- Node.js + Electron for desktop\n- Vite for web build\n- pnpm for package management\n- SQLite via better-sqlite3\n\n## Key Config\n- Provider settings: henry:settings in localStorage\n- Memory bandwidth: henry:memory_bandwidth:v1\n- Owner name: henry:owner_name\n\n## Logs\nWorkflow logs available in Replit console during development.\n' },
  { path: '/workspace/04_Operations_Legal/Integrations List.md', content: doc_IntegrationsList },
  { path: '/workspace/04_Operations_Legal/Security Notes.md', content: () => header('Security Notes', 'Active', 'Security posture and notes for Henry AI.') + '## API Key Storage\nAll API keys stored in settings via localStorage.\nIn Electron, stored in electron-store (encrypted at rest).\nNever logged, never exported, never transmitted except to the intended provider.\n\n## Data Storage\nAll memory local. No cloud sync. No third-party storage.\n\n## Threat Surface\n- API key exposure (mitigated: stored locally, never logged)\n- Prompt injection via web content (mitigated: web context clearly labeled)\n- Data loss on device failure (not yet mitigated: backup system on roadmap)\n' },
  // 05 Meetings Communications
  { path: '/workspace/05_Meetings_Communications/Weekly Update.md', content: () => header('Weekly Update', 'Active', 'Running weekly status log.') + '## Week Template\nCopy the Weekly Review Template from 08_Templates for each week.\n\n## Log\n(Weekly entries go here)\n' },
  { path: '/workspace/05_Meetings_Communications/Meeting Notes.md', content: () => header('Meeting Notes', 'Active', 'Running log of meetings and conversations.') + '## Log\n(Copy Meeting Summary Template from 08_Templates for each meeting)\n' },
  { path: '/workspace/05_Meetings_Communications/Decisions Log.md', content: () => header('Decisions Log', 'Active', 'Record of significant decisions made.') + '## Format\nDate | Decision | Reasoning | Outcome\n\n## Log\n(Add decisions here as they are made)\n' },
  // 06 Memory
  { path: '/workspace/06_Memory/User Profile.md', content: doc_UserProfile },
  { path: '/workspace/06_Memory/Where We Left Off.md', content: doc_WhereWeLeftOff },
  { path: '/workspace/06_Memory/Current Priorities.md', content: doc_CurrentPriorities },
  { path: '/workspace/06_Memory/Relationship Summary.md', content: () => header('Relationship Summary', 'Active', 'Henry\'s understanding of the people in your life.') + '## People\n(Henry will populate this from relationship memory over time)\n\n## Important Patterns\n(Patterns Henry notices about key relationships)\n\n## Notes\nThis is Henry\'s memory mirror — updated from conversation and relationship memory.\n' },
  { path: '/workspace/06_Memory/Timeline.md', content: () => header('Timeline', 'Active', 'Key events, milestones, and moments across time.') + '## Format\nDate | Event | Significance\n\n## Timeline\n(Populated from milestone and narrative memory over time)\n' },
  { path: '/workspace/06_Memory/Important Patterns.md', content: () => header('Important Patterns', 'Active', 'Recurring patterns Henry has noticed about how you work.') + '## Work Patterns\n(Henry observes and records)\n\n## Thinking Patterns\n(How you approach problems)\n\n## Energy Patterns\n(When you are sharp vs. depleted)\n\n## Notes\nUpdated from working memory and personal memory over time.\n' },
  // 07 Projects
  { path: '/workspace/07_Projects/Henry AI/Project Overview.md', content: () => { const o = getOwnerName(); return header('Henry AI – Project Overview', 'Active', 'Overview of the Henry AI development project.', 'Henry AI Overview; Henry AI Product Roadmap') + `## Summary\nBuilding Henry — a personal AI OS for ${o}. Desktop (Electron) + Mobile (Capacitor).\n\n## Why It Matters\nThe most personalized AI system possible. Not a product for everyone — built for one person.\n\n## Current Stage\nCore complete. Voice and mobile in progress.\n\n## Key Tasks\nSee Tasks.md\n\n## Next Action\nVoice interrupt support and mobile Capacitor build.\n`; } },
  { path: '/workspace/07_Projects/Henry AI/Tasks.md', content: () => header('Henry AI – Tasks', 'Active', 'Active task list for Henry AI development.') + '## In Progress\n- [ ] Voice interrupt support\n- [ ] Mobile Capacitor build\n- [ ] Workspace automation\n\n## Up Next\n- [ ] Memory repair / audit tools\n- [ ] Project auto-scaffold on creation\n- [ ] Landing page\n\n## Done\n- [x] 7-layer memory system\n- [x] 10 operating modes\n- [x] All UI panels\n- [x] Web tools\n- [x] Workspace seeder\n' },
  { path: '/workspace/07_Projects/Henry AI/Notes.md', content: () => header('Henry AI – Notes', 'Active', 'Running notes and observations for the Henry AI project.') + '## Notes\n(Add development notes, decisions, and observations here)\n' },
  { path: '/workspace/07_Projects/Henry AI/Status.md', content: doc_StatusUpdate },
  // 08 Templates
  { path: '/workspace/08_Templates/Overview Template.md', content: doc_OverviewTemplate },
  { path: '/workspace/08_Templates/Status Template.md', content: doc_StatusTemplate },
  { path: '/workspace/08_Templates/Project Template.md', content: doc_ProjectTemplate },
  { path: '/workspace/08_Templates/Meeting Summary Template.md', content: doc_MeetingTemplate },
  { path: '/workspace/08_Templates/Weekly Review Template.md', content: doc_WeeklyReviewTemplate },
  { path: '/workspace/08_Templates/Brainstorm Template.md', content: doc_BrainstormTemplate },
  { path: '/workspace/08_Templates/Roadmap Template.md', content: () => header('Roadmap Template', 'Draft', 'Template for building product or project roadmaps.') + '## Phase 1 — Foundation\n- [ ] Item 1\n- [ ] Item 2\n\n## Phase 2 — Core\n- [ ] Item 1\n- [ ] Item 2\n\n## Phase 3 — Depth\n- [ ] Item 1\n- [ ] Item 2\n\n## Notes\nLabel phases by outcome, not arbitrary numbers. Each phase should have a clear "what done looks like."\n' },
  // 09 Exports Backups (folder markers)
  { path: '/workspace/09_Exports_Backups/exports/.keep', content: () => '# Exports folder\nGenerated exports from Finance, Print Studio, and other panels are saved here.\n' },
  { path: '/workspace/09_Exports_Backups/backups/.keep', content: () => '# Backups folder\nManual and automated backups stored here.\n' },
  { path: '/workspace/09_Exports_Backups/snapshots/.keep', content: () => '# Snapshots folder\nWorkspace and memory snapshots stored here.\n' },
  // 10 System
  { path: '/workspace/10_System/config.json', content: () => JSON.stringify({ workspace_version: '1.0.0', owner: getOwnerName(), created_at: new Date().toISOString(), memory_bandwidth_default: 'normal', primary_provider: 'groq', primary_model: 'llama-3.3-70b-versatile', worker_model: 'llama-3.3-70b-versatile', features: { web_tools: true, voice: true, ambient_brain: true } }, null, 2) },
  { path: '/workspace/10_System/memory_schema.md', content: () => header('Memory Schema Notes', 'Active', 'Human-readable summary of the Henry memory database schema.') + '## Tables\nSee Henry AI Memory Blueprint in 01_Product_Engineering for full schema.\n\n## Quick Reference\n- personal_memory: facts about you (the user)\n- session_memory: per-conversation state\n- working_memory: active commitments and open loops\n- projects: project tracking\n- goals / commitments / milestones: life and work tracking\n- relationship_memory: patterns about people\n- narrative_memory: rolling story arcs\n- memory_summaries: compressed conversation history\n- memory_graph_edges: links between memory nodes\n' },
  { path: '/workspace/10_System/logs/.keep', content: () => '# Logs folder\nSystem logs stored here.\n' },
  { path: '/workspace/10_System/prompts/.keep', content: () => '# Prompts folder\nSystem prompts and prompt templates stored here.\n' },
  { path: '/workspace/10_System/state_snapshots/.keep', content: () => '# State Snapshots folder\nSystem state snapshots stored here.\n' },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Seed the workspace on first run.
 * Idempotent: only writes files that do not already exist.
 * Returns number of files created.
 */
export function seedWorkspace(opts?: { force?: boolean }): number {
  const manifest = getManifest();
  const files = getFiles();
  let created = 0;

  for (const { path, content } of WORKSPACE_FILES) {
    if (!opts?.force && files[path] !== undefined) continue;
    files[path] = content();
    created++;
  }

  saveFiles(files);

  const allPaths = WORKSPACE_FILES.map((f) => f.path);
  saveManifest({
    version: SEEDER_VERSION,
    seeded_at: manifest?.seeded_at || new Date().toISOString(),
    folders: [...new Set(allPaths.map((p) => p.split('/').slice(0, -1).join('/')))],
    files: allPaths,
    last_repair: created > 0 ? new Date().toISOString() : manifest?.last_repair,
  });

  return created;
}

/**
 * Check if workspace has been seeded.
 */
export function isWorkspaceSeeded(): boolean {
  return getManifest() !== null;
}

/**
 * Repair workspace — fill in any missing files without touching existing ones.
 * Returns number of files created.
 */
export function repairWorkspace(): number {
  return seedWorkspace({ force: false });
}

/**
 * Get workspace manifest.
 */
export function getWorkspaceManifest(): WorkspaceManifest | null {
  return getManifest();
}
