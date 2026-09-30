/**
 * Delegation Interceptor — runs BEFORE the AI call.
 * Detects "tell ChatGPT/Claude/Slack to X" and executes it directly
 * via real computer IPCs instead of hoping the AI outputs the right pattern.
 */

// NOTE: ../platform/launcher is a MAIN-PROCESS module — it imports
// child_process, which throws in the renderer ("externalized for browser
// compatibility"). Everything this file needs from the OS goes through IPC.
import { isMacOS, isLinux, isWindows } from '../utils/platform';
import { resolveAppLink } from './appLinks';

export interface DelegationTarget {
  appName: string;       // e.g. "Google Chrome"
  url: string;           // e.g. "https://chatgpt.com" (empty for app-only)
  task: string;          // what to type/do in the app
  isAI: boolean;         // true if target is an AI chatbot (type into input)
}

// Maps user-friendly names to real app names + URLs — macOS
const DELEGATION_MAP_MAC: Record<string, { app: string; url: string }> = {
  'chatgpt':   { app: 'Google Chrome', url: 'https://chatgpt.com' },
  'chat gpt':  { app: 'Google Chrome', url: 'https://chatgpt.com' },
  'gpt':       { app: 'Google Chrome', url: 'https://chatgpt.com' },
  'claude':    { app: 'Google Chrome', url: 'https://claude.ai' },
  'gemini':    { app: 'Google Chrome', url: 'https://gemini.google.com' },
  'perplexity':{ app: 'Google Chrome', url: 'https://perplexity.ai' },
  'copilot':   { app: 'Google Chrome', url: 'https://copilot.microsoft.com' },
  'slack':     { app: 'Slack',         url: '' },
  'notion':    { app: 'Notion',        url: '' },
  'discord':   { app: 'Discord',       url: '' },
  'messages':  { app: 'Messages',      url: '' },
  'mail':      { app: 'Mail',          url: '' },
  'gmail':     { app: 'Google Chrome', url: 'https://mail.google.com' },
  'chrome':    { app: 'Google Chrome', url: '' },
  'safari':    { app: 'Safari',        url: '' },
  'terminal':  { app: 'Terminal',      url: '' },
  'iterm':     { app: 'iTerm',         url: '' },
  'cursor':    { app: 'Cursor',        url: '' },
  'vscode':    { app: 'Visual Studio Code', url: '' },
  'vs code':   { app: 'Visual Studio Code', url: '' },
  'spotify':   { app: 'Spotify',       url: '' },
  'zoom':      { app: 'Zoom',          url: '' },
};

// Maps user-friendly names to real app names + URLs — Linux
const DELEGATION_MAP_LINUX: Record<string, { app: string; url: string }> = {
  'chatgpt':   { app: 'firefox', url: 'https://chatgpt.com' },
  'chat gpt':  { app: 'firefox', url: 'https://chatgpt.com' },
  'gpt':       { app: 'firefox', url: 'https://chatgpt.com' },
  'claude':    { app: 'firefox', url: 'https://claude.ai' },
  'gemini':    { app: 'firefox', url: 'https://gemini.google.com' },
  'perplexity':{ app: 'firefox', url: 'https://perplexity.ai' },
  'copilot':   { app: 'firefox', url: 'https://copilot.microsoft.com' },
  'slack':     { app: 'slack',         url: '' },
  'notion':    { app: 'notion',        url: '' },
  'discord':   { app: 'discord',       url: '' },
  'messages':  { app: '',              url: '' },
  'mail':      { app: 'thunderbird',  url: '' },
  'gmail':     { app: 'firefox',      url: 'https://mail.google.com' },
  'chrome':    { app: 'google-chrome', url: '' },
  'firefox':   { app: 'firefox',      url: '' },
  'terminal':  { app: 'gnome-terminal', url: '' },
  'cursor':    { app: 'cursor',       url: '' },
  'vscode':    { app: 'code',         url: '' },
  'vs code':   { app: 'code',         url: '' },
  'spotify':   { app: 'spotify',      url: '' },
  'zoom':      { app: 'zoom',         url: '' },
};

// Maps user-friendly names to real app names + URLs — Windows
const DELEGATION_MAP_WIN32: Record<string, { app: string; url: string }> = {
  'chatgpt':   { app: 'chrome', url: 'https://chatgpt.com' },
  'chat gpt':  { app: 'chrome', url: 'https://chatgpt.com' },
  'gpt':       { app: 'chrome', url: 'https://chatgpt.com' },
  'claude':    { app: 'chrome', url: 'https://claude.ai' },
  'gemini':    { app: 'chrome', url: 'https://gemini.google.com' },
  'perplexity':{ app: 'chrome', url: 'https://perplexity.ai' },
  'copilot':   { app: 'chrome', url: 'https://copilot.microsoft.com' },
  'slack':     { app: 'slack',         url: '' },
  'notion':    { app: 'notion',        url: '' },
  'discord':   { app: 'discord',       url: '' },
  'messages':  { app: '',              url: '' },
  'mail':      { app: 'outlook',       url: '' },
  'gmail':     { app: 'chrome',        url: 'https://mail.google.com' },
  'chrome':    { app: 'chrome',        url: '' },
  'firefox':   { app: 'firefox',       url: '' },
  'edge':      { app: 'msedge',        url: '' },
  'terminal':  { app: 'wt',            url: '' },
  'cmd':       { app: 'cmd',           url: '' },
  'powershell':{ app: 'powershell',    url: '' },
  'cursor':    { app: 'cursor',        url: '' },
  'vscode':    { app: 'code',          url: '' },
  'vs code':   { app: 'code',          url: '' },
  'spotify':   { app: 'spotify',       url: '' },
  'zoom':      { app: 'zoom',          url: '' },
};

