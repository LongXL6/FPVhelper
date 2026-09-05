begin;

select plan(43);

select has_table('public', 'app_events', 'app_events exists');
select has_table('public', 'analytics_ingest_tokens', 'ingest token registry exists');
select has_table('private', 'training_intent_ledger', 'independent intent ledger exists');
select ok((select relrowsecurity from pg_class where oid = 'public.app_events'::regclass), 'app_events has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.analytics_ingest_tokens'::regclass), 'token registry has RLS enabled');
select ok(not has_table_privilege('anon', 'public.app_events', 'select'), 'anon cannot select events');
select ok(not has_table_privilege('authenticated', 'public.app_events', 'insert'), 'authenticated cannot insert events');
select ok(has_table_privilege('service_role', 'public.app_events', 'insert'), 'service role can insert events');
select ok(not has_table_privilege('service_role', 'public.app_events', 'select'), 'service role cannot select events');
select ok(not has_table_privilege('service_role', 'public.app_events', 'update'), 'service role cannot update events');
select ok(not has_table_privilege('service_role', 'public.app_events', 'delete'), 'service role cannot delete events');
select ok(has_table_privilege('service_role', 'public.analytics_ingest_tokens', 'select'), 'service role can verify token hashes');
select ok(not has_table_privilege('service_role', 'public.analytics_ingest_tokens', 'insert'), 'service role cannot mint tokens');
select ok(not has_table_privilege('anon', 'public.analytics_ingest_tokens', 'select'), 'anon cannot read token hashes');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use private schema');

select has_view('private', 'weekly_workstation_funnel', 'weekly funnel is private');
select has_view('private', 'connection_health', 'connection health is private');
select has_view('private', 'attrition_summary', 'attrition summary is private');
select has_view('private', 'feature_usage', 'feature usage is private');
select has_view('private', 'environment_summary', 'environment summary is private');
select has_view('private', 'failure_timeline', 'failure timeline is private');
select lives_ok($sql$
  select week_start, lost_sessions, interrupted_recording_stops,
    unloaded_while_recording, unloaded_with_unexported_session, average_max_funnel_step
  from private.attrition_summary
  limit 0
$sql$, 'attrition summary separates confirmed losses from interrupted stops and exit risk');
select lives_ok($sql$
  select week_start, browser_family, os_family, secure_context, serial_supported,
    is_wechat, hostname, build, opens, workstations
  from private.environment_summary
  limit 0
$sql$, 'environment summary is executable and exposes its grouped build column');
select has_function('private', 'purge_old_app_events', array[]::text[], 'retention function is private');
select ok(exists(
  select 1 from cron.job where jobname = 'fpvhelper-app-events-retention'
), '90-day retention cron is scheduled');

select lives_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'app_opened', now(), 1, 'test-build', 'helper.example.com', 'production', 2,
    'demo', 'idle', false, 'trail', 'demo', '{}'::jsonb
  )
$sql$, 'a whitelisted event can be inserted by the database owner');

select throws_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'app_opened', now(), 2, 'test-build', 'helper.example.com', 'production', 2,
    'demo', 'idle', false, 'trail', 'demo', '{}'::jsonb
  )
$sql$, '23505', null, 'event_id is the idempotency primary key');

select throws_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'invented_event', now(), 1, 'test-build', 'helper.example.com', 'production', 2,
    'demo', 'idle', false, 'trail', 'demo', '{}'::jsonb
  )
$sql$, '23514', null, 'event names outside the 19-name allowlist are rejected');

select throws_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'app_opened', now(), 1, 'test-build', 'helper.example.com', 'production', 2,
    'demo', 'idle', false, 'trail', 'demo', '[]'::jsonb
  )
$sql$, '23514', null, 'props must be a JSON object');

select throws_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'app_opened', now(), 1, 'test-build', 'helper.example.com', 'production', 2,
    'demo', 'idle', false, 'trail', 'demo', jsonb_build_object('oversize', repeat('x', 4097))
  )
