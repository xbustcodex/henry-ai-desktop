import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database;

let dbFilePath = '';

/**
 * The real on-disk path of Henry's database.
 *
 * The health check used to assume `$HOME/henry.db`, which is not where the
 * database lives — it is under Electron's userData directory — so the check
 * *always* reported "Database file missing" and offered to repair a perfectly
 * healthy database. Exposed from here so there is one source of truth.
 */
export function getDbFilePath(): string {
  return dbFilePath;
}

export function initDatabase(dataDir: string): Database.Database {
  const dbPath = path.join(dataDir, 'henry.db');
  dbFilePath = dbPath;
  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    -- Settings (key-value store)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- AI Providers
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      models TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      engine TEXT CHECK(engine IN ('companion', 'worker', NULL)),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Task Queue
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 5,
      payload TEXT DEFAULT '{}',
      result TEXT,
      error TEXT,
      engine TEXT DEFAULT 'worker',
      source_engine TEXT,
      conversation_id TEXT,
      cost REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    -- Cost Tracking
    CREATE TABLE IF NOT EXISTS cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      conversation_id TEXT,
      task_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Memory Facts
    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      fact TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      importance INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    -- FTS5 full-text index for memory_facts (fast semantic search)
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts
      USING fts5(fact, category, content="memory_facts", content_rowid="rowid");

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
      INSERT INTO memory_facts_fts(rowid, fact, category) VALUES (new.rowid, new.fact, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
      INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category) VALUES('delete', old.rowid, old.fact, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
      INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category) VALUES('delete', old.rowid, old.fact, old.category);
      INSERT INTO memory_facts_fts(rowid, fact, category) VALUES (new.rowid, new.fact, new.category);
    END;

    -- Conversation Summaries
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    -- Workspace File Index
    CREATE TABLE IF NOT EXISTS workspace_index (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      file_type TEXT,
      summary TEXT,
      last_indexed TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0
    );

    -- Initialize default settings if empty
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('setup_complete', 'false'),
      ('theme', 'dark'),
      ('companion_model', ''),
      ('companion_provider', ''),
      ('worker_model', ''),
      ('worker_provider', ''),
      ('default_temperature', '0.7'),
      ('workspace_path', '');
  `);

  migrateDatabaseSchema(db);
  migrateAttachmentsSchema(db);

  return db;
}

/**
 * Chat attachments — files the user attaches to a message.
 *
 * Bytes live on disk under <userData>/attachments; this table is only the
 * index. Additive and idempotent so existing databases upgrade in place.
 */
function migrateAttachmentsSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      message_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      byte_size INTEGER DEFAULT 0,
      stored_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_conversation
      ON message_attachments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_message
      ON message_attachments(message_id);
  `);
}

/** Additive columns for task → workspace bridge (idempotent). */
function migrateDatabaseSchema(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  try {
    if (!has('created_from_mode')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN created_from_mode TEXT`);
    }
    if (!has('related_file_path')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN related_file_path TEXT`);
    }
    if (!has('created_from_message_id')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN created_from_message_id TEXT`);
    }
  } catch {
    /* ignore migration errors on unusual DB states */
  }

  // Memory Blueprint — full 7-layer schema migration
  migrateMemoryBlueprintSchema(db);
  addMissingSessionMemoryColumns(db);

  // Agent layer — Sprint 3 scheduler (Henry's Routines).
  migrateSchedulerSchema(db);

  // Agent layer — Sprint 4 QuickBooks invoice cache.
  migrateInvoicesSchema(db);

  // Project Vault — rich project fields + seed Topher's real projects.
  migrateProjectVaultSchema(db);
  seedProjectVault(db);

  // Book Engine — captured life material for Topher's book.
  migrateBookSchema(db);

  // Approval Queue — durable log of every confirm-tier action + its outcome.
  migrateApprovalsSchema(db);

  // Slicer — saved slicing profiles (printer + material + settings).
  migrateSlicerProfilesSchema(db);
  seedSlicerProfiles(db);

  // Machine connectivity — saved printer/CNC connections (electron/machines/).
  migrateMachineConnectionsSchema(db);

  // Lessons / Curriculum — AI-generated courses ("teach me anything" + Bible).
  migrateLessonsSchema(db);

  // Render daemon endpoint for Henry's direct video generation.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO settings (key, value) VALUES ('render_endpoint', 'http://localhost:8799')`,
    ).run();
  } catch { /* ignore on unusual DB states */ }
}

