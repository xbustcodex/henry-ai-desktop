/**
 * Henry Self-Knowledge
 *
 * Everything Henry knows about himself — panels, shortcuts, features,
 * tips. Used by the local router to answer "how do I..." and "what can
 * you do" questions instantly, without an AI call.
 */

export interface PanelInfo {
  name: string;
  icon: string;
  shortDesc: string;        // one sentence
  whatItDoes: string;       // 2-3 sentences, plain language
  howToUse: string[];       // concrete first steps
  tips: string[];           // power-user tips
  phoneAvailable: boolean;
  keywords: string[];
}

export const PANELS: PanelInfo[] = [
  {
    name: 'Chat',
    icon: '💬',
    shortDesc: 'Talk to Henry — ask anything, give commands, get things done.',
    whatItDoes: 'Every message you send goes here. Henry reads your tasks, reminders, habits, memory, and calendar before answering so he already has context. You can ask him to do things on your Mac, look things up, write drafts, or just think through a problem.',
    howToUse: [
      'Press ⌥Space from anywhere on your Mac to open Chat instantly',
      'Select text in any app first — Henry will have it ready when you open',
      'Type naturally — no special commands needed',
    ],
    tips: [
      'Say "remember that..." to save something to Henry\'s memory',
      'Say "add a task..." or "remind me to..." — he adds it directly to your lists',
      'Pin any response with 📌 to save it to memory for later',
      'Say "tell ChatGPT to [prompt]" — Henry opens the browser and types it for you',
    ],
    phoneAvailable: true,
    keywords: ['chat', 'talk', 'message', 'ask', 'question', 'help', 'command'],
  },
  {
    name: 'Today',
    icon: '☀️',
    shortDesc: 'Your daily dashboard — habits, schedule, word of the day, daily plan.',
    whatItDoes: 'Opens every morning to show your habits to check in, today\'s tasks and reminders, a word Henry picked for you, and buttons to generate a day plan or end-of-day report.',
    howToUse: [
      'Tap habit circles to mark them done — streak builds over time',
      'Hit "Day plan" to get an AI-generated priority list for the day',
      'Hit "📊 Daily report" at the end of the day for a summary',
    ],
    tips: [
      'The word of the day is cached — Henry only fetches it once per day',
      'Day plan is also cached — one AI call per day keeps costs low',
      'Quick-add a task right from Today without switching panels',
    ],
    phoneAvailable: true,
    keywords: ['today', 'dashboard', 'habits', 'morning', 'daily', 'plan', 'schedule'],
  },
  {
    name: 'Tasks',
    icon: '✓',
    shortDesc: 'Your to-do list — add, complete, and let Henry triage priorities.',
    whatItDoes: 'Full task list with priority scores. Henry can add tasks from chat, and has an AI triage button that scores and re-orders your list by urgency and importance.',
    howToUse: [
      'Say "add a task: [title]" in chat — appears here instantly',
      'Tap any task to mark it complete',
      'Hit AI Triage to have Henry score and prioritize your list',
    ],
    tips: [
      'Available on your phone — add tasks from anywhere',
      'Tasks with a due date show as reminders too',
      'Henry mentions overdue tasks when you ask about your day',
    ],
    phoneAvailable: true,
    keywords: ['task', 'todo', 'to-do', 'list', 'complete', 'check off', 'triage'],
  },
  {
    name: 'Reminders',
    icon: '⏰',
    shortDesc: 'Time-based reminders with a red badge when something is due.',
    whatItDoes: 'Set reminders and Henry shows a red badge on the sidebar icon when anything is due. Add from chat or from your phone.',
    howToUse: [
      'Say "remind me to call John tomorrow at 2pm" in chat',
      'Or add directly in the Reminders panel',
      'Mark done with one tap — red badge disappears when all cleared',
    ],
    tips: [
      'Snooze a reminder if you\'re not ready',
      'Reminders also show in Today and on your phone',
      '"What\'s due today?" in chat lists everything overdue',
    ],
    phoneAvailable: true,
    keywords: ['reminder', 'remind', 'due', 'alarm', 'notify', 'notification'],
  },
  {
    name: 'Goals',
    icon: '◎',
    shortDesc: 'Long-term goals with AI coaching and an overdue badge.',
    whatItDoes: 'Track big goals with target dates. Henry shows an orange badge on the sidebar when a goal is overdue, and can coach you on next steps.',
    howToUse: [
      'Add a goal with a title, why it matters, and a target date',
      'Ask Henry "coach me on my goals" for a push',
      'Mark a goal done when you achieve it',
    ],
    tips: [
      'Orange badge = you have an overdue goal — click it to see which ones',
      'Goals show in the companion app on your phone',
      'Henry references your active goals in daily planning',
    ],
    phoneAvailable: true,
    keywords: ['goal', 'target', 'objective', 'achieve', 'milestone', 'ambition'],
  },
  {
    name: 'Journal',
    icon: '📔',
    shortDesc: 'Daily journal with mood tracking, AI reflection, and streaks.',
    whatItDoes: 'Write entries with a mood picker. After 50+ characters a reflection button appears — Henry asks a thoughtful follow-up question. Your streak is tracked.',
    howToUse: [
      'Open Journal and just start writing',
      'Pick a mood emoji at the bottom',
      'Hit the AI Reflection button for a Henry-generated follow-up prompt',
    ],
    tips: [
      'Write from your phone — same entry saves to your Mac',
      'Journal entries stay 100% private on your Mac — never sent anywhere',
      'Ask Henry "what did I journal about last week?" and he\'ll tell you',
    ],
    phoneAvailable: true,
    keywords: ['journal', 'diary', 'write', 'entry', 'mood', 'reflection', 'streak'],
  },
  {
    name: 'Health',
    icon: '❤️',
    shortDesc: 'Log water, steps, sleep, calories, exercise with one tap.',
    whatItDoes: 'Six quick-log buttons for common health data. Tap once to log the default value, or use Custom for anything else. Charts show trends over time.',
    howToUse: [
      'Tap 💧 Water to log 8oz, 👟 Steps for 1,000, etc.',
      'Use Custom to log any value with any label',
      'Say "log 7 hours of sleep" in chat — Henry logs it directly',
    ],
    tips: [
      'All 6 buttons are on your phone too — log from anywhere',
      'Henry can mention your health trends in the daily plan',
      '"How am I doing on steps this week?" shows your logged data',
    ],
    phoneAvailable: true,
    keywords: ['health', 'water', 'steps', 'sleep', 'calories', 'exercise', 'log', 'track'],
  },
  {
    name: 'Finance',
    icon: '💰',
    shortDesc: 'Income, expenses, budgets — import bank CSV or add manually.',
    whatItDoes: 'Track money in and out, set category budgets, and see where you\'re overspending. Import transactions from a bank CSV file or add manually.',
    howToUse: [
      'Import a bank statement CSV — Henry auto-detects columns',
      'Set a budget per category (groceries, software, etc.)',
      'Ask "what did I spend on food this month?" in chat',
    ],
    tips: [
      'Henry flags when you\'re over budget on a category',
      '"Show my finance summary" gives income/expenses/net at a glance',
      'Export data as CSV from the Finance panel settings',
    ],
    phoneAvailable: true,
    keywords: ['finance', 'money', 'budget', 'expense', 'income', 'spending', 'bank', 'csv'],
  },
  {
    name: 'Memory',
    icon: '🧠',
    shortDesc: 'Everything Henry remembers about you — view, edit, delete.',
    whatItDoes: 'Henry builds a memory of facts about you over time. This panel lets you see everything he knows, add new facts, and delete ones that are wrong or outdated. These facts are injected into every conversation so Henry always has context.',
    howToUse: [
      'Open Memory to see all saved facts',
      'Click + to add a fact manually',
      'Say "remember that I prefer bullet points" in chat — Henry saves it',
    ],
    tips: [
      'More facts = better, more personal responses',
      'Pin a chat response with 📌 to save it directly to Memory',
      'Henry uses the top 8 facts by importance in every prompt',
      'Good things to add: your name, job, location, preferences, family, goals',
    ],
    phoneAvailable: false,
    keywords: ['memory', 'remember', 'facts', 'personal', 'know', 'learn', 'about me'],
  },
  {
    name: 'Quoting',
    icon: '📄',
    shortDesc: 'Create quotes and invoices for clients, with PDF export.',
    whatItDoes: 'Build quotes with line items, client info, and totals. Export to PDF and send. Manage multiple clients and quote history.',
    howToUse: [
      'Add a new quote, pick a client or create one',
      'Add line items with descriptions and prices',
      'Export to PDF when ready to send',
    ],
    tips: [
      'Client list is reusable across quotes',
      'Quote history is saved so you can reference past jobs',
    ],
    phoneAvailable: false,
    keywords: ['quote', 'invoice', 'client', 'billing', 'estimate', 'pdf'],
  },
  {
    name: 'Weekly Review',
    icon: '🗓️',
    shortDesc: 'Guided weekly review — what got done, what didn\'t, what\'s next.',
    whatItDoes: 'A structured 5-minute review of your week. Henry walks you through wins, misses, and sets up next week. Helps you stay honest about progress.',
    howToUse: [
      'Open Weekly Review at the end of the week',
      'Work through the prompts Henry gives you',
      'Save the review — it builds a history of your weeks',
    ],
    tips: [
      'Sunday evenings work best for most people',
      'Henry references past reviews when you ask how you\'re doing over time',
    ],
    phoneAvailable: false,
    keywords: ['weekly', 'review', 'week', 'reflection', 'retrospective', 'recap'],
  },
  {
    name: 'Recorder',
    icon: '🎙',
    shortDesc: 'Voice memos with automatic transcription.',
    whatItDoes: 'Record anything — meetings, ideas, notes. Transcription happens automatically. Transcripts are saved and searchable.',
    howToUse: [
      'Hit the record button and speak',
      'Stop when done — transcript appears automatically',
      'Search past recordings by content',
    ],
    tips: [
      'Great for capturing ideas when you can\'t type',
      'Ask Henry to summarize a transcript',
    ],
    phoneAvailable: false,
    keywords: ['record', 'voice', 'audio', 'transcribe', 'memo', 'dictate'],
  },
  {
    name: 'Maker Studio',
    icon: '🏭',
    shortDesc: 'Machines, materials, production runs, waste, maintenance — for makers.',
    whatItDoes: 'Full shop management: track your machines (laser, CNC, embroidery, etc.), materials inventory, production run profitability, waste patterns, and maintenance logs.',
    howToUse: [
      'Add your machines in the Machines tab',
      'Log materials with cost and stock levels',
      'Record production runs — Henry calculates profit per job',
    ],
    tips: [
      'Ask "what\'s running low?" and Henry checks material stock',
      '"Show this month\'s profit" pulls from production runs',
      'Waste patterns help you see where you\'re losing money',
    ],
    phoneAvailable: false,
    keywords: ['maker', 'machine', 'material', 'production', 'waste', 'shop', 'laser', 'cnc'],
  },
  {
    name: 'HQ',
    icon: '🌐',
    shortDesc: 'Command center — automations, captures, ambient brain status.',
    whatItDoes: 'Overview of everything Henry is doing in the background. See recent captures, active automations, and ambient brain activity.',
    howToUse: [
      'Open HQ to see what Henry has been doing',
      'Review recent captures from ⌥Space',
    ],
    tips: [
      'Good for troubleshooting if Henry seems off',
    ],
    phoneAvailable: false,
    keywords: ['hq', 'command', 'automation', 'ambient', 'capture', 'overview'],
  },
  {
    name: 'Settings',
    icon: '⚙️',
    shortDesc: 'AI providers, brains, appearance, backup, smart routing.',
    whatItDoes: 'Configure Henry\'s AI models, add API keys, change accent colors, set up smart coder routing, export backups, manage memory.',
    howToUse: [
      'AI Providers tab: add your Groq and Gemini keys',
      'AI Brains tab: choose which model handles conversations vs heavy tasks',
      'General tab: export a backup of all your data',
    ],
    tips: [
      'Smart code routing (AI Providers tab) auto-switches to Qwen Coder for code questions',
      'Add a Cerebras key as a silent fallback when Groq rate-limits',
      'Export Backup saves everything to your Desktop as a zip',
    ],
    phoneAvailable: false,
    keywords: ['settings', 'config', 'key', 'provider', 'model', 'backup', 'appearance'],
  },
];

