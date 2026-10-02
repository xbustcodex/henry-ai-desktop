import type {
  AIProvider,
  Conversation,
  Message,
  Task,
  MemoryFact,
  MemoryContext,
  DirectoryResult,
  MessageAttachment,
  MemoryGraphNode,
  MemoryGraphEdge,
  AutomationRun,
  MediaItem,
  MediaKind,
  RuntimeStatus,
  StartupFailure,
  OpencodeModelInfo,
  CatalogEntry,
  CatalogEntryState,
  CatalogListing,
} from './types';

declare global {
  interface HenryProviderRecord {
    id: string;
    name: string;
    api_key?: string;
    apiKey?: string;
    enabled: number | boolean;
    models: string | string[];
    created_at?: string;
    updated_at?: string;
  }

  interface HenryTaskFilter {
    status?: string;
    limit?: number;
  }

  interface HenryTaskSubmission {
    description: string;
    type: string;
    priority?: number;
    payload?: unknown;
    sourceEngine?: string;
    conversationId?: string;
    createdFromMode?: string;
    relatedFilePath?: string;
    createdFromMessageId?: string;
  }

  interface HenryTaskResultPayload {
    taskId: string;
    conversationId?: string;
    error?: string;
    result?: {
      type?: string;
      content?: string;
      model?: string;
      cost?: number;
      [key: string]: unknown;
    } | string;
  }

  interface HenryEngineStatusPayload {
    engine: 'companion' | 'worker';
    status: 'idle' | 'thinking' | 'working' | 'streaming' | 'error';
    taskId?: string;
    taskDescription?: string;
    message?: string;
    queueLength?: number;
  }

  // ── Coder Engine ────────────────────────────────────────────
  /** Normalized event shared by both coder engines (Claude Code CLI + local Ollama). */
  interface HenryCoderEvent {
    kind: 'init' | 'text' | 'tool' | 'result' | 'error';
    /** init/result: the CLI session id (use to resume follow-ups). */
    sessionId?: string;
    /** init: model in use. */
    model?: string;
    /** text: assistant text chunk. result: final text. */
    text?: string;
    /** tool: tool name + one-line activity summary. */
    name?: string;
    summary?: string;
    /** result: success flag + run stats. */
    ok?: boolean;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    /** error: what went wrong (actionable). */
    message?: string;
  }

  interface HenryCoderStatus {
    /** The configured setting (coder_engine): auto | claude-code | opencode | local. */
    engine: 'auto' | 'claude-code' | 'opencode' | 'local';
    /** Which engine would actually run right now. */
    active: 'claude-code' | 'opencode' | 'local' | 'none';
    claude: { available: boolean; path?: string; version?: string };
    opencode?: { available: boolean; path?: string; version?: string; error?: string };
    local: { ollamaRunning: boolean; model: string | null; hint?: string };
    workspaceDir: string;
  }

  interface HenryCoderRunHandle {
    channelId: string;
    onEvent: (cb: (event: HenryCoderEvent) => void) => void;
    cancel: () => void;
  }

  interface HenryAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }

  interface HenryAIRequest {
    provider: string;
    model: string;
    apiKey: string;
    messages: HenryAIMessage[];
    temperature?: number;
    maxTokens?: number;
    /** Ollama / local proxy base URL (renderer passes through to main). */
    apiUrl?: string;
    /**
     * Agent mode. When present and non-empty, the main process routes this turn
     * through the agent ToolRunner (calendar, messages, quotes, QuickBooks, web)
     * instead of a plain completion. The array is only a flag — the real tool
     * schemas come from the main-process registry — so passing the lightweight
     * `listTools()` catalogue (or any non-empty array) is sufficient.
     */
    tools?: unknown[];
    /** Session id the agent run logs its tool-call audit trail against. */
    sessionId?: string;
  }

  interface HenryAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    input?: number;
    output?: number;
  }

  interface HenryAIResponse {
    content: string;
    usage?: HenryAIUsage;
    cost?: number;
  }

  interface HenryAIStreamController {
    onChunk: (cb: (chunk: string) => void) => void;
    onDone: (cb: (fullText: string, usage?: HenryAIUsage) => void) => void;
    onError: (cb: (error: string) => void) => void;
    cancel: () => Promise<unknown> | void;
  }

  interface HenrySaveFactInput {
    id?: string;
    conversation_id?: string;
    fact: string;
    category?: string;
    importance?: number;
    created_at?: string;
  }

  interface HenrySearchFactsInput {
    query: string;
    category?: string;
    limit?: number;
  }

  interface HenryBuildContextInput {
    conversationId?: string;
    query?: string;
    /** Optional: rows to read before renderer-side dedupe (default 40) */
    maxFactsFetch?: number;
    /** Memory bandwidth mode (shallow/normal/deep/maximum) */
    bandwidth?: string;
  }

  /** Matches `memory:saveSummary` IPC (camelCase). */
  interface HenrySummaryInput {
    conversationId: string;
    summary: string;
    messageCount?: number;
    tokenCount?: number;
  }

  /**
   * A `conversation_summaries` row — what `memory:getSummary` actually returns.
   * It was previously declared as `string | null`, which never matched the
   * handler's `SELECT *`; the summary text is the `summary` field.
   */
  interface HenryConversationSummary {
    id: string;
    conversation_id: string;
    summary: string;
    message_count: number;
    token_count: number;
    created_at: string;
  }

  interface HenryTerminalRequest {
    command: string;
    cwd?: string;
    timeout?: number;
    channelId?: string;
  }

  interface HenryTerminalResponse {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    execId?: string;
  }

  // ── Computer Control Types ─────────────────────────────────────────
  interface HenryScreenshotResult {
    success: boolean;
    base64: string | null;
    mimeType?: string;
    error?: string;
  }

  interface HenryPermissionsResult {
    platform: string;
    accessibility: boolean;
    screenRecording: boolean;
    accessibilityInstructions?: string | null;
    screenRecordingInstructions?: string | null;
    message?: string;
  }

  // Uniform envelope returned by every session:* IPC handler. `result` holds
  // the SessionStore command output (shape varies by command); on failure
  // `ok` is false and `error` carries the Python-side message.
  interface HenrySessionResult<T = unknown> {
    ok: boolean;
    result?: T;
    error?: string;
  }

  interface HenryComputerShellResult {
    success: boolean;
    output: string;
    error?: string;
    exitCode?: number;
  }

  interface HenrySystemInfo {
    platform: string;
    arch: string;
    hostname: string;
    homeDir: string;
    appVersion: string;
    totalMemoryGB: string;
    freeMemoryGB: string;
    macOS?: string;
  }

  // ── 3D Printer Types ───────────────────────────────────────────────
  interface HenryPrinterPort {
    device: string;
    description: string;
    hwid: string;
  }

  interface HenryPrinterData {
    type: 'response' | 'sent' | 'error' | 'disconnected';
    data?: string;
  }

  // ── Agent: confirm-tier tool gate ───────────────────────────
  interface HenryConfirmRequest {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    description: string;
    safetyLevel: 'confirm';
  }

  // ── Scheduler: Henry's Routines ─────────────────────────────
  interface HenryRoutine {
    id: string;
    name: string;
    description: string | null;
    cronExpression: string;
    prompt: string;
    enabled: number; // 1 | 0
    lastRunAt: string | null;
    nextRunAt: string | null;
    createdAt: string;
  }

  interface HenryRoutineInput {
    name: string;
    description?: string;
    cronExpression: string;
    prompt: string;
    enabled?: boolean;
  }

  /** A 3D printer found on the local network. */
  interface HenryDiscoveredPrinter {
    ip: string;
    port?: number;
    kind: string;
    name?: string;
    url?: string;
    via: 'http' | 'ssdp';
  }

  /** Connection details for talking to a network printer's API. */
  interface HenryPrinterConn {
    ip: string;
    port?: number;
    kind: string;
    apiKey?: string;
  }

  /** Normalized live status from a network printer. */
  interface HenryPrinterStatus {
    state?: string;
    nozzle?: { actual: number; target: number };
    bed?: { actual: number; target: number };
    progress?: number;
    job?: string;
  }

  // ── Machine connectivity (unified printer/CNC layer) ───────
  type HenryMachineKind = 'printer' | 'cnc';
  type HenryMachineProtocol = 'bambu' | 'moonraker' | 'octoprint' | 'marlin-serial' | 'grbl-serial';
  type HenryMachineState = 'idle' | 'printing' | 'running' | 'paused' | 'error' | 'offline';

  /** Per-protocol connection settings — only the relevant fields are used. */
  interface HenryMachineConfig {
    host?: string;
    port?: number;
    serialNumber?: string; // Bambu
    accessCode?: string;   // Bambu LAN access code
    apiKey?: string;       // OctoPrint
    devicePath?: string;   // serial
    baudRate?: number;     // serial
  }

  /** Normalized live status from any machine driver. */
  interface HenryMachineStatus {
    state: HenryMachineState;
    progressPct?: number;
    tempNozzle?: number;
    tempNozzleTarget?: number;
    tempBed?: number;
    tempBedTarget?: number;
    jobName?: string;
    timeRemainingSec?: number;
    positionXYZ?: { x: number; y: number; z: number };
    raw?: unknown;
  }

  /** A saved machine connection (machine_connections table) + live flags. */
  interface HenryMachineConnection {
    id: string;
    name: string;
    kind: HenryMachineKind;
    protocol: HenryMachineProtocol;
    config: HenryMachineConfig;
    connected?: boolean;
    status?: HenryMachineStatus;
    created_at?: string;
    updated_at?: string;
  }

  /** Status of one probed capability. */
  type HenryCapabilityStatus =
    | 'ready' | 'degraded' | 'dependency-missing' | 'unsupported-session' | 'unavailable';

  interface HenryCapabilityDetail {
    status: HenryCapabilityStatus;
    backend?: string;
    details?: string;
    regionCapture?: boolean;
    windowCapture?: boolean;
  }

  interface HenryComputerCapabilities {
    platform: string;
    clipboard: HenryCapabilityDetail;
    selectedText: HenryCapabilityDetail;
    screenCapture: HenryCapabilityDetail;
    inputAutomation: HenryCapabilityDetail;
    session?: { type: string; isWayland: boolean; isWSL: boolean };
  }

  interface HenryMachineCapabilities {
    sendJob: boolean;
    pauseResume: boolean;
    stop: boolean;
  }

  /** A candidate found by machines:discover. */
  interface HenryDiscoveredMachine {
    host?: string;
    port?: number;
    devicePath?: string;
    protocolGuess: HenryMachineProtocol | 'unknown';
    label: string;
    via: 'port-scan' | 'serial';
  }

  /** Live event pushed over machines:event. */
  interface HenryMachineEvent {
    type: 'status' | 'connected' | 'disconnected' | 'job-progress' | 'error';
    machineId: string;
    status?: HenryMachineStatus;
    message?: string;
  }

  /** Uniform envelope for every machines:* IPC call. */
  type HenryMachinesResult<T> = { ok: true; result: T } | { ok: false; error: string };

  /** A saved slicing profile (slicer_profiles table). */
  interface HenrySlicerProfile {
    id: string;
    name: string;
    material?: string | null;
    printer_def?: string | null;
    settings_json: string;
    notes?: string | null;
    created_at?: string;
    updated_at?: string;
  }

  /** A captured piece of book material (book_entries table). */
  interface HenryBookEntry {
    id: string;
    kind: 'story' | 'lesson' | 'letter' | 'faith' | 'health' | 'fatherhood' | 'business' | 'money' | 'other';
    title?: string | null;
    content: string;
    created_at?: string;
    updated_at?: string;
  }

  // ── Lessons / Curriculum (courses + lessons + lesson_reviews tables) ──
  /** An AI-generated course (syllabus lives in outline_json). */
  interface HenryLessonCourse {
    id: string;
    title: string;
    topic: string;
    kind: 'bible' | 'general';
    outline_json: string;
    created_at?: string;
    updated_at?: string;
    /** Aggregates from lessons:courses:list. */
    lesson_count?: number;
    completed_count?: number | null;
  }

  /** One lesson within a course; content_md is AI-generated then cached. */
  interface HenryLesson {
    id: string;
    course_id: string;
    idx: number;
    title: string;
    content_md: string | null;
    status: 'locked' | 'available' | 'in_progress' | 'completed';
    score: number | null;
    completed_at: string | null;
  }

  /** A saved quiz attempt (lesson_reviews table). */
  interface HenryLessonReview {
    id: string;
    lesson_id: string;
    quiz_json: string;
    answers_json: string;
    score: number;
    created_at: string;
    lesson_title?: string;
    lesson_idx?: number;
  }

  type HenryLessonsResult<T> = { ok: true; result: T } | { ok: false; error: string };

  // ── Voice (local whisper.cpp STT + say/ElevenLabs TTS) ─────
  /** Uniform envelope for every voice:* IPC call. */
  type HenryVoiceResult<T> = { ok: true; result: T } | { ok: false; error: string };

  interface HenryVoiceSttStatus {
    binaryPresent: boolean;
    binaryPath: string | null;
    modelPresent: boolean;
    modelPath: string;
    ready: boolean;
  }

  interface HenryVoiceSetupProgress {
    phase: 'binary' | 'model';
    message: string;
    downloaded?: number;
    total?: number;
    pct?: number;
  }

  interface HenrySayVoice {
    name: string;
    lang: string;
    sample: string;
  }

  interface HenryVoiceTtsStatus {
    engine: 'auto' | 'local' | 'elevenlabs';
    active: 'local' | 'elevenlabs';
    elevenLabsKeyPresent: boolean;
    elevenVoiceId: string;
    sayVoice: string;
    sayRate: number;
    sayVoices: HenrySayVoice[];
  }

  interface HenryVoiceSpeakResult {
    engine: 'local' | 'elevenlabs' | 'none';
    spoke?: boolean;
    /** ElevenLabs mp3 bytes — play in the renderer via an Audio element. */
    audio?: Uint8Array;
    fellBack?: boolean;
  }

  interface HenryApproval {
    id: string;
    tool_name: string;
    description?: string | null;
    args_json?: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'needs_review' | 'expired' | 'completed';
    decided_args_json?: string | null;
    session_id?: string | null;
    requested_at?: string | null;
    decided_at?: string | null;
  }

  // ── Quoting (estimates → quotes → production runs) ─────────
  type HenryQuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

  interface HenryQuoteLineItem {
    id: string;
    quote_id: string;
    kind: 'material' | 'labor' | 'machine_time' | 'setup' | 'markup' | 'discount' | 'shipping' | 'other';
    description: string;
    quantity: number;
    unit: string;
    unit_cost: number;
    line_total: number | null;
    taxable: number;
    machine_id: string | null;
    material_id: string | null;
    sort_order: number;
    created_at: string;
  }

  /** A `quotes` row. quote:list returns the list columns; quote:get the full row plus `line_items`. */
  interface HenryQuote {
    id: string;
    quote_number: string;
    project_title: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    customer_company: string | null;
    status: HenryQuoteStatus;
    subtotal: number;
    tax_rate: number;
    tax_amount: number;
    total: number;
    currency: string;
    valid_days: number;
    valid_until: string | null;
    terms: string | null;
    notes: string | null;
    sent_at: string | null;
    decided_at: string | null;
    converted_run_id: string | null;
    created_at: string;
    updated_at: string;
    line_items?: HenryQuoteLineItem[];
  }

  interface HenryQuoteSummary {
    sinceDays: number;
    byStatus: Record<HenryQuoteStatus, { count: number; value: number }>;
    pipelineValue: number;
    wonValue: number;
    conversionRate: number;
  }

  interface HenryAPI {
    getSettings: () => Promise<Record<string, string>>;
    saveSetting: (key: string, value: string) => Promise<boolean>;

    getProviders: () => Promise<HenryProviderRecord[]>;
    // The handler returns an { ok } envelope, not a bare boolean. No caller
    // branches on the value, so this is a declaration fix only.
    saveProvider: (provider: Omit<AIProvider, 'models'> & { models: string }) => Promise<{ ok: boolean; error?: string }>;
    resyncProvidersToLocalStorage: () => Promise<{ ok: boolean; count?: number }>;

    getConversations: () => Promise<Conversation[]>;
    createConversation: (title: string) => Promise<Conversation>;
    updateConversation: (id: string, title: string) => Promise<boolean>;
    deleteConversation: (id: string) => Promise<boolean>;
    platform: () => string;

    getMessages: (conversationId: string) => Promise<Message[]>;
    saveMessage: (message: Message) => Promise<boolean>;

    // ── Chat attachments ──────────────────────────────────────
    saveAttachment: (input: {
      fileName: string;
      mimeType?: string;
      data: string | Uint8Array;
      conversationId?: string;
      messageId?: string;
    }) => Promise<{ ok: boolean; attachment?: MessageAttachment; error?: string }>;
    linkAttachmentsToMessage: (ids: string[], messageId: string, conversationId?: string) => Promise<{ ok: boolean; count: number }>;
    listAttachments: (conversationId: string) => Promise<MessageAttachment[]>;
    listAttachmentsForMessage: (messageId: string) => Promise<MessageAttachment[]>;
    getAttachment: (id: string) => Promise<{
      ok: boolean;
      mimeType?: string;
      fileName?: string;
      byteSize?: number;
      dataUrl?: string;
      error?: string;
    }>;
    deleteAttachment: (id: string) => Promise<{ ok: boolean; error?: string }>;
    openAttachment: (id: string) => Promise<{ ok: boolean; error?: string }>;

    // ── Media library ────────────────────────────────────────────
    mediaImport?: (opts?: { kind?: MediaKind }) => Promise<{
      ok: boolean;
      imported: MediaItem[];
      skipped?: string[];
      cancelled?: boolean;
      error?: string;
    }>;
    mediaList?: (opts?: { kind?: MediaKind; limit?: number }) => Promise<MediaItem[]>;
    mediaCounts?: () => Promise<Record<MediaKind, number>>;
    mediaGet?: (id: string) => Promise<{ ok: boolean; mimeType?: string; fileName?: string; dataUrl?: string; error?: string }>;
    mediaOpen?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    mediaReveal?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    mediaDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;

    // ── PrimeTech marketplace ────────────────────────────────
    marketplaceList?: () => Promise<CatalogListing>;
    marketplaceStates?: () => Promise<Record<string, CatalogEntryState>>;
    marketplaceFetch?: (entryId: string) => Promise<{ ok: boolean; path?: string; name?: string; byteSize?: number; error?: string }>;
    marketplaceOpenEntry?: (entryId: string) => Promise<{ ok: boolean; opened?: string; revealed?: string; error?: string }>;
    marketplaceReveal?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    marketplaceHistory?: () => Promise<Array<Record<string, unknown>>>;
    marketplaceRemove?: (entryId: string) => Promise<{ ok: boolean; error?: string }>;

    // ── Runtime / startup diagnostics ─────────────────────────
    runtimeGetStatus?: () => Promise<RuntimeStatus>;
    startupGetFailure?: () => Promise<StartupFailure | null>;
    startupClearFailure?: () => Promise<{ ok: boolean }>;
    runtimeRestart?: () => Promise<{ ok: boolean }>;

    sendMessage: (params: HenryAIRequest) => Promise<HenryAIResponse>;
    streamMessage: (params: HenryAIRequest) => HenryAIStreamController;

    getTasks: (filter?: HenryTaskFilter) => Promise<Task[]>;
    submitTask: (task: HenryTaskSubmission) => Promise<{ id: string; status: string }>;
    getTaskStatus: (id: string) => Promise<Task | null>;
    cancelTask: (id: string) => Promise<{ id?: string; status?: string; error?: string }>;
    retryTask: (id: string) => Promise<{ id?: string; status?: string; error?: string }>;
    getTaskStats: () => Promise<{
      byStatus: Array<{ status: string; count: number }>;
      totalCost: number;
      activeCount: number;
    }>;

    // ── Memory — Legacy ───────────────────────────────────────
    saveFact: (fact: HenrySaveFactInput) => Promise<boolean | MemoryFact>;
    searchFacts: (query: HenrySearchFactsInput) => Promise<MemoryFact[]>;
    getAllFacts: (limit?: number) => Promise<MemoryFact[]>;
    buildContext: (params: HenryBuildContextInput) => Promise<MemoryContext>;
    saveSummary: (summary: HenrySummaryInput) => Promise<{ id: string | null; error?: string }>;
    getSummary: (conversationId: string) => Promise<HenryConversationSummary | null>;

    // ── Memory — Layer 2: Session ─────────────────────────────
    saveSessionMemory: (session: Record<string, unknown>) => Promise<{ id: string; created?: boolean; updated?: boolean }>;
    getSessionMemory: (conversationId: string) => Promise<Record<string, unknown> | null>;
    compressSession: (opts: Record<string, unknown>) => Promise<{ compressed: boolean; summaryId: string }>;

    // ── Memory — Layer 3: Working Memory ─────────────────────
    getWorkingMemory: (userId?: string) => Promise<Record<string, unknown> | null>;
    updateWorkingMemory: (updates: Record<string, unknown>) => Promise<{ updated: boolean }>;

    // ── Memory — Layer 4: Personal Memory (scored) ────────────
    savePersonalMemory: (item: Record<string, unknown>) => Promise<{ id: string }>;
    getPersonalMemory: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    updatePersonalMemory: (id: string, updates: Record<string, unknown>) => Promise<{ updated: boolean }>;
    deletePersonalMemory: (id: string) => Promise<{ deleted: boolean }>;
    recallPersonalMemory: (id: string) => Promise<void>;

    // ── Memory — Layer 5: Projects ────────────────────────────
    saveProject: (project: Record<string, unknown>) => Promise<{ id: string }>;
    getProjects: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    updateProject: (id: string, updates: Record<string, unknown>) => Promise<{ updated: boolean }>;
    saveProjectMemory: (item: Record<string, unknown>) => Promise<{ id: string }>;
    getProjectMemory: (projectId: string) => Promise<Array<Record<string, unknown>>>;

    // ── Memory — Goals ────────────────────────────────────────
    saveGoal: (goal: Record<string, unknown>) => Promise<{ id: string }>;
    getGoals: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    updateGoal: (id: string, updates: Record<string, unknown>) => Promise<{ updated: boolean }>;
    deleteGoal: (id: string) => Promise<{ deleted: boolean; error?: string }>;

    // ── Memory — Commitments ──────────────────────────────────
    saveCommitment: (c: Record<string, unknown>) => Promise<{ id: string }>;
    getCommitments: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    resolveCommitment: (id: string) => Promise<{ resolved: boolean }>;
    updateCommitment: (id: string, updates: Record<string, unknown>) => Promise<{ updated: boolean }>;

    // ── Memory — Milestones ───────────────────────────────────
    saveMilestone: (m: Record<string, unknown>) => Promise<{ id: string }>;
    getMilestones: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

    // ── Memory — Layer 6: Relationship Memory ─────────────────
    saveRelationshipMemory: (item: Record<string, unknown>) => Promise<{ id: string; skipped?: boolean }>;
    getRelationshipMemory: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

    // ── Memory — Layer 7: Narrative Memory ───────────────────
    saveNarrativeMemory: (arc: Record<string, unknown>) => Promise<{ id: string; created?: boolean; updated?: boolean }>;
    getNarrativeMemory: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

    // ── Memory — Summaries + Graph ────────────────────────────
    saveMemorySummary: (s: Record<string, unknown>) => Promise<{ id: string }>;
    getMemorySummaries: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    saveGraphEdge: (edge: Record<string, unknown>) => Promise<{ id: string }>;
    getGraphEdges: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    getMemoryGraph: () => Promise<{
      ok: boolean;
      nodes: MemoryGraphNode[];
      edges: MemoryGraphEdge[];
      error?: string;
    }>;

    // ── Memory — Deep Context + Where-We-Left-Off ─────────────
    buildDeepContext: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getWhereWeLeftOff: () => Promise<Record<string, unknown>>;
    saveWhereWeLeftOff: (summary: string) => Promise<{ id: string }>;

    recordingsList: () => Promise<unknown[]>;
    recordingsGet: (id: string) => Promise<unknown>;
    recordingsSave: (r: Record<string,unknown>) => Promise<unknown>;
    recordingsDelete: (id: string) => Promise<unknown>;
    exportBackup: () => Promise<{ok: boolean; path?: string; error?: string}>;
    captureList: (limit?: number) => Promise<unknown[]>;
    captureSave: (c: Record<string,unknown>) => Promise<{ id: string }>;

    readDirectory: (path?: string) => Promise<DirectoryResult>;
    readFile: (path: string) => Promise<string>;
    pathExists: (path: string) => Promise<boolean>;
    writeFile: (path: string, content: string) => Promise<boolean>;

    // Electron-only: the main process sandboxes these to src/ and electron/,
    // and there is no browser equivalent, so the web mock leaves them absent.
    // selfRepairTools guards on isElectron() before calling them.
    readSourceFile?: (path: string) => Promise<string>;
    writeSourceFile?: (path: string, content: string) => Promise<boolean>;

    ollamaStatus: (baseUrl?: string) => Promise<{ running: boolean; version?: string; url: string; error?: string }>;
    getLocalGatewayStatus?: () => Promise<{ active: boolean; url: string | null; port?: number; upstream: string }>;

    // ── OpenCode ───────────────────────────────────────────
    opencodeStatus?: () => Promise<{ available: boolean; version?: string; path?: string; error?: string }>;
    opencodeModels?: () => Promise<{ ok: boolean; models: OpencodeModelInfo[]; error?: string }>;
    opencodeBridgeStatus?: () => Promise<{ running: boolean; port: number; baseUrl: string; modelCount: number; error?: string }>;
    opencodeTest?: (model: string) => Promise<{ ok: boolean; reply?: string; error?: string }>;
    ollamaModels: (baseUrl?: string) => Promise<{ models: Array<{ name: string; [k: string]: any }>; error?: string }>;
    ollamaPull: (model: string, baseUrl?: string) => Promise<{ success: boolean; error?: string }>;
    ollamaDelete: (model: string, baseUrl?: string) => Promise<{ success: boolean; error?: string }>;
    onOllamaPullProgress: (cb: (data: any) => void) => () => void;

    // Ollama Lifecycle — Electron-only (undefined in web/browser mode)
    ollamaIsInstalled?: () => Promise<{ installed: boolean; running: boolean; binPath?: string }>;
    ollamaLaunch?: (binPath?: string) => Promise<{ success: boolean; error?: string }>;
    ollamaInstall?: () => Promise<{ success: boolean; binPath?: string; running?: boolean; error?: string }>;
    onOllamaInstallProgress?: (cb: (data: { phase: string; downloaded: number; total: number; message: string }) => void) => () => void;

    execTerminal: (params: HenryTerminalRequest) => Promise<HenryTerminalResponse>;
    killTerminal: (execId: string) => Promise<{ killed: boolean; error?: string }>;

    // ── Computer Control ─────────────────────────────────────
    computerScreenshot: (params?: { region?: { x: number; y: number; w: number; h: number } }) => Promise<HenryScreenshotResult>;
    computerOpenApp: (appName: string) => Promise<HenryComputerShellResult>;
    computerOpenUrl: (url: string) => Promise<HenryComputerShellResult>;

    // Content Creators — scripted demo mode
    notificationGetPermission: () => Promise<'granted' | 'denied' | 'default' | 'provisional' | 'unknown' | 'unsupported'>;
    notificationRequestPermission: () => Promise<'granted' | 'denied' | 'default' | 'provisional' | 'unknown' | 'unsupported'>;
    notificationConsumeOpenRequest: () => Promise<{ kind: string; runId: number; title: string; at: number } | null>;
    notificationNotifyRun: (opts: { runId: number; title: string; success: boolean; detail?: string; mode?: 'all' | 'failures' | 'none' }) =>
      Promise<{ shown: boolean; reason?: string }>;
    onNotificationOpenRequest: (cb: (req: { kind: string; runId: number; title: string }) => void) => () => void;

    runtimeGetError: () => Promise<{ message: string | null; bootFailed: boolean; databaseOk: boolean }>;
    googleStartAuth: (opts: { clientId: string; clientSecret: string; scopes: string[] }) =>
      Promise<{ ok: boolean; error?: string }>;
    googleGetToken: (creds?: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; accessToken?: string }>;
    googleRefreshToken: (creds?: { clientId: string; clientSecret: string }) => Promise<{ ok: boolean; accessToken?: string }>;
    googleHasCredentials: () => Promise<{ hasCredentials: boolean } | boolean>;
    googleDisconnect: () => Promise<{ ok: boolean }>;
    onRuntimeStatusChanged: (cb: (s: RuntimeStatus) => void) => () => void;

    onSettingsChanged: (cb: (e: { key: string; value: string }) => void) => () => void;
    // Exposed by preload since the tunnel feature landed, but never declared —
    // which is part of why the DeviceLinkPanel fell back to POSTing routes
    // that do not exist.
    syncStartTunnel: () => Promise<{ ok: boolean; url?: string | null; error?: string } | null>;
    syncStopTunnel: () => Promise<{ ok: boolean } | null>;
    syncGetTunnelUrl: () => Promise<{ ok: boolean; url?: string | null } | null>;

    creatorsGetDemo: () => Promise<CreatorDemo>;
    creatorsSaveDemo: (demo: CreatorDemo) => Promise<{ ok: boolean; demo: CreatorDemo }>;
    creatorsGetOrb: () => Promise<OrbSettings>;
    creatorsSaveOrb: (orb: OrbSettings) => Promise<{ ok: boolean; orb: OrbSettings }>;
    creatorsListMedia: () => Promise<{ media: CreatorMedia[] }>;
    creatorsImportMedia: (input: { paths: string[]; kind: CreatorMediaKind }) => Promise<{ media: CreatorMedia[] }>;
    creatorsDeleteMedia: (fileName: string) => Promise<{ ok: boolean }>;
    creatorsOpenMedia: (fileName: string) => Promise<{ ok: boolean; error?: string }>;
    creatorsLaunchStage: (mode: 'voice' | 'chat') => Promise<{ ok: boolean; error?: string }>;
    creatorsCloseStage: () => Promise<{ ok: boolean }>;
    computerOsascript: (script: string) => Promise<HenryComputerShellResult>;
    computerRunShell: (params: { command: string; timeout?: number }) => Promise<HenryComputerShellResult>;
    computerNewFolder: (params: { path: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
    computerListApps: () => Promise<{ apps: string[]; platform: string }>;
    computerCheckCapabilities: () => Promise<HenryComputerCapabilities>;
    computerListProcesses: () => Promise<{ processes: string[] }>;
    computerCheckPermissions: () => Promise<HenryPermissionsResult>;
    computerTypeText: (text: string) => Promise<HenryComputerShellResult>;
    computerClick: (params: { x: number; y: number; button?: string }) => Promise<HenryComputerShellResult>;
    computerSystemInfo: () => Promise<HenrySystemInfo>;

    // ── 3D Printer ───────────────────────────────────────────
    printerCheckDeps: () => Promise<{ available: boolean; version?: string; installCommand?: string; error?: string }>;
    printerListPorts: () => Promise<{ ports: HenryPrinterPort[]; method?: string; error?: string }>;
    printerConnect: (params: { port: string; baudRate?: number }) => Promise<{ success: boolean; port?: string; baudRate?: number; error?: string }>;
    printerDisconnect: () => Promise<{ success: boolean; error?: string }>;
    printerSendGcode: (command: string) => Promise<{ success: boolean; sent?: string; error?: string }>;
    printerStatus: () => Promise<{ connected: boolean; port?: string; baudRate?: number }>;
    printerPrintGcode: (gcode: string) => Promise<{ success: boolean; sent?: number; total?: number; error?: string }>;
    onPrinterData: (cb: (data: HenryPrinterData) => void) => () => void;

    // ── Session History (persistent conversation store + FTS search) ──
    // Each call resolves to { ok: true, result } or { ok: false, error }.
    sessionCheckDeps: () => Promise<{ available: boolean; ftsEnabled?: boolean; journalMode?: string; error?: string; installHint?: string }>;
    sessionCreate: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionEnd: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionResume: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionBranch: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionList: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionSearch: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionAddMessage: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionGetMessages: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    // Agent audit log (Sprint 4): every tool-call message, newest first.
    listToolCalls?: (limit?: number) => Promise<HenrySessionResult>;
    clearToolCalls?: () => Promise<HenrySessionResult>;
    sessionGet: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionSetTitle: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionArchive: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionUpdateTokens: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionDelete: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionExport: (params: Record<string, unknown>) => Promise<HenrySessionResult>;
    sessionStats: () => Promise<HenrySessionResult>;

    getCostLog: (period?: string) => Promise<unknown[]>;

    onTaskUpdate: (cb: (data: Partial<Task> & { id: string }) => void) => () => void;
    onTaskResult: (cb: (data: HenryTaskResultPayload) => void) => () => void;
    onEngineStatus: (cb: (data: HenryEngineStatusPayload) => void) => () => void;
    onWorkerMessage: (cb: (data: Message) => void) => () => void;

    checkForUpdates: () => Promise<unknown>;
    installUpdate: () => Promise<void>;
    onUpdateAvailable: (cb: () => void) => () => void;
    onUpdateDownloaded: (cb: () => void) => () => void;

    whisperTranscribe?: (audioBlob: Blob, apiKey: string) => Promise<string>;

    // ── Coder Engine (Electron-only — Claude Code CLI default, local fallback) ──
    coderStatus?: (opts?: { refresh?: boolean }) => Promise<HenryCoderStatus>;
    coderRun?: (params: { prompt: string; cwd?: string; sessionId?: string }) => HenryCoderRunHandle;
    coderCancel?: (channelId: string) => Promise<{ cancelled: boolean }>;

    // ── Agent (tool layer) ────────────────────────────────────
    listTools?: () => Promise<Array<{ name: string; description: string; safetyLevel: string; category: string }>>;
    confirmTool?: (id: string, approved: boolean, editedArgs?: Record<string, unknown>) => Promise<{ ok: boolean }>;
    onAgentConfirmRequired?: (cb: (req: HenryConfirmRequest) => void) => () => void;
    onAgentToolNotify?: (cb: (data: { tool: string; message: string; ok: boolean }) => void) => () => void;

    // ── 3D printer network discovery + monitor ────────────────
    discoverPrinters?: () => Promise<{ ok: boolean; result?: HenryDiscoveredPrinter[]; error?: string }>;
    printerNetStatus?: (conn: HenryPrinterConn) => Promise<{ ok: boolean; result?: HenryPrinterStatus; error?: string }>;
    printerNetCommand?: (conn: HenryPrinterConn, action: string, gcode?: string) => Promise<{ ok: boolean; error?: string }>;
    printerNetUpload?: (conn: HenryPrinterConn, gcodePath: string, print?: boolean) => Promise<{ ok: boolean; result?: { started: boolean }; error?: string }>;

    // ── Machine connections (unified printer/CNC layer) ───────
    machinesList?: () => Promise<HenryMachinesResult<HenryMachineConnection[]>>;
    machinesAdd?: (m: { name: string; kind: HenryMachineKind; protocol: HenryMachineProtocol; config: HenryMachineConfig }) => Promise<HenryMachinesResult<HenryMachineConnection>>;
    machinesUpdate?: (id: string, patch: { name?: string; kind?: HenryMachineKind; protocol?: HenryMachineProtocol; config?: HenryMachineConfig }) => Promise<HenryMachinesResult<HenryMachineConnection>>;
    machinesRemove?: (id: string) => Promise<HenryMachinesResult<{ removed: boolean }>>;
    machinesConnect?: (id: string) => Promise<HenryMachinesResult<{ status: HenryMachineStatus; capabilities: HenryMachineCapabilities | null }>>;
    machinesDisconnect?: (id: string) => Promise<HenryMachinesResult<{ disconnected: boolean }>>;
    machinesStatus?: (id: string) => Promise<HenryMachinesResult<HenryMachineStatus>>;
    machinesStatusAll?: () => Promise<HenryMachinesResult<Array<{ id: string; name: string; kind: HenryMachineKind; protocol: HenryMachineProtocol; connected: boolean; status: HenryMachineStatus }>>>;
    machinesJob?: (id: string, action: 'send' | 'pause' | 'resume' | 'stop' | 'home', filePath?: string) => Promise<HenryMachinesResult<{ ok: boolean; message?: string }>>;
    machinesDiscover?: () => Promise<HenryMachinesResult<HenryDiscoveredMachine[]>>;
    onMachinesEvent?: (cb: (event: HenryMachineEvent) => void) => () => void;

    // ── Slicer ────────────────────────────────────────────────
    slicerStatus?: () => Promise<{ ok: boolean; result?: { available: boolean; missing: string[]; version?: string; enginePath?: string; definitionsDir?: string; printerDef?: string }; error?: string }>;
    slicerSlice?: (params: { modelPath: string; settings?: Record<string, string | number>; outPath?: string; printerDef?: string }) => Promise<{ ok: boolean; result?: { gcodePath: string; estimate: { timeSeconds?: number; filamentMm?: number; filamentGrams?: number }; bytes: number }; error?: string }>;
    slicerReadGcode?: (gcodePath: string) => Promise<{ ok: boolean; result?: { text: string }; error?: string }>;
    slicerProfilesList?: () => Promise<{ ok: boolean; result?: HenrySlicerProfile[]; error?: string }>;
    slicerProfileCreate?: (p: Partial<HenrySlicerProfile> & { settings?: Record<string, string> }) => Promise<{ ok: boolean; result?: HenrySlicerProfile; error?: string }>;
    slicerProfileUpdate?: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; result?: HenrySlicerProfile; error?: string }>;
    slicerProfileDelete?: (id: string) => Promise<{ ok: boolean; result?: { deleted: boolean }; error?: string }>;

    // ── Book Engine (life material) ───────────────────────────
    listBookEntries?: (filter?: { kind?: string; limit?: number }) => Promise<{ ok: boolean; result?: HenryBookEntry[]; error?: string }>;
    createBookEntry?: (entry: Partial<HenryBookEntry>) => Promise<{ ok: boolean; result?: HenryBookEntry; error?: string }>;
    updateBookEntry?: (id: string, patch: Partial<HenryBookEntry>) => Promise<{ ok: boolean; result?: HenryBookEntry; error?: string }>;
    deleteBookEntry?: (id: string) => Promise<{ ok: boolean; result?: { deleted: boolean }; error?: string }>;

    // ── Quoting (estimates → quotes → production runs) ─────────
    quoteList?: (opts?: { status?: string; query?: string; limit?: number }) => Promise<HenryQuote[]>;
    quoteGet?: (id: string) => Promise<HenryQuote | null>;
    quoteSave?: (quote: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
    quoteDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    quoteSetStatus?: (id: string, status: string) => Promise<{ ok: boolean; error?: string }>;
    quoteDuplicate?: (id: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
    quoteLineItemSave?: (item: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
    quoteLineItemDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
    quoteLineItemsReorder?: (quoteId: string, ids: string[]) => Promise<{ ok: boolean; error?: string }>;
    quoteSummary?: (opts?: { sinceDays?: number }) => Promise<HenryQuoteSummary | null>;
    quoteConvertToRun?: (quoteId: string, machineId?: string) => Promise<{ ok: boolean; runId?: string; error?: string }>;
    quoteExportMarkdown?: (quoteId: string) => Promise<string | null>;

    // ── Lessons / Curriculum (Henry as teacher) ───────────────
    lessonsCoursesList?: () => Promise<HenryLessonsResult<HenryLessonCourse[]>>;
    lessonsCourseCreate?: (payload: {
      title: string;
      topic: string;
      kind: 'bible' | 'general';
      outline_json: string;
      lessons: Array<{ title: string }>;
    }) => Promise<HenryLessonsResult<{ course: HenryLessonCourse; lessons: HenryLesson[] }>>;
    lessonsCourseGet?: (id: string) => Promise<HenryLessonsResult<{ course: HenryLessonCourse; lessons: HenryLesson[] } | null>>;
    lessonsCourseDelete?: (id: string) => Promise<HenryLessonsResult<{ deleted: boolean }>>;
    lessonsLessonGet?: (id: string) => Promise<HenryLessonsResult<HenryLesson | null>>;
    lessonsLessonUpdateStatus?: (payload: { id: string; status: HenryLesson['status']; score?: number }) =>
      Promise<HenryLessonsResult<{ lesson: HenryLesson; unlocked: HenryLesson | null }>>;
    lessonsLessonSaveContent?: (payload: { id: string; content_md: string }) => Promise<HenryLessonsResult<HenryLesson>>;
    lessonsReviewSave?: (payload: { lesson_id: string; quiz_json: string; answers_json: string; score: number }) =>
      Promise<HenryLessonsResult<{ review: HenryLessonReview; lesson: HenryLesson; passed: boolean; unlocked: HenryLesson | null }>>;
    lessonsReviewsForCourse?: (courseId: string) => Promise<HenryLessonsResult<HenryLessonReview[]>>;

    // ── Approval Queue ────────────────────────────────────────
    approvalsList?: (filter?: { status?: string; limit?: number }) => Promise<{ ok: boolean; result?: HenryApproval[]; error?: string }>;
    approvalsGet?: (id: string) => Promise<{ ok: boolean; result?: HenryApproval | null; error?: string }>;
    approvalsStats?: () => Promise<{ ok: boolean; result?: Record<string, number>; error?: string }>;

    // ── Scheduler (Henry's Routines) ──────────────────────────
    listRoutines?: () => Promise<{ ok: boolean; result?: HenryRoutine[]; error?: string }>;
    addRoutine?: (task: HenryRoutineInput) => Promise<{ ok: boolean; result?: HenryRoutine; error?: string }>;
    toggleRoutine?: (id: string, enabled: boolean) => Promise<{ ok: boolean; result?: HenryRoutine | null; error?: string }>;
    runRoutineNow?: (id: string) => Promise<{ ok: boolean; result?: { ok: boolean; content?: string; error?: string }; error?: string }>;

    // ── Automation run history ──────────────────────────────────────
    automationRuns?: (opts?: { taskId?: string; limit?: number; unreadOnly?: boolean }) => Promise<AutomationRun[]>;
    automationUnreadCount?: () => Promise<{ count: number }>;
    automationMarkRunRead?: (id: string) => Promise<{ ok: boolean }>;
    automationMarkAllRunsRead?: () => Promise<{ ok: boolean; count: number }>;
    automationClearRuns?: (taskId?: string) => Promise<{ ok: boolean }>;
    automationAbort?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
    automationIsRunning?: (taskId: string) => Promise<{ running: boolean }>;
    onAutomationRunChanged?: (cb: (data: unknown) => void) => () => void;
    deleteRoutine?: (id: string) => Promise<{ ok: boolean; result?: boolean; error?: string }>;
    onSchedulerTaskStarted?: (cb: (data: { id: string; name: string }) => void) => () => void;
    onSchedulerTaskCompleted?: (cb: (data: { id: string; name: string; ok: boolean; sessionId?: string; content?: string; error?: string }) => void) => () => void;

    // ── Voice (Electron-only — local whisper STT + say/ElevenLabs TTS) ────
    voiceSttStatus?: (opts?: { refresh?: boolean }) => Promise<HenryVoiceResult<HenryVoiceSttStatus>>;
    voiceSttSetup?: () => Promise<HenryVoiceResult<HenryVoiceSttStatus>>;
    onVoiceSttSetupProgress?: (cb: (p: HenryVoiceSetupProgress) => void) => () => void;
    voiceTranscribe?: (audio: ArrayBuffer) => Promise<HenryVoiceResult<{ text: string; ms: number }>>;
    voiceMicAccess?: () => Promise<{ status: string; granted: boolean }>;
    voiceSpeak?: (params: { text: string; engine?: 'auto' | 'local' | 'elevenlabs' }) => Promise<HenryVoiceResult<HenryVoiceSpeakResult>>;
    voiceStopSpeaking?: () => Promise<HenryVoiceResult<{ stopped: boolean }>>;
    voiceTtsStatus?: () => Promise<HenryVoiceResult<HenryVoiceTtsStatus>>;
  voiceGreeting?: (opts?: { speak?: boolean }) => Promise<HenryVoiceResult<{
    text: string;
    period: 'morning' | 'afternoon' | 'evening' | 'lateNight';
    speak: boolean;
    mimeType: string;
    audio: Uint8Array;
  }>>;
  voiceGreetingClearCache?: () => Promise<{ ok: boolean; error?: string }>;

    // ── Companion Sync Bridge ─────────────────────────────────────────────
    syncStart?: (port?: number) => Promise<import('./sync/types').SyncServerState>;
    syncStop?: () => Promise<{ ok: boolean }>;
    syncGetState?: () => Promise<import('./sync/types').SyncServerState>;
    syncGeneratePairToken?: (ttlMs?: number) => Promise<string>;
    syncRevokePairToken?: () => Promise<{ ok: boolean }>;
    syncUnlinkDevice?: (deviceId: string) => Promise<{ ok: boolean }>;
    syncPushEvent?: (event: unknown) => Promise<{ ok: boolean }>;
    syncAddPendingAction?: (action: unknown) => Promise<{ ok: boolean }>;
    syncUpdateNotes?: (notes: unknown[]) => Promise<{ ok: boolean }>;
    syncUpdateSettings?: (settings: Record<string, unknown>) => Promise<{ ok: boolean }>;
    onQuickExtractResult?: (cb: (result: unknown) => void) => () => void;
    requestAccessibility?: () => Promise<{ granted: boolean }>;
    checkAccessibility?: () => Promise<{ granted: boolean }>;
    openPermissions?: () => Promise<{ ok: boolean }>;
    openScreenRecording?: () => Promise<{ ok: boolean }>;
    onPermissionsStatus?: (cb: (status: { accessibility: boolean; screenRecording: boolean }) => void) => () => void;
    onCompanionCapture?: (cb: (capture: unknown) => void) => () => void;
    onCompanionPrompt?: (cb: (data: unknown) => void) => () => void;
    onCompanionActionDecision?: (cb: (decision: unknown) => void) => () => void;
    isFirstLaunch?: () => Promise<{isFirst: boolean}>;
    onCompanionDeviceLinked?: (cb: (device: unknown) => void) => () => void;
    onSyncRequestStatus?: (cb: (replyChannel: string) => void) => () => void;
    replySyncStatus?: (channel: string, status: unknown) => void;
  }

  interface Window {
    henryAPI: HenryAPI;
  }
}

export {};

export type CreatorMediaKind = 'audio' | 'image' | 'file';
export type CreatorCaptionMode = 'typewriter' | 'none';
export type CreatorDemoMode = 'chat' | 'voice';
export type CreatorTurnRole = 'user' | 'assistant';
export type OrbSkin = 'default' | 'minimalistic';
export type OrbSpeed = 'slow' | 'default' | 'fast' | 'off';

export interface CreatorMedia {
  id: string;
  fileName: string;
  originalName: string;
  kind: CreatorMediaKind;
  addedAt: number;
}

export interface CreatorTurn {
  id: string;
  role: CreatorTurnRole;
  text: string;
  audio: CreatorMedia | null;
  files: CreatorMedia[];
}

export interface CreatorDemo {
  enabled: boolean;
  mode: CreatorDemoMode;
  triggerPhrases: string[];
  turns: CreatorTurn[];
  captionMode: CreatorCaptionMode;
  fileStaggerMs: number;
  playIntro: boolean;
}

export interface OrbSettings {
  skin: OrbSkin;
  speed: OrbSpeed;
  accent: string;
  assistantName: string;
}

export interface RuntimeStatus {
  ok: boolean;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  startedAt: string;
  uptimeSeconds: number;
  bootFailed: boolean;
  lastError: string | null;
  databaseOk: boolean;
  databaseError: string | null;
}