/**
 * Lessons / Curriculum (AI-generated courses and lessons). Henry as teacher:
 * a `courses` row holds the AI-generated syllabus (outline_json), `lessons`
 * hold per-lesson cached content + progression state (locked → available →
 * in_progress → completed), and `lesson_reviews` log every quiz attempt.
 * CRUD lives in electron/ipc/lessons.ts; AI generation happens renderer-side.
 * Idempotent — safe to run on every launch.
 */
function migrateLessonsSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      topic        TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'general' CHECK(kind IN ('bible','general')),
      outline_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id           TEXT PRIMARY KEY,
      course_id    TEXT NOT NULL,
      idx          INTEGER NOT NULL,
      title        TEXT NOT NULL,
      content_md   TEXT,
      status       TEXT NOT NULL DEFAULT 'locked'
        CHECK(status IN ('locked','available','in_progress','completed')),
      score        REAL,
      completed_at TEXT,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, idx);

    CREATE TABLE IF NOT EXISTS lesson_reviews (
      id           TEXT PRIMARY KEY,
      lesson_id    TEXT NOT NULL,
      quiz_json    TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      score        REAL NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lesson_reviews_lesson
      ON lesson_reviews(lesson_id, created_at DESC);
  `);
}

/**
 * Machine connectivity (electron/machines/). One row per saved machine
 * connection — a 3D printer or CNC plus the protocol + config Henry needs to
 * reach it (Bambu LAN / Moonraker / OctoPrint / Marlin serial / GRBL serial).
 * Config lives as JSON (host, port, serial number, access code, API key,
 * device path, baud). Idempotent.
 */
function migrateMachineConnectionsSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS machine_connections (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'printer' CHECK(kind IN ('printer','cnc')),
      protocol    TEXT NOT NULL
        CHECK(protocol IN ('bambu','moonraker','octoprint','marlin-serial','grbl-serial')),
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Slicer profiles (slicer plan, P2). A profile is a named bundle of CuraEngine
 * settings (key→value) plus an optional printer-definition override and a
 * material label. Idempotent.
 */
function migrateSlicerProfilesSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slicer_profiles (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      material      TEXT,
      printer_def   TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Seed three sensible quality presets once (only if the table is empty). */
function seedSlicerProfiles(db: Database.Database) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM slicer_profiles').get() as { n: number };
  if (row.n > 0) return;
  const presets = [
    { name: 'Draft — fast (0.28mm, 15%)', settings: { layer_height: '0.28', infill_sparse_density: '15' } },
    { name: 'Standard (0.2mm, 20%)', settings: { layer_height: '0.2', infill_sparse_density: '20' } },
    { name: 'Strong (0.2mm, 40%)', settings: { layer_height: '0.2', infill_sparse_density: '40', wall_line_count: '4' } },
  ];
  const insert = db.prepare(
    `INSERT INTO slicer_profiles (id, name, settings_json) VALUES (?, ?, ?)`,
  );
  const seed = db.transaction(() => {
    for (const p of presets) {
      insert.run(`slp_${Math.random().toString(36).slice(2, 10)}`, p.name, JSON.stringify(p.settings));
    }
  });
  try { seed(); } catch { /* ignore */ }
}

/**
 * Book Engine (build plan, Phase 3). Captured material for Topher's life story —
 * stories, lessons, letters, faith reflections, the MS journey, fatherhood,
 * rebuilding, money lessons. The Book Crew mines these into chapters. No seed —
 * this is Topher's own words. Idempotent.
 */
function migrateBookSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_entries (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL DEFAULT 'story'
        CHECK(kind IN ('story','lesson','letter','faith','health','fatherhood','business','money','other')),
      title      TEXT,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_book_entries_kind ON book_entries (kind);
  `);
}

