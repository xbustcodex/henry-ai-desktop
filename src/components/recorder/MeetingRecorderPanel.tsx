import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { saveAudio, loadAudioURL, deleteAudio } from '../../henry/audioStorage';
import { henryQuickAsk } from '../../henry/henryQuickAsk';
import { safeCopyToClipboard } from '../../utils/clipboardSafe';

interface Recording {
  id: string;
  title: string;
  date: string;
  duration: number;
  transcript?: string;
  summary?: string;
  actionItems?: string[];
}

const RECORDINGS_KEY = 'henry:recordings';

function loadRecordings(): Recording[] {
  try { return JSON.parse(localStorage.getItem(RECORDINGS_KEY) || '[]'); } catch { return []; }
}

function saveRecordings(recs: Recording[]) {
  try { localStorage.setItem(RECORDINGS_KEY, JSON.stringify(recs.slice(0, 30))); } catch { /* ignore */ }
}

async function persistRecording(r: Recording) {
  try {
    const api = (window as any).henryAPI;
    if (api?.recordingsSave) {
      await api.recordingsSave?.({
        id: r.id, title: r.title, durationSecs: r.duration,
        transcript: r.transcript, summary: r.summary,
        actionItems: [], recordedAt: r.date,
      });
    }
  } catch { /* non-critical */ }
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function MeetingRecorderPanel() {
  const settings = useStore((s) => s.settings);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [copied, setCopied] = useState(false);
  // Audio playback
  const [audioURL, setAudioURL] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const prevAudioURLRef = useRef<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const mimeTypeRef = useRef<string>('audio/webm');

  useEffect(() => {
    const all = loadRecordings();
    setRecordings(all);
    if (all.length > 0) setSelectedRecording(all[0]);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Load audio when selection changes
  useEffect(() => {
    // Revoke previous URL to avoid memory leaks
    if (prevAudioURLRef.current) {
      URL.revokeObjectURL(prevAudioURLRef.current);
      prevAudioURLRef.current = null;
    }
    setAudioURL(null);
    setAudioAvailable(false);

    if (!selectedRecording) return;
    let cancelled = false;
    setLoadingAudio(true);
    loadAudioURL(selectedRecording.id).then((url) => {
      if (cancelled) return;
      setLoadingAudio(false);
      if (url) {
        setAudioURL(url);
        setAudioAvailable(true);
        prevAudioURLRef.current = url;
      } else {
        setAudioAvailable(false);
      }
    }).catch(() => {
      if (!cancelled) setLoadingAudio(false);
    });
    return () => { cancelled = true; };
  }, [selectedRecording?.id]);

  function refreshRecordings(updated?: Recording[]) {
    const all = updated ?? loadRecordings();
    setRecordings(all);
  }

  function getSupportedMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
    for (const type of candidates) {
      if (type === '' || MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  async function startRecording() {
    try {
      const { ensureMicAccess } = await import('../../henry/voice');
      await ensureMicAccess();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mimeTypeRef.current = mr.mimeType || mimeType || 'audio/webm';
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(1000);
      mediaRecorderRef.current = mr;
      startTimeRef.current = Date.now();
      setRecording(true);
      setElapsed(0);
      setStatus('Recording…');
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch {
      setStatus('Microphone access denied. Allow mic permission and try again.');
    }
  }

  async function stopRecording() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
    setProcessing(true);
    setStatus('Processing audio…');
    const durationSecs = Math.floor((Date.now() - startTimeRef.current) / 1000);
    await new Promise<void>((res) => setTimeout(res, 500));
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
    await processRecording(blob, durationSecs);
  }

  async function processRecording(blob: Blob, durationSecs: number) {
    const id = `rec_${Date.now()}`;
    try {
      // Save audio blob to IndexedDB immediately so playback works even if transcription fails
      try { await saveAudio(id, blob); } catch { /* non-fatal */ }

      const providers = await window.henryAPI.getProviders();
      const groqProvider = providers.find((p: any) => p.id === 'groq');
      const apiKey = groqProvider?.api_key || groqProvider?.apiKey || '';

      let transcript = '';
      if (apiKey && window.henryAPI.whisperTranscribe) {
        try {
          setStatus('Transcribing…');
          transcript = await window.henryAPI.whisperTranscribe(blob, apiKey);
        } catch {
          transcript = '[Transcription unavailable — configure Groq API key for Whisper]';
        }
      } else {
        transcript = '[Transcription unavailable — configure Groq API key in Settings → AI Providers]';
      }

      setStatus('Summarizing…');
      let summary = '';
      let actionItems: string[] = [];

      const companionProvider = settings.companion_provider;
      const companionModel = settings.companion_model;
      if (companionProvider && companionModel && transcript && !transcript.startsWith('[')) {
        const provider = providers.find((p: any) => p.id === companionProvider);
        if (provider) {
          try {
            const res = await window.henryAPI.sendMessage({
              provider: companionProvider,
              model: companionModel,
              apiKey: provider.api_key || provider.apiKey || '',
              messages: [
                { role: 'system', content: 'You extract meeting summaries and action items. Be concise and structured.' },
                { role: 'user', content: `Transcript:\n\n${transcript}\n\nProvide:\n1. A 3-5 sentence summary\n2. Action items (as a JSON array of strings)\n\nFormat: SUMMARY:\n...\n\nACTION_ITEMS:\n["item1","item2"]` },
              ],
              temperature: 0.3,
              maxTokens: 1000,
            });
            const content = (res as any)?.content || '';
            const summaryMatch = content.match(/SUMMARY:\s*([\s\S]*?)(?=ACTION_ITEMS:|$)/);
            const actionMatch = content.match(/ACTION_ITEMS:\s*(\[[\s\S]*?\])/);
            summary = summaryMatch?.[1]?.trim() || content;
            try { actionItems = JSON.parse(actionMatch?.[1] || '[]'); } catch { actionItems = []; }
          } catch { /* skip summarization */ }
        }
      }

      const title = meetingTitle.trim() || `Meeting — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const rec: Recording = { id, title, date: new Date().toISOString(), duration: durationSecs, transcript, summary, actionItems };

      const all = [rec, ...loadRecordings()];
      saveRecordings(all);
      setRecordings(all);
      setSelectedRecording(rec);
      setMeetingTitle('');
      setStatus('');

      // Persist full record (with transcript + summary) to SQLite
      void persistRecording(rec);

      // Create tasks for each action item
      if (actionItems.length > 0) {
        const api = (window as any).henryAPI;
        for (const item of actionItems.slice(0, 5)) {
          try {
            await api.tasksCreate?.({
              id: crypto.randomUUID(),
              title: item,
              status: 'todo',
              priority: 2,
            });
          } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      setStatus(`Error: ${String(err)}`);
    } finally {
      setProcessing(false);
    }
  }

  function renameRecording() {
    if (!selectedRecording || !titleDraft.trim()) { setEditingTitle(false); return; }
    const updated = recordings.map((r) =>
      r.id === selectedRecording.id ? { ...r, title: titleDraft.trim() } : r
    );
    saveRecordings(updated);
    const updatedRec = { ...selectedRecording, title: titleDraft.trim() };
    setSelectedRecording(updatedRec);
    refreshRecordings(updated);
    setEditingTitle(false);
  }

  async function copyTranscript() {
    if (!selectedRecording?.transcript) return;
    // A bare writeText rejects with "Document is not focused" whenever the
    // Henry window is in the background, and the .then() had no .catch(), so
    // that surfaced as an unhandled rejection.
    if (await safeCopyToClipboard(selectedRecording.transcript)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function exportRecording() {
    if (!selectedRecording) return;
    const lines = [
      `# ${selectedRecording.title}`,
      `Date: ${formatDate(selectedRecording.date)}`,
      `Duration: ${formatDuration(selectedRecording.duration)}`,
      '',
    ];
    if (selectedRecording.summary) lines.push('## Summary', selectedRecording.summary, '');
    if (selectedRecording.actionItems?.length) {
      lines.push('## Action Items', ...selectedRecording.actionItems.map((i) => `- ${i}`), '');
    }
    if (selectedRecording.transcript) lines.push('## Transcript', selectedRecording.transcript);
    const b = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = `${selectedRecording.title.replace(/[^a-z0-9]/gi, '_')}.txt`;
    a.click(); URL.revokeObjectURL(url);
  }

  function sendToWorkspace() {
    if (!selectedRecording) return;
    const prompt = [
      `Save this meeting note to my workspace:`,
      `Title: ${selectedRecording.title}`,
      `Date: ${formatDate(selectedRecording.date)}`,
      selectedRecording.summary ? `Summary: ${selectedRecording.summary}` : '',
      selectedRecording.actionItems?.length ? `Action items: ${selectedRecording.actionItems.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    window.dispatchEvent(new CustomEvent('henry_mode_launch', { detail: { mode: 'secretary', prompt } }));
    useStore.getState().setCurrentView('chat');
  }

  async function deleteRecording(id: string) {
    if (!confirm('Delete this recording?')) return;
    try { await deleteAudio(id); } catch { /* non-fatal */ }
    const updated = recordings.filter((r) => r.id !== id);
    saveRecordings(updated);
    setRecordings(updated);
    if (selectedRecording?.id === id) setSelectedRecording(null);
  }

  return (
    <div className="h-full flex flex-col bg-henry-bg">
      <div className="shrink-0 px-6 py-4 border-b border-henry-border/50">
        <div className="flex items-center justify-between w-full">
                <h1 className="text-lg font-semibold text-henry-text">Recorder</h1>
                <button
                onClick={() => henryQuickAsk({ prompt: 'Help me prepare for or debrief this meeting. What should I cover? What action items should I capture?' })}
                className="text-[11px] px-3 py-1.5 rounded-lg bg-henry-accent/10 text-henry-accent hover:bg-henry-accent/20 transition-all"
              >🧠 Ask Henry</button>
              </div>
        <p className="text-xs text-henry-text-muted mt-0.5">Record meetings — get transcripts, summaries, and action items</p>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Left: recorder + library */}
        <div className="w-64 shrink-0 border-r border-henry-border/30 flex flex-col">
          {/* Record controls */}
          <div className="p-4 space-y-3 border-b border-henry-border/20">
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              placeholder="Meeting title (optional)"
              disabled={recording || processing}
              className="w-full bg-henry-surface/40 border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder-henry-text-muted outline-none focus:border-henry-accent/40 transition-all disabled:opacity-50"
            />

            <div className="flex flex-col items-center gap-2 py-2">
              <button
                onClick={recording ? stopRecording : startRecording}
                disabled={processing}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                  recording
                    ? 'bg-henry-error animate-pulse hover:bg-henry-error/80'
                    : processing
                    ? 'bg-henry-surface border-2 border-henry-border/30 opacity-50 cursor-not-allowed'
                    : 'bg-henry-error/20 border-2 border-henry-error/40 hover:bg-henry-error/30 hover:border-henry-error/60'
                }`}
              >
                {recording ? (
                  <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : processing ? (
                  <svg className="w-6 h-6 text-henry-text-muted animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-henry-error" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="8" />
                  </svg>
                )}
              </button>

              {recording && (
                <div className="text-center">
                  <p className="text-xl font-bold font-mono text-henry-error tabular-nums">{formatDuration(elapsed)}</p>
                  <p className="text-xs text-henry-text-muted">Recording — tap to stop</p>
                </div>
              )}
              {status && !recording && (
                <p className="text-xs text-henry-text-muted text-center animate-pulse">{status}</p>
              )}
              {!recording && !processing && !status && (
                <p className="text-xs text-henry-text-muted">Tap to start</p>
              )}
            </div>
          </div>

          {/* Library */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-3 py-2.5 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-henry-text-muted">
                Recordings {recordings.length > 0 && `(${recordings.length})`}
              </p>
            </div>

            {recordings.length === 0 && (
              <div className="px-4 py-6 text-center">
                <div className="text-3xl mb-2">🎙</div>
                <p className="text-xs text-henry-text-muted">No recordings yet</p>
              </div>
            )}

            <div className="space-y-1 px-2 pb-3">
              {recordings.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRecording(r)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all ${
                    selectedRecording?.id === r.id
                      ? 'bg-henry-accent/10 border-henry-accent/25 text-henry-accent'
                      : 'bg-henry-surface/20 border-henry-border/20 text-henry-text-dim hover:text-henry-text hover:bg-henry-surface/40'
                  }`}
                >
                  <p className="text-xs font-medium truncate">{r.title}</p>
                  <p className="text-[10px] text-henry-text-muted mt-0.5">
                    {formatDuration(r.duration)} · {formatDate(r.date)}
                    {r.summary && ' · summarized'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: detail view */}
        <div className="flex-1 overflow-y-auto">
          {!selectedRecording ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-xs">
                <div className="text-4xl mb-3">🎙</div>
                <p className="text-henry-text-muted text-sm">Record a meeting to get a transcript, summary, and action items</p>
                <p className="text-henry-text-muted/60 text-xs mt-2">Uses Groq Whisper · Free with a Groq API key</p>
              </div>
            </div>
          ) : (
            <div className="p-5 max-w-2xl space-y-5">
              {/* Title + actions bar */}
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {editingTitle ? (
                      <input
                        autoFocus
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onBlur={renameRecording}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameRecording();
                          if (e.key === 'Escape') setEditingTitle(false);
                        }}
                        className="w-full bg-henry-surface border border-henry-accent/30 rounded-lg px-2 py-1 text-base font-semibold text-henry-text outline-none"
                      />
                    ) : (
                      <h2 className="text-base font-semibold text-henry-text">{selectedRecording.title}</h2>
                    )}
                    <p className="text-xs text-henry-text-muted mt-1">
                      {formatDate(selectedRecording.date)} · {formatDuration(selectedRecording.duration)}
                    </p>
                  </div>

                  <button
                    onClick={() => deleteRecording(selectedRecording.id)}
                    className="shrink-0 p-1.5 rounded-lg text-henry-text-muted hover:text-henry-error hover:bg-henry-error/10 transition-colors"
                    title="Delete recording"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                    </svg>
                  </button>
                </div>

                {/* Audio player */}
                <div className="mt-3">
                  {loadingAudio ? (
                    <div className="h-10 rounded-xl bg-henry-surface/30 border border-henry-border/20 flex items-center justify-center">
                      <span className="text-xs text-henry-text-muted animate-pulse">Loading audio…</span>
                    </div>
                  ) : audioAvailable && audioURL ? (
                    <div className="rounded-xl bg-henry-surface/30 border border-henry-border/20 p-2">
                      <audio
                        src={audioURL}
                        controls
                        className="w-full h-8"
                        style={{ colorScheme: 'dark' }}
                      />
                    </div>
                  ) : (
                    <div className="h-9 rounded-xl bg-henry-surface/20 border border-henry-border/20 flex items-center px-3 gap-2">
                      <svg className="w-3.5 h-3.5 text-henry-text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" />
                      </svg>
                      <span className="text-[11px] text-henry-text-muted/60">Audio not available for this recording</span>
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    onClick={() => { setEditingTitle(true); setTitleDraft(selectedRecording.title); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-surface/40 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 transition-colors"
                  >
                    ✏️ Rename
                  </button>
                  {selectedRecording.transcript && !selectedRecording.transcript.startsWith('[') && (
                    <button
                      onClick={copyTranscript}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-surface/40 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 transition-colors"
                    >
                      {copied ? '✓ Copied' : '📋 Copy transcript'}
                    </button>
                  )}
                  <button
                    onClick={exportRecording}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-surface/40 border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-border/60 transition-colors"
                  >
                    ⬇️ Export
                  </button>
                  <button
                    onClick={sendToWorkspace}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-henry-accent/10 border border-henry-accent/20 text-henry-accent hover:bg-henry-accent/20 transition-colors"
                  >
                    📂 Send to workspace
                  </button>
                </div>
              </div>

              {/* Summary */}
              {selectedRecording.summary && (
                <div className="rounded-xl border border-henry-accent/20 bg-henry-accent/5 p-4">
                  <p className="text-[11px] font-medium text-henry-accent uppercase tracking-wide mb-2">Summary</p>
                  <p className="text-sm text-henry-text-dim leading-relaxed">{selectedRecording.summary}</p>
                </div>
              )}

              {/* Action items */}
              {selectedRecording.actionItems && selectedRecording.actionItems.length > 0 && (
                <div className="rounded-xl border border-henry-border/30 bg-henry-surface/20 p-4">
                  <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wide mb-3">Action Items</p>
                  <div className="space-y-2">
                    {selectedRecording.actionItems.map((item, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-henry-accent mt-1.5 shrink-0" />
                        <p className="text-sm text-henry-text">{item}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Transcript */}
              {selectedRecording.transcript && (
                <div className="rounded-xl border border-henry-border/20 bg-henry-surface/10 p-4">
                  <p className="text-[11px] font-medium text-henry-text-muted uppercase tracking-wide mb-2">Transcript</p>
                  <p className="text-xs text-henry-text-dim leading-relaxed whitespace-pre-wrap">{selectedRecording.transcript}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
