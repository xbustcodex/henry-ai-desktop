import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { matchesTriggerPhrase, launchDemo } from '../../henry/creatorsActivation';
import { incrementUsage, getTodayUsage, getRemainingRequests, isNearLimit, canUseHenryProxy } from '../../henry/proxyUsage';
import { hasUsableBackend, getBackendStatus } from '../../henry/backendStatus';
import { toast, promptDialog } from '../ui/Toast';
import { useStore } from '../../store';
import { useAmbientStore } from '../../henry/ambientStateStore';
import type { HenryLeanMemoryParts, Message } from '../../types';
import ChatInput from './ChatInput';
import EngineSelector from './EngineSelector';
import MemoryAwarenessPanel from './MemoryAwarenessPanel';
import Design3DReferencePanel from './Design3DReferencePanel';
import WriterDraftLibrary from './WriterDraftLibrary';
import CreateTaskFromMessageModal from './CreateTaskFromMessageModal';
import WorkspaceContextStrip from './WorkspaceContextStrip';
import ExportPackBuilder from './ExportPackBuilder';
import MessageBubble from './MessageBubble';
import { isMacOS, isLinux, isWindows } from '../../utils/platform';
import {
  buildCompanionStreamSystemPrompt,
  buildLightSystemPrompt,
  buildMediumSystemPrompt,
  buildAwarenessSummary,
  HENRY_OPERATING_MODES,
  type HenryOperatingMode,
  isHenryOperatingMode,
  buildGroqFreeSystemPrompt,
} from '@/henry/charter';
import {
  classifyMessageIntent,
  selectContextTier,
  trimHistoryToTokenBudget,
  estimateTokens,
  TOKEN_HARD_LIMIT,
  TIER_HISTORY_CAPS,
  TIER_MEMORY_CAPS,
  logContextDecision,
  type ContextTier,
  type MessageIntent,
} from '@/henry/contextTier';
import { routeRequest } from '@/core/router/brainRouter';
import { routeLocally } from '@/henry/localRouter';
import { useDebugStore } from '@/henry/debugStore';
import { getWeather, type WeatherSnapshot } from '@/henry/weatherContext';
import {
  buildFallbackNotice,
  buildBothFailedError,
  buildStreamError,
  buildStartError,
  buildBinaryContentError,
  isBinaryContent,
} from '@/henry/errorMessages';
import { resolveChat, requiresQualityModel, modelShortName } from '@/henry/modelRouter';
import { cancelTTS } from '@/henry/ttsService';
import {
  useVoiceStore,
  speakAssistantReply,
  stopSpeaking as voiceStopSpeaking,
  VOICE_REPLIES_SETTING_KEY,
} from '@/henry/voice';
import { recordUsage } from '@/henry/savingsEngine';
import { runAutoMemory } from '@/henry/autoMemory';
import { extractFactsFromConversation, addFacts, persistFactsToDb, buildMemoryContext } from '@/henry/memoryPipeline';
import { getSmartSuggestions, type SmartSuggestion } from '@/henry/smartSuggestions';
import { trackUsage } from '@/henry/henryAnalytics';
import { shouldSummarize, buildSummaryPrompt, saveSessionSummary, getSessionSummary } from '@/henry/contextSummary';
import { getPresencePhrase, speakPresence, detectPresenceTier } from '@/henry/ambientBrain';
import {
  buildHenryMemoryContextBlock,
  capMessageContent,
  sliceRecentThreadMessages,
} from '@/henry/memoryContext';
import {
  DEFAULT_WRITER_DOCUMENT_TYPE_ID,
  WRITER_DOCUMENT_TYPES,
  type WriterDocumentTypeId,
  getWriterDocumentType,
  isWriterDocumentTypeId,
} from '@/henry/documentTypes';
import { defaultWriterDraftRelativePath } from '@/henry/documentFilename';
import { prependWriterDraftMetadata } from '@/henry/writerDraftMetadata';
import {
  HENRY_WRITER_CONTEXT_CHANGED_EVENT,
  readWriterActiveDraftPath,
  setWriterActiveDraftPath,
} from '@/henry/writerDraftContext';
import {
  DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID,
  DESIGN3D_WORKFLOW_TYPES,
  type Design3DWorkflowTypeId,
  getDesign3DWorkflowType,
  isDesign3DWorkflowTypeId,
} from '@/henry/design3dTypes';
import { defaultDesign3DPlanRelativePath } from '@/henry/design3dFilename';
import { prependDesign3dPlanMetadata } from '@/henry/design3dPlanMetadata';
import {
  buildDesign3dReferenceFilesNote,
  clearDesign3dReferencePath,
  HENRY_DESIGN3D_REF_CHANGED_EVENT,
  readLastWorkspaceFilePath,
} from '@/henry/design3dReferenceContext';
import {
  buildSuggestedTaskFromMessage,
  resolveWorkspaceLinkageForTask,
  shouldOfferCreateTaskFromMessage,
} from '@/henry/taskFromMessage';
import type { ActiveWorkspaceContext } from '@/henry/workspaceContext';
import {
  buildWorkspaceContextPromptSection,
  clearActiveWorkspaceContext,
  findIndexHintForContext,
  HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT,
  readActiveWorkspaceContext,
} from '@/henry/workspaceContext';
import type { ExportPresetId } from '@/henry/exportBundle';
import { exportConversation } from '@/henry/exportConversation';
import { interceptAndExecute } from '@/henry/actionInterceptor';
import { route as gatewayRoute, trackCost } from '@/henry/gateway';
import {
  checkSessionPathsStale,
  clearRecoveryBannerDismissedThisSession,
  clearSavedSessionResume,
  readSavedSessionResume,
  recoveryBannerDismissedThisAppSession,
  saveSessionResumeSnapshot,
  setRecoveryBannerDismissedThisSession,
  type SavedSessionStateV1,
  type SessionPathStaleReport,
} from '@/henry/sessionResume';
import { parseUserCommandLine, type HenryCommand } from '@/henry/commandLayer';
import { resolveHenryCommand } from '@/henry/commandActions';
import {
  webSearch,
  formatSearchResultsForHenry,
  fetchPageContent,
  formatPageContentForHenry,
  autoShouldSearch,
  extractUrlsFromText,
  getSearchApiKeys,
} from '@/henry/webSearch';
import {
  shouldUseWebTools,
  runWebTools,
  formatSourceCitations,
  type WebSource,
} from '@/henry/webTools';
import { shouldUseSelfTools, runSelfTools } from '@/henry/selfRepairTools';
import { logError } from '@/henry/selfRepairStore';
import { logAction } from '@/henry/auditLog';
import { extractHtmlFromMessage } from '@/henry/builderPreview';
import { detectEmotionalState, buildEmotionBlock } from '@/henry/emotionDetector';
import { autoSaveCommitments, addWorkingItem } from '@/henry/workingMemory';
import { autoExtractUserCommitments, autoExtractHenryCommitments } from '@/henry/commitmentExtractor';
import {
  sessionStart,
  sessionTick,
  autoIngestPersonalMemory,
  getActiveMemoryBandwidth,
} from '@/henry/sessionLifecycle';
import { formatDeepContext } from '@/henry/memoryRetrieval';
import BuilderPreviewPanel from './BuilderPreviewPanel';
import { useSharedBrainState } from '../../brain/sharedState';
import { hasAnythingToSurface, evaluateInitiative } from '../../core/initiative/initiativeEngine';
import { parseDelegation, executeDelegation, parseAppLink } from '@/henry/delegationInterceptor';
import { logFeatureGap, learnPref } from '@/henry/selfAssessment';
import {
  CODER_ENGINE_SETTING_KEY,
  coderAvailable,
  describeActiveEngine,
  formatToolActivity,
  getCoderStatus,
  isCoderEngineChoice,
  joinTextChunk,
  readCoderSession,
  clearCoderSession,
  runCoderTask,
  saveCoderSession,
} from '@/henry/coderEngine';

const HENRY_OPERATING_MODE_KEY = 'henry_operating_mode';
const HENRY_WRITER_DOCUMENT_TYPE_KEY = 'henry_writer_document_type';
const HENRY_DESIGN3D_WORKFLOW_KEY = 'henry_design3d_workflow_type';

function readStoredOperatingMode(): HenryOperatingMode {
  try {
    const raw = localStorage.getItem(HENRY_OPERATING_MODE_KEY);
    if (raw && isHenryOperatingMode(raw)) return raw;
  } catch {
    /* ignore */
  }
  return 'companion';
}


