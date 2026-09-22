/**
 * One-off migration: data/tam.sqlite (better-sqlite3) -> Supabase.
 *
 * Reads every table from the old local DB, decrypts encrypted columns with the
 * OLD key (DB-stored "encryption_key" setting, falling back to the current
 * ENCRYPTION_KEY), re-encrypts with the CURRENT ENCRYPTION_KEY, and upserts
 * into Supabase preserving integer ids so FK relations stay intact.
 *
 * Requires: npm i -D better-sqlite3  (dev-only; the app no longer uses it)
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-supabase.cjs            # real migration
 *   node scripts/migrate-sqlite-to-supabase.cjs --dry-run  # print counts only
 *
 * Exit codes: 0 success/migrated, 1 unrecoverable, 2 dry-run.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const DB_FILE = path.join(ROOT, "data", "tam.sqlite");
const DRY_RUN = process.argv.includes("--dry-run");

// ---- minimal dotenv loader (.env.local wins) ------------------------------
function loadEnv() {
  const out = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && !(k in out)) out[k] = v;
    }
  }
  return out;
}

const env = loadEnv();
const ENCRYPTION_KEY = env.ENCRYPTION_KEY || "";
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.PLEXUS_SUPABASE_URL || "";
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!ENCRYPTION_KEY) {
  console.error("[migrate] ENCRYPTION_KEY is missing from .env — aborting.");
  process.exit(1);
}
if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error("[migrate] Supabase URL / key missing from .env — aborting.");
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.error(`[migrate] ${DB_FILE} not found — nothing to migrate.`);
  process.exit(0);
}

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("[migrate] better-sqlite3 not installed. Run: npm i -D better-sqlite3");
  process.exit(1);
}

// ---- crypto (old format is identical to current, only the key differs) ----
function keyBuffer(hex) {
  return crypto.createHash("sha256").update(hex).digest();
}
function decryptWith(payload, hex) {
  if (!payload) return "";
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  const [, iv, tag, data] = parts;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", keyBuffer(hex), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}
function encryptWith(plain, hex) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBuffer(hex), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

// ---- read old sqlite ------------------------------------------------------
const db = new Database(DB_FILE, { readonly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const oldStoredKey = db
  .prepare("SELECT value FROM settings WHERE key = 'encryption_key'")
  .get().value ?? null;

const decryptCandidates = [oldStoredKey, ENCRYPTION_KEY].filter(Boolean);
console.log(`[migrate] encrypted columns will try old keys: [${decryptCandidates.map((k) => k.slice(0, 6) + "…").join(", ")}]`);

function decryptBest(payload) {
  for (const hex of decryptCandidates) {
    const plain = decryptWith(payload, hex);
    if (plain) return plain;
  }
  return "";
}

// Encrypted columns that must be re-encrypted with the new key.
const ENCRYPTED_COLS = {
  api_keys: ["api_key_enc"],
  kaggle_accounts: ["api_key_enc", "refresh_token_enc"],
  general_keys: ["secret_enc"],
};

// Table -> id column for the upsert conflict target.
const ID_COL = "id";
function conflictFor(table) {
  return table === "settings" ? "key" : ID_COL;
}

async function main() {
  const { createClient } = require("@supabase/supabase-js");
  const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Preferred insertion order (FK dependencies first).
  const order = [
    "settings",
    "api_keys",
    "key_models",
    "key_usage_hourly",
    "key_checks",
    "kaggle_accounts",
    "kaggle_sessions",
    "kaggle_session_events",
    "gpu_usage_weekly",
    "general_keys",
    "general_key_logs",
  ];

  let migrated = 0;
  let reencrypted = 0;
  let failedDecrypt = 0;

  for (const table of order) {
    if (!tables.includes(table)) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const names = cols.map((c) => c.name);
    const rows = db.prepare(`SELECT * FROM ${table}`).all();

    for (const row of rows) {
      for (const col of ENCRYPTED_COLS[table] ?? []) {
        const val = row[col];
        if (!val) continue;
        const plain = decryptBest(val);
        if (!plain) {
          console.warn(`[migrate] !! ${table}.${col} row id=${row.id} could not be decrypted with any known key — copied as-is.`);
          failedDecrypt++;
          continue;
        }
        row[col] = encryptWith(plain, ENCRYPTION_KEY);
        reencrypted++;
      }
      // settings row "encryption_key" is obsolete in Supabase — re-encrypt is N/A; drop it.
      if (table === "settings" && row.key === "encryption_key") continue;
    }

    if (DRY_RUN || !rows.length) {
      console.log(`[migrate] ${table.padEnd(20)} ${rows.length} row(s)`);
      migrated += rows.length;
      continue;
    }

    // Explicit ids are allowed: identity columns are "by default".
    const { error } = await supabase.from(table).upsert(rows, { onConflict: conflictFor(table) });
    if (error) {
      // Fall back: insert one by one, skipping duplicates, to stay idempotent.
      let ok = 0;
      for (const row of rows) {
        const { error: e } = await supabase.from(table).upsert([row], { onConflict: conflictFor(table) });
        if (e) {
          const msg = String(e.message || "");
          if (/duplicate/i.test(msg)) {
            console.warn(`[migrate] ${table} row ${row.id} skipped (duplicate)`);
          } else {
            console.error(`[migrate] ${table} row ${row.id}: ${msg}`);
            process.exitCode = 1;
          }
        } else {
          ok++;
        }
      }
      console.log(`[migrate] ${table.padEnd(20)} ${ok}/${rows.length} row(s) (bulk failed: ${error.message})`);
      migrated += ok;
    } else {
      console.log(`[migrate] ${table.padEnd(20)} ${rows.length} row(s)`);
      migrated += rows.length;
    }
  }

  console.log("");
  console.log(`[migrate] total rows: ${migrated}, re-encrypted fields: ${reencrypted}, decrypt failures: ${failedDecrypt}`);
  if (failedDecrypt > 0) {
    console.log("[migrate] WARNING: some encrypted values were copied verbatim and will NOT decrypt in the app.");
  }
  if (DRY_RUN) {
    console.log("[migrate] dry-run only — nothing was written to Supabase. Remove --dry-run to migrate.");
    process.exit(2);
  }
  console.log("[migrate] done.");
}

main().catch((err) => {
  console.error("[migrate] fatal:", err);
  process.exit(1);
});