function getDelegationMap(): Record<string, { app: string; url: string }> {
  if (isMacOS()) return DELEGATION_MAP_MAC;
  if (isLinux()) return DELEGATION_MAP_LINUX;
  if (isWindows()) return DELEGATION_MAP_WIN32;
  return DELEGATION_MAP_MAC;
}

// Patterns: "tell ChatGPT to write a poem" / "ask Claude to continue"
const DELEGATION_RE = /^(?:tell|ask|have|get|make|instruct)\s+([\w\s]+?)\s+(?:to|and)\s+(.+)$/i;

// Also handle: "open ChatGPT and write a poem"
const OPEN_AND_RE = /^(?:open|go to|launch)\s+([\w\s]+?)\s+and\s+(.+)$/i;

// "continue in ChatGPT" / "type X in Chrome"
const TYPE_IN_RE = /^(?:type|write|send|say|put)\s+(.+?)\s+in(?:\s+the)?\s+([\w\s]+)$/i;

/**
 * Resolve a request that names a known app into a deep link, so "show me my
 * inbox" lands in the inbox rather than merely launching the app.
 *
 * Returns null when no catalogue entry matches, so plain app launching still
 * handles everything else.
 */
export function parseAppLink(message: string): { url: string; appName: string; description: string } | null {
  const text = message.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const hit = resolveAppLink(text);
  if (!hit) return null;
  return { url: hit.url, appName: hit.app.displayName, description: hit.description };
}

export function parseDelegation(message: string): DelegationTarget | null {
  // Never fire on questions — if it starts with a question word, bail immediately
  const QUESTION_RE = /^(what|which|how|who|where|when|is|are|do|does|did|can|could|would|will|should|why|tell me about|show me)\b/i;
  if (QUESTION_RE.test(message.trim())) return null;

  const map = getDelegationMap();

  // Must contain a known app name to be a delegation — prevents false positives
  const hasKnownApp = Object.keys(map).some(key =>
    message.toLowerCase().includes(key)
  );
  if (!hasKnownApp) return null;

  let targetName = '';
  let task = '';

  const m1 = message.match(DELEGATION_RE);
  const m2 = message.match(OPEN_AND_RE);
  const m3 = message.match(TYPE_IN_RE);

  if (m1) {
    targetName = m1[1].trim().toLowerCase();
    task = m1[2].trim();
  } else if (m2) {
    targetName = m2[1].trim().toLowerCase();
    task = m2[2].trim();
  } else if (m3) {
    task = m3[1].trim();
    targetName = m3[2].trim().toLowerCase();
  } else {
    return null;
  }

  // Find the best matching app
  let target = map[targetName];
  if (!target) {
    // Partial match
    for (const [key, val] of Object.entries(map)) {
      if (targetName.includes(key) || key.includes(targetName)) {
        target = val;
        break;
      }
    }
  }
  if (!target) return null;

  const isAI = ['chatgpt','claude','gemini','gpt','copilot','perplexity'].some(n => targetName.includes(n));

  return {
    appName: target.app,
    url: target.url,
    task,
    isAI,
  };
}

export async function executeDelegation(delegation: DelegationTarget): Promise<string> {
  const api = (window as any).henryAPI;
  if (!api) return 'Henry IPC not available — restart the app.';

  const results: string[] = [];

  try {
    // 1. Open the app / URL through the main process. The result is checked so a
    //    failed launch is never reported back to the user as a success.
    if (delegation.url) {
      const opened = await api.computerOpenUrl(delegation.url);
      if (!opened?.success) throw new Error(opened?.error || `Could not open ${delegation.url}`);
      results.push(`✓ Opened ${delegation.appName}`);
    } else {
      const opened = await api.computerOpenApp(delegation.appName);
      if (!opened?.success) throw new Error(opened?.error || `Could not open ${delegation.appName}`);
      results.push(`✓ Opened ${delegation.appName}`);
    }

    // 2. Wait for it to load
    await new Promise(r => setTimeout(r, 2500));

    // 3. Activate it using platform-specific methods (via main process)
    await api.computerActivateApplication(delegation.appName);
    await new Promise(r => setTimeout(r, 800));

    // 4. For AI chatbots: click the input area first (Cmd+L or equivalent)
    if (delegation.isAI) {
      await api.computerFocusAiInput(delegation.appName);
      await new Promise(r => setTimeout(r, 300));
    }

    // 5. Type the task (via main process)
    await api.computerTypeText(delegation.task);
    results.push(`✓ Typed: "${delegation.task}"`);

    await new Promise(r => setTimeout(r, 200));

    // 6. Press Enter to submit (via main process)
    await api.computerPressKey('enter');
    results.push(`✓ Submitted`);

    return results.join('\n');
  } catch (e) {
    return `✗ ${e instanceof Error ? e.message : String(e)}`;
  }
}