$sql$, '23514', null, 'props larger than 4096 bytes are rejected');

select throws_ok($sql$
  insert into public.app_events (
    event_id, workstation_id, visit_id, recording_id, event_name, occurred_at,
    client_monotonic_ms, build, hostname, vercel_env, session_schema_version,
    connection, video_state, is_recording, overlay_mode, telemetry_source, props
  ) values (
    '10000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'session_lost', now(), 1, 'test-build', 'helper.example.com', 'production', 2,
    'live', 'live', false, 'trail', 'serial', '{"reason":"recording_interrupted"}'::jsonb
  )
$sql$, '23514', null, 'a safely persisted interruption cannot be inserted as session loss');

select throws_ok($sql$
  insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
  values (
    '20000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'admin'
  )
$sql$, '23514', null, 'tokens are restricted to the event_ingest purpose');

select lives_ok($sql$
  insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
  values ('50000000-0000-4000-8000-000000000001', repeat('1', 64), 'event_ingest')
$sql$, 'a workstation token can be issued');
select is((
  select count(*)::integer from public.analytics_ingest_tokens
  where workstation_id = '50000000-0000-4000-8000-000000000001' and revoked_at is null
), 1, 'issue leaves exactly one active token');
select throws_ok($sql$
  insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
  values ('50000000-0000-4000-8000-000000000001', repeat('2', 64), 'event_ingest')
$sql$, '23505', null, 'a second active token for the same workstation is rejected');
select lives_ok($sql$
  with revoked as (
    update public.analytics_ingest_tokens
    set revoked_at = clock_timestamp()
    where workstation_id = '50000000-0000-4000-8000-000000000001'
      and revoked_at is null
    returning workstation_id
  )
  insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
  select workstation_id, repeat('2', 64), 'event_ingest' from revoked
$sql$, 'rotation revokes and issues in one statement');
select is((
  select count(*)::integer from public.analytics_ingest_tokens
  where workstation_id = '50000000-0000-4000-8000-000000000001' and revoked_at is null
), 1, 'rotation leaves exactly one active token');
select is((
  select count(*)::integer from public.analytics_ingest_tokens
  where workstation_id = '50000000-0000-4000-8000-000000000001' and revoked_at is not null
), 1, 'rotation preserves one revoked predecessor');
select lives_ok($sql$
  update public.analytics_ingest_tokens
  set revoked_at = clock_timestamp()
  where workstation_id = '50000000-0000-4000-8000-000000000001'
    and revoked_at is null
$sql$, 'the active workstation token can be revoked');
select is((
  select count(*)::integer from public.analytics_ingest_tokens
  where workstation_id = '50000000-0000-4000-8000-000000000001' and revoked_at is null
), 0, 'revoke leaves no active token');

insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
values
  ('60000000-0000-4000-8000-000000000001', repeat('3', 64), 'event_ingest'),
  ('60000000-0000-4000-8000-000000000002', repeat('4', 64), 'event_ingest');
select throws_ok($sql$
  with revoked as (
    update public.analytics_ingest_tokens
    set revoked_at = clock_timestamp()
    where workstation_id = '60000000-0000-4000-8000-000000000001'
      and revoked_at is null
    returning workstation_id
  )
  insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
  select workstation_id, repeat('4', 64), 'event_ingest' from revoked
$sql$, '23505', null, 'a conflicting replacement aborts the rotation statement');
select is((
  select count(*)::integer from public.analytics_ingest_tokens
  where workstation_id = '60000000-0000-4000-8000-000000000001' and revoked_at is null
), 1, 'failed rotation rolls back the predecessor revocation');

select throws_ok($sql$
  insert into private.training_intent_ledger (week_start, intended_recordings, source)
  values ('2026-08-30', 4, 'club_schedule')
$sql$, '23514', null, 'intent ledger weeks must start on Monday');

select * from finish();
rollback;
