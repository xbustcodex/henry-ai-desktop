import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import { HENRY_OPERATING_MODES, type HenryOperatingMode, isHenryOperatingMode } from '../../henry/charter';
import { ALL_NAV } from '../layout/Sidebar';

interface PaletteItem {
  id: string;
  icon: string;
  label: string;
  sublabel?: string;
  action: () => void;
  category: 'mode' | 'nav' | 'action' | 'conversation';
  keywords?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSetMode: (mode: HenryOperatingMode) => void;
  onNewChat: () => void;
  onInjectPrompt: (mode: HenryOperatingMode, text: string) => void;
}

const MODE_ICONS: Record<HenryOperatingMode, string> = {
  companion: '💬',
  writer: '✍️',
  developer: '⚡',
  builder: '🌐',
  design3d: '🖨️',
  secretary: '🗓️',
  computer: '🖥️',
  coach: '🎯',
  strategic: '♟️',
  business: '🚀',
};

const MODE_LABELS: Record<HenryOperatingMode, string> = {
  companion: 'Chat — Companion mode',
  writer: 'Writer mode',
  developer: 'Code mode',
  builder: 'App Builder mode',
  design3d: '3D / Design mode',
  secretary: 'Secretary mode',
  computer: 'Computer Control mode',
  coach: 'Coach mode',
  strategic: 'Strategic mode',
  business: 'Business Builder mode',
};

const QUICK_ACTIONS: Array<{ icon: string; label: string; mode: HenryOperatingMode; prompt: string }> = [
  { icon: '🌅', label: 'Daily briefing', mode: 'secretary', prompt: 'Give me my daily briefing — schedule, priority tasks, replies needed, and one heads-up.' },
  { icon: '✉️', label: 'Draft an email', mode: 'secretary', prompt: 'I need to draft an email. BLUF format, concise and ready to send.' },
  { icon: '🌐', label: 'Build a landing page', mode: 'builder', prompt: 'Build me a professional landing page. Ask me what it\'s for.' },
  { icon: '🌐', label: 'Build a web app', mode: 'builder', prompt: 'Build me a web app. Ask me what I need.' },
  { icon: '⚡', label: 'Debug my code', mode: 'developer', prompt: 'Help me debug this. I\'ll paste the code and error.' },
  { icon: '✍️', label: 'Start a draft', mode: 'writer', prompt: 'Help me draft something. I\'ll tell you what I need to write.' },
  { icon: '💡', label: 'Think through a decision', mode: 'companion', prompt: 'I need to think through a decision. Let me walk you through it.' },
  { icon: '🎯', label: 'Coach session', mode: 'coach', prompt: 'I want to work through something I\'ve been stuck on. Help me get clear.' },
  { icon: '♟️', label: 'Strategic review', mode: 'strategic', prompt: 'Help me think strategically about what I\'m working on. I\'ll give you the context.' },
  { icon: '🚀', label: 'Build a business', mode: 'business', prompt: 'I have a business idea I want to develop. Let\'s work through the offer and plan.' },
];

