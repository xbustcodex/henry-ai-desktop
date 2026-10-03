/**
 * Task Broker — The brain of the dual-engine architecture.
 *
 * Manages the queue between Companion and Worker engines.
 * The Companion can submit tasks, the Worker picks them up.
 * Both engines can check status independently.
 */

import { ipcMain, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { callAI } from './ai';
import { safeResolve } from './_pathSafety';
import { decryptKey } from './_keyStorage';
import {
  buildWorkerAITaskSystemPrompt,
  buildWorkerCodeGenSystemPrompt,
} from '../../src/henry/charter';
import { emitTriggerEvent } from '../agent/triggers';

type WindowGetter = () => BrowserWindow | null;

/** Safely send to renderer — skips if window is destroyed (Vite HMR). */
function safeSend(getWin: WindowGetter, channel: string, data: unknown) {
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

interface TaskExecution {
  taskId: string;
  abortController?: AbortController;
}

interface ProviderRow {
  id: string;
  name: string;
  api_key: string;
}

let db: Database.Database;
const activeExecutions: Map<string, TaskExecution> = new Map();
let getWindow: WindowGetter;
let workspaceRoot: string;

function serializeTaskPayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

/** Parse stored task payload for execution — never throws. */
function safeParsePayload(payload: unknown): Record<string, unknown> {
  if (payload == null) return {};
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { raw: payload };
    } catch {
      return { raw: payload };
    }
  }
  return {};
}

function normalizeTaskError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  if (typeof error === 'string') return error;
  return 'Task failed';
}

function resolveWorkspacePath(requestedPath: string): string {
  // Shared safeResolve: correct prefix check (no sibling-dir escape) + symlink
  // hardening. See electron/ipc/_pathSafety.ts.
  return safeResolve(workspaceRoot, requestedPath);
}

function getWorkerEngineConfig(): { workerProviderId: string; workerModel: string; provider: ProviderRow } {
  const workerProviderRow = db.prepare("SELECT value FROM settings WHERE key = 'worker_provider'").get() as
    | { value?: string }
    | undefined;
  const workerModelRow = db.prepare("SELECT value FROM settings WHERE key = 'worker_model'").get() as
    | { value?: string }
    | undefined;

  const workerProviderId = workerProviderRow?.value?.trim() ?? '';
  const workerModel = workerModelRow?.value?.trim() ?? '';

  if (!workerProviderId) {
    throw new Error('Worker engine is not configured. Open Settings and choose a Worker provider/model.');
  }
  if (!workerModel) {
    throw new Error('Worker engine is not configured. Open Settings and choose a Worker provider/model.');
  }

  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(workerProviderId) as ProviderRow | undefined;
  if (!provider) {
    throw new Error('Worker engine is not configured. Open Settings and choose a Worker provider/model.');
  }

  const idLower = (provider.id || '').toLowerCase();
  const nameLower = (provider.name || '').toLowerCase();
  const isOllama = idLower === 'ollama' || nameLower === 'ollama';

  if (!isOllama && (!provider.api_key || provider.api_key === '')) {
    throw new Error('Worker provider is missing an API key.');
  }

  // Decrypt the key at the last moment — it's stored encrypted at rest in SQLite.
  return { workerProviderId, workerModel, provider: { ...provider, api_key: decryptKey(provider.api_key) } };
}