/**
 * Project Vault (build plan, Phase 1.1). Adds rich fields to the existing
 * `projects` table so each project carries the context Henry needs to be a real
 * command center: where the code lives, the live domain, the next action, the
 * money angle, and freeform notes. Idempotent — only adds columns that are
 * missing, so it is safe to run on every launch.
 */
function migrateProjectVaultSchema(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  const add = (col: string, type: string) => {
    if (!has(col)) {
      try { db.exec(`ALTER TABLE projects ADD COLUMN ${col} ${type}`); } catch { /* ignore odd DB states */ }
    }
  };
  add('description', 'TEXT'); // human description (distinct from the AI `summary`)
  add('repo_url', 'TEXT');
  add('domain', 'TEXT');
  add('next_action', 'TEXT');
  add('money_angle', 'TEXT');
  add('notes', 'TEXT');
  add('last_worked_at', 'TEXT');
}

/**
 * Seed Topher's real projects once. Idempotent by name: a project is only
 * inserted if no project with that name already exists, so user edits and
 * deletions are never clobbered on a later launch.
 */
function seedProjectVault(db: Database.Database) {
  const SEED: Array<{ name: string; type: string; description: string; money_angle?: string; next_action?: string }> = [
    { name: 'MixedMakerShop', type: 'business', description: 'Maker shop + web-design services. Henry\'s money engine for local website leads.', money_angle: 'Local website builds + audits + retainers', next_action: 'Find and audit 5 local leads' },
    { name: 'Henry AI', type: 'software', description: 'Topher\'s personal AI operating system / command center.', money_angle: 'Paid product / personal leverage', next_action: 'Phase 1: Project Vault + Approval Queue' },
    { name: 'What Do I Say?', type: 'product', description: 'Conversation / communication helper app.', money_angle: 'App revenue' },
    { name: 'StrainSpotter', type: 'product', description: 'Strain identification / tracking product.', money_angle: 'App or affiliate revenue' },
    { name: 'GiGi\'s Print Shop', type: 'business', description: '3D-print shop project.', money_angle: 'Print sales + custom jobs' },
    { name: 'Tap Hub / iTap Ring', type: 'product', description: 'NFC tap hub + ring product and dashboard.', money_angle: 'Hardware + dashboard subscription' },
    { name: 'FreshCut Property Care', type: 'business', description: 'Property care / lawn service business.', money_angle: 'Local service revenue' },
    { name: 'Topher\'s Web Design', type: 'business', description: 'Web design service brand.', money_angle: 'Client website builds' },
    { name: 'Book / Life Story', type: 'writing', description: 'Memoir / life story — MS journey, fatherhood, rebuilding, faith.', money_angle: 'Book sales / legacy' },
    { name: 'Facebook Lead System', type: 'system', description: 'Facebook-based lead generation + tracking system.', money_angle: 'Lead pipeline for the service businesses' },
  ];

  const exists = db.prepare('SELECT 1 FROM projects WHERE name = ? LIMIT 1');
  const insert = db.prepare(
    `INSERT INTO projects (id, name, type, status, description, summary, money_angle, next_action, last_worked_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, datetime('now'))`,
  );
  const seed = db.transaction(() => {
    for (const p of SEED) {
      if (exists.get(p.name)) continue;
      const id = `proj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      insert.run(id, p.name, p.type, p.description, p.description, p.money_angle ?? null, p.next_action ?? null);
    }
  });
  try { seed(); } catch { /* ignore seed errors on unusual DB states */ }
}

/**
 * Approval Queue (build plan, Phase 2). Durable record of every confirm-tier
 * action Henry requests and how it was decided. Written by the tool runner via
 * electron/ipc/approvals.ts. Idempotent — safe to run on every launch.
 */
function migrateApprovalsSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      description TEXT,
      args_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','needs_review','expired','completed')),
      decided_args_json TEXT,
      session_id TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
  `);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at)`);
  } catch { /* ignore on unusual DB states */ }
}

/**
 * Idempotent migration for the QuickBooks Online invoice cache (design §4.4,
 * Sprint 4). `qb_sync_invoices` pulls recent invoices from the QBO REST API and
 * upserts them here keyed by `qbId`; `qb_get_balance` reads this table locally
 * (no API call) to total outstanding and overdue receivables. Column names are
 * camelCase to match the tool's row shape directly.
 */
function migrateInvoicesSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id         TEXT PRIMARY KEY,
      qbId       TEXT UNIQUE,
      clientName TEXT,
      amount     REAL NOT NULL DEFAULT 0,
      amountPaid REAL NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'open',
      dueDate    TEXT,
      issueDate  TEXT,
      syncedAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
    CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices (dueDate);
  `);
}

