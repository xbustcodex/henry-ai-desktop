// ── AI Provider Types ─────────────────────────────────────────

export interface AIProvider {
  id: string;
  name: string;
  apiKey: string;
  enabled: boolean;
  models: string[];
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  contextWindow: number;
  capabilities?: string[];
  recommended?: 'companion' | 'worker' | 'both';
  local?: boolean;
}

// ── Conversation Types ────────────────────────────────────────

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

/** One execution of a scheduled Routine. */
export interface AutomationRun {
  id: string;
  task_id: string;
  task_name: string;
  prompt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  trigger: 'schedule' | 'manual';
  result: string | null;
  error: string | null;
  session_id: string | null;
  read_at: string | null;
  started_at: string;
  finished_at: string | null;
}

/** A boot failure that prevented Henry from starting cleanly. */
export interface StartupFailure {
  message: string;
  at: string;
}

/** Live snapshot of the running desktop process. */
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

/** A model opencode can reach, as reported by `opencode models`. */
export interface OpencodeModelInfo {
  /** `provider/model`, exactly what is passed to --model. */
  id: string;
  provider: string;
  name: string;
  /** True for opencode's own hosted ("zen") service. */
  isZen: boolean;
  isFree: boolean;
}

export type CatalogEntryType = 'app' | 'tool' | 'plugin' | 'extension';
export type CatalogEntryState = 'installed' | 'available' | 'unavailable';

export interface CatalogEntry {
  id: string;
  name: string;
  type: CatalogEntryType | string;
  category: string;
  description: string;
  version?: string;
  author?: string;
  packageName?: string;
  repository?: string;
  homepage?: string;
  apkUrl?: string;
  capabilities?: string[];
  integrations?: string[];
  requirements?: Record<string, unknown>;
  install: { type: string; scriptUrl?: string };
}

export interface CatalogListing {
  manifest: string;
  version: number;
  entries: CatalogEntry[];
  problems: string[];
  fetchedAt: string;
}

export type MediaKind = 'image' | 'audio' | 'document';

/** An item in the local media library. */
export interface MediaItem {
  id: string;
  kind: MediaKind;
  file_name: string;
  stored_name: string;
  mime_type: string | null;
  byte_size: number;
  created_at: string;
}

export type MemoryNodeType =
  | 'fact' | 'project' | 'goal' | 'commitment' | 'milestone' | 'narrative' | 'personal';

export interface MemoryGraphNode {
  id: string;
  type: MemoryNodeType;
  label: string;
  detail: string;
  weight: number;
  updatedAt: string | null;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
}

/** A file attached to a chat message. Bytes live on disk; this is the index row. */
export interface MessageAttachment {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  file_name: string;
  mime_type: string | null;
  byte_size: number;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  provider?: string;
  engine?: 'companion' | 'worker';
  tokens_used?: number;
  cost?: number;
  /** Why the model router picked this model (e.g. "Quick question → fast model"). */
  routeReason?: string;
  created_at: string;
  isStreaming?: boolean;
}

// ── Task Types ────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskType = 'ai_generate' | 'file_operation' | 'code_generate' | 'research' | 'custom';

export interface Task {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  payload?: string;
  result?: string;
  error?: string;
  source_engine?: string;
  conversation_id?: string;
  cost?: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  /** Operating mode when task was created from chat (follow-up bridge). */
  created_from_mode?: string;
  /** Workspace-relative path linked at creation (draft / Design3D ref). */
  related_file_path?: string;
  /** Source assistant message id when created from “Create task”. */
  created_from_message_id?: string;
}

export interface TaskSubmission {
  description: string;
  type: TaskType;
  priority?: number;
  payload?: unknown;
  sourceEngine?: string;
  conversationId?: string;
  createdFromMode?: string;
  relatedFilePath?: string;
  createdFromMessageId?: string;
}

// ── Engine Types ──────────────────────────────────────────────

export interface EngineStatus {
  status: 'idle' | 'thinking' | 'planning' | 'acting' | 'working' | 'streaming' | 'error' | 'done';
  taskId?: string;
  taskDescription?: string;
  message?: string;
}

export interface EngineConfig {
  provider: string;
  model: string;
  apiKey: string;
  temperature?: number;
}

// ── Memory Types ──────────────────────────────────────────────

export interface MemoryFact {
  id: string;
  conversation_id?: string;
  fact: string;
  category: string;
  importance: number;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  conversation_id: string;
  summary: string;
  message_count: number;
  token_count: number;
  created_at: string;
}

export interface WorkspaceFile {
  id: string;
  file_path: string;
  file_type: string;
  summary: string;
  last_indexed: string;
  size_bytes: number;
}

/** Raw slices from SQLite for the lean memory builder (see `henry/memoryContext.ts`). */
export interface HenryLeanMemoryParts {
  conversationSummary: string | null;
  facts: ReadonlyArray<{ fact: string; category: string; importance?: number; created_at?: string }>;
  workspaceHints: ReadonlyArray<{ file_path: string; summary: string }>;
}

export interface MemoryContext {
  lean: HenryLeanMemoryParts;
  estimatedTokens: number;
  factCount: number;
  /** Extended deep-context layers (Layer 3–7) — present when bandwidth ≥ normal */
  extended?: Record<string, unknown>;
}

// ── File System Types ─────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

export interface DirectoryResult {
  path: string;
  entries: FileEntry[];
}

// ── Store Types ───────────────────────────────────────────────

// R2-Fix 9: added 'memos' (SQLite voice memos via RecorderPanel) and 'queue'
// (TaskQueueView) — Layout.tsx renders these but TS didn't know they were
// valid ViewType values, forcing `as any` casts at nav call sites.
export type ViewType = 'today' | 'chat' | 'companion' | 'tasks' | 'files' | 'workspace' | 'terminal' | 'computer' | 'printer' | 'costs' | 'settings' | 'journal' | 'recorder' | 'memos' | 'queue' | 'modes' | 'reminders' | 'finance' | 'printstudio' | 'machines' | 'materials' | 'production' | 'waste' | 'maintenance' | 'imagegen' | 'videogen' | 'captures' | 'weekly' | 'health' | 'goals' | 'hq' | 'setup' | 'memory' | 'quoting' | 'routines' | 'audit' | 'book' | 'slicer' | 'approvals' | 'media' | 'marketplace' | 'about' | 'creators';

export interface AppSettings {
  [key: string]: string;
}

export interface AppState {
  // UI
  currentView: ViewType;
  setupComplete: boolean;

  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];

  // AI
  providers: AIProvider[];
  settings: AppSettings;
  isStreaming: boolean;
  streamingContent: string;

  // Engines
  companionStatus: EngineStatus;
  workerStatus: EngineStatus;

  // Tasks
  tasks: Task[];

  // Memory
  facts: MemoryFact[];

  // Navigation history
  viewHistory: ViewType[];

  // Actions
  setCurrentView: (view: ViewType) => void;
  goBack: () => void;
  setSetupComplete: (complete: boolean) => void;
  setConversations: (convos: Conversation[]) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setProviders: (providers: AIProvider[]) => void;
  updateSetting: (key: string, value: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (chunk: string) => void;
  setCompanionStatus: (status: Partial<EngineStatus>) => void;
  setWorkerStatus: (status: Partial<EngineStatus>) => void;
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  setFacts: (facts: MemoryFact[]) => void;
  addFact: (fact: MemoryFact) => void;
}