export function registerTaskBrokerHandlers(
  database: Database.Database,
  winGetter: WindowGetter,
  workspacePath: string
) {
  db = database;
  getWindow = winGetter;
  workspaceRoot = workspacePath;

  // Submit a new task to the queue
  ipcMain.handle(
    'task:submit',
    async (
      _event,
      task: {
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
    ) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const storedPayload = serializeTaskPayload(task.payload);

      db.prepare(`
      INSERT INTO tasks (
        id, description, type, status, priority, payload, source_engine, conversation_id, created_at,
        created_from_mode, related_file_path, created_from_message_id
      )
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        task.description,
        task.type,
        task.priority ?? 5,
        storedPayload,
        task.sourceEngine || 'companion',
        task.conversationId || null,
        now,
        task.createdFromMode?.trim() || null,
        task.relatedFilePath?.trim() || null,
        task.createdFromMessageId?.trim() || null
      );

      // Notify renderer about new task
      safeSend(getWindow, 'task:update', {
        id,
        status: 'queued',
        description: task.description,
        type: task.type,
        created_from_mode: task.createdFromMode?.trim() || undefined,
        related_file_path: task.relatedFilePath?.trim() || undefined,
        created_from_message_id: task.createdFromMessageId?.trim() || undefined,
      });

      // Auto-process queue
      processNextTask();

      return { id, status: 'queued' };
    }
  );

  // Get task status
  ipcMain.handle('task:status', async (_event, taskId: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return task || null;
  });

  // Get all tasks with optional filter
  ipcMain.handle(
    'task:list',
    async (
      _event,
      filter?: {
        status?: string;
        limit?: number;
      }
    ) => {
      let query = 'SELECT * FROM tasks';
      const params: unknown[] = [];

      if (filter?.status) {
        query += ' WHERE status = ?';
        params.push(filter.status);
      }

      query += ' ORDER BY priority DESC, created_at ASC';

      if (filter?.limit) {
        query += ' LIMIT ?';
        params.push(filter.limit);
      }

      return db.prepare(query).all(...params);
    }
  );

  // Cancel a task
  ipcMain.handle('task:cancel', async (_event, taskId: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
    if (!task) return { error: 'Task not found' };

    if (task.status === 'running') {
      // Abort active execution
      const execution = activeExecutions.get(taskId);
      if (execution?.abortController) {
        execution.abortController.abort();
      }
    }

    db.prepare(`
      UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?
    `).run(new Date().toISOString(), taskId);

    safeSend(getWindow, 'task:update', { id: taskId, status: 'cancelled' });

    return { id: taskId, status: 'cancelled' };
  });

  // Retry a failed task
  ipcMain.handle('task:retry', async (_event, taskId: string) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
    if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) {
      return { error: 'Can only retry failed or cancelled tasks' };
    }

    db.prepare(`
      UPDATE tasks SET status = 'queued', started_at = NULL, completed_at = NULL, result = NULL, error = NULL
      WHERE id = ?
    `).run(taskId);

    safeSend(getWindow, 'task:update', { id: taskId, status: 'queued' });

    processNextTask();

    return { id: taskId, status: 'queued' };
  });

  // Get queue statistics
  ipcMain.handle('task:stats', async () => {
    const stats = db.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM tasks 
      GROUP BY status
    `).all();

    const totalCost = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total FROM tasks WHERE cost > 0
    `).get() as { total?: number };

    return {
      byStatus: stats,
      totalCost: totalCost?.total || 0,
      activeCount: activeExecutions.size,
    };
  });
}

// Process the next queued task
async function processNextTask() {
  // Don't run more than 1 worker task at a time (for now)
  if (activeExecutions.size >= 1) return;

  const nextTask = db.prepare(`
    SELECT * FROM tasks WHERE status = 'queued' 
    ORDER BY priority DESC, created_at ASC 
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;

  if (!nextTask) return;

  const taskId = nextTask.id as string;

  // Mark as running
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?
  `).run(now, taskId);

  safeSend(getWindow, 'task:update', {
    id: taskId,
    status: 'running',
    description: nextTask.description,
  });

  // Also update the worker status in renderer
  safeSend(getWindow, 'engine:status', {
    engine: 'worker',
    status: 'working',
    taskId,
    taskDescription: nextTask.description,
  });

  const abortController = new AbortController();
  activeExecutions.set(taskId, {
    taskId,
    abortController,
  });

  try {
    // Execute the task based on type
    const result = await executeTask(nextTask, abortController.signal);

    const costArg =
      result && typeof result === 'object' && 'cost' in result && typeof (result as { cost: unknown }).cost === 'number'
        ? (result as { cost: number }).cost
        : null;

    // A task cancelled mid-flight must not be reported as completed. Some
    // task types (notably executeFileTask) never read the abort signal, so the
    // run finishes normally and used to overwrite the 'cancelled' row — the
    // user saw "cancelled" and then found it marked done.
    const alreadyCancelled = !!db
      .prepare(`SELECT status FROM tasks WHERE id = ?`)
      .get(taskId) && (db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status === 'cancelled';
    if (alreadyCancelled) {
      db.prepare(`
        UPDATE tasks SET result = ?, cost = COALESCE(?, cost) WHERE id = ?
      `).run(JSON.stringify(result), costArg, taskId);
    } else {
      db.prepare(`
        UPDATE tasks SET status = 'completed', completed_at = ?, result = ?, cost = COALESCE(?, cost)
        WHERE id = ?
      `).run(new Date().toISOString(), JSON.stringify(result), costArg, taskId);
    }

    // A task reaching 'completed' is the one thing in this module a user would
    // plausibly want a Routine to react to ("when the render finishes, do the
    // next thing"). This is the sole path that writes that status, so the event
    // fires exactly once per completed task — and never for a cancelled one,
    // because the cancellation branch above never reaches this line.
    //
    // `emitTriggerEvent` cannot throw: EventBus.emit try/catches each
    // subscriber and returns a count, so a broken Routine cannot fail the task
    // that just finished. It runs after the row is written, so the result is
    // already durable regardless.
    if (!alreadyCancelled) {
      emitTriggerEvent('task.completed', {
        taskId,
        description: nextTask.description,
        taskType: nextTask.type,
        conversationId: nextTask.conversation_id ?? null,
      });
    }

    safeSend(getWindow, 'task:update', {
      id: taskId,
      status: alreadyCancelled ? 'cancelled' : 'completed',
      result,
    });

    // Send result back to conversation if there is one
    if (nextTask.conversation_id) {
      safeSend(getWindow, 'task:result', {
        taskId,
        conversationId: nextTask.conversation_id,
        result,
      });
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      // A cancelled task must still be written back. This used to `return`
      // before any DB update, leaving the row stuck at status='running' — the
      // UI showed it as cancelled while the single-slot broker still counted
      // it as active, so the queue could wedge until restart.
      db.prepare(`
        UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?
      `).run(new Date().toISOString(), taskId);
      safeSend(getWindow, 'task:update', { id: taskId, status: 'cancelled' });
      if (nextTask.conversation_id) {
        safeSend(getWindow, 'task:result', {
          taskId,
          conversationId: nextTask.conversation_id,
          error: 'Cancelled',
        });
      }
      return;
    }

    const errMsg = normalizeTaskError(error);

    db.prepare(`
      UPDATE tasks SET status = 'failed', completed_at = ?, error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), errMsg, taskId);

    safeSend(getWindow, 'task:update', {
      id: taskId,
      status: 'failed',
      error: errMsg,
    });

    if (nextTask.conversation_id) {
      safeSend(getWindow, 'task:result', {
        taskId,
        conversationId: nextTask.conversation_id,
        error: errMsg,
      });
    }
  } finally {
    activeExecutions.delete(taskId);

    safeSend(getWindow, 'engine:status', {
      engine: 'worker',
      status: 'idle',
    });

    // Process next task in queue
    processNextTask();
  }
}

