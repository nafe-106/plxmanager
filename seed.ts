/* eslint-disable no-console */
// Seeding script: `npm run seed`
// Creates 3 fake API keys with a few days of usage history and
// 2 fake Kaggle sessions so the dashboard has something to show.

import { db } from "./src/lib/db";
import { encrypt, encKeyHex } from "./src/lib/crypto";
import { setSetting } from "./src/lib/settings";
import { logUsage, tzParts } from "./src/lib/usage";

function dayOffsetDays(d: Date, n: number): Date {
  const p = tzParts("Asia/Dhaka", d);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + n));
}

function insert(day: Date, hour: number, hits: number, tokens: number, model = ""): void {
  const p = tzParts("Asia/Dhaka", day);
  const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  db.prepare(
    `INSERT INTO key_usage_hourly(key_id, model, day, hour, hits, tokens) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(key_id, model, day, hour) DO UPDATE SET hits = hits + ?, tokens = tokens + ?`
  ).run(1, model, key, hour, hits, tokens, hits, tokens);
}

function seed() {
  const exists = db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number };
  if (exists.c > 0) {
    console.log("⚠️  api_keys table not empty — skipping to avoid duplicates.");
    console.log("   Run `node -e \"require('better-sqlite3')('data/tam.sqlite').exec('DELETE FROM api_keys; DELETE FROM key_usage_hourly; DELETE FROM key_checks')\"` first if you want a clean reseed.");
    return;
  }

  // Each key gets its encryption from the same ENCRYPTION_KEY / settings value.
  console.log("Encryption key source: " + (process.env.ENCRYPTION_KEY ? "env (ENCRYPTION_KEY)" : "auto-generated (stored in DB settings)"));

  const now = new Date();

  const k1 = db.prepare(
    `INSERT INTO api_keys(provider, account_name, account_email, api_key_enc, usage_limit, usage_period, usage_hour, status, last_checked_at, last_error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("openrouter", "Main OpenRouter", "main@example.com", encrypt("sk-or-fake-key-abc123xyz789"), 100000, "monthly", 14, "alive", new Date().toISOString(), "");
  const id1 = Number(k1.lastInsertRowid);

  const k2 = db.prepare(
    `INSERT INTO api_keys(provider, account_name, account_email, api_key_enc, usage_limit, usage_period, usage_hour, status, last_checked_at, last_error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("groq", "Groq Fast One", "fast@example.com", encrypt("gsk_fake_key_000111222333"), 50000, "daily", 9, "alive", new Date().toISOString(), "");
  const id2 = Number(k2.lastInsertRowid);

  const k3 = db.prepare(
    `INSERT INTO api_keys(provider, account_name, account_email, api_key_enc, usage_limit, usage_period, usage_hour, status, last_checked_at, last_error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("cerebras", "Cerebras Backup", "backup@example.com", encrypt("csk-fake-key-dead-98765"), 20000, "monthly", 18, "dead", new Date().toISOString(), "HTTP 401 unauthorized");
  const id3 = Number(k3.lastInsertRowid);

  // Usage history for key 1 (8 days back → now) to make charts lively.
  for (let back = 8; back >= 0; back--) {
    const day = dayOffsetDays(now, -back);
    const isWeekend = [0, 6].includes(tzParts("Asia/Dhaka", day).weekday);
    for (let h = 7; h <= 21; h++) {
      const base = (h >= 12 && h <= 16) || h === 20 ? 40 : 12;
      const multi = isWeekend ? 0.4 : 1;
      const hits = Math.floor((base + Math.floor(Math.random() * 25)) * multi);
      const tokens = hits * (500 + Math.floor(Math.random() * 1200));
      insert(day, h, hits, tokens);
    }
  }

  // Sparse usage for key 2 (today only, some morning).
  for (let h = 8; h <= 12; h++) {
    insert(now, h, 8 + Math.floor(Math.random() * 15), (8 + Math.floor(Math.random() * 15)) * 900);
  }

  // Key 3: history is empty (dead key).

  // Checks history rows for key 1 and key 3.
  const chk = new Date();
  for (let i = 0; i < 12; i++) {
    const at = new Date(chk.getTime() - i * 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      `INSERT INTO key_checks(key_id, status, error, response_ms, check_at) VALUES(?, ?, ?, ?, ?)`
    ).run(id1, i % 5 === 0 ? "rate_limited" : "alive", i % 5 === 0 ? "HTTP 429 rate limited" : null, 220 + Math.floor(Math.random() * 400), at);
  }
  db.prepare(
    `INSERT INTO key_checks(key_id, status, error, response_ms, check_at) VALUES(?, ?, ?, ?, ?)`
  ).run(id3, "dead", "HTTP 401 unauthorized", 150, new Date().toISOString().replace("T", " ").slice(0, 19));

  // --- Kaggle accounts + sessions --------------------------------------
  const a1 = db.prepare(
    `INSERT INTO kaggle_accounts(label, username, api_key_enc, weekly_gpu_quota_h, week_reset_day) VALUES(?, ?, ?, ?, ?)`
  ).run("acc-priya", "priya_gpu", encrypt("kaggle-fake-key-priya"), 30, 0);
  const a2 = db.prepare(
    `INSERT INTO kaggle_accounts(label, username, api_key_enc, weekly_gpu_quota_h, week_reset_day) VALUES(?, ?, ?, ?, ?)`
  ).run("acc-sami", "sami_gpu", encrypt("kaggle-fake-key-sami"), 30, 0);

  const s1 = db.prepare(
    `INSERT INTO kaggle_sessions(account_id, slug, label, type, status, running_since, status_changed_at, last_checked_at, dead, auto_switch, plexus_status, plexus_url, plexus_error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(a1.lastInsertRowid),
    "priya_gpu/plexus-ollama",
    "Plexus main server",
    "plexus",
    "running",
    new Date(Date.now() - 1000 * 60 * 47).toISOString(),
    new Date(Date.now() - 1000 * 60 * 47).toISOString(),
    new Date().toISOString(),
    0,
    1,
    "unknown",
    "",
    ""
  );

  const s2 = db.prepare(
    `INSERT INTO kaggle_sessions(account_id, slug, label, type, status, status_changed_at, last_checked_at, dead, auto_switch, plexus_status, plexus_url, plexus_error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(a2.lastInsertRowid),
    "sami_gpu/plexus-ollama",
    "Plexus backup",
    "plexus",
    "dead",
    new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    1,
    1,
    "dead",
    "",
    "HTTP 502 Bad Gateway"
  );

  const events = db.prepare(
    `INSERT INTO kaggle_session_events(session_id, account_id, from_status, to_status, note) VALUES(?, ?, ?, ?, ?)`
  );
  events.run(Number(s2.lastInsertRowid), Number(a2.lastInsertRowid), "running", "stopped", "went stopped while it was running");

  // GPU usage: ~14h used on account 1, ~4h on account 2.
  const gpu = db.prepare(
    `INSERT INTO gpu_usage_weekly(account_id, week_start, seconds_run) VALUES(?, ?, ?)`
  );
  const weekStart = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString().slice(0, 10);
  gpu.run(Number(a1.lastInsertRowid), weekStart, 14 * 3600);
  gpu.run(Number(a2.lastInsertRowid), weekStart, 4 * 3600);

  // Ensure default settings are present so the app behaves out of the box.
  setSetting("timezone", "Asia/Dhaka");
  setSetting("check_interval_minutes", "10");
  setSetting("kaggle_poll_minutes", "3");
  setSetting("usage_week_reset_day", "0");
  setSetting("alert_enabled", "1");
  setSetting("alert_on_key_dead", "1");

  console.log("✅ Seeded:");
  console.log("   API keys: 3 (1 openrouter alive + usage history, 1 groq alive, 1 cerebras dead)");
  console.log("   Kaggle accounts: 2 (priya_gpu 14h used, sami_gpu 4h used)");
  console.log("   Kaggle sessions: 2 (1 running Plexus, 1 dead Plexus backup)");
  console.log("   Encryption key (first 8 chars): " + encKeyHex().slice(0, 8) + "…");
}

seed();