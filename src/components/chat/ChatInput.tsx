import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store';
import { transcribeWithGroq } from '../../henry/ttsService';
import { useAmbientStore } from '../../henry/ambientStateStore';
import {
  useVoiceStore,
  voiceIpcAvailable,
  getVoiceSttStatus,
  runVoiceSetup,
  transcribeLocal,
  stopSpeaking,
} from '../../henry/voice';
import { toast } from '../ui/Toast';
import { AttachmentPicker, uploadAttachments } from './MessageAttachments';

interface ChatInputProps {
  onSend: (content: string) => void;
  isStreaming: boolean;
  onCancel?: () => void;
  placeholder?: string;
  injectDraft?: { id: number; text: string } | null;
  onInjectConsumed?: () => void;
  ttsEnabled?: boolean;
  onToggleTts?: () => void;
  onSearch?: (query: string) => void;
  isSearching?: boolean;
  onFileIngest?: (content: string, fileName: string) => void;
  ambientMode?: boolean;
  /** Agent mode: when on, Henry can use his tools (calendar, messages, quotes, QuickBooks, web). */
  agentMode?: boolean;
  onToggleAgentMode?: () => void;
  /** Attachments queued for the next message. */
  pendingAttachments?: import('../../types').MessageAttachment[];
  onAttachmentsChange?: (next: import('../../types').MessageAttachment[]) => void;
  conversationId?: string;
}

