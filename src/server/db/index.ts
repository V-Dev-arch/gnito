/**
 * Gnito — DB layer. SQLite via better-sqlite3 (synchronous, embedded).
 * All user data lives in a single file at DATA_DIR/gnito.db.
 *
 * Schema is versioned. `migrations` table tracks applied versions.
 * We never break existing data — only additive migrations.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureDataDir } from '../config.js';

export type Db = Database.Database;

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;
  ensureDataDir();
  db = new Database(CONFIG.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  migrate(db);
  return db;
}

// ------------------------------------------------------------- migrations

interface Migration { version: number; name: string; sql: string; }

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        custom_headers TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
        content TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        usage TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_grants (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        label TEXT NOT NULL,
        permissions TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL DEFAULT 'pending-approval',
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        context TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_runs_context ON tool_runs(context);

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        task_instruction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        missed_run_policy TEXT NOT NULL DEFAULT 'skip',
        catch_up_window_ms INTEGER NOT NULL DEFAULT 0,
        dry_run INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL DEFAULT 10,
        max_retries INTEGER NOT NULL DEFAULT 1,
        retry_backoff_ms INTEGER NOT NULL DEFAULT 30000,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_run_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        occurrence_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        ended_at INTEGER,
        result_summary TEXT,
        tool_run_ids TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        steps_used INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_runs_occurrence
        ON automation_runs(automation_id, occurrence_key);
      CREATE INDEX IF NOT EXISTS idx_auto_runs_auto ON automation_runs(automation_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        manifest TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'installed',
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        category TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    `,
  },
];

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT version FROM _migrations').all().map((r: any) => r.version)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(m.version, m.name, Date.now());
    });
    run();
  }
}

/** Reset DB (used by tests). */
export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

export function resetDbForTests(): void {
  closeDb();
  if (fs.existsSync(CONFIG.dbPath)) fs.rmSync(CONFIG.dbPath, { force: true });
  for (const suffix of ['-wal', '-shm']) {
    const p = CONFIG.dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  getDb();
}
