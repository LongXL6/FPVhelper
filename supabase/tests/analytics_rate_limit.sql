begin;

select plan(13);

select has_table('private', 'analytics_ingest_quota_windows', 'private quota table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'private.analytics_ingest_quota_windows'::regclass),
  'quota table has RLS enabled'
);
select has_function(
  'public',
  'authorize_and_consume_analytics_quota',
  array['text', 'uuid', 'integer'],
  'atomic quota admission RPC exists'
);
select ok(
  has_function_privilege('service_role', 'public.authorize_and_consume_analytics_quota(text, uuid, integer)', 'execute'),
  'service role can execute admission RPC'
);
select ok(
  not has_function_privilege('anon', 'public.authorize_and_consume_analytics_quota(text, uuid, integer)', 'execute'),
  'anon cannot execute admission RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.authorize_and_consume_analytics_quota(text, uuid, integer)', 'execute'),
  'authenticated cannot execute admission RPC'
);

select results_eq(
  $$select authorized, allowed, retry_after_seconds
    from public.authorize_and_consume_analytics_quota(
      repeat('f', 64),
      '20000000-0000-4000-8000-000000000001',
      1
    )$$,
  $$values (false, false, 0)$$,
  'an unknown token is not authorized'
);

insert into public.analytics_ingest_tokens (workstation_id, token_hash, purpose)
values (
  '20000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  'event_ingest'
);

select results_eq(
  $$select authorized, allowed, retry_after_seconds
    from public.authorize_and_consume_analytics_quota(
      repeat('a', 64),
      '20000000-0000-4000-8000-000000000001',
      1
    )$$,
  $$values (true, true, 0)$$,
  'a valid token reserves the first request atomically'
);

select lives_ok($sql$
  do $quota$
  begin
    for quota_index in 1..119 loop
      perform * from public.authorize_and_consume_analytics_quota(
        repeat('a', 64),
        '20000000-0000-4000-8000-000000000001',
        1
      );
    end loop;
  end
  $quota$;
$sql$, 'the remaining minute request quota can be consumed');

select is(
  (select allowed from public.authorize_and_consume_analytics_quota(
    repeat('a', 64),
    '20000000-0000-4000-8000-000000000001',
    1
  )),
  false,
  'the 121st request in one fixed minute is rejected'
);
select ok(
  (select retry_after_seconds between 1 and 60
    from public.authorize_and_consume_analytics_quota(
      repeat('a', 64),
      '20000000-0000-4000-8000-000000000001',
      1
    )),
  'a rejected request receives a bounded retry delay'
);

select throws_ok(
  $$select * from public.authorize_and_consume_analytics_quota(
    repeat('a', 64),
    '20000000-0000-4000-8000-000000000001',
    0
  )$$,
  '22023',
  'invalid analytics quota input',
  'zero-event requests are rejected by the RPC'
);

select ok(
  not has_table_privilege('anon', 'private.analytics_ingest_quota_windows', 'select'),
  'anon cannot read quota counters'
);

select * from finish();
rollback;
