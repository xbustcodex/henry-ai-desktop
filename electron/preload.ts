import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { RuntimeStatus } from './ipc/runtimeDiagnostics';
import type { AIProvider, Message, Task, TaskSubmission } from '../src/types';

type ProviderSavePayload = Omit<AIProvider, 'models'> & { models: string };

type TaskListFilter = { status?: string; limit?: number };

type AIInvokeParams = {
  provider: string;
  model: string;
  apiKey: string;
  /** Content may carry images, so an attached picture reaches the model. */
  messages: Array<{
    role: string;
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; mimeType: string; data: string; name?: string }
        >;
  }>;
  temperature?: number;
  maxTokens?: number;
  apiUrl?: string;
  // Agent mode (off unless the caller opts in). A non-empty `tools` array tells
  // the main process to route this turn through the agent ToolRunner; the real
  // tool schemas come from the main-process registry, so the array is just a
  // flag. `sessionId` ties the run's tool-call audit trail to a session.
  tools?: unknown[];
  sessionId?: string;
};

type TaskUpdatePayload = Partial<Task> & { id: string };

type TaskResultEventPayload = {
  taskId: string;
  conversationId?: string;
  error?: string;
  result?: unknown;
};

type EngineStatusEventPayload = {
  engine: 'companion' | 'worker';
  status: string;
  taskId?: string;
  taskDescription?: string;
  message?: string;
};

