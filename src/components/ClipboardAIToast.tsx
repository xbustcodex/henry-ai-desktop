import { safeCopyToClipboard } from '../utils/clipboardSafe';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';

interface ClipboardAction {
  label: string;
  prompt: (text: string) => string;
}

const ACTIONS: ClipboardAction[] = [
  { label: 'Summarize', prompt: (t) => `Summarize this concisely:\n\n${t}` },
  { label: 'Improve', prompt: (t) => `Rewrite and improve this text, keeping the same intent but making it cleaner and sharper:\n\n${t}` },
  { label: 'Explain', prompt: (t) => `Explain this clearly — what it means, what it does, what matters:\n\n${t}` },
  { label: 'Translate', prompt: (t) => `Translate this to English (or to Spanish if already in English):\n\n${t}` },
  { label: 'Email reply', prompt: (t) => `Draft a professional, warm reply to this:\n\n${t}` },
];

export default function ClipboardAIToast() {
  const [visible, setVisible] = useState(false);
  const [clipText, setClipText] = useState('');
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [copying, setCopying] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClipRef = useRef('');
  const { settings } = useStore();

  const scheduleHide = useCallback((ms = 8000) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      setResult('');
      setActiveAction(null);
    }, ms);
  }, []);

  useEffect(() => {

    async function checkClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text || text === lastClipRef.current) return;
        if (text.trim().length < 20 || text.trim().length > 8000) return;
        lastClipRef.current = text;
        setClipText(text);
        setResult('');
        setActiveAction(null);
        setVisible(true);
        scheduleHide(10000);
      } catch {
        // Clipboard read may be blocked (focus required or permission denied)
      }
    }

    const pollInterval = setInterval(checkClipboard, 1500);
    return () => clearInterval(pollInterval);
  }, [scheduleHide]);

  async function runAction(action: ClipboardAction) {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setActiveAction(action.label);
    setResult('');

    try {
      const s = useStore.getState().settings;
      if (!s.companion_provider || !s.companion_model) {
        setResult('No AI model configured. Set one up in Settings.');
        scheduleHide(6000);
        return;
      }
      const providers = await window.henryAPI.getProviders();
      const provider = providers.find((p: any) => p.id === s.companion_provider);
      if (!provider) { setResult('Provider not found.'); scheduleHide(4000); return; }

      let full = '';
      const stream = window.henryAPI.streamMessage({
        provider: s.companion_provider,
        model: s.companion_model,
        apiKey: provider.api_key || provider.apiKey || '',
        messages: [
          { role: 'system', content: 'You are Henry. Be brief, direct, and useful. No preamble.' },
          { role: 'user', content: action.prompt(clipText) },
        ],
        temperature: 0.7,
        maxTokens: 500,
      });
      stream.onChunk((chunk: string) => { full += chunk; setResult(full); });
      stream.onDone(() => scheduleHide(30000));
      stream.onError(() => { setResult('Something went wrong.'); scheduleHide(5000); });
    } catch {
      setResult('Error running action.');
      scheduleHide(5000);
    }
  }

  function copyResult() {
    safeCopyToClipboard(result).then(() => {
      setCopying(true);
      setTimeout(() => setCopying(false), 2000);
    }).catch(() => {});
  }

  function dismiss() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(false);
    setResult('');
    setActiveAction(null);
  }

  if (!visible) return null;

  const preview = clipText.length > 80 ? clipText.slice(0, 80) + '…' : clipText;

  return (
    <div className="fixed bottom-20 right-4 z-50 w-80 animate-fade-in">
      <div className="bg-henry-surface border border-henry-border/60 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-henry-border/30 bg-henry-bg/50">
          <div className="flex items-center gap-2">
            <span className="text-sm">🧠</span>
            <span className="text-xs font-medium text-henry-text">Clipboard AI</span>
          </div>
          <button onClick={dismiss} className="text-henry-text-muted hover:text-henry-text transition-colors text-sm">✕</button>
        </div>

        {/* Clip preview */}
        <div className="px-4 py-2.5 border-b border-henry-border/20">
          <p className="text-[10px] text-henry-text-muted/70 italic truncate">{preview}</p>
        </div>

        {/* Actions */}
        <div className="px-3 py-2.5 flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <button
              key={a.label}
              onClick={() => runAction(a)}
              disabled={!!activeAction && activeAction !== a.label}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                activeAction === a.label
                  ? 'bg-henry-accent text-white'
                  : 'bg-henry-surface/60 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 disabled:opacity-40'
              }`}
            >
              {activeAction === a.label && !result ? '…' : a.label}
            </button>
          ))}
        </div>

        {/* Result */}
        {result && (
          <div className="px-4 pb-3">
            <div className="bg-henry-bg/60 rounded-xl p-3 border border-henry-border/20">
              <p className="text-xs text-henry-text leading-relaxed line-clamp-6">{result}</p>
              <button
                onClick={copyResult}
                className="mt-2 text-[10px] text-henry-text-muted hover:text-henry-accent transition-colors flex items-center gap-1"
              >
                {copying ? '✓ Copied' : '⎘ Copy result'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
