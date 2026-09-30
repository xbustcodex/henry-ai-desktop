/**
 * Henry Local Router — answers common queries from SQLite without touching AI.
 *
 * The cost-efficiency engine. When the user types something Henry can answer
 * from his own database, we skip Groq entirely. Saves tokens, saves money,
 * answers instantly, works offline.
 *
 * Pattern → SQL/IPC → formatted markdown reply.
 *
 * Returns:
 *   - { handled: true, reply: string }  → bypass AI, render `reply` as Henry's answer
 *   - { handled: false }                 → fall through to the normal AI pipeline
 *
 * Add a new intent: append a Handler to INTENTS. Each handler tests the query
 * and (if matched) returns a formatted string. Order matters — first match wins.
 */

import { PANELS, SHORTCUTS, POWER_TIPS, findPanelsByKeyword } from './henrySelfKnowledge';
import { buildSelfReport, logFeatureGap, trackUsage, learnPref, getLearnedPrefs } from './selfAssessment';

type Handler = {
  name: string;
  match: (q: string) => boolean;
  run: () => Promise<string | null>;
};

export interface LocalRouteResult {
  handled: boolean;
  reply?: string;  intentName?: string;
}

function api(): Record<string, (...args: unknown[]) => Promise<unknown>> | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { henryAPI?: Record<string, (...args: unknown[]) => Promise<unknown>> }).henryAPI || null;
}

function thisMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtMoney(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function fmtMinutes(m: number | null | undefined): string {
  const mins = Number(m) || 0;
  if (mins < 60) return `${Math.round(mins)} min`;
  const hours = Math.floor(mins / 60);
  const r = Math.round(mins % 60);
  return r ? `${hours}h ${r}m` : `${hours}h`;
}

// ── Pattern test helpers ────────────────────────────────────────────────────
const re = (...pats: RegExp[]) => (q: string) => pats.some(p => p.test(q));

// ── Intents ─────────────────────────────────────────────────────────────────
const INTENTS: Handler[] = [

  // What AI are you using? / What models? / What providers?
  {
    name: 'ai_provider_status',
    match: re(
      /what (ai|model|provider|brain|engine|llm).*(are you|do you|using|set|configured)/i,
      /which (ai|model|provider|brain|engine|llm).*(are you|do you|using)/i,
      /what.*(are you|you) (using|running|on|powered by)/i,
      /what.*your (ai|model|brain|engine)/i,
      /are you using (groq|gemini|openai|claude|ollama)/i,
    ),
    run: async () => {
      const settings = (() => {
        try { return JSON.parse(localStorage.getItem('henry:settings') || '{}'); } catch { return {}; }
      })();
      const providers = (() => {
        try { return JSON.parse(localStorage.getItem('henry:providers') || '[]') as Array<{id:string;apiKey?:string;api_key?:string;enabled?:boolean}>; } catch { return []; }
      })();

      const brain1Model = settings.companion_model || 'llama-3.3-70b-versatile';
      const brain1Provider = settings.companion_provider || 'groq';
      const brain2Model = settings.worker_model || brain1Model;
      const brain2Provider = settings.worker_provider || brain1Provider;
      const coderModel = 'qwen-2.5-coder-32b';

      const hasGroq = providers.some(p => p.id === 'groq' && (p.apiKey || p.api_key));
      const hasGoogle = providers.some(p => p.id === 'google' && (p.apiKey || p.api_key));
      const hasCerebras = !!localStorage.getItem('henry:cerebras_api_key');

      const lines = [
        `Here's my actual AI setup right now:`,
        ``,
        `**Brain 1 (every conversation):** ${brain1Model} via ${brain1Provider}`,
        `**Brain 2 (heavy tasks):** ${brain2Model} via ${brain2Provider}`,
        `**Coder brain (auto for code):** ${coderModel} via Groq`,
        ``,
        `**Keys I have:**`,
        `• Groq: ${hasGroq ? '✓ configured' : '✗ not set — go to Settings → AI Providers'}`,
        `• Google Gemini: ${hasGoogle ? '✓ configured' : '✗ not set — free at aistudio.google.com'}`,
        `• Cerebras fallback: ${hasCerebras ? '✓ configured' : '✗ not set (optional)'}`,
      ];

      if (!hasGroq && !hasGoogle) {
        lines.push(``, `You're running on Henry's shared free tier (50 requests/day). Add a Groq key in Settings → AI Providers for unlimited free responses.`);
      }

      return lines.join('\n');
    },
  },


  // ── Self-knowledge intents ─────────────────────────────────────────────

  // "what can you do" / "help" / "how do I use you"
  {
    name: 'what_can_you_do',
    match: re(
      /^help$/i, /^what can you do/i, /how do i use (henry|you)/i,
      /what (do you|can you|are you able to) do/i,
      /show me (what|how|your) (you can|features|capabilities)/i,
      /what (features|panels|sections) (do you have|are there)/i,
      /give me a tour/i, /overview of henry/i,
    ),
    run: async () => {
      const lines = [
        `Here's everything I can do:
`,
        ...PANELS.slice(0, 10).map(p => `**${p.icon} ${p.name}** — ${p.shortDesc}`),
        `
...and ${PANELS.length - 10} more panels in the sidebar.
`,
        `**Shortcuts:**`,
        ...SHORTCUTS.slice(0, 3).map(s => `• **${s.keys}** — ${s.what}`),
        `\nAsk me "how do I use [panel name]" for details on any of these, or "give me tips" for power-user tricks.`,

      ];
      return lines.join('\n');
    },
  },

  // "give me tips" / "how do I get the most out of henry"
  {
    name: 'henry_tips',
    match: re(
      /give me tips/i, /power.?user/i, /get the most (out of|from) (henry|you)/i,
      /how do i use (henry|you) better/i, /tricks? for henry/i,
      /best way to use (henry|you)/i,
    ),
    run: async () => {
      const lines = [`Here are the best ways to get more out of me:\n`];

      POWER_TIPS.forEach((t, i) => {
        lines.push(`**${i+1}. ${t.tip}**`);
        lines.push(t.detail);
        lines.push('');
      });
      return lines.join('\n');
    },
  },

  // "how do I use [panel]" / "tell me about [panel]" / "what is [panel]"
  {
    name: 'panel_help',
    match: (q: string) => {
      const panelRe = /^(how do i use|tell me about|what is|what does|explain|help me with|how does)\s+(.+)/i;
      const m = q.match(panelRe);
      if (!m) return false;
      return findPanelsByKeyword(m[2]).length > 0;
    },
    run: async () => {
      const q = (window as any).__lastLocalQuery__ || '';
      const panelRe = /^(?:how do i use|tell me about|what is|what does|explain|help me with|how does)\s+(.+)/i;
      const m = q.match(panelRe);
      const panels = m ? findPanelsByKeyword(m[1]) : [];
      if (!panels.length) return null;
      const p = panels[0];
      const lines = [
        `## ${p.icon} ${p.name}
`,
        p.whatItDoes,
        `
**How to use it:**`,
        ...p.howToUse.map(s => `• ${s}`),
        `
**Tips:**`,
        ...p.tips.map(s => `• ${s}`),
      ];
      if (p.phoneAvailable) lines.push(`\n✓ Available on your phone companion too.`);
      return lines.join('\n');
    },
  },

  // "what shortcuts does henry have" / "keyboard shortcuts"
  {
    name: 'shortcuts',
    match: re(
      /shortcut/i, /keyboard/i, /hotkey/i, /⌥.?space/i,
      /how do i open henry/i, /how do i (launch|start) henry/i,
    ),
    run: async () => {
      const lines = [`**Henry shortcuts:**\n`];
      SHORTCUTS.forEach(s => lines.push(`• **${s.keys}** — ${s.what}`));
      lines.push(`\nThe fastest one is **⌥Space** — it works from any app, any time. If you have text selected first, it's already in the chat when Henry opens.`);
      return lines.join('\n');
    },
  },

  // "what panels are on my phone" / "what works on mobile"
  {
    name: 'phone_panels',
    match: re(
      /what.*(phone|mobile|companion).*(panel|tab|work|use)/i,
      /what can i do (on|from) (my )?(phone|mobile)/i,
      /(phone|companion).*(feature|available|support)/i,
    ),
    run: async () => {
      const phonePanels = PANELS.filter(p => p.phoneAvailable);
      const lines = [
        `These panels are available on the Henry companion app on your phone:\n`,
        ...phonePanels.map(p => `• **${p.icon} ${p.name}** — ${p.shortDesc}`),
        `\nTo install: open your companion URL in **Safari** on iPhone → tap Share (□↑) → Add to Home Screen.`,
      ];
      return lines.join('\n');
    },
  },

  // "how do I teach you about me" / "how do you learn about me" / "memory"
  {
    name: 'memory_help',
    match: re(
      /how do (i|you) (teach|tell|train|add|save|give) (you|henry) (about|facts|info|memory)/i,
      /how does (your |henry.?s )?memory work/i,
      /how do i (use|add to|update) (the )?memory/i,
      /how do you (learn|remember|know) about me/i,
    ),
    run: async () => {
      return `**Three ways to add to my memory:**

1. **Say it in chat** — "Remember that I work from home" or "Remember I prefer bullet points." I save it automatically.

2. **Pin a response** — tap the 📌 button on any of my responses to save what I said to memory.

3. **Memory panel directly** — open 🧠 Memory in the sidebar, click +, and type any fact.

**What's worth adding:**
• Your name, job, and what you're building
• Your schedule and preferences
• Family names and details
• Your goals
• How you like answers formatted

The more you tell me, the more personal every response gets. I use your top facts in every single conversation.`;
    },
  },

  // Self-assessment: "how are you doing" / "what can't you do" / "assess yourself"
  {
    name: 'self_assessment',
    match: re(
      /how are you doing/i,
      /self.?assess/i,
      /what (can't|cannot|can you not) (you )?do/i,
      /what.*gaps/i,
      /what.*missing/i,
      /what.*don't you (know|do|support)/i,
      /what.*feature.*request/i,
      /assess yourself/i,
      /how (good|well|smart) are you/i,
    ),
    run: async () => buildSelfReport(),
  },

  // "learn that I prefer..." / "I prefer..." — save communication preference
  {
    name: 'learn_pref',
    match: re(
      /^(learn that |please note |note that |remember that )?i prefer (.+)/i,
      /^(learn that |please note )?when (you respond|answering|replying),? (.+)/i,
    ),
    run: async () => {
      // This is handled upstream in remember shortcut, but for prefs specifically:
      return null; // fall through to AI which will then save it
    },
  },

  // What colors do I have? / Show my color library
  {
    name: 'colors',
    match: re(/what colors? (do i|are|i)/i, /show (me )?(my )?colors?/i, /color library/i, /list (my )?colors/i),
    run: async () => {
      const a = api(); if (!a?.makerMaterialsColors) return null;
      const list = await a.makerMaterialsColors() as Array<{color:string; color_hex?:string; category:string; count:number; total_stock:number}>;
      if (!list?.length) return "You don't have any colored materials tracked yet. Add a material with a color in the Materials panel and I'll know.";
      const byCat = new Map<string, typeof list>();
      list.forEach(c => {
        if (!byCat.has(c.category)) byCat.set(c.category, []);
        byCat.get(c.category)!.push(c);
      });
      const sections: string[] = [];
      byCat.forEach((items, cat) => {
        sections.push(`**${cat}** — ${items.length} color${items.length===1?'':'s'}`);
        items.forEach(c => {
          const hex = c.color_hex ? ` (${c.color_hex})` : '';
          sections.push(`  • ${c.color}${hex} — ${c.count} item${c.count===1?'':'s'}`);
        });
      });
      return `Here's your color library:\n\n${sections.join('\n')}`;
    },
  },

  // What materials do I have / what's in inventory
  {
    name: 'materials',
    match: re(/what materials? (do i|are|i have)/i, /show (me )?(my )?materials?/i, /list (my )?materials/i, /(my )?inventory/i, /what'?s in stock/i),
    run: async () => {
      const a = api(); if (!a?.makerMaterialsList) return null;
      const list = await a.makerMaterialsList({ activeOnly: true }) as Array<{name:string;category:string;quantity_total:number;unit:string;reorder_threshold?:number}>;
      if (!list?.length) return "Your materials inventory is empty. Add materials in the Materials panel.";
      const byCat = new Map<string, typeof list>();
      list.forEach(m => {
        if (!byCat.has(m.category)) byCat.set(m.category, []);
        byCat.get(m.category)!.push(m);
      });
      const out = [`You have **${list.length}** material${list.length===1?'':'s'} across **${byCat.size}** categor${byCat.size===1?'y':'ies'}:`, ''];
      byCat.forEach((items, cat) => {
        out.push(`**${cat}**`);
        items.forEach(m => {
          const low = (m.reorder_threshold ?? 0) > 0 && m.quantity_total <= (m.reorder_threshold ?? 0);
          out.push(`  • ${m.name} — ${m.quantity_total}${m.unit}${low ? ' ⚠️ LOW' : ''}`);
        });
        out.push('');
      });
      return out.join('\n').trim();
    },
  },

  // What's running low / what should I reorder
  {
    name: 'low_stock',
    match: re(/what'?s (running )?low/i, /what should i reorder/i, /low stock/i, /need to (re)?order/i),
    run: async () => {
      const a = api(); if (!a?.makerMaterialsList) return null;
      const list = await a.makerMaterialsList({ lowStock: true }) as Array<{name:string;category:string;quantity_total:number;unit:string;reorder_threshold?:number;supplier?:string;supplier_url?:string}>;
      if (!list?.length) return "Nothing's low on stock right now. ✓";
      const out = [`**${list.length}** item${list.length===1?'':'s'} below your reorder threshold:`, ''];
      list.forEach(m => {
        const supplier = m.supplier ? ` from ${m.supplier}` : '';
        const url = m.supplier_url ? ` ${m.supplier_url}` : '';
        out.push(`• **${m.name}** (${m.category}) — ${m.quantity_total}${m.unit} left, threshold ${m.reorder_threshold}${m.unit}${supplier}${url}`);
      });
      return out.join('\n');
    },
  },

  // What machines do I have
  {
    name: 'machines',
    match: re(/what machines? (do i|are|i have)/i, /show (me )?(my )?machines/i, /list (my )?machines/i, /(my )?workshop/i),
    run: async () => {
      const a = api(); if (!a?.makerMachinesList) return null;
      const list = await a.makerMachinesList({ activeOnly: true }) as Array<{name:string;machine_type:string;brand?:string;model?:string;status:string}>;
      if (!list?.length) return "No machines tracked yet. Add one in the Machines panel.";
      const out = [`You have **${list.length}** machine${list.length===1?'':'s'}:`, ''];
      list.forEach(m => {
        const id = [m.brand, m.model].filter(Boolean).join(' ');
        const status = m.status === 'idle' ? '' : ` _(${m.status})_`;
        out.push(`• **${m.name}** — ${m.machine_type}${id ? ', ' + id : ''}${status}`);
      });
      return out.join('\n');
    },
  },

  // What's my profit / revenue / cost this month
  {
    name: 'monthly_profit',
    match: re(/(what'?s |show )?(my )?profit (this )?month/i, /revenue (this )?month/i, /how (much )?(have i made|did i make) (this )?month/i, /workshop (profit|earnings)/i),
    run: async () => {
      const a = api(); if (!a?.makerRunsSummary) return null;
      const month = thisMonthStr();
      const s = await a.makerRunsSummary({ month }) as {runs:number; total_cost:number; revenue:number; profit:number; total_minutes:number};
      if (!s || !s.runs) return `No production runs logged yet for ${month}. Log your jobs in the Runs panel and I'll calculate profit automatically.`;
      return `**${month} workshop summary:**\n\n• ${s.runs} production run${s.runs===1?'':'s'}\n• Time: ${fmtMinutes(s.total_minutes)}\n• Revenue: ${fmtMoney(s.revenue)}\n• Cost: ${fmtMoney(s.total_cost)}\n• **Profit: ${fmtMoney(s.profit)}**`;
    },
  },

  // What's my income / expenses this month
  {
    name: 'monthly_finance',
    match: re(/(what'?s |show )?(my )?(income|expenses?|spending|finance) (this )?month/i, /how much (did i (make|spend|earn))/i),
    run: async () => {
      const a = api(); if (!a?.financeSummary) return null;
      let s: {income:number; expenses:number; net:number; breakdown:unknown[]} | null = null;
      try {
        // Use the typed preload alias. There is no `window.electronAPI` — the
        // preload only exposes `henryAPI`, so this always returned null and
        // "what's my finance" silently produced nothing.
        s = await a.financeSummary(thisMonthStr()) as {income:number; expenses:number; net:number; breakdown:unknown[]};
      } catch { /* ignore */ }
      if (!s) return null;
      return `**${thisMonthStr()} finance:**\n\n• Income: ${fmtMoney(s.income)}\n• Expenses: ${fmtMoney(s.expenses)}\n• **Net: ${fmtMoney(s.net)}**`;
    },
  },

  // What failure patterns / where am I losing material
  {
    name: 'waste_patterns',
    match: re(/(failure|waste) pattern/i, /(where|why) (am i|are.*) (losing|wasting) (material|filament)/i, /print failures/i, /what.*went wrong/i),
    run: async () => {
      const a = api(); if (!a?.makerWastePatterns) return null;
      const list = await a.makerWastePatterns({ sinceDays: 30 }) as Array<{reason:string;count:number;total_qty:number;total_cost:number}>;
      if (!list?.length) return "No waste logged in the last 30 days. ✓";
      const out = [`**Waste patterns — last 30 days:**`, ''];
      let totalCost = 0;
      list.forEach(p => {
        totalCost += p.total_cost || 0;
        out.push(`• **${p.reason}** — ${p.count}× (${fmtMoney(p.total_cost)})`);
      });
      out.push('', `**Total waste cost: ${fmtMoney(totalCost)}**`);
      return out.join('\n');
    },
  },

  // What tasks today / due
  {
    name: 'tasks_today',
    match: re(/what tasks (do i|are)/i, /(my )?tasks (today|right now)/i, /what'?s on my (list|todo)/i, /^todo$/i),
    run: async () => {
      const a = api(); if (!a?.tasksList) return null;
      const list = await a.tasksList({ status: 'pending' }) as Array<{title:string; due_at?:string; priority?:number}>;
      if (!list?.length) return "Your task list is clear. ✓";
      const sorted = [...list].sort((a, b) => (b.priority || 0) - (a.priority || 0));
      const out = [`**${sorted.length} open task${sorted.length===1?'':'s'}:**`, ''];
      sorted.slice(0, 15).forEach(t => {
        const due = t.due_at ? ` _(due ${t.due_at.slice(0, 10)})_` : '';
        out.push(`• ${t.title}${due}`);
      });
      if (sorted.length > 15) out.push(`\n_…and ${sorted.length - 15} more._`);
      return out.join('\n');
    },
  },

  // What reminders
  {
    name: 'reminders',
    match: re(/(my )?reminders?/i, /what'?s (due|upcoming)/i, /what.*remind.*me/i),
    run: async () => {
      const a = api();
      try {
        const list = await (a?.remindersList?.() ?? null) as Array<{title:string;due_at:string;done:number}> | null;
        if (!list) return null;
        const open = list.filter(r => !r.done);
        if (!open.length) return "No active reminders. ✓";
        const out = [`**${open.length} reminder${open.length===1?'':'s'}:**`, ''];
        open.slice(0, 15).forEach(r => out.push(`• ${r.title} — ${new Date(r.due_at).toLocaleString()}`));
        return out.join('\n');
      } catch { return null; }
    },
  },

  // What journal entries / show recent journal
  {
    name: 'journal_recent',
    match: re(/(show |my )?recent journal/i, /journal entries?/i, /what did i journal/i),
    run: async () => {
      try {
        const list = await (window as any).electronAPI?.invoke?.('journal:list') as Array<{date:string;title?:string;mood?:string}> | null;
        if (!list?.length) return "No journal entries yet.";
        const out = [`**Recent journal entries:**`, ''];
        list.slice(0, 10).forEach(j => {
          const title = j.title ? ` — ${j.title}` : '';
          const mood = j.mood ? ` _(${j.mood})_` : '';
          out.push(`• ${j.date}${title}${mood}`);
        });
        return out.join('\n');
      } catch { return null; }
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Try to answer a user query locally. Returns { handled: true, reply } if any
 * intent matches, otherwise { handled: false }.
 *
 * Call this BEFORE invoking the AI in ChatView. If handled, render the reply
 * directly as the assistant message and skip the Groq round-trip.
 */
export async function routeLocally(query: string): Promise<LocalRouteResult> {
  const q = (query || '').trim();
  if (!q || q.length < 2) return { handled: false };

  // Henry does not open apps from chat — suggest keyboard shortcuts instead

  // ── Panel help — handled here so the query is in scope ──────────────────
  const PANEL_QUERY_RE = /^(?:how do i use|tell me about|what is|what does|explain|how does|help me with|how do i)\s+(.+)/i;
  const pm = q.match(PANEL_QUERY_RE);
  if (pm) {
    const panels = findPanelsByKeyword(pm[1]);
    if (panels.length > 0) {
      const p = panels[0];
      const lines = [
        `## ${p.icon} ${p.name}\n`,
        p.whatItDoes,
        `\n**How to use it:**`,
        ...p.howToUse.map(s => `• ${s}`),
        `\n**Tips:**`,
        ...p.tips.map(s => `• ${s}`),
      ];
      if (p.phoneAvailable) lines.push(`\n✓ Also available on your phone.`);
      return { handled: true, reply: lines.join('\n'), intentName: 'panel_help' };
    }
  }

  for (const intent of INTENTS) {
    if (intent.match(q)) {
      try {
        const reply = await intent.run();
        if (reply) return { handled: true, reply, intentName: intent.name };
      } catch (e) {
        console.warn(`[localRouter] intent "${intent.name}" failed:`, e);
        // fall through to AI
      }
    }
  }
  return { handled: false };
}

/** Returns the names of all registered intents — for debugging / settings UI */
export function listLocalIntents(): string[] {
  return INTENTS.map(i => i.name);
}
