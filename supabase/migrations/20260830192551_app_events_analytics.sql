create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table public.analytics_ingest_tokens (
  id uuid primary key default gen_random_uuid(),
  workstation_id uuid not null,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null default 'event_ingest'
    check (purpose = 'event_ingest'),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint analytics_ingest_tokens_expiry_order
    check (expires_at is null or expires_at > created_at),
  constraint analytics_ingest_tokens_revocation_order
    check (revoked_at is null or revoked_at >= created_at)
);

comment on table public.analytics_ingest_tokens is
  'Hashes of revocable, event-ingest-only workstation ingest tokens. Plaintext tokens are never stored in Postgres.';
comment on column public.analytics_ingest_tokens.workstation_id is
  'Random workstation UUID only. This table must never gain a club, person, device-label, or joinable customer mapping.';

create unique index analytics_ingest_tokens_one_active_per_workstation_idx
  on public.analytics_ingest_tokens (workstation_id)
  where revoked_at is null;

alter table public.analytics_ingest_tokens enable row level security;
revoke all on table public.analytics_ingest_tokens from public, anon, authenticated, service_role;
grant select on table public.analytics_ingest_tokens to service_role;

create table private.analytics_ingest_quota_windows (
  token_id uuid not null references public.analytics_ingest_tokens(id) on delete cascade,
  workstation_id uuid not null,
  window_started_at timestamptz not null,
  request_count integer not null
    check (request_count between 1 and 120),
  event_count integer not null
    check (event_count between 1 and 1000),
  primary key (token_id, workstation_id, window_started_at)
);

comment on table private.analytics_ingest_quota_windows is
  'Short-lived fixed-window counters for the event-ingest endpoint. Stores token row IDs, never plaintext tokens or network identifiers.';

alter table private.analytics_ingest_quota_windows enable row level security;
revoke all on table private.analytics_ingest_quota_windows from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select, insert, update on table private.analytics_ingest_quota_windows to service_role;