export default function ChatInput({
  onSend,
  isStreaming,
  onCancel,
  placeholder = 'Message Henry...',
  injectDraft,
  onInjectConsumed,
  ttsEnabled = false,
  onToggleTts,
  onSearch,
  isSearching = false,
  onFileIngest,
  ambientMode = false,
  agentMode = false,
  onToggleAgentMode,
  pendingAttachments = [],
  onAttachmentsChange,
  conversationId,
}: ChatInputProps) {
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const speechRecRef = useRef<any>(null);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);

  // ── Voice stack (FREE local whisper.cpp preferred; Groq fallback) ─────────
  const sttReady = useVoiceStore((s) => s.sttReady);
  const handsFree = useVoiceStore((s) => s.handsFree);
  const setHandsFree = useVoiceStore((s) => s.setHandsFree);
  const voiceState = useVoiceStore((s) => s.state);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [voiceSetupBusy, setVoiceSetupBusy] = useState(false);
  const [voiceSetupProgress, setVoiceSetupProgress] = useState<HenryVoiceSetupProgress | null>(null);
  const [voiceSetupError, setVoiceSetupError] = useState<string | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;

  const groqKeyPresent = providers.some((p) => p.id === 'groq' && p.apiKey);

  // Probe local whisper readiness once (Electron only).
  useEffect(() => {
    if (voiceIpcAvailable()) void getVoiceSttStatus();
  }, []);

  // Live recording timer.
  useEffect(() => {
    if (!listening) {
      setRecordSeconds(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setRecordSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [listening]);

  async function startVoiceSetup() {
    setVoiceSetupBusy(true);
    setVoiceSetupError(null);
    try {
      const status = await runVoiceSetup((p) => setVoiceSetupProgress(p));
      if (status.ready) {
        setShowVoiceSetup(false);
        toast.success('Free voice is ready — tap the mic and talk.');
      } else {
        setVoiceSetupError('Setup finished but voice is still not ready — check Settings → Voice.');
      }
    } catch (e) {
      setVoiceSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoiceSetupBusy(false);
      setVoiceSetupProgress(null);
    }
  }

  // Handle global henry_focus_input event (from keyboard shortcut Cmd+K)
  useEffect(() => {
    function handleFocusInput() {
      textareaRef.current?.focus();
    }
    window.addEventListener('henry_focus_input', handleFocusInput);
    return () => window.removeEventListener('henry_focus_input', handleFocusInput);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) {
      textareaRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!injectDraft?.text) return;
    setInput(injectDraft.text);
    onInjectConsumed?.();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [injectDraft?.id, injectDraft?.text, onInjectConsumed]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stop();
      }
      speechRecRef.current?.stop();
    };
  }, []);

  // Ambient mode: auto-start mic when TTS finishes speaking
  useEffect(() => {
    if (!ambientMode || !ttsEnabled) return;
    function onTtsDone() {
      if (!isStreaming) {
        startGroqWhisper();
      }
    }
    window.addEventListener('henry_tts_done', onTtsDone);
    return () => window.removeEventListener('henry_tts_done', onTtsDone);
  }, [ambientMode, ttsEnabled, isStreaming]);

  async function startGroqWhisper() {
    useAmbientStore.getState().setState('listening');
    useAmbientStore.getState().startSession();
    try {
      // macOS TCC: fire the system mic prompt from the main process BEFORE
      // getUserMedia — packaged apps fail silently without the OS grant.
      if (window.henryAPI?.voiceMicAccess) {
        const access = await window.henryAPI.voiceMicAccess();
        if (!access.granted) {
          useAmbientStore.getState().setState('idle');
          toast.error(
            access.status === 'denied' || access.status === 'restricted'
              ? 'Microphone is off for Henry — I opened System Settings → Privacy & Security → Microphone. Flip Henry AI on, then tap the mic again.'
              : 'Microphone permission not granted — tap the mic again and click OK on the system prompt.',
          );
          return;
        }
      }

      // Detect supported audio MIME type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        speechRecRef.current?.stop();
        transcribeAudio();
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setListening(true);
      setInterimTranscript('');

      // Start SpeechRecognition for live interim display (Chrome/Edge/Android)
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SR) {
        try {
          const rec = new SR();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = 'en-US';
          rec.onresult = (e: any) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
            }
            if (interim) setInterimTranscript(interim);
          };
          rec.onerror = () => { /* ignore — Groq transcription is the source of truth */ };
          rec.start();
          speechRecRef.current = rec;
        } catch { /* SpeechRecognition not available — graceful degrade */ }
      }
    } catch (err) {
      useAmbientStore.getState().setState('idle');
      const name = (err as DOMException)?.name;
      toast.error(
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone → Henry AI.'
          : name === 'NotFoundError'
          ? 'No microphone found — plug one in or check your input device.'
          : `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function stopGroqWhisper() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    speechRecRef.current?.stop();
    speechRecRef.current = null;
    setListening(false);
    setTranscribing(true);
    setInterimTranscript('');
    useAmbientStore.getState().setState('thinking');
  }

  async function transcribeAudio() {
    try {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      if (blob.size < 1000) {
        setTranscribing(false);
        return;
      }

      const allProviders = await window.henryAPI.getProviders();
      const s = useStore.getState().settings;

      let transcript: string | undefined;

      // 1. FREE local whisper.cpp — the default when set up (works offline).
      // Don't gate on the sttReady store flag (it can lag the mount-time status
      // fetch); transcribeLocal fails fast with a clear error if not set up.
      if (voiceIpcAvailable()) {
        try {
          transcript = await transcribeLocal(blob);
        } catch (err) {
          console.warn('Local whisper failed, trying cloud fallback:', err);
        }
      }

      // 2. Groq Whisper fallback (needs a key + internet).
      if (!transcript && window.henryAPI.whisperTranscribe) {
        const groqProvider = allProviders.find((p: any) => p.id === 'groq');
        const apiKey = groqProvider?.api_key || groqProvider?.apiKey || '';
        if (apiKey) {
          transcript = await window.henryAPI.whisperTranscribe(blob, apiKey);
        }
      }

      // 3. Web path — Groq Whisper via fetch.
      if (!transcript) {
        transcript = await transcribeWithGroq(blob, s, allProviders);
      }

      const text = transcript?.trim();
      if (text) {
        if (handsFreeRef.current) {
          // Hands-free: send it straight to Henry — the reply is spoken back.
          setTranscribing(false);
          useVoiceStore.getState().setUserTyped(false);
          onSend(text);
          return;
        }
        setInput((prev) => prev ? `${prev} ${text}` : text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            el.focus();
          }
        });
      }
    } catch (err) {
      console.warn('Whisper transcription failed:', err);
      toast.error(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setTranscribing(false);
      useAmbientStore.getState().setState('ready');
    }
  }

  function toggleVoice() {
    if (listening) {
      stopGroqWhisper();
      return;
    }
    // No local whisper yet and no cloud key → offer the one-time free setup.
    if (voiceIpcAvailable() && sttReady === false && !groqKeyPresent) {
      setShowVoiceSetup(true);
      return;
    }
    startGroqWhisper();
  }

  function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    if (listening) stopGroqWhisper();
    useVoiceStore.getState().setUserTyped(false);
    onSend(trimmed);
    setInput('');
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleFileUpload(file: File) {
    if (!onFileIngest) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['txt', 'md', 'json', 'csv', 'js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'xml', 'yaml', 'yml'].includes(ext) && file.type !== 'text/plain') {
      // For non-text, just pass metadata
      onFileIngest(`[File: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — binary or unsupported format. Describe what you'd like to do with it.]`, file.name);
      return;
    }
    try {
      const text = await file.text();
      const preview = text.length > 12000 ? text.slice(0, 12000) + '\n\n[... file truncated at 12,000 chars]' : text;
      onFileIngest(preview, file.name);
    } catch {
      onFileIngest(`[Could not read ${file.name}]`, file.name);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && onFileIngest) handleFileUpload(file);
  }

  const micAvailable = !!navigator.mediaDevices?.getUserMedia;

  return (
    <div
      className={`relative transition-all ${dragOver ? 'ring-2 ring-henry-accent/50 rounded-xl' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 rounded-xl bg-henry-accent/10 border-2 border-dashed border-henry-accent/50 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-sm text-henry-accent font-medium">Drop to send to Henry</p>
        </div>
      )}

      {/* One-time free voice setup card — shown when whisper isn't ready yet */}
      {showVoiceSetup && (
        <div className="mb-2 rounded-xl border border-henry-accent/30 bg-henry-accent/5 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-henry-text">Set up free voice</p>
              <p className="text-[11px] text-henry-text-muted mt-0.5 leading-relaxed">
                One-time download (~150MB). Henry listens with Whisper running on your Mac —
                free, private, works offline.
              </p>
              {voiceSetupBusy && (
                <div className="mt-2">
                  <div className="h-1.5 rounded-full bg-henry-border/40 overflow-hidden">
                    <div
                      className="h-full bg-henry-accent transition-all"
                      style={{ width: `${voiceSetupProgress?.pct ?? 5}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-henry-text-muted mt-1">
                    {voiceSetupProgress?.message ?? 'Preparing…'}
                    {voiceSetupProgress?.total
                      ? ` ${(Math.round((voiceSetupProgress.downloaded ?? 0) / 1048576))} / ${Math.round(voiceSetupProgress.total / 1048576)} MB`
                      : ''}
                  </p>
                </div>
              )}
              {voiceSetupError && (
                <p className="text-[11px] text-henry-error mt-1.5">{voiceSetupError}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!voiceSetupBusy && (
                <button
                  onClick={() => void startVoiceSetup()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-henry-accent text-white hover:bg-henry-accent-hover transition-colors"
                >
                  Set up
                </button>
              )}
              <button
                onClick={() => setShowVoiceSetup(false)}
                className="text-henry-text-muted hover:text-henry-text px-1"
                title="Not now"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2 bg-henry-bg/80 border border-henry-border rounded-xl px-4 py-3 focus-within:border-henry-accent/50 transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Manual typing means: don't auto-speak the reply the user is now editing past.
            if (e.target.value.trim()) useVoiceStore.getState().setUserTyped(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={listening ? 'Listening… tap mic to stop' : transcribing ? 'Transcribing…' : placeholder}
          rows={1}
          className="flex-1 bg-transparent text-sm text-henry-text placeholder-henry-text-muted outline-none resize-none max-h-[200px]"
          disabled={transcribing}
        />

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Mic button — local whisper.cpp, Groq fallback — first and prominent */}
          {micAvailable && (
            <button
              onClick={toggleVoice}
              disabled={transcribing || isStreaming}
              title={
                listening
                  ? 'Stop recording'
                  : transcribing
                  ? 'Transcribing…'
                  : sttReady
                  ? 'Voice input (free local Whisper)'
                  : groqKeyPresent
                  ? 'Voice input (Groq Whisper)'
                  : 'Voice input — one-time free setup'
              }
              className={`p-2.5 rounded-xl transition-all ${
                listening
                  ? 'bg-henry-error/20 text-henry-error animate-pulse hover:bg-henry-error/30 ring-1 ring-henry-error/40'
                  : transcribing
                  ? 'text-henry-accent animate-pulse bg-henry-accent/10'
                  : isStreaming
                  ? 'text-henry-text-muted opacity-40 cursor-not-allowed'
                  : 'text-henry-text-muted hover:text-henry-accent hover:bg-henry-accent/10'
              }`}
            >
              {transcribing ? (
                <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          )}

          {/* Hands-free toggle — voice in, voice out: transcript auto-sends, reply is spoken */}
          {micAvailable && voiceIpcAvailable() && (
            <button
              onClick={() => setHandsFree(!handsFree)}
              title={
                handsFree
                  ? 'Hands-free ON — your words send automatically and Henry speaks his reply'
                  : 'Hands-free mode — talk, Henry answers out loud'
              }
              aria-pressed={handsFree}
              className={`p-2 rounded-lg transition-all ${
                handsFree
                  ? 'bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30 ring-1 ring-henry-accent/40'
                  : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/50'
              }`}
            >
              {/* headset icon */}
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
            </button>
          )}

          {/* Stop speaking — visible while Henry is talking */}
          {voiceState === 'speaking' && (
            <button
              onClick={() => void stopSpeaking()}
              title="Stop speaking"
              className="p-2 rounded-lg bg-henry-error/15 text-henry-error hover:bg-henry-error/25 transition-all animate-pulse"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="16" y1="9" x2="22" y2="15" />
                <line x1="22" y1="9" x2="16" y2="15" />
              </svg>
            </button>
          )}

          {/* Agent mode toggle — lets Henry use his tools (calendar, messages, quotes, QuickBooks, web) */}
          {onToggleAgentMode && (
            <button
              onClick={onToggleAgentMode}
              title={
                agentMode
                  ? 'Agent mode ON — Henry can use his tools (calendar, messages, quotes, QuickBooks, web). Sending actions still asks first.'
                  : 'Agent mode OFF — turn on to let Henry use his tools'
              }
              aria-pressed={agentMode}
              className={`p-2 rounded-lg transition-all ${
                agentMode
                  ? 'bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30'
                  : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/50'
              }`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          )}

          {/* TTS toggle */}
          {onToggleTts && (
            <button
              onClick={onToggleTts}
              title={ttsEnabled ? 'Voice responses on — click to mute' : 'Enable voice responses'}
              className={`p-2 rounded-lg transition-all ${
                ttsEnabled
                  ? 'bg-henry-accent/20 text-henry-accent hover:bg-henry-accent/30'
                  : 'text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/50'
              }`}
            >
              {ttsEnabled ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
          )}

          {/* File/Document ingest button */}
          {onAttachmentsChange && !isStreaming && (
            <AttachmentPicker
              attachments={pendingAttachments}
              disabled={isStreaming}
              onAdd={(files) => {
                void uploadAttachments(files, conversationId).then((saved) => {
                  if (saved.length) onAttachmentsChange([...pendingAttachments, ...saved]);
                });
              }}
              onRemove={(id) => {
                void window.henryAPI.deleteAttachment(id);
                onAttachmentsChange(pendingAttachments.filter((a) => a.id !== id));
              }}
            />
          )}

          {onFileIngest && !isStreaming && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Send a file to Henry"
                className="p-2 rounded-lg text-henry-text-muted hover:text-henry-text hover:bg-henry-hover/50 transition-all"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </>
          )}

          {/* Web search button */}
          {onSearch && !isStreaming && (
            <button
              onClick={() => { const q = input.trim(); if (q) onSearch(q); }}
              disabled={!input.trim() || isSearching}
              title="Search the web for this query"
              className={`p-2 rounded-lg transition-all ${
                isSearching
                  ? 'text-henry-accent animate-pulse bg-henry-accent/10'
                  : input.trim()
                  ? 'text-henry-text-muted hover:text-henry-accent hover:bg-henry-accent/10'
                  : 'text-henry-text-muted opacity-40 cursor-not-allowed'
              }`}
            >
              {isSearching ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              )}
            </button>
          )}

          {/* Send / Stop */}
          {isStreaming ? (
            <button
              onClick={onCancel}
              disabled={!onCancel}
              className="p-2 rounded-lg bg-henry-error/10 text-henry-error hover:bg-henry-error/20 transition-colors disabled:opacity-50"
              title="Stop generating"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || transcribing}
              className={`p-2 rounded-lg transition-all ${
                input.trim() && !transcribing
                  ? 'bg-henry-accent text-white hover:bg-henry-accent-hover'
                  : 'bg-henry-hover text-henry-text-muted cursor-not-allowed'
              }`}
              title="Send message (Enter)"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 px-1 min-h-[18px]">
        <span className="text-[10px] text-henry-text-muted flex items-center gap-1.5 overflow-hidden">
          {listening ? (
            <span className="flex items-center gap-1.5 text-henry-error font-medium">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-henry-error animate-pulse" />
              <span className="tabular-nums">
                {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
              </span>
              {interimTranscript
                ? <span className="text-henry-text font-normal truncate max-w-[280px]">{interimTranscript}</span>
                : handsFree ? 'Listening (hands-free)… tap mic to send' : 'Listening… tap mic to stop'}
            </span>
          ) : transcribing ? (
            <span className="flex items-center gap-1.5 text-henry-accent">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-henry-accent animate-pulse" />
              {sttReady ? 'Transcribing locally with Whisper…' : 'Transcribing with Whisper…'}
            </span>
          ) : voiceState === 'speaking' ? (
            <span className="flex items-center gap-1.5 text-henry-accent">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-henry-accent animate-pulse" />
              Henry is speaking…
            </span>
          ) : (
            <>
              <span className="hidden sm:inline">Enter to send · Shift+Enter for new line · Drop files here</span>
              <span className="sm:hidden">Tap ↑ to send</span>
            </>
          )}
        </span>
        {isStreaming && (
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="typing-dot" />
            <div className="typing-dot" />
            <div className="typing-dot" />
          </div>
        )}
      </div>
    </div>
  );
}