/**
 * Idempotent migration for the agent scheduler (design §3). One row per
 * scheduled Routine; `HenryScheduler` (electron/agent/scheduler.ts) loads the
 * enabled ones at startup and registers them with node-cron. Column names are
 * camelCase to match the scheduler's `ScheduledTask` shape directly.
 */
function migrateSchedulerSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      cronExpression TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      lastRunAt      TEXT,
      nextRunAt      TEXT,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled
      ON scheduled_tasks (enabled);
  `);

  // Run history for Routines. Before this, a Routine only remembered
  // lastRunAt, so there was no record of what it did, whether it failed, or
  // which results the user had not looked at yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      task_name   TEXT NOT NULL,
      prompt      TEXT,
      status      TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','aborted')),
      trigger     TEXT NOT NULL DEFAULT 'schedule',
      result      TEXT,
      error       TEXT,
      session_id  TEXT,
      read_at     TEXT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_task
      ON automation_runs (task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_unread
      ON automation_runs (read_at, started_at DESC);
  `);
}

/**
 * Idempotent migration for the full Henry Memory Blueprint schema.
 * Adds all Layer 3–7 tables without touching existing tables.
 */
/**
 * Additive column repair for session_memory.
 *
 * `emotional_pattern` was only ever declared in CREATE TABLE IF NOT EXISTS, so
 * any database created before that column existed never got it — and the
 * session-memory queries then failed with "no such column". This walks the
 * table and adds anything missing.
 */
function addMissingSessionMemoryColumns(db: Database.Database): void {
  const expected = [
    'emotional_pattern', 'active_files_json', 'unresolved_items_json',
    'project_id', 'updated_at', 'related_facts_json',
  ];
  try {
    const cols = db.prepare(`PRAGMA table_info(session_memory)`).all() as { name: string }[];
    if (cols.length === 0) return; // table not created yet
    const have = new Set(cols.map((c) => c.name));
    for (const name of expected) {
      if (have.has(name)) continue;
      db.exec(`ALTER TABLE session_memory ADD COLUMN ${name} TEXT`);
    }
  } catch (e) {
    // A concurrent migration may have won the race; that is fine.
  }
}