// Shortcuts reference
export const SHORTCUTS = [
  { keys: '⌥Space', what: 'Open Henry from anywhere. If you have text selected, it\'s pasted in automatically.' },
  { keys: '⌘⇧H', what: 'Open Henry\'s full window from anywhere on your Mac.' },
  { keys: 'Dock icon', what: 'Click the Henry icon in your dock to open the app.' },
  { keys: '📌 button', what: 'Pin any chat response to save it to Memory.' },
  { keys: 'Pull down', what: 'Pull down on the phone companion to refresh data.' },
];

// Tips for getting the most out of Henry
export const POWER_TIPS = [
  { tip: 'Teach Henry about yourself', detail: 'Say "remember that I [fact]" in chat. The more he knows, the more personal every response gets. Try: your job, your schedule, your preferences, your family.' },
  { tip: 'Use ⌥Space constantly', detail: 'Select any text anywhere on your Mac — an email, article, contract — and press ⌥Space. Henry opens with that text already loaded. Ask him to summarize, reply, explain, or act on it.' },
  { tip: 'Talk to Henry like a person', detail: 'You don\'t need special commands. "Remind me to call Sarah on Friday" works. "What should I focus on today?" works. "Write a reply to this email" works.' },
  { tip: 'Install Henry on your phone', detail: 'Open your companion URL in Safari on iPhone/iPad. Tap Share → Add to Home Screen. Henry installs as a real app — log health, add tasks, write journal entries from anywhere.' },
  { tip: 'Get unlimited free AI', detail: 'Go to aistudio.google.com and get a free Gemini key (no card). Then go to groq.com and get a free Groq key. Paste both in Settings → AI Providers. Unlimited responses.' },
  { tip: 'Ask Henry about his memory', detail: 'Say "what do you know about me?" and Henry shows his memory. Edit it in the Memory panel — delete wrong facts, add important ones.' },
];

// Map keywords to panel names for lookup
export function findPanelsByKeyword(query: string): PanelInfo[] {
  const q = query.toLowerCase();
  return PANELS.filter(p =>
    p.keywords.some(k => q.includes(k)) ||
    p.name.toLowerCase().includes(q) ||
    p.shortDesc.toLowerCase().includes(q)
  );
}

export function getPanelByName(name: string): PanelInfo | undefined {
  return PANELS.find(p => p.name.toLowerCase() === name.toLowerCase());
}
