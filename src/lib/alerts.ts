import { rows, nowSql } from "./store";
import { getSetting } from "./settings";

export interface AlertPayload {
  kind: "session_dead" | "session_switched" | "key_dead" | "plexus_down";
  title: string;
  lines: string[];
}

export function messageFrom(payload: AlertPayload): string {
  return `🚨 Target API Manager — ${payload.title}\n\n${payload.lines.join("\n")}`;
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  try {
    const [enabled, bot, chat, webhook] = await Promise.all([
      getSetting("alert_enabled"),
      getSetting("telegram_bot_token"),
      getSetting("telegram_chat_id"),
      getSetting("alert_webhook_url"),
    ]);
    const message = messageFrom(payload);

    if (enabled !== "0" && bot && chat) {
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
  } catch {
    // settings read failed (e.g. tables not migrated yet) — never crash a watcher
  }
}

// In-app alert banner: any dead items or failed tunnels get surfaced on the UI.
export async function activeAlerts(): Promise<{ level: "red" | "amber"; message: string }[]> {
  const out: { level: "red" | "amber"; message: string }[] = [];

  const deadKeys = await rows<{ account_name: string; provider: string; last_error: string; last_checked_at: string | null }>(
    "api_keys",
    { disabled: 0, status: "dead" },
    { order: "id", limit: 100 }
  );

  const alertKeyDead = (await getSetting("alert_on_key_dead")) !== "0";
  if (alertKeyDead) {
    for (const k of deadKeys.filter((k) => k.last_checked_at)) {
      out.push({
        level: "red",
        message: `API key dead — ${k.account_name} (${k.provider}${k.last_error ? ": " + k.last_error : ""})`,
      });
    }
  }

  const deadSessions = await rows<{ id: number; label: string; slug: string; type: string; account_id: number | null }>(
    "kaggle_sessions",
    { paused: 0, dead: 1 },
    { order: "id", limit: 100 }
  );
  for (const s of deadSessions.slice(0, 5)) {
    out.push({
      level: "red",
      message: `Kaggle session dead — ${s.label || s.slug}${s.type === "plexus" ? " (Plexus server)" : ""}${s.account_id ? ` (account #${s.account_id})` : ""}`,
    });
  }

  const plexusDown = await rows<{ label: string; slug: string; plexus_error: string }>(
    "kaggle_sessions",
    { type: "plexus", paused: 0, plexus_status: "dead" },
    { order: "id", limit: 100 }
  );
  for (const p of plexusDown.slice(0, 3)) {
    out.push({
      level: "red",
      message: `Plexus endpoint unreachable — ${p.label || p.slug}${p.plexus_error ? ": " + p.plexus_error : ""}`,
    });
  }

  return out.slice(0, 12);
}