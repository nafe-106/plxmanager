# Target API Manager

Single-user dashboard to manage API keys and watch/restart Kaggle GPU sessions. Built with Next.js (App Router), TypeScript, Tailwind CSS, SQLite (`better-sqlite3`) and `node-cron`.

## Features

- **API key manager** — store keys encrypted (AES-256-GCM), health-check them against real providers (OpenRouter, Cerebras, Groq, xAI, OpenAI, Gemini, custom), track token usage/hour and per-key limits, mark dead/rate-limited keys, nightly usage reset.
- **Usage logging** — your Python scripts report usage via `POST /api/usage/log` (bearer-protected) to fill per-hour charts and busy-hour detection.
- **Kaggle watcher** — polls kernel status for every session, auto-detects dead sessions, tracks GPU hours against weekly quota, and can **auto-switch** the shared kernel from a dying account to the account with the most GPU time left.
- **Plexus integration** — reads the current Cloudflare tunnel URL from a Supabase table (`plexus_endpoint`, row id=1) and monitors `{url}/api/tags`; restarts the session when the tunnel goes dark.
- **Alerts** — Telegram and/or generic webhook notifications when a key dies or a session goes down.
- Password-protected, dark-mode, mobile-friendly.

## Requirements

- Windows or Linux, Node.js 20+ (npm).
- `better-sqlite3` needs a native binding — on npm 11+ approve it first:

   ```bash
   npm install
   npm approve-scripts better-sqlite3 esbuild
   ```

## Setup

1. Copy the env file and edit values:

   ```bash
   copy .env.example .env
   ```

2. Optionally seed demo data (3 fake keys, 2 Kaggle accounts, 2 sessions):

   ```bash
   npm run seed
   ```

3. Run it:

   ```bash
   npm run dev        # http://localhost:3000
   # or production:
   npm run build && npm run start
   ```

4. Log in with the password from `ADMIN_PASSWORD` in `.env` (default `target-admin`). Change it anytime in **Settings**.

## Environment variables (`.env`)

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Login password (also editable from Settings). |
| `ENCRYPTION_KEY` | 64-hex key for encrypting stored API keys. Leave empty to auto-generate + persist in the DB (DB only decryptable on this machine). |
| `USAGE_LOG_BEARER` | Bearer token scripts must send to `POST /api/usage/log`. |
| `DB_PATH` | SQLite file location (default `./data/tam.sqlite`). |
| `TIMEZONE`, `CHECK_INTERVAL_MINUTES`, `KAGGLE_POLL_MINUTES` | Scheduling. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL`, `ALERT_ON_KEY_DEAD` | Alerts. |
| `KAGGLE_API_BASE` | Custom Kaggle API base (normally empty). |
| `PLEXUS_SUPABASE_URL`, `PLEXUS_SUPABASE_KEY`, `PLEXUS_TOKEN` | Supabase project URL, anon/service key, and the bearer token your Ollama gateway expects. Also configurable from Settings → no .env needed. |

> Your Supabase project needs a table `plexus_endpoint` with a row `id=1` and a `public_url` column that the Gligen notebook updates to the current tunnel URL:
> ```sql
> create table public.plexus_endpoint (
>   id bigint primary key,
>   public_url text not null
> );
> insert into public.plexus_endpoint (id, public_url) values (1, 'https://your-tunnel.trycloudflare.com');
> ```

## Reporting usage from your scripts

**curl**

```bash
curl -X POST http://localhost:3000/api/usage/log \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tam-cf5b87ee02fc237b09e1756a892f63c84227c5eb05ccbb21" \
  -d '{"keyId":1,"tokens":1234,"success":true}'
```

**Python**

```python
import requests

BASE = "http://localhost:3000"
TOKEN = "tam-cf5b87ee02fc237b09e1756a892f63c84227c5eb05ccbb21"  # your USAGE_LOG_BEARER

def log_usage(key_id: int, tokens: int, success: bool = True, cost_usd: float | None = None,
              endpoint: str | None = None):
    body = {"keyId": key_id, "tokens": tokens, "success": success}
    if cost_usd is not None:
        body["costUsd"] = cost_usd
    if endpoint is not None:
        body["endpoint"] = endpoint
    r = requests.post(f"{BASE}/api/usage/log", json=body,
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10)
    r.raise_for_status()
    return r.json()

# in your client right after each LLM call:
log_usage(key_id=1, tokens=150, cost_usd=0.0015, endpoint="/v1/chat")
```

Find the numeric `keyId` from the API Keys page, or:

```bash
curl -s http://localhost:3000/api/keys
```

## Main API endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | — | password → session cookie |
| GET | `/api/overview` | session | totals, alerts, per-key usage |
| GET/POST | `/api/keys` | session | list / create keys |
| GET/PATCH/DELETE | `/api/keys/[id]` | session | key detail / edit / delete |
| POST | `/api/keys/[id]/check` | session | immediate health check |
| POST | `/api/keys/[id]/usage` | session | record usage (key-scoped) |
| POST | `/api/usage/log` | **bearer** | record usage from scripts |
| GET | `/api/ai/ollama?token=<PLEXUS_TOKEN>` | token | automation: returns all keys + models (full apiKey included) |
| POST | `/api/ai/ollama` | token in body/query/bearer | automation: add a key (same JSON as `POST /api/keys`, plus optional `token`) |
| GET/POST | `/api/kaggle/accounts` | session | list / create accounts |
| GET/POST | `/api/kaggle/sessions` | session | list / create sessions |
| POST | `/api/kaggle/sessions/[id]/check` | session | force watcher check |
| POST | `/api/kaggle/sessions/[id]/restart` | session | restart session |
| POST | `/api/kaggle/sessions/[id]/switch` | session | switch shared kernel to another account |
| GET/PUT | `/api/settings` | session | read / update settings |

## Database

- `data/tam.sqlite` — auto-created on first run. `npm run seed` loads demo data.
- Only the API-key secrets are encrypted. Everything else is plaintext SQLite — don't expose the app publicly without adding HTTPS/reverse proxy protection.