create or replace function public.authorize_and_consume_analytics_quota(
  p_token_hash text,
  p_workstation_id uuid,
  p_event_count integer
)
returns table (
  authorized boolean,
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  quota_now timestamptz := clock_timestamp();
  quota_window timestamptz := date_trunc('minute', quota_now);
  quota_token_id uuid;
  quota_reserved boolean;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_event_count not between 1 and 50 then
    raise exception 'invalid analytics quota input' using errcode = '22023';
  end if;

  select id
  into quota_token_id
  from public.analytics_ingest_tokens
  where token_hash = p_token_hash
    and workstation_id = p_workstation_id
    and purpose = 'event_ingest'
    and revoked_at is null
    and (expires_at is null or expires_at > quota_now);

  if quota_token_id is null then
    return query select false, false, 0;
    return;
  end if;

  insert into private.analytics_ingest_quota_windows (
    token_id,
    workstation_id,
    window_started_at,
    request_count,
    event_count
  ) values (
    quota_token_id,
    p_workstation_id,
    quota_window,
    1,
    p_event_count
  )
  on conflict (token_id, workstation_id, window_started_at) do update
  set
    request_count = private.analytics_ingest_quota_windows.request_count + 1,
    event_count = private.analytics_ingest_quota_windows.event_count + excluded.event_count
  where private.analytics_ingest_quota_windows.request_count < 120
    and private.analytics_ingest_quota_windows.event_count + excluded.event_count <= 1000
  returning true into quota_reserved;

  if coalesce(quota_reserved, false) then
    return query select true, true, 0;
    return;
  end if;

  return query select
    true,
    false,
    greatest(
      1,
      ceil(extract(epoch from quota_window + interval '1 minute' - quota_now))::integer
    );
end;
$$;

comment on function public.authorize_and_consume_analytics_quota(text, uuid, integer) is
  'Atomically authorizes and reserves one fixed-window request/event quota for one ingest token and workstation. Returns no token or network identifier.';
revoke all on function public.authorize_and_consume_analytics_quota(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.authorize_and_consume_analytics_quota(text, uuid, integer)
  to service_role;

create table public.app_events (
  event_id uuid primary key,
  workstation_id uuid not null,
  visit_id uuid not null,
  recording_id uuid,
  event_name text not null
    check (event_name in (
      'app_opened',
      'video_connect_result',
      'video_lost',
      'serial_connect_result',
      'serial_lost',
      'telemetry_stalled',
      'telemetry_resumed',
      'demo_returned',
      'recording_started',
      'recording_stopped',
      'session_exported',
      'session_lost',
      'page_hidden',
      'page_visible',
      'page_unloaded',
      'error_shown',
      'js_error',
      'overlay_mode_changed',
      'overlay_layout_reset'
    )),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  client_monotonic_ms double precision not null
    check (client_monotonic_ms >= 0 and client_monotonic_ms <= 31536000000),
  build text not null
    check (build ~ '^[A-Za-z0-9][A-Za-z0-9._+\-]{0,79}$'),
  hostname text not null
    check (length(hostname) between 1 and 253)
    check (hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  vercel_env text not null
    check (vercel_env = 'production'),
  session_schema_version integer not null
    check (session_schema_version between 1 and 1000),
  connection text not null
    check (connection in ('demo', 'connecting', 'live', 'stale', 'error')),
  video_state text not null
    check (video_state in ('idle', 'connecting', 'live', 'error')),
  is_recording boolean not null,
  overlay_mode text not null
    check (overlay_mode in ('trail', 'simple')),
  telemetry_source text not null
    check (telemetry_source in ('demo', 'serial')),
  props jsonb not null default '{}'::jsonb,
  constraint app_events_props_object
    check (jsonb_typeof(props) = 'object'),
  constraint app_events_props_size
    check (octet_length(props::text) <= 4096),
  constraint app_events_confirmed_session_loss
    check (
      event_name <> 'session_lost'
      or (
        jsonb_typeof(props->'reason') = 'string'
        and props->>'reason' in ('overwritten', 'unload')
      )
    )
);

comment on table public.app_events is
  'Pseudonymous product events only. Video, raw RC samples/bytes, free-form errors, stack traces, labels, port names, IP and user-agent are prohibited.';
comment on column public.app_events.workstation_id is
  'Random local UUID. No workstation-to-club mapping may be added to this database.';
comment on column public.app_events.recording_id is
  'Optional random recording UUID without a foreign key; no athlete identity is stored.';

create index app_events_name_received_idx
  on public.app_events (event_name, received_at desc);
create index app_events_workstation_received_idx
  on public.app_events (workstation_id, received_at desc);
create index app_events_recording_idx
  on public.app_events (recording_id)
  where recording_id is not null;
create index app_events_retention_idx
  on public.app_events (received_at);

alter table public.app_events enable row level security;
revoke all on table public.app_events from public, anon, authenticated, service_role;
grant insert on table public.app_events to service_role;

create table private.training_intent_ledger (
  week_start date primary key,
  intended_recordings integer not null
    check (intended_recordings >= 0),
  source text not null
    check (source in ('club_schedule', 'signed_acceptance', 'manual_reconciliation')),
  reconciled_at timestamptz not null default now(),
  constraint training_intent_ledger_monday
    check (extract(isodow from week_start) = 1)
);

comment on table private.training_intent_ledger is
  'Independent commercial denominator. Populate from the external training-intent/acceptance ledger without names or workstation mappings. Tracked recording_started events must never replace or shrink this denominator.';
revoke all on table private.training_intent_ledger from public, anon, authenticated, service_role;

create or replace function private.purge_old_app_events()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from private.analytics_ingest_quota_windows
  where window_started_at < now() - interval '1 day';

  delete from public.app_events
  where received_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

comment on function private.purge_old_app_events() is
  'Deletes raw pseudonymous product events after the promised rolling 90-day retention period.';
revoke all on function private.purge_old_app_events() from public, anon, authenticated, service_role;

create extension if not exists pg_cron;

select cron.schedule(
  'fpvhelper-app-events-retention',
  '15 3 * * *',
  $$select private.purge_old_app_events();$$
);

create view private.weekly_workstation_funnel
with (security_invoker = true)
as
with product_events as (
  select
    date_trunc('week', received_at at time zone 'Asia/Shanghai')::date as week_start,
    workstation_id,
    count(*) filter (where event_name = 'app_opened') as opens,
    count(distinct recording_id) filter (
      where event_name = 'recording_started'
        and props->>'connection_at_start' = 'live'
    ) as tracked_recording_attempts,
    count(distinct recording_id) filter (
      where event_name = 'recording_stopped'
        and props->>'valid' = 'true'
    ) as valid_recordings,
    count(distinct recording_id) filter (where event_name = 'session_exported') as exported_recordings,
    count(*) filter (where event_name = 'session_lost') as lost_recordings
  from public.app_events
  group by 1, 2
), weekly_product as (
  select
    week_start,
    sum(opens)::bigint as opens,
    count(*) filter (where opens > 0)::bigint as active_workstations,
    sum(tracked_recording_attempts)::bigint as tracked_recording_attempts,
    sum(valid_recordings)::bigint as valid_recordings,
    sum(exported_recordings)::bigint as exported_recordings,
    sum(lost_recordings)::bigint as lost_recordings
  from product_events
  group by week_start
)
select
  coalesce(product.week_start, ledger.week_start) as week_start,
  coalesce(product.opens, 0) as opens,
  coalesce(product.active_workstations, 0) as active_workstations,
  coalesce(product.tracked_recording_attempts, 0) as tracked_recording_attempts,
  coalesce(product.valid_recordings, 0) as valid_recordings,
  coalesce(product.exported_recordings, 0) as exported_recordings,
  coalesce(product.lost_recordings, 0) as lost_recordings,
  ledger.intended_recordings as independent_intended_recordings,
  case
    when ledger.intended_recordings > 0
      then coalesce(product.valid_recordings, 0)::numeric / ledger.intended_recordings
    else null
  end as commercial_valid_coverage,
  case
    when product.tracked_recording_attempts > 0
      then product.valid_recordings::numeric / product.tracked_recording_attempts
    else null
  end as product_capture_valid_rate
from weekly_product product
full join private.training_intent_ledger ledger using (week_start);

comment on view private.weekly_workstation_funnel is
  'Commercial coverage uses independent_intended_recordings only. product_capture_valid_rate is diagnostic and must not be reported as the commercial acceptance denominator. lost_recordings counts only confirmed unrecoverable session_lost events; with no reliable client loss detector it remains zero.';

create view private.connection_health
with (security_invoker = true)
as
select
  date_trunc('week', received_at at time zone 'Asia/Shanghai')::date as week_start,
  count(*) filter (where event_name = 'serial_connect_result') as serial_attempts,
  count(*) filter (where event_name = 'serial_connect_result' and props->>'ok' = 'true') as serial_successes,
  count(*) filter (where event_name = 'video_connect_result') as video_attempts,
  count(*) filter (where event_name = 'video_connect_result' and props->>'ok' = 'true') as video_successes,
  count(*) filter (where event_name = 'serial_lost') as serial_losses,
  count(*) filter (where event_name = 'video_lost') as video_losses,
  count(*) filter (where event_name = 'telemetry_stalled') as telemetry_stalls,
  percentile_cont(0.5) within group (
    order by case when jsonb_typeof(props->'ms_to_first_frame') = 'number'
      then (props->>'ms_to_first_frame')::double precision end
  ) filter (where event_name = 'serial_connect_result' and props->>'ok' = 'true') as serial_first_frame_p50_ms,
  percentile_cont(0.95) within group (
    order by case when jsonb_typeof(props->'ms_to_first_frame') = 'number'
      then (props->>'ms_to_first_frame')::double precision end
  ) filter (where event_name = 'serial_connect_result' and props->>'ok' = 'true') as serial_first_frame_p95_ms
from public.app_events
group by 1;

create view private.attrition_summary
with (security_invoker = true)
as
select
  date_trunc('week', received_at at time zone 'Asia/Shanghai')::date as week_start,
  count(*) filter (where event_name = 'session_lost') as lost_sessions,
  count(*) filter (
    where event_name = 'recording_stopped'
      and props->'invalid_reasons' @> '["interrupted"]'::jsonb
  ) as interrupted_recording_stops,
  count(*) filter (where event_name = 'page_unloaded' and props->>'is_recording' = 'true') as unloaded_while_recording,
  count(*) filter (where event_name = 'page_unloaded' and props->>'has_unexported_session' = 'true') as unloaded_with_unexported_session,
  avg(
    case when event_name = 'page_unloaded' and jsonb_typeof(props->'max_funnel_step') = 'number'
      then (props->>'max_funnel_step')::double precision end
  ) as average_max_funnel_step
from public.app_events
group by 1;

create view private.feature_usage
with (security_invoker = true)
as
select
  date_trunc('week', received_at at time zone 'Asia/Shanghai')::date as week_start,
  event_name,
  count(*) as uses,
  count(distinct workstation_id) as workstations
from public.app_events
where event_name in (
  'recording_started',
  'session_exported',
  'demo_returned',
  'overlay_mode_changed',
  'overlay_layout_reset'
)
group by 1, 2;

create view private.environment_summary
with (security_invoker = true)
as
select
  date_trunc('week', received_at at time zone 'Asia/Shanghai')::date as week_start,
  props->>'browser_family' as browser_family,
  props->>'os_family' as os_family,
  props->>'secure_context' as secure_context,
  props->>'serial_supported' as serial_supported,
  props->>'is_wechat' as is_wechat,
  hostname,
  build,
  count(*) as opens,
  count(distinct workstation_id) as workstations
from public.app_events
where event_name = 'app_opened'
group by 1, 2, 3, 4, 5, 6, 7, 8;

create view private.failure_timeline
with (security_invoker = true)
as
select
  received_at,
  occurred_at,
  workstation_id,
  visit_id,
  recording_id,
  event_name,
  build,
  connection,
  video_state,
  props->>'reason' as reason,
  props->>'code' as error_code,
  props->>'stage' as error_stage,
  props->>'fingerprint' as error_fingerprint
from public.app_events
where event_name in (
  'video_lost',
  'serial_lost',
  'telemetry_stalled',
  'session_lost',
  'error_shown',
  'js_error'
)
or (event_name in ('video_connect_result', 'serial_connect_result') and props->>'ok' = 'false');

revoke all on table
  private.weekly_workstation_funnel,
  private.connection_health,
  private.attrition_summary,
  private.feature_usage,
  private.environment_summary,
  private.failure_timeline
from public, anon, authenticated, service_role;

comment on view private.connection_health is 'Weekly serial, video and telemetry-link health without raw device or error data.';
comment on view private.attrition_summary is
  'Weekly confirmed unrecoverable loss, interrupted recording-stop, and page-exit risk signals. A recording stop or page exit alone is not counted as loss.';
comment on view private.feature_usage is 'Weekly use of the five Phase 1 product actions.';
comment on view private.environment_summary is 'Weekly coarse browser/environment categories; no raw user-agent is stored.';
comment on view private.failure_timeline is 'Pseudonymous failure timeline for bounded troubleshooting; no club mapping is available in this database.';
