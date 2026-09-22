import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbDir = path.join(process.cwd(), "data");
fs.mkdirSync(dbDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dbDir, "tam.sqlite");

declare global {
  // eslint-disable-next-line no-var
  var __tamDb: Database.Database | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'other',
  account_name TEXT NOT NULL,
  account_email TEXT DEFAULT '',
  api_key_enc TEXT NOT NULL,
  base_url TEXT DEFAULT '',
  usage_limit REAL DEFAULT 0,
  usage_period TEXT DEFAULT 'monthly',
  usage_hour INTEGER DEFAULT 9,
  provider_usage REAL,
  provider_limit REAL,
  disabled INTEGER DEFAULT 0,
  status TEXT DEFAULT 'unknown',
  status_detail TEXT DEFAULT '',
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS key_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  token_limit REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'daily',
  usage_hour INTEGER NOT NULL DEFAULT 0,
  rpm REAL NOT NULL DEFAULT 0,
  rpd REAL NOT NULL DEFAULT 0,
  tpm REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(key_id, model)
);

CREATE TABLE IF NOT EXISTS key_usage_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  hits INTEGER DEFAULT 0,
  tokens REAL DEFAULT 0,
  UNIQUE(key_id, model, day, hour)
);

CREATE TABLE IF NOT EXISTS key_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  response_ms INTEGER,
  ratelimit TEXT,
  provider_usage TEXT,
  check_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kaggle_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  weekly_gpu_quota_h REAL DEFAULT 30,
  week_reset_day INTEGER DEFAULT 0,
  remaining_override_h REAL,
  override_set_at TEXT,
  disabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kaggle_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  label TEXT DEFAULT '',
  type TEXT DEFAULT 'notebook',
  status TEXT DEFAULT 'unknown',
  status_detail TEXT DEFAULT '',
  status_changed_at TEXT,
  running_since TEXT,
  last_checked_at TEXT,
  dead INTEGER DEFAULT 0,
  dead_at TEXT,
  paused INTEGER DEFAULT 0,
  auto_switch INTEGER DEFAULT 1,
  plexus_url TEXT DEFAULT '',
  plexus_status TEXT DEFAULT 'unknown',
  plexus_error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kaggle_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  account_id INTEGER,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gpu_usage_weekly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  seconds_run REAL DEFAULT 0,
  UNIQUE(account_id, week_start)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS general_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT DEFAULT '',
  key_hash TEXT NOT NULL,
  secret_enc TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS general_key_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gk_id INTEGER NOT NULL,
  key_id INTEGER,
  hits INTEGER DEFAULT 1,
  tokens INTEGER DEFAULT 0,
  day TEXT NOT NULL DEFAULT '',
  hour INTEGER NOT NULL DEFAULT 0,
  at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_key_day ON key_usage_hourly(key_id, day);
CREATE INDEX IF NOT EXISTS idx_models_key ON key_models(key_id);
CREATE INDEX IF NOT EXISTS idx_checks_key ON key_checks(key_id, check_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON kaggle_session_events(session_id, at);
CREATE INDEX IF NOT EXISTS idx_gpu_account ON gpu_usage_weekly(account_id, week_start);
CREATE INDEX IF NOT EXISTS idx_gk_logs ON general_key_logs(gk_id, at);
CREATE INDEX IF NOT EXISTS idx_gk_logs_day ON general_key_logs(gk_id, day);
`;

function migrate(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(key_usage_hourly)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "model")) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE key_usage_hourly RENAME TO key_usage_hourly_old;
        CREATE TABLE key_usage_hourly (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id INTEGER NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          day TEXT NOT NULL,
          hour INTEGER NOT NULL,
          hits INTEGER DEFAULT 0,
          tokens REAL DEFAULT 0,
          UNIQUE(key_id, model, day, hour)
        );
        INSERT INTO key_usage_hourly(key_id, model, day, hour, hits, tokens)
          SELECT key_id, '', day, hour, hits, tokens FROM key_usage_hourly_old;
        DROP TABLE key_usage_hourly_old;
      `);
    })();
  }
  // Safe to create now that the model column (fresh or migrated) exists.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_model ON key_usage_hourly(key_id, model, day)`);

  // key_models gained rate-limit columns — add them on existing databases.
  const modelCols = db.prepare("PRAGMA table_info(key_models)").all() as { name: string }[];
  for (const col of ["rpm", "rpd", "tpm"]) {
    if (!modelCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE key_models ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
  }

  // kaggle_accounts supports refresh tokens (KGRT_) for KGAT_ bearer access tokens.
  if (!db.prepare("PRAGMA table_info(kaggle_accounts)").all().some((c: any) => c.name === "refresh_token_enc")) {
    db.exec(`ALTER TABLE kaggle_accounts ADD COLUMN refresh_token_enc TEXT`);
  }

  // Real accelerator quota snapshot from POST /api/v1/kernels/quota.
  // Re-read columns right before each add and ignore "duplicate column" so a
  // concurrent importer/worker can never fail the migration.
  const addColumn = (col: string, ddl: string): void => {
    if (db.prepare("PRAGMA table_info(kaggle_accounts)").all().some((c: any) => c.name === col)) return;
    try {
      db.exec(ddl);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  };
  // general_key_logs gained tz-local day/hour buckets for "today" stats.
  const gkLogCols = db.prepare("PRAGMA table_info(general_key_logs)").all() as { name: string }[];
  if (gkLogCols.length) {
    if (!gkLogCols.some((c) => c.name === "day")) {
      db.exec("ALTER TABLE general_key_logs ADD COLUMN day TEXT NOT NULL DEFAULT ''");
    }
    if (!gkLogCols.some((c) => c.name === "hour")) {
      db.exec("ALTER TABLE general_key_logs ADD COLUMN hour INTEGER NOT NULL DEFAULT 0");
    }
  }

  addColumn("quota_used_h", "ALTER TABLE kaggle_accounts ADD COLUMN quota_used_h REAL NOT NULL DEFAULT 0");
  addColumn("quota_reserved_h", "ALTER TABLE kaggle_accounts ADD COLUMN quota_reserved_h REAL NOT NULL DEFAULT 0");
  addColumn("quota_total_h", "ALTER TABLE kaggle_accounts ADD COLUMN quota_total_h REAL");
  addColumn("quota_refresh_at", "ALTER TABLE kaggle_accounts ADD COLUMN quota_refresh_at TEXT");
  addColumn("quota_source", "ALTER TABLE kaggle_accounts ADD COLUMN quota_source TEXT");

  // general_keys gained secret_enc so the tam_gk_ secret stays revealable
  // (encrypted at rest, same v1: scheme as provider api_key_enc).
  if (!db.prepare("PRAGMA table_info(general_keys)").all().some((c: any) => c.name === "secret_enc")) {
    try {
      db.exec("ALTER TABLE general_keys ADD COLUMN secret_enc TEXT");
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  }
}

function createDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const db: Database.Database =
  globalThis.__tamDb ?? (globalThis.__tamDb = createDb());

export function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function touch(table: string, id: number): void {
  db.prepare(
    `UPDATE ${table} SET updated_at = ? WHERE id = ?`
  ).run(nowSql(), id);
}