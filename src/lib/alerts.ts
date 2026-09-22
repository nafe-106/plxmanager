import { db } from "./db";
import { getSetting } from "./settings";
import { nowSql } from "./db";

export interface AlertPayload {
  kind: "session_dead" | "session_switched" | "key_dead" | "plexus_down";
  title: string;
  lines: string[];
}

export function messageFrom(payload: AlertPayload): string {
  return `🚨 Target API Manager — ${payload.title}\n\n${payload.lines.join("\n")}`;
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const enabled = getSetting("alert_enabled") !== "0";
  const message = messageFrom(payload);

  if (enabled) {
    const bot = getSetting("telegram_bot_token");
    const chat = getSetting("telegram_chat_id");
    if (bot && chat) {
      try {
        await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: message }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        // never let an alert failure crash anything
      }
    }
  }

  const webhook = getSetting("alert_webhook_url");
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: payload.kind,
          title: payload.title,
          message,
          time: nowSql(),
          lines: payload.lines,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // ignore
    }
  }
}

// In-app alert banner: any dead items or failed tunnels get surfaced on the UI.
export function activeAlerts(): { level: "red" | "amber"; message: string }[] {
  const out: { level: "red" | "amber"; message: string }[] = [];

  const deadKeys = db
    .prepare(`SELECT account_name, provider, last_error FROM api_keys WHERE disabled = 0 AND status = 'dead' AND last_checked_at IS NOT NULL`)
    .all() as { account_name: string; provider: string; last_error: string }[];

  const alertKeyDead = getSetting("alert_on_key_dead") !== "0";
  if (alertKeyDead) {
    for (const k of deadKeys.slice(0, 5)) {
      out.push({
        level: "red",
        message: `API key dead — ${k.account_name} (${k.provider}${k.last_error ? ": " + k.last_error : ""})`,
      });
    }
  }

  const deadSessions = db
    .prepare(`SELECT s.id, s.label, s.slug, s.type, a.label AS account FROM kaggle_sessions s LEFT JOIN kaggle_accounts a ON a.id = s.account_id WHERE s.paused = 0 AND s.dead = 1`)
    .all() as { id: number; label: string; slug: string; type: string; account: string }[];

  for (const s of deadSessions.slice(0, 5)) {
    out.push({
      level: "red",
      message: `Kaggle session dead — ${s.label || s.slug}${s.type === "plexus" ? " (Plexus server)" : ""}${s.account ? " on " + s.account : ""}`,
    });
  }

  const plexusDown = db
    .prepare(`SELECT label, slug, plexus_error FROM kaggle_sessions WHERE type = 'plexus' AND paused = 0 AND plexus_status = 'dead'`)
    .all() as { label: string; slug: string; plexus_error: string }[];
  for (const p of plexusDown.slice(0, 3)) {
    out.push({
      level: "red",
      message: `Plexus endpoint unreachable — ${p.label || p.slug}${p.plexus_error ? ": " + p.plexus_error : ""}`,
    });
  }

  return out.slice(0, 12);
}