// Execute a task based on its type
async function executeTask(task: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const payload = safeParsePayload(task.payload);

  switch (task.type) {
    case 'ai_generate':
      return await executeAITask(task, payload, signal);

    case 'file_operation':
      return await executeFileTask(task, payload, signal);

    case 'code_generate':
      return await executeCodeGenTask(task, payload, signal);

    case 'research':
      return await executeResearchTask(task, payload, signal);

    default:
      // Default: treat as AI generation task
      return await executeAITask(task, payload, signal);
  }
}

// AI generation task
async function executeAITask(
  task: Record<string, unknown>,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const { workerProviderId, workerModel, provider } = getWorkerEngineConfig();

  const messages = [
    {
      role: 'system',
      content: buildWorkerAITaskSystemPrompt(),
    },
    {
      role: 'user',
      content: (typeof payload.prompt === 'string' ? payload.prompt : null) || String(task.description ?? ''),
    },
  ];

  const result = await callAI({
    provider: workerProviderId,
    model: workerModel,
    apiKey: provider.api_key,
    messages,
    temperature: 0.7,
    signal,
  });

  return {
    type: 'ai_response',
    content: result.content,
    model: workerModel,
    tokens: result.usage,
    cost: result.cost,
  };
}

// File operation task
async function executeFileTask(
  _task: Record<string, unknown>,
  payload: Record<string, unknown>,
  _signal: AbortSignal
): Promise<Record<string, unknown>> {
  const operation = payload.operation;
  const rawPath = typeof payload.path === 'string' ? payload.path : '';

  switch (operation) {
    case 'read': {
      const target = resolveWorkspacePath(rawPath);
      const content = await fs.readFile(target, 'utf-8');
      return { type: 'file_content', path: rawPath, content };
    }

    case 'write': {
      const target = resolveWorkspacePath(rawPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(payload.content ?? ''), 'utf-8');
      return { type: 'file_written', path: rawPath };
    }

    case 'list': {
      const target = resolveWorkspacePath(rawPath || '.');
      const entries = await fs.readdir(target, { withFileTypes: true });
      return {
        type: 'file_list',
        path: rawPath || '.',
        entries: entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        })),
      };
    }

    default:
      throw new Error(`Unknown file operation: ${String(operation)}`);
  }
}

// Code generation task
async function executeCodeGenTask(
  task: Record<string, unknown>,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const { workerProviderId, workerModel, provider } = getWorkerEngineConfig();

  const messages = [
    {
      role: 'system',
      content: buildWorkerCodeGenSystemPrompt({
        language: typeof payload.language === 'string' ? payload.language : 'TypeScript',
        framework: typeof payload.framework === 'string' ? payload.framework : 'Not specified',
        context: typeof payload.context === 'string' ? payload.context : '',
      }),
    },
    {
      role: 'user',
      content: (typeof payload.prompt === 'string' ? payload.prompt : null) || String(task.description ?? ''),
    },
  ];

  const result = await callAI({
    provider: workerProviderId,
    model: workerModel,
    apiKey: provider.api_key,
    messages,
    temperature: 0.3,
    signal,
  });

  return {
    type: 'code_generation',
    content: result.content,
    model: workerModel,
    tokens: result.usage,
    cost: result.cost,
  };
}

// Research task
async function executeResearchTask(
  task: Record<string, unknown>,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  return executeAITask(
    task,
    {
      ...payload,
      prompt: `Research the following thoroughly and provide a comprehensive summary with sources and key findings:\n\n${(typeof payload.prompt === 'string' ? payload.prompt : null) || String(task.description ?? '')}`,
    },
    signal
  );
}
