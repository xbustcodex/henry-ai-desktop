/**
 * Runtime + startup diagnostics.
 *
 * Henry runs a long-lived local process that also hosts a browser window and a
 * sync server. When something goes wrong at boot the failure used to be logged
 * and swallowed, leaving a windowless process. This records the failure
 * durably, reports a live status snapshot, and offers a clean restart.
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

export interface StartupFailure {
  message: string;
  at: string;
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
  /** True when the window failed to come up during this boot. */
  bootFailed: boolean;
  lastError: string | null;
  databaseOk: boolean;
  databaseError: string | null;
}

const startedAt = new Date();

/**
 * The failure record lives in a file rather than the database: it has to
 * survive the very failure that stops the database from opening.
 */
function failureFile(): string {
  return path.join(app.getPath('userData'), 'startup-failure.json');
}

export function recordStartupFailure(err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    fs.mkdirSync(path.dirname(failureFile()), { recursive: true });
    const payload: StartupFailure = { message, at: new Date().toISOString() };
    fs.writeFileSync(failureFile(), JSON.stringify(payload), 'utf8');
  } catch {
    /* if even this fails there is nothing more we can do */
  }
}

function readStartupFailure(): StartupFailure | null {
  try {
    const raw = fs.readFileSync(failureFile(), 'utf8');
    const parsed = JSON.parse(raw) as StartupFailure;
    return parsed && typeof parsed.message === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function clearStartupFailure(): void {
  try {
    fs.rmSync(failureFile(), { force: true });
  } catch {
    /* best effort */
  }
}

export function registerRuntimeHandlers(getDb: () => Database.Database | null): void {
  ipcMain.handle('runtime:get-status', () => {
    let databaseOk = false;
    let databaseError: string | null = null;
    try {
      const db = getDb();
      if (db) {
        db.prepare('SELECT 1').get();
        databaseOk = true;
      } else {
        databaseError = 'Database handle is not available.';
      }
    } catch (e: unknown) {
      databaseError = e instanceof Error ? e.message : String(e);
    }

    const failure = readStartupFailure();
    return {
      ok: databaseOk && !failure,
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      bootFailed: !!failure,
      lastError: failure?.message ?? null,
      databaseOk,
      databaseError,
    } satisfies RuntimeStatus;
  });

  ipcMain.handle('startup:get-failure', () => readStartupFailure());

  ipcMain.handle('startup:clear-failure', () => {
    clearStartupFailure();
    return { ok: true };
  });

  /** Clean restart: relaunch the app and exit this process. */
  ipcMain.handle('runtime:restart', () => {
    clearStartupFailure();
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}