export default function CommandPalette({ open, onClose, onSetMode, onNewChat, onInjectPrompt }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { conversations, setActiveConversation, setMessages, setCurrentView } = useStore();

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const buildItems = useCallback((_q: string): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // New chat
    items.push({
      id: 'new-chat',
      icon: '✦',
      label: 'New chat',
      sublabel: 'Start a fresh conversation',
      category: 'action',
      keywords: ['new', 'fresh', 'clear', 'start'],
      action: () => { onNewChat(); onClose(); },
    });

    // Modes
    for (const mode of HENRY_OPERATING_MODES) {
      items.push({
        id: `mode-${mode}`,
        icon: MODE_ICONS[mode],
        label: `Switch to ${MODE_LABELS[mode]}`,
        sublabel: `/mode ${mode}`,
        category: 'mode',
        keywords: [mode, 'mode', 'switch'],
        action: () => { onSetMode(mode); onClose(); },
      });
    }

    // Quick actions
    for (const qa of QUICK_ACTIONS) {
      items.push({
        id: `qa-${qa.label}`,
        icon: qa.icon,
        label: qa.label,
        sublabel: `Launches in ${MODE_LABELS[qa.mode].split(' ')[0]} mode`,
        category: 'action',
        keywords: [qa.label.toLowerCase(), qa.mode],
        action: () => { onInjectPrompt(qa.mode, qa.prompt); onClose(); },
      });
    }

    // Nav — every surface, from the shared sidebar config (one keystroke to anything).
    for (const nav of ALL_NAV) {
      items.push({
        id: `nav-${nav.id}`,
        icon: nav.icon ?? '•',
        label: `Open ${nav.label}`,
        sublabel: nav.desc,
        category: 'nav',
        keywords: [nav.label.toLowerCase(), nav.id, ...(nav.desc ? [nav.desc.toLowerCase()] : [])],
        action: () => { setCurrentView(nav.id); onClose(); },
      });
    }

    // Recent conversations
    for (const convo of conversations.slice(0, 5)) {
      items.push({
        id: `convo-${convo.id}`,
        icon: '💬',
        label: convo.title || 'Untitled chat',
        sublabel: 'Recent conversation',
        category: 'conversation',
        keywords: [(convo.title || '').toLowerCase()],
        action: async () => {
          setActiveConversation(convo.id);
          try {
            const msgs = await window.henryAPI.getMessages(convo.id);
            setMessages(msgs);
            setCurrentView('chat');
          } catch { /* ignore */ }
          onClose();
        },
      });
    }

    return items;
  }, [conversations, onNewChat, onClose, onSetMode, onInjectPrompt, setActiveConversation, setMessages, setCurrentView]);

  const allItems = buildItems(query);

  const filtered = query.trim()
    ? allItems.filter((item) => {
        const q = query.toLowerCase();
        return (
          item.label.toLowerCase().includes(q) ||
          item.sublabel?.toLowerCase().includes(q) ||
          item.keywords?.some((k) => k.includes(q))
        );
      })
    : allItems;

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[selectedIdx]?.action();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  if (!open) return null;

  const categoryLabels: Record<string, string> = {
    action: 'Actions',
    mode: 'Switch Mode',
    nav: 'Navigate',
    conversation: 'Recent Chats',
  };

  let lastCategory = '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-henry-surface border border-henry-border/50 rounded-2xl shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-henry-border/30">
          <svg className="w-4 h-4 text-henry-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, modes, chats…"
            className="flex-1 bg-transparent text-sm text-henry-text placeholder-henry-text-muted outline-none"
          />
          <kbd className="text-[10px] text-henry-text-muted bg-henry-bg/60 border border-henry-border/40 rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <p className="text-center text-xs text-henry-text-muted py-8">No results for "{query}"</p>
          ) : (
            filtered.map((item, idx) => {
              const showHeader = item.category !== lastCategory;
              lastCategory = item.category;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <p className="px-4 pt-3 pb-1 text-[10px] font-semibold text-henry-text-muted uppercase tracking-wider">
                      {categoryLabels[item.category] || item.category}
                    </p>
                  )}
                  <button
                    onClick={item.action}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      idx === selectedIdx ? 'bg-henry-accent/10' : 'hover:bg-henry-hover/30'
                    }`}
                  >
                    <span className="text-base shrink-0">{item.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm truncate ${idx === selectedIdx ? 'text-henry-accent' : 'text-henry-text'}`}>
                        {item.label}
                      </p>
                      {item.sublabel && (
                        <p className="text-[10px] text-henry-text-muted truncate">{item.sublabel}</p>
                      )}
                    </div>
                    {idx === selectedIdx && (
                      <kbd className="text-[10px] text-henry-accent/70 bg-henry-accent/10 border border-henry-accent/20 rounded px-1.5 py-0.5 shrink-0">
                        ↵
                      </kbd>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="px-4 py-2 border-t border-henry-border/20 flex items-center gap-4 text-[10px] text-henry-text-muted">
          <span><kbd className="bg-henry-bg/60 border border-henry-border/40 rounded px-1">↑↓</kbd> navigate</span>
          <span><kbd className="bg-henry-bg/60 border border-henry-border/40 rounded px-1">↵</kbd> select</span>
          <span><kbd className="bg-henry-bg/60 border border-henry-border/40 rounded px-1">Esc</kbd> close</span>
          <span className="ml-auto">⌘K to open</span>
        </div>
      </div>
    </div>
  );
}