function migrateMemoryBlueprintSchema(db: Database.Database) {
  db.exec(`
    -- ── Layer 4: Personal Memory ─────────────────────────────────────
    -- Enhanced facts with full scoring. Replaces memory_facts for new saves.
    CREATE TABLE IF NOT EXISTS personal_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      memory_key TEXT NOT NULL,
      memory_value TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'general',
      summary TEXT,
      source TEXT,
      confidence_score REAL DEFAULT 0.7,
      relevance_score REAL DEFAULT 0.5,
      emotional_significance_score REAL DEFAULT 0.3,
      strategic_significance_score REAL DEFAULT 0.5,
      recency_score REAL DEFAULT 1.0,
      active_status INTEGER NOT NULL DEFAULT 1,
      tags_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_recalled_at TEXT
    );

    -- ── Layer 5: Projects ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'completed', 'archived')),
      summary TEXT,
      strategic_importance_score REAL DEFAULT 0.5,
      emotional_importance_score REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      memory_value TEXT NOT NULL,
      summary TEXT,
      blocker_flag INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      confidence_score REAL DEFAULT 0.8,
      relevance_score REAL DEFAULT 0.7,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_recalled_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- ── Layer 2: Session Memory ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS session_memory (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      summary TEXT,
      active_goals_json TEXT DEFAULT '[]',
      active_tasks_json TEXT DEFAULT '[]',
      active_files_json TEXT DEFAULT '[]',
      emotional_pattern TEXT,
      unresolved_items_json TEXT DEFAULT '[]',
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- ── Layer 3: Working Memory (DB-backed, one row per user) ────────
    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE DEFAULT 'default',
      active_context_summary TEXT,
      active_project_ids_json TEXT DEFAULT '[]',
      active_goal_ids_json TEXT DEFAULT '[]',
      pending_commitments_json TEXT DEFAULT '[]',
      relevant_file_ids_json TEXT DEFAULT '[]',
      relevant_memory_ids_json TEXT DEFAULT '[]',
      refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Goals ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'completed', 'abandoned')),
      priority_score REAL DEFAULT 0.5,
      emotional_significance_score REAL DEFAULT 0.5,
      strategic_significance_score REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Commitments (Henry's explicit promises) ──────────────────────
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      source_conversation_id TEXT,
      project_id TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'in_progress', 'completed', 'dropped')),
      due_date TEXT,
      importance_score REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- ── Milestones ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      project_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      milestone_type TEXT NOT NULL DEFAULT 'win'
        CHECK(milestone_type IN ('win','setback','launch','decision','realization','breakthrough','other')),
      significance_score REAL DEFAULT 0.7,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- ── Layer 6: Relationship Memory ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS relationship_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      pattern_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      support_preference TEXT,
      context_trigger TEXT,
      confidence_score REAL DEFAULT 0.5,
      relevance_score REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_recalled_at TEXT
    );

    -- ── Layer 7: Narrative Memory (life/work arcs) ───────────────────
    CREATE TABLE IF NOT EXISTS narrative_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      arc_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      importance_score REAL DEFAULT 0.7,
      active_status INTEGER NOT NULL DEFAULT 1,
      linked_project_ids_json TEXT DEFAULT '[]',
      linked_memory_ids_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Memory Summaries (daily/weekly/monthly/where-left-off) ───────
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      summary_type TEXT NOT NULL
        CHECK(summary_type IN (
          'daily_rollup','weekly_rollup','monthly_rollup',
          'project_rollup','where_we_left_off','life_timeline_rollup','session_end'
        )),
      period_label TEXT,
      summary TEXT NOT NULL,
      linked_memory_ids_json TEXT DEFAULT '[]',
      linked_project_ids_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Memory Graph Edges (relationship graph) ───────────────────────
    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      id TEXT PRIMARY KEY,
      from_entity_type TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      to_entity_type TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      weight_score REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Indexes for retrieval performance ─────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_personal_memory_type
      ON personal_memory(memory_type, active_status);
    CREATE INDEX IF NOT EXISTS idx_personal_memory_user
      ON personal_memory(user_id, active_status);
    CREATE INDEX IF NOT EXISTS idx_project_memory_project
      ON project_memory(project_id);
    CREATE INDEX IF NOT EXISTS idx_session_memory_conv
      ON session_memory(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_commitments_status
      ON commitments(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_narrative_memory_active
      ON narrative_memory(user_id, active_status);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_from
      ON memory_graph_edges(from_entity_type, from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_to
      ON memory_graph_edges(to_entity_type, to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_type
      ON memory_summaries(user_id, summary_type, created_at);
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}