contextBridge.exposeInMainWorld('henryAPI', {
  // Signal flag — tells webMock that real Electron IPC is available
  // Must be a function — contextBridge strips non-function properties in sandbox mode
  __isElectron: () => true,
  // ── Platform ────────────────────────────────────────────
  platform: () => process.platform,
  // ── Settings ──────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  saveSetting: (key: string, value: string) => ipcRenderer.invoke('settings:save', { key, value }),

  // ── Providers ─────────────────────────────────────────────
  getProviders: () => ipcRenderer.invoke('providers:getAll'),
  saveProvider: (provider: ProviderSavePayload) => ipcRenderer.invoke('providers:save', provider),
  resyncProvidersToLocalStorage: () => ipcRenderer.invoke('providers:resync-localStorage'),

  // ── Conversations ─────────────────────────────────────────
  getConversations: () => ipcRenderer.invoke('conversations:getAll'),
  createConversation: (title: string) => ipcRenderer.invoke('conversations:create', title),
  updateConversation: (id: string, title: string) => ipcRenderer.invoke('conversations:update', { id, title }),
  deleteConversation: (id: string) => ipcRenderer.invoke('conversations:delete', id),

  // ── Messages ──────────────────────────────────────────────
  getMessages: (conversationId: string) => ipcRenderer.invoke('messages:getAll', conversationId),
  saveMessage: (message: Message) => ipcRenderer.invoke('messages:save', message),

  // ── Chat attachments ───────────────────────────────────────
  saveAttachment: (input: {
    fileName: string;
    mimeType?: string;
    data: string | Uint8Array;
    conversationId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke('attachments:save', input),
  linkAttachmentsToMessage: (ids: string[], messageId: string, conversationId?: string) =>
    ipcRenderer.invoke('attachments:linkToMessage', ids, messageId, conversationId),
  listAttachments: (conversationId: string) => ipcRenderer.invoke('attachments:list', conversationId),
  listAttachmentsForMessage: (messageId: string) => ipcRenderer.invoke('attachments:listForMessage', messageId),
  getAttachment: (id: string) => ipcRenderer.invoke('attachments:get', id),
  deleteAttachment: (id: string) => ipcRenderer.invoke('attachments:delete', id),
  openAttachment: (id: string) => ipcRenderer.invoke('attachments:open', id),

  // ── Media library ──────────────────────────────────────────
  mediaImport: (opts?: { kind?: 'image' | 'audio' | 'document' }) =>
    ipcRenderer.invoke('media:import', opts ?? {}),
  mediaList: (opts?: { kind?: 'image' | 'audio' | 'document'; limit?: number }) =>
    ipcRenderer.invoke('media:list', opts ?? {}),
  mediaCounts: () => ipcRenderer.invoke('media:counts'),
  mediaGet: (id: string) => ipcRenderer.invoke('media:get', id),
  mediaOpen: (id: string) => ipcRenderer.invoke('media:open', id),
  mediaReveal: (id: string) => ipcRenderer.invoke('media:reveal', id),
  mediaDelete: (id: string) => ipcRenderer.invoke('media:delete', id),

  // ── PrimeTech marketplace ───────────────────────────────────
  marketplaceList: () => ipcRenderer.invoke('marketplace:list'),
  marketplaceStates: () => ipcRenderer.invoke('marketplace:states'),
  marketplaceFetch: (entryId: string) => ipcRenderer.invoke('marketplace:fetch', entryId),
  marketplaceOpenEntry: (entryId: string) => ipcRenderer.invoke('marketplace:openEntry', entryId),
  marketplaceReveal: (filePath: string) => ipcRenderer.invoke('marketplace:reveal', filePath),
  marketplaceHistory: () => ipcRenderer.invoke('marketplace:history'),
  marketplaceRemove: (entryId: string) => ipcRenderer.invoke('marketplace:remove', entryId),

  // ── Runtime / startup diagnostics ─────────────────────────
  runtimeGetStatus: () => ipcRenderer.invoke('runtime:get-status'),
  startupGetFailure: () => ipcRenderer.invoke('startup:get-failure'),
  startupClearFailure: () => ipcRenderer.invoke('startup:clear-failure'),
  runtimeRestart: () => ipcRenderer.invoke('runtime:restart'),

  // ── AI ────────────────────────────────────────────────────
  sendMessage: (params: AIInvokeParams) => ipcRenderer.invoke('ai:send', params),
  streamMessage: (params: AIInvokeParams) => {
    const channelId = `ai-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let onChunkCb: ((chunk: string) => void) | null = null;
    let onDoneCb: ((fullText: string, usage?: Record<string, unknown>) => void) | null = null;
    let onErrorCb: ((error: string) => void) | null = null;

    const chunkHandler = (_: IpcRendererEvent, data: { channelId: string; chunk: string }) => {
      if (data.channelId === channelId && onChunkCb) onChunkCb(data.chunk);
    };
    const doneHandler = (_: IpcRendererEvent, data: { channelId: string; fullText: string; usage?: Record<string, unknown> }) => {
      if (data.channelId === channelId) {
        onDoneCb?.(data.fullText, data.usage);
        cleanup();
      }
    };
    const errorHandler = (_: IpcRendererEvent, data: { channelId: string; error: string }) => {
      if (data.channelId === channelId) {
        onErrorCb?.(data.error);
        cleanup();
      }
    };

    // Register listeners before starting IPC so ultra-fast streams (local) never miss events.
    ipcRenderer.on('ai:stream:chunk', chunkHandler);
    ipcRenderer.on('ai:stream:done', doneHandler);
    ipcRenderer.on('ai:stream:error', errorHandler);

    void ipcRenderer.invoke('ai:stream', { ...params, channelId });

    function cleanup() {
      ipcRenderer.removeListener('ai:stream:chunk', chunkHandler);
      ipcRenderer.removeListener('ai:stream:done', doneHandler);
      ipcRenderer.removeListener('ai:stream:error', errorHandler);
    }

    return {
      onChunk: (cb: (chunk: string) => void) => {
        onChunkCb = cb;
      },
      onDone: (cb: (fullText: string, usage?: Record<string, unknown>) => void) => {
        onDoneCb = cb;
      },
      onError: (cb: (error: string) => void) => {
        onErrorCb = cb;
      },
      cancel: () => {
        ipcRenderer.invoke('ai:cancel', channelId);
        cleanup();
      },
    };
  },

  // ── Coder Engine (Claude Code CLI default, local Ollama fallback) ──
  coderStatus: (opts?: { refresh?: boolean }) => ipcRenderer.invoke('coder:status', opts),
  coderCancel: (channelId: string) => ipcRenderer.invoke('coder:cancel', channelId),
  coderRun: (params: { prompt: string; cwd?: string; sessionId?: string }) => {
    const channelId = `coder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let onEventCb: ((event: Record<string, unknown>) => void) | null = null;

    const handler = (_: IpcRendererEvent, data: { channelId: string; event: Record<string, unknown> }) => {
      if (data.channelId !== channelId) return;
      onEventCb?.(data.event);
      const kind = data.event?.kind;
      if (kind === 'result' || kind === 'error') cleanup();
    };

    // Register the listener before starting IPC so fast runs never miss events.
    ipcRenderer.on('coder:event', handler);
    void ipcRenderer.invoke('coder:run', { ...params, channelId });

    function cleanup() {
      ipcRenderer.removeListener('coder:event', handler);
    }

    return {
      channelId,
      onEvent: (cb: (event: Record<string, unknown>) => void) => {
        onEventCb = cb;
      },
      cancel: () => {
        void ipcRenderer.invoke('coder:cancel', channelId);
        cleanup();
      },
    };
  },

  // ── Agent (tool layer) ────────────────────────────────────
  // Catalogue of registered tools (name, description, safety tier, category).
  listTools: () => ipcRenderer.invoke('agent:list-tools'),
  // Respond to a confirm-tier tool the runner is waiting on. `editedArgs`
  // optionally overrides the params (e.g. an edited message body) before run.
  confirmTool: (id: string, approved: boolean, editedArgs?: Record<string, unknown>) =>
    ipcRenderer.invoke('agent:confirm-response', { id, approved, editedArgs }),
  // Main → renderer events: a confirm-tier tool is awaiting approval.
  onAgentConfirmRequired: (cb: (req: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('agent:confirm-required', handler);
    return () => ipcRenderer.removeListener('agent:confirm-required', handler);
  },
  // Main → renderer events: a notify-tier tool just ran (toast).
  onAgentToolNotify: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('agent:tool-notify', handler);
    return () => ipcRenderer.removeListener('agent:tool-notify', handler);
  },

  // ── 3D printer network discovery + monitor ────────────────
  discoverPrinters: () => ipcRenderer.invoke('printers:discover'),
  printerNetStatus: (conn: Record<string, unknown>) => ipcRenderer.invoke('printerNet:status', conn),
  printerNetCommand: (conn: Record<string, unknown>, action: string, gcode?: string) =>
    ipcRenderer.invoke('printerNet:command', { conn, action, gcode }),
  printerNetUpload: (conn: Record<string, unknown>, gcodePath: string, print?: boolean) =>
    ipcRenderer.invoke('printerNet:upload', { conn, gcodePath, print }),

  // ── Machine connections (unified printer/CNC layer) ───────
  machinesList: () => ipcRenderer.invoke('machines:list'),
  machinesAdd: (m: Record<string, unknown>) => ipcRenderer.invoke('machines:add', m),
  machinesUpdate: (id: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('machines:update', { id, patch }),
  machinesRemove: (id: string) => ipcRenderer.invoke('machines:remove', { id }),
  machinesConnect: (id: string) => ipcRenderer.invoke('machines:connect', { id }),
  machinesDisconnect: (id: string) => ipcRenderer.invoke('machines:disconnect', { id }),
  machinesStatus: (id: string) => ipcRenderer.invoke('machines:status', { id }),
  machinesStatusAll: () => ipcRenderer.invoke('machines:statusAll'),
  machinesJob: (id: string, action: string, filePath?: string) =>
    ipcRenderer.invoke('machines:job', { id, action, filePath }),
  machinesDiscover: () => ipcRenderer.invoke('machines:discover'),
  onMachinesEvent: (cb: (event: unknown) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('machines:event', handler);
    return () => ipcRenderer.removeListener('machines:event', handler);
  },

  // ── Slicer ────────────────────────────────────────────────
  slicerStatus: () => ipcRenderer.invoke('slicer:status'),
  slicerSlice: (params: { modelPath: string; settings?: Record<string, string | number>; outPath?: string; printerDef?: string }) =>
    ipcRenderer.invoke('slicer:slice', params),
  slicerReadGcode: (gcodePath: string) => ipcRenderer.invoke('slicer:readGcode', { gcodePath }),
  slicerProfilesList: () => ipcRenderer.invoke('slicerProfiles:list'),
  slicerProfileCreate: (p: Record<string, unknown>) => ipcRenderer.invoke('slicerProfiles:create', p),
  slicerProfileUpdate: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('slicerProfiles:update', { id, patch }),
  slicerProfileDelete: (id: string) => ipcRenderer.invoke('slicerProfiles:delete', { id }),

  // ── Book Engine (life material) ───────────────────────────
  listBookEntries: (filter?: { kind?: string; limit?: number }) => ipcRenderer.invoke('book:list', filter),
  createBookEntry: (entry: Record<string, unknown>) => ipcRenderer.invoke('book:create', entry),
  updateBookEntry: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('book:update', { id, patch }),
  deleteBookEntry: (id: string) => ipcRenderer.invoke('book:delete', { id }),

  // ── Quoting (estimates → quotes → production runs) ────────
  // These handlers were registered in main but never bridged, so
  // QuotingPanel's `api()` probe returned undefined and the whole panel
  // rendered empty.
  quoteList: (opts?: { status?: string; query?: string; limit?: number }) =>
    ipcRenderer.invoke('quote:list', opts),
  quoteGet: (id: string) => ipcRenderer.invoke('quote:get', id),
  quoteSave: (quote: Record<string, unknown>) => ipcRenderer.invoke('quote:save', quote),
  quoteDelete: (id: string) => ipcRenderer.invoke('quote:delete', id),
  quoteSetStatus: (id: string, status: string) => ipcRenderer.invoke('quote:setStatus', id, status),
  quoteDuplicate: (id: string) => ipcRenderer.invoke('quote:duplicate', id),
  quoteLineItemSave: (item: Record<string, unknown>) => ipcRenderer.invoke('quote:lineItem:save', item),
  quoteLineItemDelete: (id: string) => ipcRenderer.invoke('quote:lineItem:delete', id),
  quoteLineItemsReorder: (quoteId: string, ids: string[]) =>
    ipcRenderer.invoke('quote:lineItems:reorder', quoteId, ids),
  quoteSummary: (opts?: { sinceDays?: number }) => ipcRenderer.invoke('quote:summary', opts),
  quoteConvertToRun: (quoteId: string, machineId?: string) =>
    ipcRenderer.invoke('quote:convertToRun', quoteId, machineId),
  quoteExportMarkdown: (quoteId: string) => ipcRenderer.invoke('quote:exportMarkdown', quoteId),

  // ── Approval Queue ────────────────────────────────────────
  approvalsList: (filter?: { status?: string; limit?: number }) =>
    ipcRenderer.invoke('approvals:list', filter),
  approvalsGet: (id: string) => ipcRenderer.invoke('approvals:get', { id }),
  approvalsStats: () => ipcRenderer.invoke('approvals:stats'),

  // ── Scheduler (Henry's Routines) ──────────────────────────
  listRoutines: () => ipcRenderer.invoke('scheduler:list'),
  addRoutine: (task: Record<string, unknown>) => ipcRenderer.invoke('scheduler:add', task),
  toggleRoutine: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('scheduler:toggle', { id, enabled }),
  runRoutineNow: (id: string) => ipcRenderer.invoke('scheduler:run-now', { id }),

  // ── Automation run history ────────────────────────────────────────
  automationRuns: (opts?: { taskId?: string; limit?: number; unreadOnly?: boolean }) =>
    ipcRenderer.invoke('automation:runs', opts ?? {}),
  automationUnreadCount: () => ipcRenderer.invoke('automation:unread-count'),
  automationMarkRunRead: (id: string) => ipcRenderer.invoke('automation:mark-read', id),
  automationMarkAllRunsRead: () => ipcRenderer.invoke('automation:mark-all-read'),
  automationClearRuns: (taskId?: string) => ipcRenderer.invoke('automation:clear-runs', taskId),
  automationAbort: (taskId: string) => ipcRenderer.invoke('automation:abort', taskId),
  automationIsRunning: (taskId: string) => ipcRenderer.invoke('automation:is-running', taskId),
  onAutomationRunChanged: (cb: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on('automation:run-changed', handler);
    return () => { ipcRenderer.removeListener('automation:run-changed', handler); };
  },
  deleteRoutine: (id: string) => ipcRenderer.invoke('scheduler:delete', { id }),
  // Main → renderer events: a Routine started / finished running.
  onSchedulerTaskStarted: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('scheduler:task-started', handler);
    return () => ipcRenderer.removeListener('scheduler:task-started', handler);
  },
  onSchedulerTaskCompleted: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('scheduler:task-completed', handler);
    return () => ipcRenderer.removeListener('scheduler:task-completed', handler);
  },

  // ── Tasks ─────────────────────────────────────────────────
  getTasks: (filter?: TaskListFilter) => ipcRenderer.invoke('task:list', filter),
  submitTask: (task: TaskSubmission) => ipcRenderer.invoke('task:submit', task),
  getTaskStatus: (id: string) => ipcRenderer.invoke('task:status', id),
  cancelTask: (id: string) => ipcRenderer.invoke('task:cancel', id),
  retryTask: (id: string) => ipcRenderer.invoke('task:retry', id),
  getTaskStats: () => ipcRenderer.invoke('task:stats'),

  // ── Memory — Legacy (backward-compatible) ─────────────────
  saveFact: (fact: Record<string, unknown>) => ipcRenderer.invoke('memory:saveFact', fact),
  // Generic invoke — for panels that need direct IPC access
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  // Reminders (SQLite persistent)
  remindersList: () => ipcRenderer.invoke('reminders:list'),
  remindersSave: (r: Record<string,unknown>) => ipcRenderer.invoke('reminders:save', r),
  remindersDelete: (id: string) => ipcRenderer.invoke('reminders:delete', id),
  remindersDue: () => ipcRenderer.invoke('reminders:due'),
  // Finance
  financeCreate: (t: Record<string,unknown>) => ipcRenderer.invoke('finance:create', t),
  financeList: (month?: string) => ipcRenderer.invoke('finance:list', month),
  financeAdd: (t: Record<string,unknown>) => ipcRenderer.invoke('finance:add', t),
  financeDelete: (id: string) => ipcRenderer.invoke('finance:delete', id),
  financeSummary: (month: string) => ipcRenderer.invoke('finance:summary', month),
  // Journal
  journalList: (search?: string) => ipcRenderer.invoke('journal:list', search),
  journalGet: (id: string) => ipcRenderer.invoke('journal:get', id),
  journalSave: (entry: Record<string,unknown>) => ipcRenderer.invoke('journal:save', entry),
  journalDelete: (id: string) => ipcRenderer.invoke('journal:delete', id),
  // Self-repair / health
  runDiagnostic: () => ipcRenderer.invoke('henry:diagnostic:run'),
  getLastDiagnostic: () => ipcRenderer.invoke('henry:diagnostic:last'),
  // ── Reminder events ──────────────────────────────────────────────────────────
  onReminderFired: (cb: (rem: unknown) => void) => {
    const handler = (_: IpcRendererEvent, rem: unknown) => cb(rem);
    ipcRenderer.on('reminder:fired', handler);
    return () => ipcRenderer.removeListener('reminder:fired', handler);
  },

  // ── Recurring Transactions ───────────────────────────────────────────────
  financeRecurringList: () => ipcRenderer.invoke('finance:recurring:list'),
  financeRecurringSave: (r: Record<string,unknown>) => ipcRenderer.invoke('finance:recurring:save', r),
  financeRecurringDelete: (id: string) => ipcRenderer.invoke('finance:recurring:delete', id),
  financeRecurringAutopost: () => ipcRenderer.invoke('finance:recurring:autopost'),

  // ── Health & Habits ──────────────────────────────────────────────────────────
  healthLogSave: (log: Record<string,unknown>) => ipcRenderer.invoke('health:logSave', log),
  healthLogsForDate: (date: string) => ipcRenderer.invoke('health:logsForDate', date),
  healthLogsRange: (from: string, to: string) => ipcRenderer.invoke('health:logsRange', from, to),
  healthLogDelete: (id: string) => ipcRenderer.invoke('health:logDelete', id),
  healthHabitList: () => ipcRenderer.invoke('health:habitList'),
  healthHabitSave: (h: Record<string,unknown>) => ipcRenderer.invoke('health:habitSave', h),
  healthHabitDelete: (id: string) => ipcRenderer.invoke('health:habitDelete', id),
  healthHabitLog: (opts: Record<string,unknown>) => ipcRenderer.invoke('health:habitLog', opts),
  healthHabitUnlog: (opts: Record<string,unknown>) => ipcRenderer.invoke('health:habitUnlog', opts),
  healthHabitLogsForDate: (date: string) => ipcRenderer.invoke('health:habitLogsForDate', date),
  healthHabitLogsRange: (from: string, to: string) => ipcRenderer.invoke('health:habitLogsRange', from, to),

  // ── Auto-setup & permissions ─────────────────────────────────────────────
  requestAccessibility: () => ipcRenderer.invoke('henry:requestAccessibility'),
  checkAccessibility: () => ipcRenderer.invoke('henry:checkAccessibility'),
  checkScreenRecording: () => ipcRenderer.invoke('henry:checkScreenRecording'),
  openPermissions: () => ipcRenderer.invoke('henry:openPermissions'),
  openScreenRecording: () => ipcRenderer.invoke('henry:openScreenRecording'),
  getRegisteredHotkeys: () => ipcRenderer.invoke('henry:getRegisteredHotkeys'),
  onPermissionsStatus: (cb: (status: { accessibility: boolean; screenRecording: boolean }) => void) => {
    const handler = (_: IpcRendererEvent, status: { accessibility: boolean; screenRecording: boolean }) => cb(status);
    ipcRenderer.on('henry:permissions:status', handler);
    return () => ipcRenderer.removeListener('henry:permissions:status', handler);
  },

  // ── System stats + computer control ────────────────────────────────────────
  computerSystemStats: () => ipcRenderer.invoke('computer:systemStats'),
  computerClipboardRead: () => ipcRenderer.invoke('computer:clipboard:read'),
  computerClipboardWrite: (text: string) => ipcRenderer.invoke('computer:clipboard:write', text),
  computerCaptureSelectedText: () => ipcRenderer.invoke('computer:captureSelectedText'),
  computerCheckCapabilities: () => ipcRenderer.invoke('computer:checkCapabilities'),
  computerSetVolume: (level: number) => ipcRenderer.invoke('computer:setVolume', level),
  computerGetVolume: () => ipcRenderer.invoke('computer:getVolume'),
  computerNotify: (opts: { title: string; body?: string }) => ipcRenderer.invoke('computer:notify', opts),
  computerDesktopMode: (opts: { enable: boolean; fullscreen?: boolean }) => ipcRenderer.invoke('computer:desktopMode', opts),
  computerKillProcess: (pid: number) => ipcRenderer.invoke('computer:killProcess', pid),
  computerScheduleTask: (task: { id: string; intervalMs: number; command: string; label: string }) =>
    ipcRenderer.invoke('computer:scheduleTask', task),
  computerUnscheduleTask: (id: string) => ipcRenderer.invoke('computer:unscheduleTask', id),
  computerListScheduled: () => ipcRenderer.invoke('computer:listScheduled'),
  onScheduledTaskResult: (cb: (result: unknown) => void) => {
    const handler = (_: IpcRendererEvent, result: unknown) => cb(result);
    ipcRenderer.on('computer:scheduledTask:result', handler);
    return () => ipcRenderer.removeListener('computer:scheduledTask:result', handler);
  },

  // Google OAuth (PKCE desktop flow)
  googleStartAuth: (opts: { clientId: string; clientSecret: string; scopes: string[] }) =>
    ipcRenderer.invoke('google:startAuth', opts),
  // ── Integrations (provider-agnostic OAuth; see electron/integrations/) ──
  // These back every connected service. `integration:setToken` is for
  // providers that issue a paste-a-token credential (Discord bot tokens);
  // `integration:connect` runs the PKCE + loopback flow for providers that do.
  // NONE of them ever returns a token, refresh token, or client secret.
  integrationList: () => ipcRenderer.invoke('integration:list'),
  integrationStatus: () => ipcRenderer.invoke('integration:status'),
  integrationConnect: (opts: { providerId: string; clientId: string; clientSecret: string; scopes?: string[] }) =>
    ipcRenderer.invoke('integration:connect', opts),
  integrationSetToken: (opts: { providerId: string; token: string; label?: string }) =>
    ipcRenderer.invoke('integration:setToken', opts),
  integrationDisconnect: (providerId: string) =>
    ipcRenderer.invoke('integration:disconnect', { providerId }),
  onIntegrationChanged: (cb: (changed: { providerId?: string }) => void) => {
    const handler = (_: IpcRendererEvent, changed: { providerId?: string }) => cb(changed);
    ipcRenderer.on('integration:changed', handler);
    return () => ipcRenderer.removeListener('integration:changed', handler);
  },
  // The handlers refresh using the app's OAuth client credentials, so they must
  // be passed through. These previously invoked with no argument at all, which
  // made the handler's destructuring throw a TypeError on every call.
  googleGetToken: (creds?: { clientId: string; clientSecret: string }) =>
    ipcRenderer.invoke('google:getToken', creds ?? { clientId: '', clientSecret: '' }),
  googleRefreshToken: (creds?: { clientId: string; clientSecret: string }) =>
    ipcRenderer.invoke('google:refreshToken', creds ?? { clientId: '', clientSecret: '' }),
  googleHasCredentials: () => ipcRenderer.invoke('google:hasCredentials'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  // Recordings (Meeting Recorder → SQLite)
  recordingsList: () => ipcRenderer.invoke('recordings:list'),
  recordingsGet: (id: string) => ipcRenderer.invoke('recordings:get', id),
  recordingsSave: (r: Record<string,unknown>) => ipcRenderer.invoke('recordings:save', r),
  recordingsDelete: (id: string) => ipcRenderer.invoke('recordings:delete', id),
  // Quick captures
  captureSave: (c: Record<string,unknown>) => ipcRenderer.invoke('capture:save', c),
  exportBackup: () => ipcRenderer.invoke('data:export-backup'),
  captureList: (limit?: number) => ipcRenderer.invoke('capture:list', limit),
  // Focus sessions
  focusSave: (s: Record<string,unknown>) => ipcRenderer.invoke('focus:save', s),
  focusList: (limit?: number) => ipcRenderer.invoke('focus:list', limit),
  focusStats: () => ipcRenderer.invoke('focus:stats'),
  // Weekly review
  weeklyData: () => ipcRenderer.invoke('weekly:data'),
  // Lists
  listsAll: () => ipcRenderer.invoke('lists:all'),
  listsSave: (list: Record<string,unknown>) => ipcRenderer.invoke('lists:save', list),
  listsDelete: (id: string) => ipcRenderer.invoke('lists:delete', id),
  listsAddItem: (listId: string, item: Record<string,unknown>) => ipcRenderer.invoke('lists:add-item', listId, item),
  listsToggleItem: (itemId: string) => ipcRenderer.invoke('lists:toggle-item', itemId),
  listsDeleteItem: (itemId: string) => ipcRenderer.invoke('lists:delete-item', itemId),
  listsClearDone: (listId: string) => ipcRenderer.invoke('lists:clear-done', listId),
  // Contacts / CRM
  contactsList: (query?: string) => ipcRenderer.invoke('contacts:list', query),
  contactsGet: (id: string) => ipcRenderer.invoke('contacts:get', id),
  contactsCreate: (c: Record<string,unknown>) => ipcRenderer.invoke('contacts:create', c),
  contactsUpdate: (id: string, patch: Record<string,unknown>) => ipcRenderer.invoke('contacts:update', id, patch),
  contactsDelete: (id: string) => ipcRenderer.invoke('contacts:delete', id),
  // Personal tasks
  tasksList: (filter?: { status?: string }) => ipcRenderer.invoke('tasks:list', filter),
  tasksCreate: (task: Record<string, unknown>) => ipcRenderer.invoke('tasks:create', task),
  tasksUpdate: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('tasks:update', id, patch),
  tasksDelete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
  // Maker Studio — machines, materials, production runs, waste, maintenance
  // Generalized: 3D printers, lasers, CNC, embroidery, vinyl, sewing, kilns, etc.
  makerMachinesList: (opts?: { type?: string; activeOnly?: boolean }) => ipcRenderer.invoke('maker:machines:list', opts),
  makerMachinesSave: (m: Record<string, unknown>) => ipcRenderer.invoke('maker:machines:save', m),
  makerMachinesDelete: (id: string) => ipcRenderer.invoke('maker:machines:delete', id),
  makerMaterialsList: (opts?: { category?: string; lowStock?: boolean; activeOnly?: boolean }) => ipcRenderer.invoke('maker:materials:list', opts),
  makerMaterialsSave: (m: Record<string, unknown>) => ipcRenderer.invoke('maker:materials:save', m),
  makerMaterialsDelete: (id: string) => ipcRenderer.invoke('maker:materials:delete', id),
  makerMaterialsColors: () => ipcRenderer.invoke('maker:materials:colors'),
  makerRunsList: (opts?: { machineId?: string; project?: string; limit?: number }) => ipcRenderer.invoke('maker:runs:list', opts),
  makerRunsSave: (r: Record<string, unknown>) => ipcRenderer.invoke('maker:runs:save', r),
  makerRunsDelete: (id: string) => ipcRenderer.invoke('maker:runs:delete', id),
  makerRunsSummary: (opts?: { month?: string; machineId?: string }) => ipcRenderer.invoke('maker:runs:summary', opts),
  makerWasteList: (limit?: number) => ipcRenderer.invoke('maker:waste:list', limit),
  makerWasteSave: (w: Record<string, unknown>) => ipcRenderer.invoke('maker:waste:save', w),
  makerWasteDelete: (id: string) => ipcRenderer.invoke('maker:waste:delete', id),
  makerWastePatterns: (opts?: { sinceDays?: number }) => ipcRenderer.invoke('maker:waste:patterns', opts),
  makerMaintenanceList: (machineId?: string) => ipcRenderer.invoke('maker:maintenance:list', machineId),
  makerMaintenanceSave: (m: Record<string, unknown>) => ipcRenderer.invoke('maker:maintenance:save', m),
  makerMaintenanceDelete: (id: string) => ipcRenderer.invoke('maker:maintenance:delete', id),
  makerBomList: (projectName?: string) => ipcRenderer.invoke('maker:bom:list', projectName),
  makerBomSave: (b: Record<string, unknown>) => ipcRenderer.invoke('maker:bom:save', b),
  makerBomDelete: (id: string) => ipcRenderer.invoke('maker:bom:delete', id),
  makerMigrateFromLocalStorage: (data: Record<string, unknown>) => ipcRenderer.invoke('maker:migrate:from-localStorage', data),
  // Native notification
  showNotification: (opts: { title: string; body?: string }) => ipcRenderer.invoke('notification:show', opts),
  searchFacts: (query: Record<string, unknown>) => ipcRenderer.invoke('memory:searchFacts', query),
  getAllFacts: (limit?: number) => ipcRenderer.invoke('memory:getAllFacts', limit),
  buildContext: (params: Record<string, unknown>) => ipcRenderer.invoke('memory:buildContext', params),
  saveSummary: (summary: Record<string, unknown>) => ipcRenderer.invoke('memory:saveSummary', summary),
  getSummary: (conversationId: string) => ipcRenderer.invoke('memory:getSummary', conversationId),

  // ── Memory — Layer 2: Session ─────────────────────────────
  saveSessionMemory: (session: Record<string, unknown>) => ipcRenderer.invoke('memory:saveSessionMemory', session),
  getSessionMemory: (conversationId: string) => ipcRenderer.invoke('memory:getSessionMemory', conversationId),
  compressSession: (opts: Record<string, unknown>) => ipcRenderer.invoke('memory:compressSession', opts),

  // ── Memory — Layer 3: Working Memory (DB-backed) ──────────
  getWorkingMemory: (userId?: string) => ipcRenderer.invoke('memory:getWorkingMemory', userId),
  updateWorkingMemory: (updates: Record<string, unknown>) => ipcRenderer.invoke('memory:updateWorkingMemory', updates),

  // ── Memory — Layer 4: Personal Memory (scored) ────────────
  savePersonalMemory: (item: Record<string, unknown>) => ipcRenderer.invoke('memory:savePersonalMemory', item),
  getPersonalMemory: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getPersonalMemory', opts),
  updatePersonalMemory: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke('memory:updatePersonalMemory', id, updates),
  deletePersonalMemory: (id: string) => ipcRenderer.invoke('memory:deletePersonalMemory', id),
  recallPersonalMemory: (id: string) => ipcRenderer.invoke('memory:recallPersonalMemory', id),

  // ── Memory — Layer 5: Projects ────────────────────────────
  saveProject: (project: Record<string, unknown>) => ipcRenderer.invoke('memory:saveProject', project),
  getProjects: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getProjects', opts),
  updateProject: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke('memory:updateProject', id, updates),
  saveProjectMemory: (item: Record<string, unknown>) => ipcRenderer.invoke('memory:saveProjectMemory', item),
  getProjectMemory: (projectId: string) => ipcRenderer.invoke('memory:getProjectMemory', projectId),

  // ── Memory — Goals ────────────────────────────────────────
  saveGoal: (goal: Record<string, unknown>) => ipcRenderer.invoke('memory:saveGoal', goal),
  getGoals: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getGoals', opts || {}),
  updateGoal: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke('memory:updateGoal', id, updates),
  deleteGoal: (id: string) => ipcRenderer.invoke('memory:deleteGoal', id),
  getCommitments: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getCommitments', opts || {}),
  saveCommitment: (c: Record<string, unknown>) => ipcRenderer.invoke('memory:saveCommitment', c),
  resolveCommitment: (id: string) => ipcRenderer.invoke('memory:resolveCommitment', id),
  updateCommitment: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke('memory:updateCommitment', id, updates),

  // ── Memory — Commitments ──────────────────────────────────

  // ── Memory — Milestones ───────────────────────────────────
  saveMilestone: (m: Record<string, unknown>) => ipcRenderer.invoke('memory:saveMilestone', m),
  getMilestones: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getMilestones', opts),

  // ── Memory — Layer 6: Relationship Memory ─────────────────
  saveRelationshipMemory: (item: Record<string, unknown>) => ipcRenderer.invoke('memory:saveRelationshipMemory', item),
  getRelationshipMemory: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getRelationshipMemory', opts),

  // ── Memory — Layer 7: Narrative Memory ───────────────────
  saveNarrativeMemory: (arc: Record<string, unknown>) => ipcRenderer.invoke('memory:saveNarrativeMemory', arc),
  getNarrativeMemory: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getNarrativeMemory', opts),

  // ── Memory — Summaries + Graph ────────────────────────────
  saveMemorySummary: (s: Record<string, unknown>) => ipcRenderer.invoke('memory:saveMemorySummary', s),
  getMemorySummaries: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getMemorySummaries', opts),
  saveGraphEdge: (edge: Record<string, unknown>) => ipcRenderer.invoke('memory:saveGraphEdge', edge),
  getGraphEdges: (opts?: Record<string, unknown>) => ipcRenderer.invoke('memory:getGraphEdges', opts),
  getMemoryGraph: () => ipcRenderer.invoke('memory:getGraph'),

  // ── Memory — Deep Context + Where-We-Left-Off ─────────────
  buildDeepContext: (params: Record<string, unknown>) => ipcRenderer.invoke('memory:buildDeepContext', params),
  getWhereWeLeftOff: () => ipcRenderer.invoke('memory:getWhereWeLeftOff'),
  saveWhereWeLeftOff: (summary: string) => ipcRenderer.invoke('memory:saveWhereWeLeftOff', summary),

  // ── Lessons / Curriculum (Henry as teacher) ────────────────
  lessonsCoursesList: () => ipcRenderer.invoke('lessons:courses:list'),
  lessonsCourseCreate: (payload: Record<string, unknown>) => ipcRenderer.invoke('lessons:courses:create', payload),
  lessonsCourseGet: (id: string) => ipcRenderer.invoke('lessons:courses:get', id),
  lessonsCourseDelete: (id: string) => ipcRenderer.invoke('lessons:courses:delete', id),
  lessonsLessonGet: (id: string) => ipcRenderer.invoke('lessons:lessons:get', id),
  lessonsLessonUpdateStatus: (payload: Record<string, unknown>) => ipcRenderer.invoke('lessons:lessons:updateStatus', payload),
  lessonsLessonSaveContent: (payload: Record<string, unknown>) => ipcRenderer.invoke('lessons:lessons:saveContent', payload),
  lessonsReviewSave: (payload: Record<string, unknown>) => ipcRenderer.invoke('lessons:reviews:save', payload),
  lessonsReviewsForCourse: (courseId: string) => ipcRenderer.invoke('lessons:reviews:listForCourse', courseId),

  // ── File System ───────────────────────────────────────────
  readDirectory: (dirPath?: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  pathExists: (filePath: string) => ipcRenderer.invoke('fs:pathExists', filePath) as Promise<boolean>,
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', { path: filePath, content }),

  // ── Project source files (dev mode only, main-process path-sandboxed) ──
  // selfRepairTools calls these by name; the handlers existed in main but
  // were never bridged, so the agent tools always threw on `henryAPI.*`.
  readSourceFile: (filePath: string) => ipcRenderer.invoke('source:read', filePath),
  writeSourceFile: (filePath: string, content: string) => ipcRenderer.invoke('source:write', filePath, content),

  // ── Ollama ────────────────────────────────────────────────
  ollamaStatus: (baseUrl?: string) => ipcRenderer.invoke('ollama:status', baseUrl),
  // The local gateway IPC was registered but never exposed, so the renderer's
  // optional probe always came back undefined.
  getLocalGatewayStatus: () => ipcRenderer.invoke('henry:localGatewayStatus'),

  // ── OpenCode (models + loopback bridge) ───────────────
  opencodeStatus: () => ipcRenderer.invoke('opencode:status'),
  opencodeModels: () => ipcRenderer.invoke('opencode:models'),
  opencodeBridgeStatus: () => ipcRenderer.invoke('opencode:bridgeStatus'),
  opencodeTest: (model: string) => ipcRenderer.invoke('opencode:test', model),
  ollamaModels: (baseUrl?: string) => ipcRenderer.invoke('ollama:models', baseUrl),
  ollamaPull: (model: string, baseUrl?: string) => ipcRenderer.invoke('ollama:pull', model, baseUrl),
  ollamaDelete: (model: string, baseUrl?: string) => ipcRenderer.invoke('ollama:delete', model, baseUrl),
  onOllamaPullProgress: (cb: (data: unknown) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('ollama:pull:progress', handler);
    return () => ipcRenderer.removeListener('ollama:pull:progress', handler);
  },

  // ── Ollama Lifecycle (Electron-only — Henry manages Ollama automatically) ──
  ollamaIsInstalled: () => ipcRenderer.invoke('ollama:isInstalled') as Promise<{ installed: boolean; running: boolean; binPath?: string }>,
  ollamaLaunch: (binPath?: string) => ipcRenderer.invoke('ollama:launch', binPath) as Promise<{ success: boolean; error?: string }>,
  ollamaInstall: () => ipcRenderer.invoke('ollama:install') as Promise<{ success: boolean; binPath?: string; running?: boolean; error?: string }>,
  onOllamaInstallProgress: (cb: (data: { phase: string; downloaded: number; total: number; message: string }) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data as { phase: string; downloaded: number; total: number; message: string });
    ipcRenderer.on('ollama:install:progress', handler);
    return () => ipcRenderer.removeListener('ollama:install:progress', handler);
  },

  // ── Terminal ──────────────────────────────────────────────
  execTerminal: (params: Record<string, unknown>) => ipcRenderer.invoke('terminal:exec', params),
  killTerminal: (execId: string) => ipcRenderer.invoke('terminal:kill', execId),

  // ── Computer Control ──────────────────────────────────────
  computerScreenshot: (params?: Record<string, unknown>) => ipcRenderer.invoke('computer:screenshot', params ?? {}),
  computerOpenApp: (appName: string) => ipcRenderer.invoke('computer:openApp', appName),
  computerOpenUrl: (url: string) => ipcRenderer.invoke('computer:openUrl', url),
  // Automation notifications — permission state + click routing
  notificationGetPermission: () => ipcRenderer.invoke('notification:getPermission'),
  notificationRequestPermission: () => ipcRenderer.invoke('notification:requestPermission'),
  notificationConsumeOpenRequest: () => ipcRenderer.invoke('notification:consumeOpenRequest'),
  notificationNotifyRun: (opts: { runId: number; title: string; success: boolean; detail?: string; mode?: 'all' | 'failures' | 'none' }) =>
    ipcRenderer.invoke('notification:notifyRun', opts),
  onNotificationOpenRequest: (cb: (req: { kind: string; runId: number; title: string }) => void) => {
    const l = (_e: unknown, req: { kind: string; runId: number; title: string }) => cb(req);
    ipcRenderer.on('notification:open-request', l);
    return () => ipcRenderer.removeListener('notification:open-request', l);
  },
  // Content Creators — scripted demo mode
  creatorsGetDemo: () => ipcRenderer.invoke('creators:getDemo'),
  creatorsSaveDemo: (demo: unknown) => ipcRenderer.invoke('creators:saveDemo', demo),
  creatorsGetOrb: () => ipcRenderer.invoke('creators:getOrb'),
  creatorsSaveOrb: (orb: unknown) => ipcRenderer.invoke('creators:saveOrb', orb),
  creatorsListMedia: () => ipcRenderer.invoke('creators:listMedia'),
  creatorsImportMedia: (input: { paths: string[]; kind: string }) => ipcRenderer.invoke('creators:importMedia', input),
  creatorsDeleteMedia: (fileName: string) => ipcRenderer.invoke('creators:deleteMedia', { fileName }),
  creatorsOpenMedia: (fileName: string) => ipcRenderer.invoke('creators:openMedia', { fileName }),
  creatorsLaunchStage: (mode: 'voice' | 'chat') => ipcRenderer.invoke('creators:launchStage', { mode }),
  creatorsCloseStage: () => ipcRenderer.invoke('creators:closeStage'),
  computerCloseApp: (appName: string) => ipcRenderer.invoke('computer:closeApp', appName),
  computerOsascript: (script: string) => ipcRenderer.invoke('computer:osascript', script),
  computerRunShell: (params: Record<string, unknown>) => ipcRenderer.invoke('computer:runShell', params),
  computerNewFolder: (params: { path: string }) => ipcRenderer.invoke('computer:newFolder', params),
  computerCheckPermissions: () => ipcRenderer.invoke('computer:checkPermissions'),
  computerListApps: () => ipcRenderer.invoke('computer:listApps'),
  computerListProcesses: () => ipcRenderer.invoke('computer:listProcesses'),
  computerTypeText: (text: string) => ipcRenderer.invoke('computer:typeText', text),
  computerClick: (params: Record<string, unknown>) => ipcRenderer.invoke('computer:click', params),
  computerActivateApplication: (appName: string) => ipcRenderer.invoke('computer:activateApplication', appName),
  computerFocusAiInput: (appName: string) => ipcRenderer.invoke('computer:focusAiInput', appName),
  computerPressKey: (key: string) => ipcRenderer.invoke('computer:pressKey', key),
  computerSystemInfo: () => ipcRenderer.invoke('computer:systemInfo'),
  getDefaultFileManager: () => ipcRenderer.invoke('computer:getDefaultFileManager'),
  getDefaultTerminal: () => ipcRenderer.invoke('computer:getDefaultTerminal'),
  getDefaultBrowser: () => ipcRenderer.invoke('computer:getDefaultBrowser'),

  // ── 3D Printer ────────────────────────────────────────────
  printerCheckDeps: () => ipcRenderer.invoke('printer:checkDeps'),
  printerListPorts: () => ipcRenderer.invoke('printer:listPorts'),
  printerConnect: (params: Record<string, unknown>) => ipcRenderer.invoke('printer:connect', params),
  printerDisconnect: () => ipcRenderer.invoke('printer:disconnect'),
  printerSendGcode: (command: string) => ipcRenderer.invoke('printer:sendGcode', command),
  printerStatus: () => ipcRenderer.invoke('printer:status'),
  printerPrintGcode: (gcode: string) => ipcRenderer.invoke('printer:printGcode', gcode),
  onPrinterData: (cb: (data: unknown) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('printer:data', handler);
    return () => ipcRenderer.removeListener('printer:data', handler);
  },

  // ── Session History (persistent conversation store + FTS search) ──
  sessionCheckDeps: () => ipcRenderer.invoke('session:checkDeps'),
  sessionCreate: (params: Record<string, unknown>) => ipcRenderer.invoke('session:create', params),
  sessionEnd: (params: Record<string, unknown>) => ipcRenderer.invoke('session:end', params),
  sessionResume: (params: Record<string, unknown>) => ipcRenderer.invoke('session:resume', params),
  sessionBranch: (params: Record<string, unknown>) => ipcRenderer.invoke('session:branch', params),
  sessionList: (params: Record<string, unknown>) => ipcRenderer.invoke('session:list', params),
  sessionSearch: (params: Record<string, unknown>) => ipcRenderer.invoke('session:search', params),
  sessionAddMessage: (params: Record<string, unknown>) => ipcRenderer.invoke('session:addMessage', params),
  sessionGetMessages: (params: Record<string, unknown>) => ipcRenderer.invoke('session:getMessages', params),
  // Agent audit log (Sprint 4): tool-call history + clear.
  listToolCalls: (limit?: number) => ipcRenderer.invoke('session:list-tool-calls', { limit: limit ?? 200 }),
  clearToolCalls: () => ipcRenderer.invoke('session:clear-tool-calls', {}),
  sessionGet: (params: Record<string, unknown>) => ipcRenderer.invoke('session:get', params),
  sessionSetTitle: (params: Record<string, unknown>) => ipcRenderer.invoke('session:setTitle', params),
  sessionArchive: (params: Record<string, unknown>) => ipcRenderer.invoke('session:archive', params),
  sessionUpdateTokens: (params: Record<string, unknown>) => ipcRenderer.invoke('session:updateTokens', params),
  sessionDelete: (params: Record<string, unknown>) => ipcRenderer.invoke('session:delete', params),
  sessionExport: (params: Record<string, unknown>) => ipcRenderer.invoke('session:export', params),
  sessionStats: () => ipcRenderer.invoke('session:stats', {}),

  // ── Cost Tracking ─────────────────────────────────────────
  getCostLog: (period?: string) => ipcRenderer.invoke('cost:getAll', period),

  // ── Events ────────────────────────────────────────────────
  onTaskUpdate: (cb: (data: TaskUpdatePayload) => void) => {
    const handler = (_: IpcRendererEvent, data: TaskUpdatePayload) => cb(data);
    ipcRenderer.on('task:update', handler);
    return () => ipcRenderer.removeListener('task:update', handler);
  },
  onTaskResult: (cb: (data: TaskResultEventPayload) => void) => {
    const handler = (_: IpcRendererEvent, data: TaskResultEventPayload) => cb(data);
    ipcRenderer.on('task:result', handler);
    return () => ipcRenderer.removeListener('task:result', handler);
  },
  onEngineStatus: (cb: (data: EngineStatusEventPayload) => void) => {
    const handler = (_: IpcRendererEvent, data: EngineStatusEventPayload) => cb(data);
    ipcRenderer.on('engine:status', handler);
    return () => ipcRenderer.removeListener('engine:status', handler);
  },
  onWorkerMessage: (cb: (data: unknown) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('worker:message', handler);
    return () => ipcRenderer.removeListener('worker:message', handler);
  },

  // ── Whisper STT ───────────────────────────────────────────
  // Implemented directly in the renderer since it's a plain HTTPS fetch to Groq.
  // The renderer process in Electron has full network access.
  whisperTranscribe: async (audioBlob: Blob, apiKey: string): Promise<string> => {
    const MIME_TO_EXT: Record<string, string> = {
      'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a',
    };
    const baseType = audioBlob.type.split(';')[0].trim();
    const ext = MIME_TO_EXT[baseType] || 'webm';
    const form = new FormData();
    form.append('file', audioBlob, `recording.${ext}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Whisper error ${res.status}${errText ? ': ' + errText.slice(0, 200) : ''}`);
    }
    return res.text();
  },

  // ── Voice (local whisper.cpp STT + say/ElevenLabs TTS) ────
  runtimeGetError: () => ipcRenderer.invoke('runtime:get-error'),
  onRuntimeStatusChanged: (cb: (s: RuntimeStatus) => void) => {
    const l = (_e: unknown, s: RuntimeStatus) => cb(s);
    ipcRenderer.on('runtime:status-changed', l);
    return () => ipcRenderer.removeListener('runtime:status-changed', l);
  },
  onSettingsChanged: (cb: (e: { key: string; value: string }) => void) => {
    const l = (_e: unknown, payload: { key: string; value: string }) => cb(payload);
    ipcRenderer.on('settings:changed', l);
    return () => ipcRenderer.removeListener('settings:changed', l);
  },
  voiceSttStatus: (opts?: { refresh?: boolean }) => ipcRenderer.invoke('voice:sttStatus', opts),
  voiceSttSetup: () => ipcRenderer.invoke('voice:sttSetup'),
  onVoiceSttSetupProgress: (cb: (p: unknown) => void) => {
    const handler = (_: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('voice:stt:setup-progress', handler);
    return () => ipcRenderer.removeListener('voice:stt:setup-progress', handler);
  },
  voiceTranscribe: (audio: ArrayBuffer) => ipcRenderer.invoke('voice:transcribe', new Uint8Array(audio)),
  voiceMicAccess: () => ipcRenderer.invoke('voice:micAccess'),
  voiceSpeak: (params: { text: string; engine?: string }) => ipcRenderer.invoke('voice:speak', params),
  voiceStopSpeaking: () => ipcRenderer.invoke('voice:stopSpeaking'),
  voiceTtsStatus: () => ipcRenderer.invoke('voice:ttsStatus'),
  voiceGreeting: (opts?: { speak?: boolean }) => ipcRenderer.invoke('voice:greeting', opts ?? {}),
  voiceGreetingClearCache: () => ipcRenderer.invoke('voice:greeting:clearCache'),
  voiceSttDownloadModel: () => ipcRenderer.invoke('voice:sttDownloadModel'),
  voiceTtsLocalStatus: (opts?: { voice?: string; refresh?: boolean }) => ipcRenderer.invoke('voice:ttsLocalStatus', opts ?? {}),
  voiceTtsLocalVoices: () => ipcRenderer.invoke('voice:ttsLocalVoices'),
  voiceTtsLocalSetup: (opts?: { voice?: string }) => ipcRenderer.invoke('voice:ttsLocalSetup', opts ?? {}),
  voiceTtsLocalStop: () => ipcRenderer.invoke('voice:ttsLocalStop'),
  voiceTtsLocalSetupProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('voice:ttsLocal:setup-progress', handler);
    return () => ipcRenderer.removeListener('voice:ttsLocal:setup-progress', handler);
  },
  voiceElevenLabsStatus: () => ipcRenderer.invoke('voice:elevenlabsStatus'),
  voiceElevenLabsVoices: () => ipcRenderer.invoke('voice:elevenlabsVoices'),

  // ── Companion Sync Bridge ─────────────────────────────────
  syncStart: (port?: number) => ipcRenderer.invoke('henry:sync:start', port),
  syncStartTunnel: () => ipcRenderer.invoke('henry:sync:start-tunnel'),
  syncStopTunnel: () => ipcRenderer.invoke('henry:sync:stop-tunnel'),
  syncGetTunnelUrl: () => ipcRenderer.invoke('henry:sync:get-tunnel-url'),
  syncStop: () => ipcRenderer.invoke('henry:sync:stop'),
  syncGetState: () => ipcRenderer.invoke('henry:sync:state'),
  syncGeneratePairToken: (ttlMs?: number) => ipcRenderer.invoke('henry:sync:generate-pair-token', ttlMs),
  syncRevokePairToken: () => ipcRenderer.invoke('henry:sync:revoke-pair-token'),
  syncUnlinkDevice: (deviceId: string) => ipcRenderer.invoke('henry:sync:unlink-device', deviceId),
  syncPushEvent: (event: unknown) => ipcRenderer.invoke('henry:sync:push-event', event),
  syncAddPendingAction: (action: unknown) => ipcRenderer.invoke('henry:sync:add-pending-action', action),
  syncUpdateNotes: (notes: unknown[]) => ipcRenderer.invoke('henry:sync:update-notes', notes),
  syncUpdateSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke('henry:sync:update-settings', settings),

  // Companion events from mobile → desktop renderer
  onQuickExtractResult: (cb: (result: unknown) => void) => {
    const handler = (_: IpcRendererEvent, result: unknown) => cb(result);
    ipcRenderer.on('henry:quick-extract:result', handler);
    return () => ipcRenderer.removeListener('henry:quick-extract:result', handler);
  },
  onCompanionCapture: (cb: (capture: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('henry:companion:capture', handler);
    return () => ipcRenderer.removeListener('henry:companion:capture', handler);
  },
  onCompanionPrompt: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('henry:companion:prompt', handler);
    return () => ipcRenderer.removeListener('henry:companion:prompt', handler);
  },
  onCompanionActionDecision: (cb: (decision: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('henry:companion:action-decision', handler);
    return () => ipcRenderer.removeListener('henry:companion:action-decision', handler);
  },
  onDiagnosticComplete: (cb: (report: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('henry:diagnostic:complete', handler);
    return () => ipcRenderer.removeListener('henry:diagnostic:complete', handler);
  },
  isFirstLaunch: () => ipcRenderer.invoke('henry:isFirstLaunch'),
  onCompanionChatUpdate: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on('henry:companion:chat-update', handler);
    return () => ipcRenderer.removeListener('henry:companion:chat-update', handler);
  },
  onCompanionDeviceLinked: (cb: (device: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('henry:companion:device-linked', handler);
    return () => ipcRenderer.removeListener('henry:companion:device-linked', handler);
  },
  onSyncRequestStatus: (cb: (replyChannel: string) => void) => {
    const handler = (_e: IpcRendererEvent, data: { replyChannel: string }) => cb(data.replyChannel);
    ipcRenderer.on('henry:sync:request-status', handler);
    return () => ipcRenderer.removeListener('henry:sync:request-status', handler);
  },
  replySyncStatus: (channel: string, status: unknown) => {
    ipcRenderer.send(channel, status);
  },

  // ── Auto-updater ──────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateAvailable: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('updater:update-available', handler);
    return () => ipcRenderer.removeListener('updater:update-available', handler);
  },
  onUpdateDownloaded: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('updater:update-downloaded', handler);
    return () => ipcRenderer.removeListener('updater:update-downloaded', handler);
  },

  // ── Security / privacy / logs / quit ─────────────────────────────────
  // Each of these maps to a switch that gates real behaviour in the main
  // process (see electron/ipc/securityPolicy.ts). None of them is UI-only
  // state: `securitySet` writes the row the IPC boundary consults on the very
  // next call.

  /** Full policy + defaults + lock state, for the Security panel to render. */
  securityGet: () => ipcRenderer.invoke('security:get'),
  securitySet: (key: string, value: boolean) => ipcRenderer.invoke('security:set', { key, value }),
  /** Stores a scrypt hash — the PIN itself is never written to disk. */
  securitySetPin: (pin: string) => ipcRenderer.invoke('security:setPin', { pin }),
  securityClearPin: () => ipcRenderer.invoke('security:clearPin'),
  securityUnlock: (pin: string) => ipcRenderer.invoke('security:unlock', { pin }),

  privacyGet: () => ipcRenderer.invoke('privacy:get'),
  privacyClear: (what: string[]) => ipcRenderer.invoke('privacy:clear', { what }),

  logsQuery: (q?: Record<string, unknown>) => ipcRenderer.invoke('logs:query', q ?? {}),
  logsStats: () => ipcRenderer.invoke('logs:stats'),
  logsClear: (before?: string) => ipcRenderer.invoke('logs:clear', before ? { before } : {}),
  logsSetRetention: (days: number) => ipcRenderer.invoke('logs:retention', { days }),
  logsGetRetention: () => ipcRenderer.invoke('logs:retention:get'),
  /** Returns redacted text. Writes no file — the caller decides where it goes. */
  logsExport: (q?: Record<string, unknown>) => ipcRenderer.invoke('logs:export', q ?? {}),

  /**
   * Quit Henry.
   *
   * Returns `{ ok: false, needsConfirmation: true, activeWork: [...] }` rather
   * than quitting when a Routine or task is still running; pass `confirm: true`
   * after the user has acknowledged the lost work.
   */
  quitApp: (opts?: { force?: boolean; confirm?: boolean }) =>
    ipcRenderer.invoke('app:quit', opts ?? {}),
  appActiveWork: () => ipcRenderer.invoke('app:activeWork'),
  /** Main tells the renderer it has begun teardown, so it can show "saving…". */
  onAppQuitting: (cb: (info: { forced: boolean; abandonedWork: string[] }) => void) => {
    const handler = (_: IpcRendererEvent, info: { forced: boolean; abandonedWork: string[] }) =>
      cb(info);
    ipcRenderer.on('app:quitting', handler);
    return () => ipcRenderer.removeListener('app:quitting', handler);
  },

  /**
   * Grant one execution of a gated channel (shell/terminal/printer).
   *
   * Must be called ONLY after the user has actually confirmed — the main
   * process treats a grant as that decision having been made. Grants are
   * single-use and expire in 60s.
   */
  securityApproveChannel: (channel: string) =>
    ipcRenderer.invoke('security:approve-channel', { channel }),
});