function readStoredWriterDocumentType(): WriterDocumentTypeId {
  try {
    const raw = localStorage.getItem(HENRY_WRITER_DOCUMENT_TYPE_KEY);
    if (raw && isWriterDocumentTypeId(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_WRITER_DOCUMENT_TYPE_ID;
}

function readStoredDesign3dWorkflow(): Design3DWorkflowTypeId {
  try {
    const raw = localStorage.getItem(HENRY_DESIGN3D_WORKFLOW_KEY);
    if (raw && isDesign3DWorkflowTypeId(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID;
}

const MODE_HUMAN_LABELS: Record<HenryOperatingMode, string> = {
  companion: 'Chat',
  writer: 'Writing',
  developer: 'Code',
  builder: 'App Builder',
  design3d: '3D / Design',
  computer: 'Computer',
  secretary: 'Secretary',
  coach: 'Coach',
  strategic: 'Strategic',
  business: 'Business',
};

function detectModeFromMessage(text: string, currentMode: HenryOperatingMode): HenryOperatingMode {
  const lower = text.toLowerCase();

  const devKeywords = ['debug','bug','error','function','programming','python','javascript',
    'typescript','html','css','react','api','database','algorithm','variable','syntax',
    'compiler','git','github','software','terminal','command','script','loop','array',
    'class','method','exception','null','undefined','import','export','package'];

  const writerPhrases = ['write a','write an','draft a','draft an','help me write',
    'write me a','write me an','give me an essay','an essay about','a letter to',
    'an email to','a story about','a poem about','a report on','an outline for',
    'proofread','edit my writing','cover letter'];

  const designKeywords = ['3d model','blender','room layout','floor plan','architecture',
    'interior design','render','blueprint','furniture layout','kitchen layout',
    'bedroom layout','home office','workspace design','3d print','cad '];

  const secretaryPhrases = ['draft an email','draft email','write an email','send an email',
    'schedule a meeting','schedule meeting','book a meeting','my calendar','my schedule',
    'daily briefing','morning briefing','weekly briefing','meeting prep','prep for',
    'follow up','follow-up','action items','task list','triage my tasks','remind me',
    'out of office','reschedule','cancel my','meeting agenda','who do i owe','waiting on'];

  const computerPhrases = ['run a command','run the command','open the terminal','shell command',
    'bash script','applescript','take a screenshot','screenshot my','open the app',
    'launch the app','automate my','run this script','execute','system command',
    'find the file','move the file','delete the file','computer control'];

  const builderPhrases = ['build a website','build a web app','build an app','build me a',
    'create a website','create a web app','create an app','make a website','make a web app',
    'make me a website','make me an app','landing page','build a landing','build a dashboard',
    'build a tool','build a form','build a game','build a calculator','build a timer',
    'build a portfolio','build me a portfolio','design a website','design a web app',
    'build a todo','build a task','build a budget','build a habit tracker'];

  if (builderPhrases.some((p) => lower.includes(p))) return 'builder';

  if (designKeywords.some((k) => lower.includes(k))) return 'design3d';

  if (secretaryPhrases.some((p) => lower.includes(p))) return 'secretary';

  if (computerPhrases.some((p) => lower.includes(p))) return 'computer';

  if (writerPhrases.some((p) => lower.includes(p))) return 'writer';

  // Code detection — require multiple signals or specific code keywords to avoid false positives
  const devMatches = devKeywords.filter((k) => lower.includes(k)).length;
  if (devMatches >= 2 || (devMatches >= 1 && /[{}\[\]()=>]|```/.test(text))) return 'developer';

  return currentMode;
}

function exportPresetForOperatingMode(mode: HenryOperatingMode): ExportPresetId {
  if (mode === 'writer') return 'writer_handoff';
  if (mode === 'design3d') return 'design3d_handoff';
  if (mode === 'builder') return 'mixed_workspace';
  return 'mixed_workspace';
}

function resumeModeLabel(m: HenryOperatingMode): string {
  if (m === 'design3d') return '3D / design';
  return m.charAt(0).toUpperCase() + m.slice(1);
}


// Henry Cloud Proxy — license-gated only. The developer pays the bill behind it,
// so it is NEVER a fallback for free users. The hard gate `canUseHenryProxy()`
// (in proxyUsage.ts) ensures only users with a valid license key can reach it.
// Free users must BYOK (Groq, Ollama, OpenAI, etc.) or install Ollama.
const HENRY_PROXY_URL = (import.meta as any).env?.VITE_HENRY_PROXY_URL || 'https://henry-proxy.henryai.workers.dev';
const HENRY_PROXY_ENABLED = true; // proxy code path is enabled — but every call is still gated by canUseHenryProxy()
const HENRY_PROXY_MAX_RETRIES = 1;

/**
 * True when a speech rejection is the user's own doing rather than a failure:
 * the stop button, a new outgoing message, or switching TTS off all tear the
 * current utterance down mid-flight. Interrupting Henry is a normal outcome
 * and must never surface as an error.
 */
function isSpeechStop(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /abort|cancel|stopped|stopping|interrupted|killed|sigterm/i.test(msg);
}

/**
 * Speak a finished reply, swallowing the rejection. Stops are silent; a real
 * engine failure (no key, no engine, a spawn error) earns one toast so the
 * user knows voice replies are broken instead of wondering why it went quiet.
 */
function speakReplySafely(
  text: string,
  settings: Record<string, string>,
  providers: unknown[],
): void {
  void speakAssistantReply(text, settings, providers).catch((err: unknown) => {
    if (isSpeechStop(err)) return;
    console.warn('[Henry voice] reply speech failed:', err);
    toast.error(`Voice reply failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export default function ChatView() {
  const {
    messages,
    activeConversationId,
    setActiveConversation,
    addMessage,
    updateMessage,
    setMessages,
    isStreaming,
    setIsStreaming,
    streamingContent,
    setStreamingContent,
    appendStreamingContent,
    companionStatus,
    setCompanionStatus,
    setWorkerStatus,
    settings,
    conversations,
    tasks,
  } = useStore();

  const [selectedEngine, setSelectedEngine] = useState<'companion' | 'worker'>('companion');
  const [operatingMode, setOperatingMode] = useState<HenryOperatingMode>(() => {
    const m = readStoredOperatingMode();
    // Never restore design3d or writer mode on startup — always start in companion
    return (m === 'design3d' || m === 'writer') ? 'companion' : m;
  });
  const [writerDocumentTypeId, setWriterDocumentTypeId] = useState<WriterDocumentTypeId>(
    readStoredWriterDocumentType
  );
  const [design3dWorkflowTypeId, setDesign3dWorkflowTypeId] = useState<Design3DWorkflowTypeId>(
    readStoredDesign3dWorkflow
  );
  const [saveWorkspaceDraftBusy, setSaveWorkspaceDraftBusy] = useState(false);
  const [chatInject, setChatInject] = useState<{ id: number; text: string } | null>(() => {
    // Check for a pending inject stored before navigation (timing safety net)
    try {
      const pending = localStorage.getItem('henry:pending_inject');
      if (pending) {
        localStorage.removeItem('henry:pending_inject');
        return { id: Date.now(), text: pending };
      }
    } catch { /* ignore */ }
    return null;
  });
  const [isSearching, setIsSearching] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<import('../../types').MessageAttachment[]>([]);
  const [lastWebSources, setLastWebSources] = useState<WebSource[]>([]);
  // Coder engine (developer mode): Claude Code CLI default, local qwen fallback
  const [coderStatus, setCoderStatus] = useState<HenryCoderStatus | null>(null);
  const [currentWeather, setCurrentWeather] = useState<WeatherSnapshot | null>(null);
  // Voice replies — persisted as the `voice_replies` setting (legacy key kept in sync).
  const [ttsEnabled, setTtsEnabled] = useState(() => useVoiceStore.getState().voiceReplies);
  const handsFreeVoice = useVoiceStore((s) => s.handsFree);
  // Agent mode (off by default): when on, chat turns are routed through the
  // agent ToolRunner so Henry can use his tools. Confirm-tier actions (send a
  // message, create an event) still pause for approval.
  const [agentMode, setAgentMode] = useState(() => {
    // Default ON so Henry uses his tool crew (generate_video, calendar, web, …)
    // out of the box. Only honor an explicit 'false' the user set via the toggle.
    try { const v = localStorage.getItem('henry_agent_mode'); return v === null ? true : v === 'true'; }
    catch { return true; }
  });
  const toggleAgentMode = () => {
    setAgentMode((prev) => {
      const next = !prev;
      try { localStorage.setItem('henry_agent_mode', String(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const lastSpokenMsgIdRef = useRef<string | null>(null);
  const [design3dRefPath, setDesign3dRefPath] = useState<string | null>(() =>
    readLastWorkspaceFilePath()
  );
  const [writerActiveDraftPath, setWriterActiveDraftPathState] = useState<string | null>(() =>
    readWriterActiveDraftPath()
  );
  const [createTaskFromMessage, setCreateTaskFromMessage] = useState<Message | null>(null);
  const [activeWorkspaceContext, setActiveWorkspaceContextState] = useState<ActiveWorkspaceContext | null>(
    () => readActiveWorkspaceContext()
  );
  const [workspaceContextIndexHint, setWorkspaceContextIndexHint] = useState<string | null>(null);
  const [exportPackOpen, setExportPackOpen] = useState(false);
  const [exportPackPreset, setExportPackPreset] = useState<ExportPresetId>('mixed_workspace');
  const [exportPackSession, setExportPackSession] = useState(0);
  const [recoverySnapshot, setRecoverySnapshot] = useState<SavedSessionStateV1 | null>(null);
  const [recoveryBannerOpen, setRecoveryBannerOpen] = useState(false);
  const [recoveryStale, setRecoveryStale] = useState<SessionPathStaleReport | null>(null);
  const [recoveryConvRestored, setRecoveryConvRestored] = useState(false);
  const [recoveryConvMissing, setRecoveryConvMissing] = useState(false);
  const [memoryPanelSessionHint, setMemoryPanelSessionHint] = useState(false);
  const [autoSwitchNotice, setAutoSwitchNotice] = useState<string | null>(null);
  const [builderPreviewHtml, setBuilderPreviewHtml] = useState<string | null>(null);
  const [builderPreviewOpen, setBuilderPreviewOpen] = useState(false);
  const autoSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<any>(null);
  const sessionAsyncResumeStartedRef = useRef(false);
  const wakeHandleSendRef = useRef<((content: string) => void) | null>(null);

  // ── Proactive initiative surfacing ────────────────────────────────────────
  const [proactiveSuggestion, setProactiveSuggestion] = useState<string | null>(null);
  const [smartSuggestions, setSmartSuggestions] = useState<SmartSuggestion[]>([]);
  const proactiveFiredRef = useRef(false);
  const { priorityReadyAt } = useSharedBrainState();

  // When the background brain has run and the conversation is empty,
  // ask the initiative engine if there's anything worth saying first.
  useEffect(() => {
    if (proactiveFiredRef.current) return;         // only once per session
    if (messages.length > 0) return;              // don't interrupt existing conversation
    if (!priorityReadyAt) return;                 // brain hasn't run yet

    const delay = setTimeout(() => {
      if (proactiveFiredRef.current) return;
      if (messages.length > 0) return;            // user may have started typing

      if (!hasAnythingToSurface()) return;

      const result = evaluateInitiative();
      if (result.shouldSurface && result.message) {
        proactiveFiredRef.current = true;
        setProactiveSuggestion(result.message);
      }
    }, 2200); // give the brain a moment to settle after first run

    return () => clearTimeout(delay);
  }, [priorityReadyAt, messages.length]);

  // Clear the proactive suggestion once the user engages
  useEffect(() => {
    if (messages.length > 0 && proactiveSuggestion) {
      setProactiveSuggestion(null);
    }
  }, [messages.length, proactiveSuggestion]);

  useEffect(() => {
    function handleSecretaryPrompt(e: Event) {
      const detail = (e as CustomEvent<{ prompt: string; mode?: string }>).detail;
      const mode = detail.mode && isHenryOperatingMode(detail.mode) ? detail.mode : 'secretary';
      setOperatingMode(mode);
      if (detail.prompt) {
        setChatInject({ id: Date.now(), text: detail.prompt });
      }
    }
    function handleModeLaunch(e: Event) {
      const detail = (e as CustomEvent<{ mode: string; prompt: string }>).detail;
      const mode = detail.mode && isHenryOperatingMode(detail.mode) ? detail.mode : 'companion';
      setOperatingMode(mode);
      if (detail.prompt) {
        setChatInject({ id: Date.now(), text: detail.prompt });
      }
    }
    function handleNewChat() {
      clearSavedSessionResume();
      clearRecoveryBannerDismissedThisSession();
      setActiveConversation(null);
      setMessages([]);
      setOperatingMode('companion');
      setRecoveryBannerOpen(false);
      setRecoverySnapshot(null);
    }
    function handleWakeWord(e: Event) {
      const { query } = (e as CustomEvent<{ query: string }>).detail;
      useStore.getState().setCurrentView('chat');
      setOperatingMode('companion');
      const text = query?.trim() || 'Hey.';
      setTimeout(() => {
        wakeHandleSendRef.current?.(text);
      }, 80);
    }

    function handleActionPrompt(e: Event) {
      const { prompt } = (e as CustomEvent<{ prompt: string }>).detail;
      if (prompt) setChatInject({ id: Date.now(), text: prompt });
    }

    window.addEventListener('henry_secretary_prompt', handleSecretaryPrompt);
    window.addEventListener('henry_mode_launch', handleModeLaunch);

    // henry_inject_draft — fired from any panel to pre-fill the chat input
    function handleInjectDraft(e: Event) {
      const { text } = (e as CustomEvent<{ text: string }>).detail;
      if (text?.trim()) {
        setChatInject({ id: Date.now(), text: text.trim() });
      }
    }
    window.addEventListener('henry_inject_draft', handleInjectDraft);
    window.addEventListener('henry_new_chat', handleNewChat);
    window.addEventListener('henry_wake_word', handleWakeWord);
    window.addEventListener('henry_action_prompt', handleActionPrompt);
    return () => {
      window.removeEventListener('henry_secretary_prompt', handleSecretaryPrompt);
      window.removeEventListener('henry_mode_launch', handleModeLaunch);
      window.removeEventListener('henry_inject_draft', handleInjectDraft);
      window.removeEventListener('henry_new_chat', handleNewChat);
      window.removeEventListener('henry_wake_word', handleWakeWord);
      window.removeEventListener('henry_action_prompt', handleActionPrompt);
    };
  }, []);

  // Worker Brain: inject Worker messages back into the active conversation
  useEffect(() => {
    if (!window.henryAPI.onWorkerMessage) return;
    const unsub = window.henryAPI.onWorkerMessage((msg) => {
      if (msg.conversation_id === activeConversationId) {
        addMessage(msg);
        setWorkerStatus({ status: 'idle' });
      }
    });
    return unsub;
  }, [activeConversationId]);

  // Startup: auto-detect best Ollama models if none are set yet
  useEffect(() => {
    void (async () => {
      try {
        const s = useStore.getState().settings;
        const provs = await window.henryAPI.getProviders();
        const ollamaEnabled = provs.some((p: any) => p.id === 'ollama' && p.enabled);
        if (!ollamaEnabled) return;
        if (s.companion_model) return; // already configured, don't override

        const { autoSelectModels } = await import('@/henry/modelPriority');
        const ollamaUrl = s.ollama_base_url || 'http://localhost:11434';
        const raw = await window.henryAPI.ollamaModels(ollamaUrl) as any;
        const installed: string[] = (raw?.models ?? []).map((m: any) => m.name as string);
        if (!installed.length) return;

        const best = autoSelectModels(installed);
        if (best.companion) {
          await window.henryAPI.saveSetting('companion_model', best.companion.id);
          await window.henryAPI.saveSetting('companion_provider', 'ollama');
          useStore.getState().updateSetting('companion_model', best.companion.id);
          useStore.getState().updateSetting('companion_provider', 'ollama');
        }
        if (best.companionFallback) {
          await window.henryAPI.saveSetting('companion_model_2', best.companionFallback.id);
          await window.henryAPI.saveSetting('companion_provider_2', 'ollama');
          useStore.getState().updateSetting('companion_model_2', best.companionFallback.id);
          useStore.getState().updateSetting('companion_provider_2', 'ollama');
        }
        if (best.worker) {
          await window.henryAPI.saveSetting('worker_model', best.worker.id);
          await window.henryAPI.saveSetting('worker_provider', 'ollama');
          useStore.getState().updateSetting('worker_model', best.worker.id);
          useStore.getState().updateSetting('worker_provider', 'ollama');
        }
      } catch {
        // Auto-detect is best-effort — silently skip if Ollama isn't reachable
      }
    })();
  }, []);

  // Voice replies: speak Henry's completed response when streaming ends
  // (never token-by-token). Hands-free mode always speaks; the persisted
  // "voice replies" toggle covers normal chats. Skipped when the user has
  // started typing their next message.
  useEffect(() => {
    if ((!ttsEnabled && !handsFreeVoice) || isStreaming) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;
    if (lastSpokenMsgIdRef.current === lastMsg.id) return;
    lastSpokenMsgIdRef.current = lastMsg.id;
    if (useVoiceStore.getState().userTypedSinceReply) return; // user moved on — stay quiet
    const s = useStore.getState().settings;
    window.henryAPI?.getProviders?.().then((providers) => {
      speakReplySafely(lastMsg.content, s, providers);
    }).catch(() => {
      speakReplySafely(lastMsg.content, s, []);
    });
  }, [isStreaming, ttsEnabled, handsFreeVoice, messages]);

  function toggleTts() {
    const next = !ttsEnabled;
    if (!next) {
      cancelTTS();
      void voiceStopSpeaking();
    }
    setTtsEnabled(next);
    useVoiceStore.getState().setVoiceReplies(next); // persists voice_replies + legacy key
    useStore.getState().updateSetting(VOICE_REPLIES_SETTING_KEY, String(next));
  }

  /** Restore active thread id before persistence effects run (avoids wiping saved conversation). */
  useLayoutEffect(() => {
    if (!conversations.length) return;
    const saved = readSavedSessionResume();
    if (!saved?.lastConversationId) return;
    if (!conversations.some((c) => c.id === saved.lastConversationId)) return;
    const cur = useStore.getState().activeConversationId;
    if (cur && cur !== saved.lastConversationId) return;
    useStore.getState().setActiveConversation(saved.lastConversationId);
  }, [conversations]);

  useEffect(() => {
    saveSessionResumeSnapshot({
      lastConversationId: activeConversationId,
      operatingMode,
      writerDocumentTypeId,
      design3dWorkflowTypeId,
      writerActiveDraftPath,
      design3dReferencePath: design3dRefPath,
      activeWorkspaceContext,
    });
  }, [
    activeConversationId,
    operatingMode,
    writerDocumentTypeId,
    design3dWorkflowTypeId,
    writerActiveDraftPath,
    design3dRefPath,
    activeWorkspaceContext,
  ]);

  useEffect(() => {
    if (!conversations.length) return;
    if (sessionAsyncResumeStartedRef.current) return;
    sessionAsyncResumeStartedRef.current = true;

    void (async () => {
      const saved = readSavedSessionResume();
      if (!saved) return;

      const stale = await checkSessionPathsStale(saved, (p) => window.henryAPI.pathExists(p));
      setRecoveryStale(stale);

      const st = useStore.getState();
      let restored = false;
      let missing = false;
      if (saved.lastConversationId) {
        if (st.conversations.some((c) => c.id === saved.lastConversationId)) {
          try {
            const msgs = await window.henryAPI.getMessages(saved.lastConversationId);
            st.setMessages(msgs);
            restored = true;
          } catch {
            missing = true;
          }
        } else {
          missing = true;
        }
      }

      setRecoveryConvRestored(restored);
      setRecoveryConvMissing(missing);
      setRecoverySnapshot(saved);
      setMemoryPanelSessionHint(true);
      if (!recoveryBannerDismissedThisAppSession()) {
        setRecoveryBannerOpen(true);
      }
    })();
  }, [conversations.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (isStreaming) {
      container.scrollTop = container.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, isStreaming]);

  useEffect(() => {
    const { setState } = useAmbientStore.getState();
    if (isStreaming) {
      setState('responding');
    } else {
      setState('ready');
    }
  }, [isStreaming]);

  useEffect(() => {
    try {
      localStorage.setItem(HENRY_OPERATING_MODE_KEY, operatingMode);
    } catch {
      /* ignore */
    }
  }, [operatingMode]);

  useEffect(() => {
    try {
      localStorage.setItem(HENRY_WRITER_DOCUMENT_TYPE_KEY, writerDocumentTypeId);
    } catch {
      /* ignore */
    }
  }, [writerDocumentTypeId]);

  useEffect(() => {
    try {
      localStorage.setItem(HENRY_DESIGN3D_WORKFLOW_KEY, design3dWorkflowTypeId);
    } catch {
      /* ignore */
    }
  }, [design3dWorkflowTypeId]);

  useEffect(() => {
    const sync = () => setDesign3dRefPath(readLastWorkspaceFilePath());
    window.addEventListener(HENRY_DESIGN3D_REF_CHANGED_EVENT, sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(HENRY_DESIGN3D_REF_CHANGED_EVENT, sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  // Fetch live weather once on mount (cached 30 min)
  useEffect(() => {
    getWeather().then((w) => { if (w) setCurrentWeather(w); }).catch(() => {});
  }, []);

  useEffect(() => {
    const sync = () => setWriterActiveDraftPathState(readWriterActiveDraftPath());
    window.addEventListener(HENRY_WRITER_CONTEXT_CHANGED_EVENT, sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(HENRY_WRITER_CONTEXT_CHANGED_EVENT, sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  useEffect(() => {
    const sync = () => setActiveWorkspaceContextState(readActiveWorkspaceContext());
    window.addEventListener(HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT, sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(HENRY_WORKSPACE_CONTEXT_CHANGED_EVENT, sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  useEffect(() => {
    if (!activeWorkspaceContext) setWorkspaceContextIndexHint(null);
  }, [activeWorkspaceContext]);

  function openExportPack(preset: ExportPresetId) {
    setExportPackPreset(preset);
    setExportPackSession((k) => k + 1);
    setExportPackOpen(true);
  }

  const exportPackChatActionVisible =
    !!settings.workspace_path?.trim() ||
    !!activeWorkspaceContext ||
    !!writerActiveDraftPath ||
    !!design3dRefPath ||
    operatingMode !== 'companion' ||
    messages.length > 0;

  function handleRecoveryDismiss() {
    setRecoveryBannerOpen(false);
    setRecoveryBannerDismissedThisSession();
  }

  async function handleResumeLastThread() {
    const saved = readSavedSessionResume() ?? recoverySnapshot;
    const id = saved?.lastConversationId;
    if (!id || !conversations.some((c) => c.id === id)) return;
    setActiveConversation(id);
    try {
      const msgs = await window.henryAPI.getMessages(id);
      setMessages(msgs);
      setRecoveryConvMissing(false);
      setRecoveryConvRestored(true);
    } catch {
      /* keep banner honest */
    }
    setRecoveryBannerOpen(false);
    setRecoveryBannerDismissedThisSession();
  }

  function handleSessionStartClean() {
    clearSavedSessionResume();
    clearRecoveryBannerDismissedThisSession();
    setActiveConversation(null);
    setMessages([]);
    setOperatingMode('companion');
    setWriterDocumentTypeId(DEFAULT_WRITER_DOCUMENT_TYPE_ID);
    setDesign3dWorkflowTypeId(DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID);
    clearActiveWorkspaceContext();
    clearDesign3dReferencePath();
    setWriterActiveDraftPath(null);
    setDesign3dRefPath(null);
    setWriterActiveDraftPathState(null);
    setActiveWorkspaceContextState(null);
    setRecoveryBannerOpen(false);
    setRecoverySnapshot(null);
    setRecoveryStale(null);
    setRecoveryConvRestored(false);
    setRecoveryConvMissing(false);
    setMemoryPanelSessionHint(false);
  }

  const recoveryThreadTitle =
    (activeConversationId && conversations.find((c) => c.id === activeConversationId)?.title) ||
    (recoverySnapshot?.lastConversationId &&
      conversations.find((c) => c.id === recoverySnapshot.lastConversationId)?.title) ||
    null;

  async function handleSaveWriterDraft(markdown: string) {
    const root = settings.workspace_path?.trim();
    if (!root) {
      toast.error('Set a workspace folder in Settings before saving drafts.');
      return;
    }
    const suggested = defaultWriterDraftRelativePath(writerDocumentTypeId);
    // R3-Fix 1: was window.prompt() — native dialog ignored dark theme +
    // blocked renderer thread. Now uses the in-app prompt modal.
    const input = await promptDialog('Save as path (relative to workspace):', { defaultValue: suggested, confirmLabel: 'Save' });
    if (input === null) return;
    const relPath = input.trim() || suggested;
    setSaveWorkspaceDraftBusy(true);
    try {
      const writerType = getWriterDocumentType(writerDocumentTypeId);
      const withMeta = prependWriterDraftMetadata(markdown, {
        documentTypeId: writerDocumentTypeId,
        documentTypeLabel: writerType?.label ?? writerDocumentTypeId,
        relativePath: relPath,
        workspaceHint: root,
      });
      await window.henryAPI.writeFile(relPath, withMeta);
      toast.success(`Saved to workspace: ${relPath}`);
    } catch (e: unknown) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaveWorkspaceDraftBusy(false);
    }
  }

  async function handleSaveDesign3dPlan(markdown: string) {
    const root = settings.workspace_path?.trim();
    if (!root) {
      toast.error('Set a workspace folder in Settings before saving plans.');
      return;
    }
    const suggested = defaultDesign3DPlanRelativePath(design3dWorkflowTypeId);
    const input = await promptDialog('Save as path (relative to workspace):', { defaultValue: suggested, confirmLabel: 'Save' });
    if (input === null) return;
    const relPath = input.trim() || suggested;
    setSaveWorkspaceDraftBusy(true);
    try {
      const withMeta = prependDesign3dPlanMetadata(markdown, {
        workflowId: design3dWorkflowTypeId,
        referencePath: design3dRefPath,
      });
      await window.henryAPI.writeFile(relPath, withMeta);
      toast.success(`Saved to workspace: ${relPath}`);
    } catch (e: unknown) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaveWorkspaceDraftBusy(false);
    }
  }

  async function handleOperatorCommand(content: string, parsed: HenryCommand) {
    const outcome = resolveHenryCommand(parsed, {
      operatingMode,
      writerDocumentTypeId,
      design3dWorkflowTypeId,
      workspaceReady: !!settings.workspace_path?.trim(),
      activeWorkspaceContext,
    });

    let convId = activeConversationId;

    if (outcome.effects.newChat) {
      try {
        const convo = await window.henryAPI.createConversation('New conversation');
        convId = convo.id;
        setActiveConversation(convId);
        setMessages([]);
        const convos = await window.henryAPI.getConversations();
        useStore.getState().setConversations(convos);
      } catch (err) {
        console.error('Failed to start new conversation:', err);
        return;
      }
    } else if (!convId) {
      try {
        const convo = await window.henryAPI.createConversation(
          content.slice(0, 50) + (content.length > 50 ? '...' : '')
        );
        convId = convo.id;
        setActiveConversation(convId);
        const convos = await window.henryAPI.getConversations();
        useStore.getState().setConversations(convos);
      } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
      }
    }

    if (outcome.effects.setOperatingMode) {
      setOperatingMode(outcome.effects.setOperatingMode);
    }
    if (outcome.effects.clearWriterDraft) {
      setWriterActiveDraftPath(null);
      setWriterActiveDraftPathState(null);
    }
    if (outcome.effects.clearDesign3dRef) {
      clearDesign3dReferencePath();
      setDesign3dRefPath(null);
    }
    if (outcome.effects.clearWorkspaceContext) {
      clearActiveWorkspaceContext();
      setActiveWorkspaceContextState(null);
    }
    if (outcome.effects.composerSeed) {
      setChatInject({ id: Date.now(), text: outcome.effects.composerSeed });
    }
    if (outcome.effects.openExportPackPreset) {
      openExportPack(outcome.effects.openExportPackPreset);
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversation_id: convId!,
      role: 'user',
      content,
      engine: selectedEngine,
      created_at: new Date().toISOString(),
    };
    addMessage(userMsg);
    setSmartSuggestions([]);
    // Auto-extract memory facts from user message (non-blocking)
    runAutoMemory(content, convId ?? undefined);
    try {
      await window.henryAPI.saveMessage(userMsg);
    } catch (err) {
      console.error('Failed to save command message:', err);
    }

    const ackContent = `*Henry (command)*\n\n${outcome.acknowledgement}`;
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      conversation_id: convId!,
      role: 'assistant',
      content: ackContent,
      engine: 'companion',
      created_at: new Date().toISOString(),
    };
    addMessage(assistantMsg);
    try {
      await window.henryAPI.saveMessage(assistantMsg);
    } catch (err) {
      console.error('Failed to save command acknowledgement:', err);
    }
  }

  // ── First-launch greeting ─────────────────────────────────────────────────
  useEffect(() => {
    const GREETED_KEY = 'henry:greeted_v1';
    if (localStorage.getItem(GREETED_KEY)) return;
    if (messages.length > 0) return;
    const api = window.henryAPI;
    if (!api?.isFirstLaunch) return;
    void (async () => {
      try {
        const result = await api.isFirstLaunch?.();
        if (!result?.isFirst) return;
        localStorage.setItem(GREETED_KEY, 'true');
        const platform = isMacOS() ? 'Mac' : isLinux() ? 'computer' : isWindows() ? 'computer' : 'device';
        const shortcut = isMacOS() ? '⌥Space' : 'Alt+Space';
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Hey — I'm Henry, your personal AI on your ${platform.toLowerCase()}.\n\nI'm connected to your tasks, habits, goals, and more. I work best when I know you:\n\n• Say **"remember that I..."** and I'll save any fact permanently\n• Ask me anything — tasks, reminders, decisions, writing\n• Press **${shortcut}** from anywhere on your ${platform.toLowerCase()} to open me instantly\n\nWhat are you working on right now?`,
          conversation_id: activeConversationId || '',
          created_at: new Date().toISOString(),
          model: 'henry',
          provider: 'henry',
        });
      } catch { /* ignore */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Morning brief — fires once per day when you open Henry ────────────────
  useEffect(() => {
    const BRIEF_KEY = `henry:morning_brief:${new Date().toISOString().slice(0,10)}`;
    if (localStorage.getItem(BRIEF_KEY)) return;
    if (messages.length > 2) return; // only on fresh open
    const api = window.henryAPI;
    if (!api) return;
    void (async () => {
      try {
        const api2 = api as any;
        const [tasks, rems, goals] = await Promise.all([
          (api2.tasksList?.({}) ?? Promise.resolve([])),
          (api2.remindersDue?.() ?? Promise.resolve([])),
          (api2.getGoals?.({status:'active'}) ?? Promise.resolve({goals:[]})),
        ]);
        const taskList  = Array.isArray(tasks) ? tasks : [];
        const remList   = Array.isArray(rems)  ? rems  : [];
        const goalList  = Array.isArray(goals) ? goals : ((goals as any)?.goals || []);
        const overdue   = goalList.filter((g:any) => g.target_date && new Date(g.target_date) < new Date());
        if (taskList.length === 0 && remList.length === 0 && goalList.length === 0) return;
        localStorage.setItem(BRIEF_KEY, 'true');
        const parts: string[] = [`☀️ **Good morning, ${(window as any).__henryUserName__ || 'Topher'}.**
`];
        if (remList.length)   parts.push(`⏰ **${remList.length} reminder${remList.length > 1 ? 's' : ''} due:** ${remList.slice(0,3).map((r:any) => r.title).join(', ')}${remList.length > 3 ? '...' : ''}`);
        if (taskList.length)  parts.push(`✓ **${taskList.length} open task${taskList.length > 1 ? 's' : ''}:** ${taskList.slice(0,3).map((t:any) => t.title).join(', ')}${taskList.length > 3 ? '...' : ''}`);
        if (overdue.length)   parts.push(`◎ **${overdue.length} overdue goal${overdue.length > 1 ? 's' : ''}:** ${overdue.slice(0,2).map((g:any) => g.title).join(', ')}`);
        parts.push(`
What do you want to tackle first?`);
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: parts.join('\n'),
          conversation_id: activeConversationId || '',
          created_at: new Date().toISOString(),
          model: 'henry:morning',
          provider: 'henry',
        });
      } catch { /* if no data yet, skip */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Companion chat sync — phone messages appear live on desktop ──────────
  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent<{conversation_id: string; messages: Array<{id:string;role:string;content:string;model?:string;provider?:string}>}>).detail;
      if (!data?.messages?.length) return;
      data.messages.forEach(msg => {
        // Skip if already in current messages (dedup by id)
        addMessage({
          id: msg.id,
          role: msg.role as 'user' | 'assistant',
          content: (msg.role === 'user' ? '📱 ' : '') + msg.content,
          conversation_id: data.conversation_id,
          created_at: new Date().toISOString(),
          model: msg.model || 'companion',
          provider: msg.provider || 'companion',
        });
      });
    };
    window.addEventListener('henry_companion_chat_update', handler);
    return () => window.removeEventListener('henry_companion_chat_update', handler);
  }, [addMessage]);

  // ── Coder engine (developer mode) ─────────────────────────────────────
  // Refresh availability whenever developer mode becomes active or the
  // engine setting changes, so the chip + status line stay truthful.
  useEffect(() => {
    if (operatingMode !== 'developer' || !coderAvailable()) return;
    let alive = true;
    void getCoderStatus().then((s) => {
      if (alive) setCoderStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [operatingMode, settings.coder_engine]);

  const coderEngineChoice = isCoderEngineChoice(settings.coder_engine)
    ? settings.coder_engine
    : 'auto';

  async function pickCoderEngine(value: string) {
    if (!isCoderEngineChoice(value)) return;
    try {
      await window.henryAPI.saveSetting?.(CODER_ENGINE_SETTING_KEY, value);
    } catch {
      /* setting persists next launch at worst */
    }
    useStore.getState().updateSetting(CODER_ENGINE_SETTING_KEY, value);
    setCoderStatus(await getCoderStatus());
  }

  /**
   * Developer-mode turn through the coder engine. Streams normalized coder
   * events into the regular chat streaming UI (text chunks + tool-activity
   * blockquotes), then finalizes a normal assistant message. Falls back to
   * the regular chat model only when engine='auto' and neither engine is
   * available; a strict engine choice that's unavailable reports exactly
   * what to do instead.
   */
  async function handleCoderRun(content: string, convId: string) {
    setIsStreaming(true);
    setStreamingContent('');
    setCompanionStatus({ status: 'thinking', taskDescription: 'Coder engine…' });

    const status = await getCoderStatus();
    setCoderStatus(status);

    if (!status || status.active === 'none') {
      const strictChoice = status && status.engine !== 'auto';
      if (!strictChoice) {
        // Auto + nothing available → answer with the regular chat model.
        await handleCompanionStream(content, convId, 'developer');
        return;
      }
      const lines = [
        `**Coder engine unavailable** (set to _${status.engine === 'claude-code' ? 'Claude Code' : 'Local'}_).`,
        '',
        status.engine === 'claude-code'
          ? 'Claude Code CLI not found — install it with: `npm install -g @anthropic-ai/claude-code`'
          : status.local.ollamaRunning
            ? `Local coder model not installed — ${status.local.hint ?? 'run: ollama pull qwen2.5-coder:7b'}`
            : `Ollama isn't running — ${status.local.hint ?? 'start it with: ollama serve'}`,
        '',
        'Or switch the Coder selector to **Auto**.',
      ];
      addMessage({
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'assistant',
        content: lines.join('\n'),
        engine: 'companion',
        model: 'coder-status',
        provider: 'coder',
        created_at: new Date().toISOString(),
      });
      setStreamingContent('');
      setIsStreaming(false);
      setCompanionStatus({ status: 'idle' });
      return;
    }

    const engine = status.active;
    const s = useStore.getState().settings;
    const cwd = (s.coder_project_dir || '').trim() || undefined;
    const sessionId = engine === 'claude-code' ? readCoderSession(convId) : undefined;

    let acc = '';
    const finalize = async (finalText: string) => {
      const assistantMsg = {
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'assistant' as const,
        content: finalText,
        engine: 'companion' as const,
        model: engine === 'claude-code' ? 'claude-code' : status.local.model ?? 'local-coder',
        provider: 'coder',
        created_at: new Date().toISOString(),
      };
      addMessage(assistantMsg);
      try {
        await window.henryAPI.saveMessage(assistantMsg);
      } catch {
        /* non-fatal */
      }
      setStreamingContent('');
      setIsStreaming(false);
      setCompanionStatus({ status: 'done' });
      setTimeout(() => setCompanionStatus({ status: 'idle' }), 1500);
      streamRef.current = null;
    };

    const run = runCoderTask(
      { prompt: content, cwd, sessionId },
      {
        onInit: (sid, model) => {
          if (engine === 'claude-code' && sid) saveCoderSession(convId, sid);
          setCompanionStatus({
            status: 'streaming',
            taskDescription:
              engine === 'claude-code'
                ? 'Claude Code working…'
                : `Local coder${model ? ` (${model})` : ''}…`,
          });
        },
        onText: (text) => {
          const chunk = joinTextChunk(acc, text);
          acc += chunk;
          appendStreamingContent(chunk);
        },
        onTool: (name, summary) => {
          const chunk = formatToolActivity(name, summary);
          acc += chunk;
          appendStreamingContent(chunk);
        },
        onResult: (res) => {
          if (engine === 'claude-code' && res.sessionId) saveCoderSession(convId, res.sessionId);
          let finalText = acc.trim() ? acc : res.text ?? '';
          if (!finalText.trim()) {
            finalText = res.ok
              ? '_(Coder run finished with no output.)_'
              : res.text || 'The coder run failed with no output.';
          }
          void finalize(finalText);
        },
        onError: (message) => {
          // A stale --resume session is the most common failure — drop it so
          // the next message starts a fresh CLI session.
          if (engine === 'claude-code') clearCoderSession(convId);
          const errText = acc.trim()
            ? `${acc}\n\n**Coder error:** ${message}`
            : `**Coder error:** ${message}`;
          void finalize(errText);
        },
      }
    );
    streamRef.current = run; // Stop button → cancelStream() → run.cancel()
  }

  async function handleSend(rawContent: string) {
    if (isStreaming) return;
    // Content Creators: a trigger phrase opens the demo stage instead of
    // sending a chat turn. Checked before anything else so a filmed trigger
    // never burns a model call.
    if (matchesTriggerPhrase(rawContent)) {
      void launchDemo('voice');
      return;
    }
    // An attachment-only message is valid: say what was shared so the turn
    // still has a prompt for the model.
    const autoText = pendingAttachments.length > 0 && !rawContent.trim()
      ? `I've attached ${pendingAttachments.length} file${pendingAttachments.length === 1 ? '' : 's'}: ${pendingAttachments.map((a) => a.file_name).join(', ')}.`
      : '';
    const content = rawContent.trim() ? rawContent : autoText;
    if (!content.trim()) return;
    const attachmentsForThisMessage = pendingAttachments;
    setPendingAttachments([]);
    cancelTTS();
    void voiceStopSpeaking(); // cut Henry off — the user is talking now

    const parsedCmd = parseUserCommandLine(content);
    if (parsedCmd) {
      await handleOperatorCommand(content, parsedCmd);
      return;
    }

    // URL browse: if message is ONLY a URL, fetch the page and inject it as context
    const trimmed = content.trim();
    const urlMatch = trimmed.match(/^(https?:\/\/[^\s]+)(\s+(.+))?$/);
    if (urlMatch) {
      const url = urlMatch[1];
      const question = urlMatch[3]?.trim() || `Summarize the key information from this page.`;
      await handleBrowseUrl(url, question);
      return;
    }

    const engine = selectedEngine;

    // Auto-detect mode from message content (only for companion/chat engine)
    let detectedMode = operatingMode;
    if (engine !== 'worker') {
      detectedMode = detectModeFromMessage(content, operatingMode);
      if (detectedMode !== operatingMode) {
        setOperatingMode(detectedMode);
        const label = MODE_HUMAN_LABELS[detectedMode];
        setAutoSwitchNotice(label);
        if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
        autoSwitchTimerRef.current = setTimeout(() => setAutoSwitchNotice(null), 4000);
      }
    }

    // Ensure we have a conversation
    let convId = activeConversationId;
    if (!convId) {
      try {
        const convo = await window.henryAPI.createConversation(
          content.slice(0, 50) + (content.length > 50 ? '...' : '')
        );
        convId = convo.id;
        setActiveConversation(convId);

        // Refresh conversations list
        const convos = await window.henryAPI.getConversations();
        useStore.getState().setConversations(convos);
      } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
      }
    }

    // Add user message
    const userMsg = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: 'user' as const,
      content,
      engine,
      created_at: new Date().toISOString(),
    };
    addMessage(userMsg);

    // Bind any queued attachments to the message they were sent with, so the
    // bubbles can render them and the files stay with the conversation.
    if (attachmentsForThisMessage.length > 0) {
      void window.henryAPI
        .linkAttachmentsToMessage(attachmentsForThisMessage.map((a) => a.id), userMsg.id, convId)
        .catch(() => { /* attachments stay orphaned but the message still sends */ });
    }

    // Save user message to DB
    try {
      await window.henryAPI.saveMessage(userMsg);
    } catch (err) {
      console.error('Failed to save message:', err);
    }

    // Route based on engine
    if (engine === 'worker') {
      // Worker tasks go through the task queue
      await handleWorkerRequest(content, convId);
    } else if (detectedMode === 'developer' && coderAvailable()) {
      // Developer mode routes through the coder engine (Claude Code CLI by
      // default, free local qwen coder as fallback / per the Coder selector).
      await handleCoderRun(content, convId);
    } else {
      // Companion uses streaming directly — pass detectedMode so the prompt uses the right mode
      // even before React re-renders with the new operatingMode state
      await handleCompanionStream(content, convId, detectedMode);
    }
  }

  // Like handleSend but shows original user message in chat while sending enriched content to Henry
  async function handleSendEnriched(enrichedContent: string, displayContent: string) {
    const engine = selectedEngine;
    let detectedMode = operatingMode;
    if (engine !== 'worker') {
      detectedMode = detectModeFromMessage(displayContent, operatingMode);
      if (detectedMode !== operatingMode) {
        setOperatingMode(detectedMode);
        setAutoSwitchNotice(MODE_HUMAN_LABELS[detectedMode]);
        if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
        autoSwitchTimerRef.current = setTimeout(() => setAutoSwitchNotice(null), 4000);
      }
    }
    let convId = activeConversationId;
    if (!convId) {
      try {
        const convo = await window.henryAPI.createConversation(displayContent.slice(0, 50) + (displayContent.length > 50 ? '...' : ''));
        convId = convo.id;
        setActiveConversation(convId);
        const convos = await window.henryAPI.getConversations();
        useStore.getState().setConversations(convos);
      } catch (err) {
        console.error('Failed to create conversation:', err);
        return;
      }
    }
    const userMsg = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: 'user' as const,
      content: displayContent,
      engine,
      created_at: new Date().toISOString(),
    };
    addMessage(userMsg);
    try { await window.henryAPI.saveMessage(userMsg); } catch { /* optional */ }
    if (detectedMode === 'developer' && coderAvailable()) {
      await handleCoderRun(enrichedContent, convId);
    } else {
      await handleCompanionStream(enrichedContent, convId, detectedMode);
    }
  }

  async function autoNameConversation(
    convId: string,
    userMessage: string,
    assistantReply: string,
    providerName: string,
    model: string,
    apiKey: string
  ): Promise<void> {
    try {
      const prompt = `Here is the start of a conversation. Create a concise 4-6 word title for it.\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantReply.slice(0, 300)}`;
      const titleStream = window.henryAPI.streamMessage({
        provider: providerName,
        model,
        apiKey,
        messages: [
          { role: 'system', content: 'You name conversations with a crisp 4-6 word title. Output ONLY the title text, no quotes, no trailing punctuation.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      });
      titleStream.onChunk(() => { /* collect silently */ });
      titleStream.onDone(async (rawTitle: string) => {
        const clean = rawTitle.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?]+$/, '').slice(0, 60);
        if (clean.length >= 4) {
          try {
            await window.henryAPI.updateConversation(convId, clean);
            const convos = await window.henryAPI.getConversations();
            useStore.getState().setConversations(convos);
          } catch { /* silent */ }
        }
      });
      titleStream.onError(() => { /* silent */ });
    } catch { /* silent */ }
  }

  async function handleCompanionStream(content: string, convId: string, modeOverride?: HenryOperatingMode) {
    // Track what kind of things the user asks Henry — helps self-assessment
    const lc = content.toLowerCase();
    if (lc.includes('task') || lc.includes('todo')) trackUsage('chat', 'tasks');
    else if (lc.includes('remind')) trackUsage('chat', 'reminders');
    else if (lc.includes('remember') || lc.includes('memory') || lc.includes('save')) trackUsage('chat', 'memory');
    else if (lc.includes('goal')) trackUsage('chat', 'goals');
    else if (lc.includes('habit')) trackUsage('chat', 'habits');
    else if (lc.includes('journal') || lc.includes('write')) trackUsage('chat', 'journal');
    else if (lc.includes('finance') || lc.includes('money') || lc.includes('budget')) trackUsage('chat', 'finance');
    else trackUsage('chat', 'general');

    // ── App deep links ────────────────────────────────────────────────────
    // "show me my inbox" / "search youtube for lofi beats" — jump straight to
    // the right screen in a known app. Local catalogue, no third-party
    // service, and the OS routes the URL to whichever app handles it.
    const appLink = parseAppLink(content);
    if (appLink) {
      setIsStreaming(true);
      setStreamingContent('');
      let opened = false;
      let failure: string | undefined;
      try {
        const res = await window.henryAPI.computerOpenUrl(appLink.url);
        opened = !!res?.success;
        if (!opened) failure = res?.error;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: opened
          ? `✓ ${appLink.description} — ${appLink.url}`
          : `✗ Could not ${appLink.description.toLowerCase()}${failure ? `: ${failure}` : ''}`,
        conversation_id: convId,
        created_at: new Date().toISOString(),
        model: 'computer:applink',
        provider: 'henry',
      });
      setIsStreaming(false);
      return;
    }

    // ── Pre-AI delegation interceptor ─────────────────────────────────────
    // "tell ChatGPT to X" / "ask Claude to Y" — execute DIRECTLY, no AI needed
    const delegation = parseDelegation(content);
    if (delegation) {
      setIsStreaming(true);
      setStreamingContent('');
      const result = await executeDelegation(delegation);
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result,
        conversation_id: convId,
        created_at: new Date().toISOString(),
        model: 'computer:delegation',
        provider: 'henry',
      });
      setIsStreaming(false);
      return;
    }

    // Auto-detect other computer operation phrases — force computer mode
    const delegationPattern = /\b(tell|ask|have|get|make|instruct)\s+(chatgpt|claude|gpt|siri|chrome|safari|slack|notion|messages|mail|gmail|cursor|vscode|vs code|spotify|zoom|teams|discord|whatsapp|finder|terminal|iterm|any app|the browser)\s+(to|and)\b/i;
    const operatePattern = /\b(open|go to|navigate to|type|click|press)\s+\w.*\b(in|on|at)\s+(chrome|safari|chatgpt|claude|slack|notion|messages|mail|gmail|cursor|spotify|zoom|discord)\b/i;
    const forcedMode: HenryOperatingMode | undefined =
      (delegationPattern.test(content) || operatePattern.test(content)) ? 'computer' : undefined;
    const effectiveMode = forcedMode ?? modeOverride ?? operatingMode;
    setIsStreaming(true);
    setStreamingContent('');

    // ── Local-first router (cost-efficiency) ─────────────────────────────
    // Before spending any AI tokens, see if Henry can answer this from his
    // own SQLite. Patterns like "what colors do I have", "show my machines",
    // "what's running low", "how much did I spend" are all answered instantly,
    // offline, with zero token cost. Falls through to AI on no match.
    try {
      const local = await routeLocally(content);
      if (local.handled && local.reply) {
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: local.reply,
          conversation_id: convId,
          created_at: new Date().toISOString(),
          model: `local:${local.intentName || 'router'}`,
          provider: 'henry',
        });
        setIsStreaming(false);
        setStreamingContent('');
        setCompanionStatus({ status: 'idle' });
        return;
      }
    } catch (e) {
      // Never block the AI path on a local-router failure
      console.warn('[Henry] localRouter error, falling through to AI:', e);
    }

    // ── Backend gate (cost protection) ────────────────────────────────────
    // If the user has NO Groq key, NO Ollama, NO other BYOK key, and NO
    // license, do not attempt any AI call. Render an inline setup card
    // instead. This is THE wall that protects the developer from paying
    // for free-tier usage — never bypass it.
    if (!hasUsableBackend(settings)) {
      const backendStatus = getBackendStatus(settings);
      const availableOptions: string[] = [];
      if (!backendStatus.kinds.includes('groq')) {
        availableOptions.push(
          '**Free Groq key (60 seconds, recommended)** — Get one at [console.groq.com/keys](https://console.groq.com/keys), then paste it in **Settings → AI Providers → Groq**. The free tier is 14,400 requests/day — plenty for normal use.'
        );
      }
      if (!backendStatus.kinds.includes('ollama')) {
        availableOptions.push(
          '**Local Ollama (fully private, fully free)** — Install from [ollama.com](https://ollama.com/download), then Henry connects automatically.'
        );
      }
      if (!backendStatus.kinds.includes('openai')) {
        availableOptions.push(
          '**OpenAI API key** — Add in **Settings → AI Providers → OpenAI**.'
        );
      }
      if (!backendStatus.kinds.includes('anthropic')) {
        availableOptions.push(
          '**Anthropic API key** — Add in **Settings → AI Providers → Anthropic**.'
        );
      }
      if (!backendStatus.kinds.includes('google')) {
        availableOptions.push(
          '**Google Gemini API key (free tier available)** — Get one at [aistudio.google.com](https://aistudio.google.com), then paste it in **Settings → AI Providers → Google**.'
        );
      }
      if (!backendStatus.kinds.includes('license')) {
        availableOptions.push(
          '**Henry license** — If you bought one, paste it in **Settings → License**.'
        );
      }

      const setupMessage = [
        '**Henry needs an AI provider to answer.**',
        '',
        availableOptions.length > 0
          ? `You have ${availableOptions.length} option${availableOptions.length === 1 ? '' : 's'}:`
          : 'No providers configured.',
        '',
        ...availableOptions.map((opt, i) => `${i + 1}. ${opt}`),
        '',
        '_Henry will never charge you for AI use. Your keys stay local — cloud providers\' free tiers are generous enough that most people never pay anything._',
      ].join('\n');
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: setupMessage,
        conversation_id: convId,
        created_at: new Date().toISOString(),
        model: 'setup-required',
        provider: 'henry',
      });
      setIsStreaming(false);
      setStreamingContent('');
      setCompanionStatus({ status: 'idle' });
      return;
    }

    // Detect tier before resolving model (for presence phrase and status label)
    const presenceTier = detectPresenceTier(content, settings);
    const tierLabel = presenceTier === 'quality' ? '70B' : presenceTier === 'fast' ? '8B' : '';
    setCompanionStatus({
      status: 'thinking',
      taskDescription: tierLabel ? `Thinking… (${tierLabel})` : 'Thinking…',
    });

    // Presence behavior — speak a short ack before heavy tasks so Henry feels responsive
    if (presenceTier === 'quality' && ttsEnabled) {
      const phrase = getPresencePhrase('quality', content);
      if (phrase) void speakPresence(phrase, settings, []);
    }

    // ── Web tool auto-routing ───────────────────────────────────────────────
    // Detect if this message needs live web access, execute the right tools,
    // and inject results into the system prompt as enriched context.
    setLastWebSources([]);
    let webContextBlock = '';
    if (shouldUseWebTools(content)) {
      setIsSearching(true);
      try {
        const apiKeys = getSearchApiKeys();
        const toolResult = await runWebTools(content, {
          ...apiKeys,
          onStatus: (msg) =>
            setCompanionStatus({ status: 'thinking', taskDescription: msg }),
        });
        webContextBlock = toolResult.contextBlock;
        if (toolResult.sources.length > 0) {
          setLastWebSources(toolResult.sources);
        }
      } catch {
        // Web tools failed — Henry answers from training knowledge
      } finally {
        setIsSearching(false);
        setCompanionStatus({
          status: 'thinking',
          taskDescription: tierLabel ? `Thinking… (${tierLabel})` : 'Thinking…',
        });
      }
    }

    // ── Self-repair tool auto-routing ───────────────────────────────────────
    // When Henry's message touches his own systems, run self-repair tools and
    // inject results as enriched context (same pattern as web tools above).
    let selfRepairContextBlock = '';
    if (shouldUseSelfTools(content)) {
      try {
        const selfResult = await runSelfTools(content, {
          onStatus: (msg) =>
            setCompanionStatus({ status: 'thinking', taskDescription: msg }),
        });
        selfRepairContextBlock = selfResult.contextBlock;
      } catch (err) {
        logError('tool_failure', `Self-repair tools failed to run: ${String(err)}`, {
          severity: 'low',
        });
      } finally {
        setCompanionStatus({
          status: 'thinking',
          taskDescription: tierLabel ? `Thinking… (${tierLabel})` : 'Thinking…',
        });
      }
    }

    // Lean memory slices from DB (summary, facts, workspace hints); format in memoryContext.ts
    const emptyLean: HenryLeanMemoryParts = {
      conversationSummary: null,
      facts: [],
      workspaceHints: [],
    };
    let lean: HenryLeanMemoryParts = emptyLean;
    let deepContextBlock = '';
    const bandwidth = getActiveMemoryBandwidth();
    try {
      const ctx = await window.henryAPI.buildContext({
        conversationId: convId,
        query: content,
        bandwidth,
      });
      lean = ctx.lean;
      // Format extended memory layers (Layer 3–7) into system prompt block
      if (ctx.extended) {
        const formatted = formatDeepContext(ctx, { bandwidth, maxTokenBudget: 12_000 });
        deepContextBlock = formatted.systemBlock;
      }
    } catch {
      /* Memory context is optional */
    }

    // Auto-ingest personal memory from user message (fire-and-forget)
    autoIngestPersonalMemory(content).catch(() => {});

    // Start/continue session tracking
    sessionStart(convId).catch(() => {});

    const convTitle = conversations.find((c) => c.id === convId)?.title ?? null;
    const workspacePath = settings.workspace_path?.trim() || null;
    const writerType = getWriterDocumentType(writerDocumentTypeId);
    const design3dType = getDesign3DWorkflowType(design3dWorkflowTypeId);
    const lastFile = effectiveMode === 'design3d' ? design3dRefPath : null;
    const design3dRefNote =
      effectiveMode === 'design3d' && lastFile
        ? buildDesign3dReferenceFilesNote([lastFile])
        : null;

    const wsCtx = activeWorkspaceContext;
    const wsIndexHint = wsCtx ? findIndexHintForContext(wsCtx, lean.workspaceHints) : null;
    setWorkspaceContextIndexHint(wsIndexHint);
    const wsBlock =
      wsCtx != null
        ? buildWorkspaceContextPromptSection(wsCtx, { indexSummaryHint: wsIndexHint })
        : '';

    // ── Brain Router decision ─────────────────────────────────────────────
    const threadMessagesLive = useStore.getState().messages.filter((m) => m.conversation_id === convId);

    const brainDecision = routeRequest({
      message: content,
      mode: effectiveMode,
      historyLength: threadMessagesLive.length,
      hasWorkspaceContext: !!activeWorkspaceContext,
    });

    // ── Debug store: capture routing decision ─────────────────────────────
    useDebugStore.getState().setDecision(brainDecision);

    // Gate blocked actions before touching the model at all
    if (brainDecision.actionGate.decision === 'block') {
      const blockMsg = brainDecision.actionGate.reason
        ?? `That action isn't available right now.`;
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: blockMsg,
        conversation_id: convId,
        created_at: new Date().toISOString(),
        model: 'router',
        provider: 'henry',
      });
      setIsStreaming(false);
      setCompanionStatus({ status: 'idle' });
      return;
    }

    // Deferred actions: let Henry respond naturally but prepend a quiet note
    // (the note is folded into the system prompt context, not shown in chat)
    const deferNote = brainDecision.actionGate.decision === 'defer'
      ? `\n\n[Note: This action is deferred. Respond helpfully but do not execute the action — suggest it as a next step instead.]`
      : '';

    // ── Context tier (from brain router, replaces standalone selectContextTier call)
    const intent: MessageIntent = classifyMessageIntent(content);
    const tier: ContextTier = brainDecision.contextTier;
    const tierHistoryCaps = TIER_HISTORY_CAPS[tier];
    const tierMemoryCaps  = TIER_MEMORY_CAPS[tier];

    // Trim lean data to tier caps before building memory block
    const tieredLean = {
      conversationSummary: tierMemoryCaps.maxSummaryChars === 0
        ? null
        : (lean.conversationSummary?.slice(0, tierMemoryCaps.maxSummaryChars) ?? null),
      facts: lean.facts.slice(0, tierMemoryCaps.maxFacts),
      workspaceHints: lean.workspaceHints.slice(0, tierMemoryCaps.maxWorkspaceHints),
    };

    // Build memory context: empty for LIGHT, compact for MEDIUM, full for FULL
    const memoryContext = tier === 'light'
      ? ''
      : buildHenryMemoryContextBlock({
          mode: effectiveMode,
          lean: tieredLean,
          workspacePathHint: workspacePath,
          conversationTitle: convTitle,
          writerDocumentTypeLabel:
            effectiveMode === 'writer' ? writerType?.label ?? null : null,
          design3dWorkflowLabel:
            effectiveMode === 'design3d' ? design3dType?.label ?? null : null,
          design3dReferenceNote: design3dRefNote,
          activeWorkspaceContextBlock: wsBlock || null,
        });

    // History: apply tier-based caps (fewer messages + shorter per-message on LIGHT)
    const history = sliceRecentThreadMessages(
      threadMessagesLive.map((m) => ({
        role: m.role,
        content: capMessageContent(m.content, tierHistoryCaps.maxCharsEach),
      })),
      tierHistoryCaps.maxMessages
    );

    // Get companion engine settings — use model router to pick the right provider/model
    const providers = await window.henryAPI.getProviders();
    const s = useStore.getState().settings;

    const route = resolveChat(content, s, providers);
    let companionProvider = route.provider;
    let companionModel = route.model;
    let provider = providers.find((p: any) => p.id === companionProvider);

    // If router's choice has no provider object, fall back to companion_model_2 or raw companion
    if (!provider || !companionModel) {
      const fallbackModel = s.companion_model_2;
      const fallbackProvider = s.companion_provider_2 || s.companion_provider;
      if (fallbackModel && fallbackProvider) {
        companionProvider = fallbackProvider;
        companionModel = fallbackModel;
        provider = providers.find((p: any) => p.id === companionProvider);
      }
    }

    if (!provider || !companionModel) {
      addMessage({
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'assistant',
        content: '⚠️ No model configured. Go to Settings → Engines, click **Auto-detect** if you have Ollama running, or set a model manually.',
        engine: 'companion',
        created_at: new Date().toISOString(),
      });
      setIsStreaming(false);
      setCompanionStatus({ status: 'idle' });
      return;
    }

    // Check for custom mode system prompt override
    const customModeRaw = (() => { try { return localStorage.getItem('henry_custom_mode_override'); } catch { return null; } })();
    const customModeOverride = customModeRaw ? (() => { try { return JSON.parse(customModeRaw) as { systemPrompt?: string; name?: string }; } catch { return null; } })() : null;

    // ── Build system prompt for this tier ────────────────────────────────────

    let systemPrompt: string;
    if (customModeOverride?.systemPrompt) {
      systemPrompt = `${customModeOverride.systemPrompt}\n\n${memoryContext ? `## Memory Context\n${memoryContext}` : ''}`;
    } else if (tier === 'full' || effectiveMode === 'writer' || effectiveMode === 'design3d') {
      // FULL tier or mode-specific (writer/design3d) always use the rich system prompt
      systemPrompt = buildCompanionStreamSystemPrompt(effectiveMode, memoryContext, {
        weather: currentWeather,
        hasWebContext: webContextBlock.length > 0,
        currentView: useStore.getState().currentView,
        ...(effectiveMode === 'writer'
          ? { writerDocumentTypeId, writerActiveDraftRelativePath: writerActiveDraftPath }
          : {}),
        ...(effectiveMode === 'design3d'
          ? { design3dWorkflowTypeId, design3dReferencePath: design3dRefPath }
          : {}),
      });
    } else if (tier === 'medium') {
      // MEDIUM tier: light base + compact memory + connected services summary
      systemPrompt = buildMediumSystemPrompt(effectiveMode, memoryContext, {
        weather: currentWeather,
      });
    } else {
      // LIGHT tier (default): core identity + mode only
      systemPrompt = buildLightSystemPrompt(effectiveMode, { weather: currentWeather });
      if (intent === 'awareness') {
        systemPrompt += '\n\n' + buildAwarenessSummary();
      }
    }

    // Emotional intelligence — detect user state and adapt tone (all tiers)
    const emotionResult = detectEmotionalState(content);
    const emotionBlock = buildEmotionBlock(emotionResult);

    // Extra context: LIGHT skips deep memory + self-repair blocks (saves ~400–800 tokens)
    const extraContextParts = tier === 'light'
      ? [emotionBlock, webContextBlock]
      : [deepContextBlock, emotionBlock, webContextBlock, selfRepairContextBlock];
    const extraContext = extraContextParts.filter(Boolean).join('\n\n');
    const enrichedSystemPrompt = (extraContext
      ? `${systemPrompt}\n\n${extraContext}`
      : systemPrompt) + deferNote;

    // ── Token guard ──────────────────────────────────────────────────────────
    const systemTokens = estimateTokens(enrichedSystemPrompt);
    const historyTokensBefore = history.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
    // Use provider-appropriate context limit
    const providerLimits: Record<string, number> = {
      groq: 100_000,
      anthropic: 180_000,
      openai: 100_000,
      google: 800_000,
      ollama: 30_000,
    };
    const effectiveLimit = providerLimits[companionProvider ?? ''] ?? TOKEN_HARD_LIMIT;
    const guardedHistory = trimHistoryToTokenBudget(history, systemTokens, effectiveLimit);
    const historyTokensAfter = guardedHistory.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);

    // ── Context logging ──────────────────────────────────────────────────────
    logContextDecision({
      tier,
      intent,
      systemTokens,
      historyTokensBefore,
      historyTokensAfter,
      totalTokens: systemTokens + historyTokensAfter,
      historyCountBefore: history.length,
      historyCountAfter: guardedHistory.length,
      trimmed: guardedHistory.length < history.length,
    });

    // ── Debug store: capture token/context snapshot ───────────────────────
    useDebugStore.getState().setTokens({
      estimated: systemTokens + historyTokensAfter,
      historyTrimmed: guardedHistory.length < history.length,
      tier,
      tierReason: brainDecision.rationale,
    });

    const messagesPayload: HenryAIMessage[] = [
      { role: 'system', content: enrichedSystemPrompt },
      ...guardedHistory.map((m) => ({
        role: m.role as HenryAIMessage['role'],
        content: m.content,
      })),
    ];

    const apiKey = provider.api_key || provider.apiKey || '';

    // LEAN PROMPT: for Groq free tier AND Ollama — bypass the full 12k-token charter
    // Exception: computer mode always gets the full prompt so action patterns are clear
    const useLeanPrompt = (companionProvider === 'groq' || companionProvider === 'ollama') && effectiveMode !== 'computer';

    // Use Henry Cloud Proxy if no personal Groq key is set
    let effectiveApiKey = apiKey;
    const effectiveProvider = companionProvider;
    const effectiveModel = companionModel;
    let useProxy = false;
    if (companionProvider === 'groq' && (!apiKey || apiKey.length < 10) && HENRY_PROXY_ENABLED && canUseHenryProxy()) {
      useProxy = true;
      effectiveApiKey = 'henry-proxy'; // placeholder, proxy uses its own key
    }

    if (useLeanPrompt) {
      const minimalSys = buildGroqFreeSystemPrompt(effectiveMode);
      const messagesPayloadGroq: HenryAIMessage[] = [
        { role: 'system', content: minimalSys },
        ...guardedHistory.map((m) => ({
          role: m.role as HenryAIMessage['role'],
          content: m.content,
        })),
        { role: 'user', content },
      ];
      // Hard cap total to 2000 chars per slot for safety
      if (messagesPayloadGroq.length > 1) {
        let budget = 6000;
        const sys0 = messagesPayloadGroq[0];
        const conv = messagesPayloadGroq.slice(1, -1);
        const last = messagesPayloadGroq[messagesPayloadGroq.length - 1];
        const kept: HenryAIMessage[] = [];
        for (let i = conv.length - 1; i >= 0; i--) {
          if (conv[i].content.length <= budget) { kept.unshift(conv[i]); budget -= conv[i].content.length; }
        }
        messagesPayloadGroq.splice(0, messagesPayloadGroq.length, sys0, ...kept, last);
      }
      // Route through Henry Cloud Proxy if no personal key
      const groqStream = useProxy
        ? (() => {
            // Direct fetch to Henry proxy (streaming)
            const ctrl = new AbortController();
            const deviceId = (() => {
              try {
                let id = localStorage.getItem('henry:device_id');
                if (!id) { id = crypto.randomUUID(); localStorage.setItem('henry:device_id', id); }
                return id;
              } catch { return 'unknown'; }
            })();
            const licenseKey = localStorage.getItem('henry:license_key') || '';
            let chunkCb: ((c: string) => void) | undefined;
            let doneCb: ((t: string) => void) | undefined;
            let errCb: ((e: string) => void) | undefined;
            void (async () => {
              try {
                const r = await fetch(HENRY_PROXY_URL + '/v1/chat', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Henry-Device': deviceId,
                    'X-Henry-License': licenseKey,
                    'X-Henry-Version': '0.7.9',
                  },
                  body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: messagesPayloadGroq, max_tokens: 1024, stream: true }),
                  signal: ctrl.signal,
                });
                if (!r.ok) {
                  const errData = await r.json().catch(() => ({ error: { message: 'Proxy error ' + r.status } })) as any;
                  const msg = errData.error?.message || 'Proxy error ' + r.status;
                  if (r.status === 429) {
                    errCb?.('**Daily limit reached** — 50 free requests/day used.\n\nAdd your free Groq key in **Settings → AI Providers** for unlimited responses (takes 60 seconds at console.groq.com).');
                  } else {
                    errCb?.(msg);
                  }
                  return;
                }
                const reader = r.body!.getReader(); const dec = new TextDecoder();
                let full = '';
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = dec.decode(value);
                  for (const line of text.split('\n').filter(l => l.startsWith('data: '))) {
                    const d = line.slice(6).trim();
                    if (d === '[DONE]') {
                      try { incrementUsage(); } catch { /* non-critical */ }
                      doneCb?.(full); return;
                    }
                    try { const p = JSON.parse(d); const c = p.choices?.[0]?.delta?.content || ''; if (c) { full += c; chunkCb?.(c); } } catch { }
                  }
                }
                doneCb?.(full);
              } catch (e: any) {
                if (e.name !== 'AbortError') errCb?.(e.message || 'Proxy connection failed');
              }
            })();
            return {
              onChunk: (cb: (c: string) => void) => { chunkCb = cb; },
              onDone: (cb: (t: string) => void) => { doneCb = cb; },
              onError: (cb: (e: string) => void) => { errCb = cb; },
              cancel: () => ctrl.abort(),
            };
          })()
        : window.henryAPI.streamMessage({
            provider: companionProvider,
            model: companionModel,
            apiKey,
            messages: messagesPayloadGroq,
            temperature: 0.7,
            maxTokens: 1024,
          });
      streamRef.current = groqStream;
      groqStream.onChunk((chunk: string) => { appendStreamingContent(chunk); });
      groqStream.onError((error: string) => {
        let errorContent: string;
        // Use the companionProvider to correctly attribute errors
        errorContent = buildStreamError(companionProvider, companionModel, error);
        addMessage({ id: crypto.randomUUID(), conversation_id: convId, role: 'assistant', content: errorContent, engine: 'companion', created_at: new Date().toISOString() });
        setStreamingContent(''); setIsStreaming(false); setCompanionStatus({ status: 'idle' });
      });
      groqStream.onDone(async (fullText: string) => {
        // Save the message and finalize
        setStreamingContent('');
        if (!fullText?.trim()) {
          addMessage({ id: crypto.randomUUID(), conversation_id: convId, role: 'assistant' as const,
            content: "Henry didn't respond. The message may have been too long or Groq hit a rate limit. Try a **New Chat**.",
            engine: 'companion', created_at: new Date().toISOString() } as any);
        } else {
          const assistantMsg = { id: crypto.randomUUID(), conversation_id: convId, role: 'assistant' as const,
            content: fullText, engine: 'companion', created_at: new Date().toISOString() } as any;
          addMessage(assistantMsg);
          try { await window.henryAPI.saveMessage(assistantMsg); } catch { /* ignore */ }
        }
        setIsStreaming(false);
        setCompanionStatus({ status: 'idle' });
      });
      return;
    }

    // ── HTTPS + Ollama guard ────────────────────────────────────────────────
    // Browsers silently block HTTP requests from HTTPS pages (mixed content).
    // Catch this before the fetch so we can show a helpful message instead of
    // the cryptic "load failed" network error.
    if (companionProvider === 'ollama' && window.location.protocol === 'https:') {
      const ollamaBase = (useStore.getState().settings.ollama_base_url || 'http://localhost:11434');
      if (ollamaBase.startsWith('http://')) {
        addMessage({
          id: crypto.randomUUID(),
          conversation_id: convId,
          role: 'assistant',
          content: [
            `🔒 **Henry can't reach Ollama from this browser page**`,
            ``,
            `Ollama runs on plain HTTP (\`${ollamaBase}\`), but this page is HTTPS — the browser blocks that connection automatically.`,
            ``,
            `**Your options:**`,
            `- **Use the desktop app** — Henry connects to Ollama directly, no browser restrictions`,
            `- **Switch to a Cloud AI** — OpenAI, Anthropic, or Google. Add an API key in **Settings → AI Providers**`,
            `- **Remote Ollama** — If Ollama is on another machine at e.g. \`192.168.x.x\`, update the URL in **Settings → AI Providers → Ollama** (must still be served over HTTPS or via the desktop app)`,
          ].join('\n'),
          engine: 'companion',
          created_at: new Date().toISOString(),
        });
        setStreamingContent('');
        setIsStreaming(false);
        setCompanionStatus({ status: 'idle' });
        return;
      }
    }

    try {
      setCompanionStatus({ status: 'streaming' });

      // Max output tokens — sized to realistic response lengths, not theoretical max.
      // Smaller ceilings reduce TTFT because models reserve capacity before streaming.
      const maxOutputTokens = presenceTier === 'quality' ? 6_000 : presenceTier === 'fast' ? 1_500 : 3_000;

      // Iron Gateway — route to cheapest capable path
      const gatewayResult = gatewayRoute(content, {
        settings: s,
        history: messagesPayload.slice(1).map(m => ({ role: m.role, content: m.content })).slice(-10),
      });

      // Tier 0: handled locally — zero tokens, zero cost
      if (gatewayResult.handled) {
        const localMsg: Message = {
          id: crypto.randomUUID(),
          conversation_id: convId,
          role: 'assistant',
          content: gatewayResult.response,
          engine: 'companion',
          created_at: new Date().toISOString(),
        };
        addMessage(localMsg);
        try { await window.henryAPI.saveMessage(localMsg); } catch { /* ignore */ }
        setStreamingContent('');
        setIsStreaming(false);
        setCompanionStatus({ status: 'idle' });
        return;
      }

      // Use gateway model selection if it overrides (tier 1 = fast 8b, tier 2 = 70b)
      if (gatewayResult.tier === 1 && s.chat_fast_model) {
        companionModel = s.chat_fast_model;
        companionProvider = s.chat_fast_provider || companionProvider;
      }
      // tier 2 uses the already-set companion_model (70b)

      // GROQ FREE TIER: 12,000 tokens/minute hard limit.
      // Henry's full charter is 12,000+ tokens alone. Must slash aggressively.
      if (companionProvider === 'groq') {
        // Cap system prompt to 4,000 chars (~1,000 tokens) — leaves 11k for conversation
        if (messagesPayload[0]?.role === 'system') {
          const sys = messagesPayload[0].content;
          const SYS_CAP = 4_000;
          if (sys.length > SYS_CAP) {
            // Keep the first part (identity/role) which is most important
            messagesPayload[0].content = sys.slice(0, SYS_CAP) + '\n[Context condensed for free tier]';
          }
        }
        // Cap total to 8,000 chars (~2,000 tokens) — well under Groq free 12k TPM
        const totalChars = messagesPayload.reduce((s, m) => s + m.content.length, 0);
        if (totalChars > 8_000) {
          const sys = messagesPayload[0];
          const rest = messagesPayload.slice(1);
          let budget = 4_000; // 4k for conversation history after system prompt
          const kept: typeof rest = [];
          for (let i = rest.length - 1; i >= 0; i--) {
            const chars = rest[i].content.length;
            if (chars <= budget) { kept.unshift(rest[i]); budget -= chars; }
          }
          messagesPayload.splice(0, messagesPayload.length, sys, ...kept);
        }
      }

      const stream = window.henryAPI.streamMessage({
        provider: companionProvider,
        model: companionModel,
        apiKey,
        messages: messagesPayload,
        temperature: 0.7,
        maxTokens: maxOutputTokens,
        apiUrl: companionProvider === 'ollama'
          ? (s.ollama_base_url || 'http://localhost:11434')
          : undefined,
        // Agent mode: a non-empty `tools` array tells the main process to route
        // this turn through the agent ToolRunner. The real tool schemas come
        // from the main-process registry, so the marker array is sufficient.
        // `sessionId` ties the run's tool-call audit trail to this conversation.
        ...(agentMode
          ? { tools: [{ name: 'henry-agent' }], sessionId: activeConversationId || undefined }
          : {}),
      });

      streamRef.current = stream;

      stream.onChunk((chunk: string) => {
        appendStreamingContent(chunk);
      });

      stream.onDone(async (fullText: string, usage?: any) => {
        // Track cost for the iron gateway cost dashboard
        if (usage && (usage.total_tokens || usage.input_tokens)) {
          const totalTok = usage.total_tokens || (usage.input_tokens + (usage.output_tokens || 0));
          try { trackCost(companionModel, totalTok); } catch { /* ignore */ }
        }

        // Extract facts from this exchange in the background (non-blocking)
        void (async () => {
          try {
            const st = useStore.getState();
            const groqKey = st.providers?.find((p: any) => p.id === 'groq')?.apiKey || '';
            if (groqKey && messagesPayload.length >= 2) {
              const recentMsgs = messagesPayload.slice(-6).map(m => ({ role: m.role, content: String(m.content || '') }));
              const facts = await extractFactsFromConversation(recentMsgs, groqKey);
              if (facts.length > 0) {
                addFacts(facts);
                await persistFactsToDb(facts);
              }
            }
          } catch { /* non-critical — never block chat */ }
        })();

        // Action interceptor — detect and execute real computer actions from Henry's text
        // This runs BEFORE saving the message so results can be appended
        if (fullText && fullText.trim()) {
          try {
            const actionResults = await interceptAndExecute(fullText);
            if (actionResults.length > 0) {
              // Append real execution results to Henry's response
              const resultLines = actionResults.map(r => {
                let line = '\n\n**Execution result:** ' + r.output;
                if (r.screenshotUrl) {
                  line += '\n\n![Screenshot](' + r.screenshotUrl + ')';
                }
                return line;
              });
              fullText = fullText + resultLines.join('');
            }
          } catch { /* non-critical — continue without results */ }
        }

        // Empty response guard — Groq/API returned nothing (context too large, rate limit, or network drop)
        if (!fullText || !fullText.trim()) {
          const retryMsg = companionProvider === 'groq'
            ? "Henry didn't get a response from Groq. This usually means the conversation is too long for one request, or Groq hit a rate limit.\n\n**Try:** Start a new chat and ask the same question. Or ask a shorter, more specific question in this chat."
            : `Henry got an empty response from ${companionProvider}. The request may have been too long or hit a rate limit. Try starting a new chat.`;
          addMessage({
            id: crypto.randomUUID(),
            conversation_id: convId,
            role: 'assistant',
            content: retryMsg,
            engine: 'companion',
            created_at: new Date().toISOString(),
          });
          setStreamingContent('');
          setIsStreaming(false);
          setCompanionStatus({ status: 'idle' });
          return;
        }

        // Binary content guard — bail with explanation rather than rendering garbage
        if (isBinaryContent(fullText)) {
          addMessage({
            id: crypto.randomUUID(),
            conversation_id: convId,
            role: 'assistant',
            content: buildBinaryContentError(companionProvider, companionModel),
            engine: 'companion',
            created_at: new Date().toISOString(),
          });
          setStreamingContent('');
          setIsStreaming(false);
          setCompanionStatus({ status: 'idle' });
          return;
        }

        // Save assistant message
        const assistantMsg = {
          id: crypto.randomUUID(),
          conversation_id: convId,
          role: 'assistant' as const,
          content: fullText,
          engine: 'companion' as const,
          model: companionModel,
          provider: companionProvider,
          tokens_used: usage?.total_tokens,
          cost: usage?.cost,
          routeReason: route.reason,
          created_at: new Date().toISOString(),
        };

        addMessage(assistantMsg);
        setStreamingContent('');
        setIsStreaming(false);
        setCompanionStatus({ status: 'done' });
        setTimeout(() => setCompanionStatus({ status: 'idle' }), 1500);

        // ── Debug store: record actual model used ─────────────────────────
        useDebugStore.getState().setModels([
          { role: 'companion', provider: companionProvider, model: companionModel, isFallback: false },
        ]);

        // Auto-extract Henry's commitments and next steps into working memory
        if (fullText.length > 80) {
          autoSaveCommitments(fullText, convId);
          // Also check for durable commitments on both sides of the conversation
          autoExtractUserCommitments(content, convId);
          autoExtractHenryCommitments(fullText, convId);
        }

        // Tick session tracker — track message count + emotional pattern
        sessionTick({ emotionalPattern: emotionResult?.state || undefined });

        // Builder mode: extract HTML and show live preview
        if (effectiveMode === 'builder') {
          const extracted = extractHtmlFromMessage(fullText);
          if (extracted) {
            setBuilderPreviewHtml(extracted);
            setBuilderPreviewOpen(true);
          }
        }

        try {
          await window.henryAPI.saveMessage(assistantMsg);
          // Track cost vs benchmark for savings dashboard
          if (assistantMsg.cost != null && assistantMsg.cost >= 0) {
            try {
              recordUsage({
                provider: assistantMsg.provider || 'unknown',
                model: assistantMsg.model || 'unknown',
                cost: assistantMsg.cost || 0,
                tokensIn: Math.floor((assistantMsg.tokens_used || 0) * 0.4),
                tokensOut: Math.floor((assistantMsg.tokens_used || 0) * 0.6),
              });
            } catch { /* non-critical */ }
          }
        } catch (err) {
          console.error('Failed to save assistant message:', err);
        }

        // Try to extract and save any facts from the conversation
        try {
          if (content.length > 30) {
            await window.henryAPI.saveFact({
              conversation_id: convId,
              fact: content.slice(0, 200),
              category: 'conversation',
              importance: 1,
            });
          }
        } catch {
          // Fact extraction is optional
        }

        // Auto-name conversation after the first complete exchange
        try {
          const allConvMsgs = useStore.getState().messages.filter((m) => m.conversation_id === convId);
          const userCount = allConvMsgs.filter((m) => m.role === 'user').length;
          if (userCount === 1) {
            void autoNameConversation(convId, content, fullText, companionProvider, companionModel, apiKey);
          }
        } catch { /* optional */ }

        // Auto-delegate to Worker Brain if the task is heavy and Worker is configured
        const heavyTaskType = detectTaskType(content);
        const isHeavyTask = heavyTaskType === 'code_generate' || heavyTaskType === 'research';
        if (isHeavyTask) {
          const s = useStore.getState().settings;
          const workerProvider = s.worker_provider;
          const workerModel = s.worker_model;
          if (workerProvider && workerModel) {
            // Silent delegation — Companion already responded, Worker supplements with deep output
            void handleWorkerRequest(content, convId, true);
          }
        }

        // Track usage analytics (local only)
        try { trackUsage(effectiveMode, useStore.getState().currentView); } catch { /* non-critical */ }

        // Surface contextual follow-up suggestion chips
        try {
          const lastUser = useStore.getState().messages.filter(m => m.role === 'user').at(-1);
          const chips = getSmartSuggestions(fullText, lastUser?.content ?? '');
          setSmartSuggestions(chips);
        } catch { /* non-critical */ }

        // Auto-summarize conversation every N messages for long-session memory
        try {
          const allMsgs = useStore.getState().messages.filter(m => m.conversation_id === convId);
          const assistantCount = allMsgs.filter(m => m.role === 'assistant').length;
          if (convId && shouldSummarize(convId, assistantCount)) {
            const prompt = buildSummaryPrompt(allMsgs.slice(-16).map(m => ({ role: m.role, content: m.content })));
            // Fire-and-forget summary generation
            const sumProvider = useStore.getState().settings.companion_provider;
            const sumModel = useStore.getState().settings.companion_model;
            const sumProviders = await window.henryAPI.getProviders();
            const sumProv = sumProviders.find((p: any) => p.id === sumProvider);
            const sumKey = sumProv?.api_key || sumProv?.apiKey || '';
            if (sumProvider && sumModel && sumKey) {
              window.henryAPI.streamMessage({
                provider: sumProvider, model: sumModel, apiKey: sumKey,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
              }).onDone((summary: string) => {
                if (summary && convId) {
                  saveSessionSummary({ conversationId: convId, summary: summary.trim(), messageCount: assistantCount, generatedAt: new Date().toISOString() });
                }
              });
            }
          }
        } catch { /* non-critical — summary is enhancement only */ }
      });

      stream.onError(async (error: string) => {
        // Try fallback model before showing error
        const curSettings = useStore.getState().settings;
        const fallbackM = curSettings.companion_model_2;
        const fallbackP = curSettings.companion_provider_2 || curSettings.companion_provider;
        const usedFallback = companionModel !== curSettings.companion_model; // already on fallback

        if (fallbackM && fallbackP && !usedFallback && fallbackM !== companionModel) {
          setStreamingContent('');
          setCompanionStatus({ status: 'thinking', taskDescription: `Switching to ${fallbackM}…` });
          // Show a quiet inline notice so the user knows something switched
          appendStreamingContent(buildFallbackNotice(companionModel, fallbackM) + '\n\n');
          // Swap to fallback — try proxy once, then stop
          const fallbackProviders = await window.henryAPI.getProviders();
          const fbProvider = fallbackProviders.find((p: any) => p.id === fallbackP);
          const fbApiKey = fbProvider?.api_key || fbProvider?.apiKey || '';

          const fbStream = window.henryAPI.streamMessage({
            provider: fallbackP,
            model: fallbackM,
            apiKey: fbApiKey,
            messages: messagesPayload,
            temperature: 0.7,
          });

          streamRef.current = fbStream;
          setCompanionStatus({ status: 'streaming' });

          fbStream.onChunk((chunk: string) => { appendStreamingContent(chunk); });
          fbStream.onDone(async (fullText: string) => {
            const fbMsg = {
              id: crypto.randomUUID(),
              conversation_id: convId,
              role: 'assistant' as const,
              content: fullText,
              engine: 'companion' as const,
              model: fallbackM,
              provider: fallbackP,
              created_at: new Date().toISOString(),
            };
            addMessage(fbMsg);
            setStreamingContent('');
            setIsStreaming(false);
            setCompanionStatus({ status: 'idle' });
            // ── Debug store: fallback model used ─────────────────────────
            useDebugStore.getState().setModels([
              { role: 'companion', provider: fallbackP, model: fallbackM, isFallback: true },
            ]);
            if (effectiveMode === 'builder') {
              const extracted = extractHtmlFromMessage(fullText);
              if (extracted) { setBuilderPreviewHtml(extracted); setBuilderPreviewOpen(true); }
            }
            try { await window.henryAPI.saveMessage(fbMsg); } catch { /* optional */ }
          });
          fbStream.onError((fbError: string) => {
            addMessage({
              id: crypto.randomUUID(),
              conversation_id: convId,
              role: 'assistant',
              content: buildBothFailedError(companionProvider, companionModel, error, fallbackM, fbError),
              engine: 'companion',
              created_at: new Date().toISOString(),
            });
            setStreamingContent('');
            setIsStreaming(false);
            setCompanionStatus({ status: 'error', message: 'Both models failed' });
            setTimeout(() => setCompanionStatus({ status: 'idle' }), 3000);
          });
          return;
        }

        const isNetworkBlock = /load failed|failed to fetch|networkerror|network request failed|couldn't reach|could not reach|connection error|network error/i.test(error);
        const isOllama = companionProvider === 'ollama';
        const isHttpsCtx = window.location.protocol === 'https:';
        const isOllamaNotRunning = isOllama && /ollama isn't running|ollama not running/i.test(error);
        const isOllamaModelMissing = isOllama && /isn't loaded in ollama|not found in ollama/i.test(error);
        const ollamaBase = s.ollama_base_url || 'http://localhost:11434';

        let errorContent: string;
        if (isOllamaNotRunning) {
          errorContent = [
            `**Ollama isn't running.**`,
            ``,
            `I tried to use your local model at \`${ollamaBase}\` but couldn't reach it.`,
            ``,
            `**Start it in Terminal:**`,
            `\`\`\``,
            `ollama serve`,
            `\`\`\``,
            `Then send your message again.`,
            ``,
            `Or switch to a cloud provider (Groq / OpenAI / Anthropic) in **Settings → Engines** — those work without Ollama.`,
          ].join('\n');
        } else if (isOllamaModelMissing) {
          errorContent = [
            `**Model not found in Ollama.**`,
            ``,
            `\`${companionModel}\` isn't loaded yet. Pull it in Terminal:`,
            `\`\`\``,
            `ollama pull ${companionModel}`,
            `\`\`\``,
            `Then try again.`,
          ].join('\n');
        } else if (isNetworkBlock && isOllama && isHttpsCtx) {
          errorContent = [
            `🔒 **Henry can't reach Ollama from this browser page**`,
            ``,
            `Ollama runs on HTTP but this page is HTTPS — the browser blocks that connection.`,
            ``,
            `**Fix:** Open **Settings → AI Providers** and switch to a Cloud AI (OpenAI / Anthropic / Google), or use the Henry desktop app where this restriction doesn't apply.`,
          ].join('\n');
        } else if (isNetworkBlock) {
          // The error string may already be a friendly message from the stream layer;
          // use it directly if it reads naturally, otherwise add a generic wrapper.
          const alreadyFriendly = error.length > 40 && !error.startsWith('[');
          errorContent = alreadyFriendly
            ? `❌ ${error}`
            : `❌ **Connection failed** — Henry couldn't reach the AI provider. Check your API key in **Settings → AI Providers**, or try again in a moment.`;
        } else if (isOllama) {
          errorContent = `**Ollama error.** ${error}\n\nCheck the model name and Ollama status in **Settings → Engines**.`;
        } else {
          errorContent = buildStreamError(companionProvider, companionModel, error);
        }

        addMessage({
          id: crypto.randomUUID(),
          conversation_id: convId,
          role: 'assistant',
          content: errorContent,
          engine: 'companion',
          created_at: new Date().toISOString(),
        });
        setStreamingContent('');
        setIsStreaming(false);
        setCompanionStatus({ status: 'error', message: error });
        setTimeout(() => setCompanionStatus({ status: 'idle' }), 3000);
      });
    } catch (err: unknown) {
      addMessage({
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'assistant',
        content: buildStartError(err),
        engine: 'companion',
        created_at: new Date().toISOString(),
      });
      setIsStreaming(false);
      setCompanionStatus({ status: 'idle' });
    }
  }

  async function handleWorkerRequest(content: string, convId: string, silent = false) {
    const taskType = detectTaskType(content);

    // Get recent conversation messages so Worker has the same context as Companion
    const threadMsgs = useStore.getState().messages.filter((m) => m.conversation_id === convId);
    const contextMessages: HenryAIMessage[] = threadMsgs
      .slice(-10)
      .map((m) => ({ role: m.role as HenryAIMessage['role'], content: m.content.slice(0, 800) }));

    if (!silent) {
      addMessage({
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'assistant',
        content: `⚡ Worker Brain is on it...\n\n> ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}\n\nRunning in background — result will appear here when done.`,
        engine: 'worker',
        created_at: new Date().toISOString(),
      });
    }

    try {
      const result = await window.henryAPI.submitTask({
        description: content.slice(0, 200),
        type: taskType,
        payload: {
          prompt: content,
          conversationId: convId,
          context_messages: contextMessages,
          current_mode: operatingMode,
          auto_delegated: silent,
        },
        sourceEngine: 'companion',
        conversationId: convId,
        createdFromMode: operatingMode,
      });

      setWorkerStatus({
        status: 'working',
        taskId: result.id,
        taskDescription: content.slice(0, 100),
      });
    } catch (err: any) {
      if (!silent) {
        addMessage({
          id: crypto.randomUUID(),
          conversation_id: convId,
          role: 'assistant',
          content: `❌ Failed to start Worker: ${err.message}`,
          engine: 'worker',
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  function detectTaskType(content: string): string {
    const lower = content.toLowerCase();
    if (lower.includes('code') || lower.includes('function') || lower.includes('implement') || lower.includes('build') || lower.includes('create a')) {
      return 'code_generate';
    }
    if (lower.includes('research') || lower.includes('find') || lower.includes('compare') || lower.includes('analyze')) {
      return 'research';
    }
    if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('save')) {
      return 'file_operation';
    }
    return 'ai_generate';
  }

  async function handleSearch(query: string) {
    if (isSearching || isStreaming) return;
    setIsSearching(true);
    logAction({ type: 'search', description: `Web search: ${query}`, input: query, success: true });
    try {
      const apiKeys = getSearchApiKeys();
      const sr = await webSearch(query, apiKeys);
      const formatted = formatSearchResultsForHenry(sr);
      const injected = `${formatted}\n\n---\nMy question: ${query}`;
      setChatInject({ id: Date.now(), text: injected });
    } catch (err) {
      console.error('[Henry] web search failed:', err);
      setChatInject({
        id: Date.now(),
        text: `Search failed for: ${query}\n\nMy question: ${query}`,
      });
    } finally {
      setIsSearching(false);
    }
  }

  async function handleBrowseUrl(url: string, userQuestion?: string) {
    if (isSearching || isStreaming) return;
    setIsSearching(true);
    logAction({ type: 'search', description: `Browse URL: ${url}`, input: url, success: true });
    try {
      const page = await fetchPageContent(url);
      const formatted = formatPageContentForHenry(page);
      const suffix = userQuestion ? `\n\n---\nMy question: ${userQuestion}` : '';
      setChatInject({ id: Date.now(), text: `${formatted}${suffix}` });
    } catch (err) {
      console.error('[Henry] URL browse failed:', err);
      setChatInject({ id: Date.now(), text: `Failed to browse ${url}. Error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setIsSearching(false);
    }
  }

  function cancelStream() {
    if (streamRef.current) {
      streamRef.current.cancel();
      streamRef.current = null;
    }
    // Stamp the in-flight message as cancelled so user knows it wasn't a crash
    const currentContent = useStore.getState().streamingContent;
    if (currentContent && currentContent.trim()) {
      const msgs = useStore.getState().messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === 'assistant') {
        const cancelledContent = currentContent.trimEnd() + '\n\n*[Cancelled]*';
        useStore.getState().updateMessage(lastMsg.id, {
          content: cancelledContent,
          isStreaming: false,
        });
        window.henryAPI.saveMessage({
          ...lastMsg,
          content: cancelledContent,
          isStreaming: false,
        }).catch(() => {});
      }
    }
    setStreamingContent('');
    setIsStreaming(false);
    setCompanionStatus({ status: 'idle' });
  }

  // Keep wake word ref always pointing to latest handleSend (safe to assign during render)
  // eslint-disable-next-line react-hooks/refs -- intentional: keep ref to latest handler
  wakeHandleSendRef.current = handleSend;

  const activeConvTitle = conversations.find(c => c.id === activeConversationId)?.title ?? undefined;

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Messages area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
        {/* Export button — visible when conversation has messages */}
        {messages.length > 2 && (
          <div className="max-w-3xl mx-auto flex justify-end mb-1">
            <button
              onClick={() => exportConversation(messages, activeConvTitle)}
              className="text-[10px] text-henry-text-muted hover:text-henry-text px-2 py-1 rounded-lg hover:bg-henry-surface/40 transition-all flex items-center gap-1"
              title="Export conversation as Markdown"
            >⬇ Export</button>
          </div>
        )}
        {messages.length === 0 && !isStreaming ? (
          <>
            <EmptyChat
              onModeAndInject={(mode, text) => {
                setOperatingMode(mode);
                setChatInject({ id: Date.now(), text });
              }}
              proactiveSuggestion={proactiveSuggestion}
            />
          </>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {messages.map((msg) => {
              const head = msg.content.trimStart();
              const isErrorBubble =
                msg.role === 'assistant' && (head.startsWith('⚠️') || head.startsWith('❌'));
              const showWorkspaceSave =
                (operatingMode === 'writer' || operatingMode === 'design3d') &&
                msg.role === 'assistant' &&
                msg.engine !== 'worker' &&
                !isErrorBubble;
              const showCreateTask =
                shouldOfferCreateTaskFromMessage(operatingMode, msg, isErrorBubble) &&
                msg.engine !== 'worker';

              const isAuthError = isErrorBubble &&
                /unauthorized|401|invalid.api.key|api[\s_-]?key|no.*key|authentication|billing|quota|forbidden|403/i.test(msg.content);

              return (
                <div key={msg.id}>
                  <MessageBubble
                    message={msg}
                    workspaceSaveDraft={
                      showWorkspaceSave
                        ? {
                            enabled: true,
                            workspaceReady: !!settings.workspace_path?.trim(),
                            busy: saveWorkspaceDraftBusy,
                            label:
                              operatingMode === 'design3d' ? 'Save design plan' : 'Save draft',
                            onSave: () =>
                              operatingMode === 'design3d'
                                ? handleSaveDesign3dPlan(msg.content)
                                : handleSaveWriterDraft(msg.content),
                          }
                        : undefined
                    }
                    createTask={undefined}
                    onQuickAction={
                      msg.role === 'assistant' && !isStreaming
                        ? (prompt) => void handleSend(prompt)
                        : undefined
                    }
                  />
                  {isAuthError && (
                    <div className="flex items-center gap-2 mt-1 ml-11 pb-1">
                      <button
                        onClick={() => useStore.getState().setCurrentView('settings')}
                        className="text-xs text-henry-accent hover:underline flex items-center gap-1"
                      >
                        → Add or fix your API key in Settings
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Streaming indicator — show as soon as streaming starts (content may be empty until first chunk) */}
            {isStreaming && (
              <MessageBubble
                message={{
                  id: 'streaming',
                  conversation_id: '',
                  role: 'assistant',
                  content: streamingContent,
                  engine: 'companion',
                  created_at: new Date().toISOString(),
                }}
                isStreaming={true}
                streamingContent={streamingContent}
              />
            )}

            {/* Web sources — shown after Henry responds with live web data */}
            {!isStreaming && lastWebSources.length > 0 && (
              <div className="flex flex-wrap gap-2 px-2 pt-1 pb-2 animate-fade-in">
                <span className="text-[10px] uppercase tracking-wide text-henry-text-muted self-center shrink-0">Sources</span>
                {lastWebSources.slice(0, 6).map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-henry-border/40 bg-henry-surface/30 text-[11px] text-henry-text-muted hover:text-henry-accent hover:border-henry-accent/30 transition-colors max-w-[220px] truncate"
                    title={s.title}
                  >
                    <svg className="w-2.5 h-2.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                    <span className="truncate">{s.title.slice(0, 45) || s.url}</span>
                  </a>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-henry-border/30 bg-henry-surface/20 px-3 sm:px-6 py-3 sm:py-4">
        <div className="max-w-3xl mx-auto">
          {operatingMode === 'design3d' && (
            <Design3DReferencePanel
              referencePath={design3dRefPath}
              workflowTypeId={design3dWorkflowTypeId}
              onWorkflowChange={setDesign3dWorkflowTypeId}
              onInjectChat={(text) => setChatInject({ id: Date.now(), text })}
              disabled={isStreaming}
              onRequestExportPack={() => openExportPack('design3d_handoff')}
            />
          )}
          {operatingMode === 'writer' && (
            <WriterDraftLibrary
              writerDocumentTypeId={writerDocumentTypeId}
              activeDraftPath={writerActiveDraftPath}
              onInjectChat={(text) => setChatInject({ id: Date.now(), text })}
              disabled={isStreaming}
              onRequestExportPack={() => openExportPack('writer_handoff')}
            />
          )}
          {!!settings.workspace_path?.trim() && (
            <WorkspaceContextStrip
              context={activeWorkspaceContext}
              indexHintForCopy={workspaceContextIndexHint}
              onInjectChat={(text) => setChatInject({ id: Date.now(), text })}
              disabled={isStreaming}
            />
          )}

          {/* Henry state indicator */}
          {companionStatus.status !== 'idle' && !isSearching && (
            <div className={`flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg text-xs animate-fade-in border ${
              companionStatus.status === 'thinking'
                ? 'bg-henry-accent/6 border-henry-accent/15 text-henry-accent/80'
                : companionStatus.status === 'planning'
                ? 'bg-henry-accent/8 border-henry-accent/20 text-henry-accent/85'
                : companionStatus.status === 'acting'
                ? 'bg-henry-worker/8 border-henry-worker/20 text-henry-worker/85'
                : companionStatus.status === 'streaming'
                ? 'bg-henry-companion/6 border-henry-companion/15 text-henry-companion/80'
                : companionStatus.status === 'working'
                ? 'bg-henry-worker/6 border-henry-worker/15 text-henry-worker/80'
                : companionStatus.status === 'done'
                ? 'bg-henry-success/6 border-henry-success/20 text-henry-success/80'
                : companionStatus.status === 'error'
                ? 'bg-henry-error/6 border-henry-error/20 text-henry-error/80'
                : 'bg-henry-surface/30 border-henry-border/30 text-henry-text-dim'
            }`}>
              {companionStatus.status === 'thinking' && (
                <>
                  <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.2" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  <span>{companionStatus.taskDescription || 'Thinking…'}</span>
                </>
              )}
              {companionStatus.status === 'planning' && (
                <>
                  <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.2" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  <span>{companionStatus.taskDescription || 'Planning…'}</span>
                </>
              )}
              {companionStatus.status === 'acting' && (
                <>
                  <span className="inline-flex gap-0.5 items-end h-3">
                    <span className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                  <span>{companionStatus.taskDescription || 'Acting…'}</span>
                </>
              )}
              {companionStatus.status === 'streaming' && (
                <>
                  <span className="inline-flex gap-0.5 items-end h-3">
                    <span className="w-0.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-0.5 h-2.5 bg-current rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-0.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                  <span>Responding…</span>
                </>
              )}
              {companionStatus.status === 'working' && (
                <>
                  <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.2" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  <span>{companionStatus.taskDescription || 'Working…'}</span>
                </>
              )}
              {companionStatus.status === 'done' && (
                <>
                  <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>Done</span>
                </>
              )}
              {companionStatus.status === 'error' && (
                <span>{companionStatus.message || 'Something went wrong'}</span>
              )}
            </div>
          )}

          {isSearching && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-henry-accent/8 border border-henry-accent/15 text-xs text-henry-accent/80 animate-fade-in">
              <svg className="w-3.5 h-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
              <span>Searching the web for current information…</span>
            </div>
          )}
          {autoSwitchNotice && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-henry-accent/10 border border-henry-accent/20 text-xs text-henry-accent animate-fade-in">
              <span>✦</span>
              <span>Switched to <strong>{autoSwitchNotice}</strong> mode based on your message</span>
              <button
                onClick={() => setAutoSwitchNotice(null)}
                className="ml-auto text-henry-accent/60 hover:text-henry-accent"
              >
                ×
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 md:gap-3 overflow-x-auto scrollbar-none pb-0.5">


            {operatingMode === 'developer' && coderAvailable() && (
              <label className="flex flex-col gap-1 shrink-0 text-[10px] text-henry-text-muted uppercase tracking-wide">
                Coder
                <select
                  className="text-xs font-medium normal-case tracking-normal rounded-lg border border-henry-border/40 bg-henry-surface/40 text-henry-text px-2 py-1.5 max-w-[12rem] focus:outline-none focus:ring-1 focus:ring-henry-accent/50"
                  value={coderEngineChoice}
                  onChange={(e) => void pickCoderEngine(e.target.value)}
                  aria-label="Coder engine for Code mode"
                >
                  <option value="auto">
                    Auto{coderStatus ? ` — ${coderStatus.claude.available ? 'Claude Code' : coderStatus.local.model ? 'Local' : 'none ready'}` : ''}
                  </option>
                  <option value="claude-code" disabled={coderStatus ? !coderStatus.claude.available : false}>
                    Claude Code{coderStatus && !coderStatus.claude.available ? ' (not installed)' : ''}
                  </option>
                  <option value="local" disabled={coderStatus ? !coderStatus.local.model : false}>
                    Local (free){coderStatus && !coderStatus.local.model ? ' (not ready)' : ''}
                  </option>
                </select>
              </label>
            )}
            <div className="flex-1">
              
              {/* Smart follow-up suggestion chips */}
              {smartSuggestions.length > 0 && !isStreaming && (
                <div className="px-4 pb-2 flex flex-wrap gap-2">
                  {smartSuggestions.map((chip) => (
                    <button
                      key={chip.id}
                      onClick={() => {
                        setSmartSuggestions([]);
                        window.dispatchEvent(new CustomEvent('henry_inject_draft', { detail: { text: chip.prompt } }));
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-henry-surface border border-henry-border/30 text-henry-text-dim hover:text-henry-text hover:border-henry-accent/40 hover:bg-henry-accent/5 transition-all"
                    >
                      <span>{chip.icon}</span>
                      <span>{chip.label}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => setSmartSuggestions([])}
                    className="px-2 py-1.5 rounded-full text-[10px] text-henry-text-muted hover:text-henry-text transition-colors"
                  >✕</button>
                </div>
              )}

<ChatInput
                onSend={handleSend}
                isStreaming={isStreaming}
                onCancel={isStreaming ? cancelStream : undefined}
                injectDraft={chatInject}
                onInjectConsumed={() => setChatInject(null)}
                placeholder="Message Henry…"
                ttsEnabled={ttsEnabled}
                onToggleTts={toggleTts}
                agentMode={agentMode}
                onToggleAgentMode={toggleAgentMode}
                onSearch={handleSearch}
                isSearching={isSearching}
                pendingAttachments={pendingAttachments}
                onAttachmentsChange={setPendingAttachments}
                conversationId={activeConversationId ?? undefined}
                ambientMode={settings.ambient_mode === 'on'}
                onFileIngest={(content, fileName) => {
                  handleSend(
                    `I'm sharing a file with you — **${fileName}**. Here's the content:\n\n\`\`\`\n${content}\n\`\`\`\n\nGive me your honest, multi-angle take on it. What stands out? What questions does it raise? And ask me what I'd like to do with it.`
                  );
                }}
              />
            </div>
          </div>

          {operatingMode === 'developer' && coderAvailable() && (
            <p className="text-[10px] text-henry-text-muted mt-2 leading-relaxed">
              Coder engine: <span className="text-henry-text-dim">{describeActiveEngine(coderStatus)}</span>
              {coderStatus?.active === 'none' && (
                <>
                  {' — '}
                  {!coderStatus.claude.available && (
                    <span>Claude Code CLI missing (<span className="text-henry-text-dim">npm install -g @anthropic-ai/claude-code</span>). </span>
                  )}
                  {!coderStatus.local.model && coderStatus.local.hint && (
                    <span>Local coder: {coderStatus.local.hint}.</span>
                  )}
                </>
              )}
              {coderStatus?.active === 'claude-code' && (
                <> · Edits apply automatically only inside <span className="text-henry-text-dim">~/HenryAI/coder-projects</span>; elsewhere Claude Code asks first.</>
              )}
              {coderStatus?.active === 'local' && (
                <> · The free local coder writes code in chat — it doesn't edit files on disk.</>
              )}
            </p>
          )}

          {operatingMode === 'builder' && (
            <p className="text-[10px] text-henry-text-muted mt-2 leading-relaxed">
              App Builder: describe anything — landing page, dashboard, tool, game. Henry generates a complete,
              working HTML app instantly. Preview appears live on the right. Tell him to change anything and he
              rebuilds it in full.
              {builderPreviewHtml && !builderPreviewOpen && (
                <button
                  onClick={() => setBuilderPreviewOpen(true)}
                  className="ml-1 text-henry-accent hover:underline"
                >
                  Show preview →
                </button>
              )}
            </p>
          )}

        </div>
      </div>
      </div>
      {(operatingMode === 'builder' || builderPreviewOpen) && (
        <BuilderPreviewPanel
          html={builderPreviewHtml}
          isStreaming={isStreaming}
          streamingHtml={streamingContent}
          onClose={() => setBuilderPreviewOpen(false)}
        />
      )}



      <ExportPackBuilder
        key={exportPackSession}
        open={exportPackOpen}
        initialPreset={exportPackPreset}
        workspaceReady={!!settings.workspace_path?.trim()}
        context={{
          operatingMode,
          writerActiveDraftPath,
          design3dRefPath,
          activeWorkspaceContext,
          activeConversationId,
          tasks,
        }}
        onClose={() => setExportPackOpen(false)}
        onExportCreated={(baseDir) => {
          const st = useStore.getState();
          saveSessionResumeSnapshot({
            lastConversationId: st.activeConversationId,
            operatingMode,
            writerDocumentTypeId,
            design3dWorkflowTypeId,
            writerActiveDraftPath,
            design3dReferencePath: design3dRefPath,
            activeWorkspaceContext,
            lastExportPackRelativeDir: baseDir,
          });
          setRecoverySnapshot((prev) =>
            prev
              ? { ...prev, lastExportPackRelativeDir: baseDir, savedAt: new Date().toISOString() }
              : readSavedSessionResume()
          );
        }}
      />

      <CreateTaskFromMessageModal
        open={!!createTaskFromMessage}
        suggestion={
          createTaskFromMessage
            ? buildSuggestedTaskFromMessage({
                message: createTaskFromMessage,
                operatingMode,
                linkage: resolveWorkspaceLinkageForTask(operatingMode, {
                  writerActiveDraftPath,
                  design3dRefPath,
                }),
              })
            : null
        }
        onClose={() => setCreateTaskFromMessage(null)}
        onSubmit={async (title, body) => {
          const msg = createTaskFromMessage;
          if (!msg) return;
          const sug = buildSuggestedTaskFromMessage({
            message: msg,
            operatingMode,
            linkage: resolveWorkspaceLinkageForTask(operatingMode, {
              writerActiveDraftPath,
              design3dRefPath,
            }),
          });
          const result = await window.henryAPI.submitTask({
            description: title,
            type: sug.taskType,
            priority: 6,
            sourceEngine: 'companion',
            conversationId: msg.conversation_id,
            payload: {
              prompt: body,
              henryOrigin: {
                createdFromMode: sug.sourceMode,
                relatedFilePath: sug.relatedFilePath,
                createdFromMessageId: sug.createdFromMessageId,
                relatedConversationId: sug.relatedConversationId,
              },
            },
            createdFromMode: sug.sourceMode,
            relatedFilePath: sug.relatedFilePath,
            createdFromMessageId: sug.createdFromMessageId,
          });
          const st = useStore.getState();
          if (!st.tasks.some((t) => t.id === result.id)) {
            const now = new Date().toISOString();
            st.addTask({
              id: result.id,
              description: title,
              type: sug.taskType,
              status: 'queued',
              priority: 6,
              created_at: now,
              created_from_mode: sug.sourceMode,
              related_file_path: sug.relatedFilePath,
              created_from_message_id: sug.createdFromMessageId,
              source_engine: 'companion',
              conversation_id: msg.conversation_id,
            });
          }
          setWorkerStatus({
            status: 'working',
            taskId: result.id,
            taskDescription: title.slice(0, 100),
          });
        }}
      />
    </div>
  );
}

const DISCOVERY_MODES: Array<{
  mode: HenryOperatingMode;
  icon: string;
  title: string;
  desc: string;
  examples: string[];
}> = [
  {
    mode: 'companion',
    icon: '💬',
    title: 'Just Talk',
    desc: 'Ask anything, think out loud, plan your day, or have a real conversation.',
    examples: [
      'What should I focus on today?',
      'Help me think through a decision I\'m facing',
      'Give me a motivating thought for the morning',
    ],
  },
  {
    mode: 'writer',
    icon: '✍️',
    title: 'Write Something',
    desc: 'Letters, essays, stories, outlines, summaries — you describe it, Henry drafts it.',
    examples: [
      'Help me write an email to my landlord',
      'Draft a short essay about gratitude',
      'Give me an outline for a 5-page report',
    ],
  },
  {
    mode: 'builder',
    icon: '🌐',
    title: 'Build an App',
    desc: 'Describe a website or app. Henry generates it live — one HTML file, works instantly.',
    examples: [
      'Build me a personal landing page',
      'Create a task manager app with localStorage',
      'Make a dashboard with charts and stats',
    ],
  },
  {
    mode: 'developer',
    icon: '💻',
    title: 'Help With Code',
    desc: 'Debug errors, explain concepts, review code, or plan a project.',
    examples: [
      'Why does my code keep giving an error?',
      'Explain what a for loop does in plain English',
      'Review this function and suggest improvements',
    ],
  },
  {
    mode: 'design3d',
    icon: '🎨',
    title: 'Design & 3D',
    desc: 'Plan room layouts, 3D models, architectural ideas, and visual projects.',
    examples: [
      'Help me plan a small kitchen layout',
      'What are the steps to model a chair in Blender?',
      'Describe a cozy home office setup for me',
    ],
  },
  {
    mode: 'coach',
    icon: '🎯',
    title: 'Coach Me',
    desc: 'Accountability, clarity, follow-through. Henry asks the question you need to hear.',
    examples: [
      'I keep procrastinating on a big project — help me figure out why',
      'What should I actually focus on this week?',
      'I feel overwhelmed. Help me think through this.',
    ],
  },
  {
    mode: 'strategic',
    icon: '♟️',
    title: 'Think Strategically',
    desc: 'Big picture thinking. Priorities, tradeoffs, leverage points, and clear roadmaps.',
    examples: [
      'Help me think through my biggest priorities for the next 90 days',
      'I have three opportunities — help me choose the right one',
      'Map out the risks in what I\'m planning to do',
    ],
  },
  {
    mode: 'business',
    icon: '🚀',
    title: 'Business Builder',
    desc: 'Turn an idea into an offer, a plan, and a path to first revenue.',
    examples: [
      'I have a business idea — help me turn it into a real offer',
      'Who is the ideal customer for what I\'m building?',
      'What\'s the fastest path to a first paying customer?',
    ],
  },
];

// ── Quick action pills — 6 essentials only ───────────────────────────────────
const QUICK_CHIPS = [
  { icon: '☀️', label: 'Morning brief', text: 'gm' },
  { icon: '📋', label: 'My jobs',       text: 'show jobs' },
  { icon: '💰', label: 'Who owes me',   text: 'who owes me' },
  { icon: '📊', label: 'Cash flow',     text: 'cash flow' },
  { icon: '💪', label: 'Habits',        text: 'habit consistency' },
  { icon: '🌙', label: 'Wrap up',       text: 'gn' },
];

function EmptyChat({
  onModeAndInject,
  proactiveSuggestion,
}: {
  onModeAndInject: (mode: HenryOperatingMode, text: string) => void;
  proactiveSuggestion?: string | null;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center pb-6">
      <div className="w-full max-w-md px-6 animate-fade-in">

        {/* Identity */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-henry-accent/10 border border-henry-accent/20 flex items-center justify-center text-2xl">🤖</div>
          <h2 className="text-base font-semibold text-henry-text">Henry AI</h2>
        </div>

        {/* Proactive suggestion */}
        {proactiveSuggestion && (
          <div className="mb-6 flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-henry-accent/6 border border-henry-accent/15">
            <span className="shrink-0 text-henry-accent text-xs mt-0.5">💡</span>
            <p className="text-[11px] text-henry-text leading-relaxed">{proactiveSuggestion}</p>
          </div>
        )}

        {/* 6 core chips in 2 rows of 3 */}
        <div className="grid grid-cols-3 gap-2">
          {QUICK_CHIPS.map(({ icon, label, text }) => (
            <button
              key={label}
              onClick={() => onModeAndInject('companion', text)}
              className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl bg-henry-surface/40 border border-henry-border/20 text-henry-text-muted hover:text-henry-text hover:border-henry-accent/25 hover:bg-henry-hover/30 transition-all active:scale-95"
            >
              <span className="text-base">{icon}</span>
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}
