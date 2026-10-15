-- ===========================================================================
-- Reliable background trigger for the Kaggle watcher / auto-switcher / alerts.
--
-- Why this exists:
--   * On Vercel (serverless) the in-process node-cron scheduler never stays
--     alive, so it does not fire on its own.
--   * GitHub Actions `*/5` schedules get throttled down to every few hours.
--   => Until now the watcher only really ran when somebody opened the site, so
--      status-change / switch / dead-session Telegram alerts were silent.
--
-- This schedules a pg_cron job INSIDE Supabase that pings the app's cron
-- endpoint every minute, so the watcher + alerts fire automatically.
--
-- HOW TO USE
--   1. Supabase Dashboard -> SQL Editor -> New query.
--   2. Replace <USAGE_LOG_BEARER> below with the app's USAGE_LOG_BEARER value
--      (Vercel -> Project -> Settings -> Environment Variables). It looks like
--      `tam-<40 hex chars>`.
--   3. Run it. Re-running is safe (the old job is dropped first).
--
-- Verify it is running:
--   select * from cron.job;                       -- should show plxmanager-kaggle-watch
--   select * from cron.job_run_details
--     order by start_time desc limit 10;          -- recent runs + status
--   select * from net._http_response
--     order by created desc limit 10;             -- HTTP results from the app
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop any previous version of the job so this file is idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'plxmanager-kaggle-watch') then
    perform cron.unschedule('plxmanager-kaggle-watch');
  end if;
end
$$;

-- Tick every 2 minutes. pg_net queues the request async, so this returns instantly.
select cron.schedule(
  'plxmanager-kaggle-watch',
  '*/2 * * * *',
  $job$
  select net.http_get(
    url := 'https://plxmanager.vercel.app/api/cron/kaggle',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <USAGE_LOG_BEARER>',
      'x-cron-secret', '<USAGE_LOG_BEARER>'
    ),
    timeout_milliseconds := 120000
  );
  $job$
);
