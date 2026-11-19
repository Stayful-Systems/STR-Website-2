-- Review R4 (R4-48): database checks for Batch 28's btl_apply_screen (the
-- nightly buy-to-let screen's writes) and Batch 30's sync_live_mortgage_rate
-- (today's average rate written into every profile that has not chosen its
-- own), with the rateSet guard, and Review R4's quiz_v2_backfill_done_at stamp
-- the sync waits for. Run AFTER schema.sql: by hand in the Supabase SQL
-- editor, or by CI (.github/workflows/ci.yml, job "schema", after the other
-- smoke files). One transaction, rolled back at the end: it leaves no data
-- behind. A failing check raises; success prints notices.
begin;

-- ── btl_apply_screen ──
do $$
declare
  n integer;
  r record;
begin
  insert into sourced_listings (canonical_url, source, kind, query_key, snapshot) values
    ('https://btl-smoke.test/a', 'test', 'sale', 'k', '{}'),
    ('https://btl-smoke.test/b', 'test', 'sale', 'k', '{}'),
    ('https://btl-smoke.test/c', 'test', 'sale', 'k', '{}');
  insert into marketplace_deals (canonical_url, source, kind, band, screening) values
    ('https://btl-smoke.test/a', 'test', 'sale', 'qualified', '{}'),
    ('https://btl-smoke.test/b', 'test', 'sale', 'qualified', '{}'),
    ('https://btl-smoke.test/c', 'test', 'sale', 'qualified', '{}');

  -- A fresh row has no lens and is not a buy-to-let deal.
  select btl, btl_pass, btl_screened_at into r from marketplace_deals where canonical_url = 'https://btl-smoke.test/a';
  if r.btl is not null or r.btl_pass or r.btl_screened_at is not null then raise exception 'a new deal starts with no buy-to-let lens: %', r; end if;

  -- One pass, one fail, one with no pass flag (null means not passing), and one listing that is not a deal.
  n := public.btl_apply_screen(jsonb_build_array(
    jsonb_build_object('canonical_url', 'https://btl-smoke.test/a', 'btl', jsonb_build_object('cashIn', jsonb_build_object('mid', 41000)), 'pass', true),
    jsonb_build_object('canonical_url', 'https://btl-smoke.test/b', 'btl', jsonb_build_object('cashIn', jsonb_build_object('mid', 52000)), 'pass', false),
    jsonb_build_object('canonical_url', 'https://btl-smoke.test/c', 'btl', jsonb_build_object('cashIn', jsonb_build_object('mid', 60000))),
    jsonb_build_object('canonical_url', 'https://btl-smoke.test/not-a-deal', 'btl', '{}'::jsonb, 'pass', true)
  ));
  if n <> 3 then raise exception 'btl_apply_screen writes only the deals it was given that exist: % rows', n; end if;

  select btl, btl_pass, btl_screened_at into r from marketplace_deals where canonical_url = 'https://btl-smoke.test/a';
  if not r.btl_pass or (r.btl->'cashIn'->>'mid')::int <> 41000 or r.btl_screened_at is null then raise exception 'a passing deal: %', r; end if;
  select btl, btl_pass into r from marketplace_deals where canonical_url = 'https://btl-smoke.test/b';
  if r.btl_pass or (r.btl->'cashIn'->>'mid')::int <> 52000 then raise exception 'a failing deal keeps its lens but is not a buy-to-let deal: %', r; end if;
  select btl, btl_pass into r from marketplace_deals where canonical_url = 'https://btl-smoke.test/c';
  if r.btl_pass or r.btl is null then raise exception 'no pass flag means not passing: %', r; end if;
  if exists (select 1 from marketplace_deals where canonical_url = 'https://btl-smoke.test/not-a-deal') then
    raise exception 'btl_apply_screen never creates a deal';
  end if;

  -- A later screen replaces the lens; a deal that stops passing stops being a buy-to-let deal.
  n := public.btl_apply_screen(jsonb_build_array(jsonb_build_object('canonical_url', 'https://btl-smoke.test/a', 'btl', jsonb_build_object('cashIn', jsonb_build_object('mid', 43000)), 'pass', false)));
  select btl, btl_pass into r from marketplace_deals where canonical_url = 'https://btl-smoke.test/a';
  if n <> 1 or r.btl_pass or (r.btl->'cashIn'->>'mid')::int <> 43000 then raise exception 'a re-screen replaces the lens: % %', n, r; end if;

  -- Nothing given, nothing written.
  if public.btl_apply_screen(null) <> 0 or public.btl_apply_screen('[]'::jsonb) <> 0 then raise exception 'an empty screen writes nothing'; end if;

  if has_function_privilege('authenticated', 'public.btl_apply_screen(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.btl_apply_screen(jsonb)', 'execute') then
    raise exception 'btl_apply_screen is service-role only';
  end if;
  raise notice 'btl_apply_screen ok';
end $$;

-- ── sync_live_mortgage_rate, its rateSet guard, and the backfill stamp it waits for ──
do $$
declare
  avg_m uuid := gen_random_uuid();   -- on today's average (rateSet absent)
  own uuid := gen_random_uuid();     -- chose their own rate (rateSet true)
  off_m uuid := gen_random_uuid();   -- rateSet false, stored as text
  bare uuid := gen_random_uuid();    -- no finance block yet
  none_m uuid := gen_random_uuid();  -- no goals at all
  sp_avg uuid; sp_own uuid; sp_gone uuid;
  j jsonb;
  v jsonb;
  day text := to_char(date '2026-11-19', 'YYYY-MM-DD');
begin
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select i, 'btl-smoke-' || i::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(array[avg_m, own, off_m, bare, none_m]) as i;
  insert into profiles (id, email) select i, 'btl-smoke-' || i::text || '@example.test' from unnest(array[avg_m, own, off_m, bare, none_m]) as i on conflict (id) do nothing;
  update profiles set market_goals = '{"finance": {"mortgageRatePct": 4.1, "rateAsOf": "2026-11-01", "depositPct": 25}}'::jsonb where id = avg_m;
  update profiles set market_goals = '{"finance": {"mortgageRatePct": 3.2, "rateSet": true}}'::jsonb where id = own;
  update profiles set market_goals = '{"finance": {"mortgageRatePct": 4.1, "rateSet": "false"}}'::jsonb where id = off_m;
  update profiles set market_goals = '{"bedrooms": 2}'::jsonb where id = bare;
  update profiles set market_goals = null where id = none_m;
  insert into search_profiles (user_id, name, criteria) values (avg_m, 'Average', '{"finance": {"mortgageRatePct": 4.1}}') returning id into sp_avg;
  insert into search_profiles (user_id, name, criteria) values (avg_m, 'Mine', '{"finance": {"mortgageRatePct": 2.9, "rateSet": true}}') returning id into sp_own;
  insert into search_profiles (user_id, name, criteria, deleted_at) values (avg_m, 'Gone', '{"finance": {"mortgageRatePct": 4.1}}', now()) returning id into sp_gone;

  -- A bad rate or date changes nothing.
  j := public.sync_live_mortgage_rate(null, date '2026-11-19');
  if not (j->>'skipped')::boolean then raise exception 'a null rate is skipped: %', j; end if;
  j := public.sync_live_mortgage_rate(30, date '2026-11-19');
  if not (j->>'skipped')::boolean then raise exception 'a rate over 25%% is skipped: %', j; end if;
  j := public.sync_live_mortgage_rate(4.6, null);
  if not (j->>'skipped')::boolean then raise exception 'a missing date is skipped: %', j; end if;
  if (select market_goals->'finance'->>'mortgageRatePct' from profiles where id = avg_m) <> '4.1' then raise exception 'a skipped sync wrote a rate'; end if;

  j := public.sync_live_mortgage_rate(4.6, date '2026-11-19');
  if (j->>'skipped')::boolean then raise exception 'a good rate is not skipped: %', j; end if;

  -- On the average: today's rate and date, and the rest of the finance answer kept.
  v := (select market_goals->'finance' from profiles where id = avg_m);
  if (v->>'mortgageRatePct')::numeric <> 4.6 or v->>'rateAsOf' <> day or (v->>'depositPct')::int <> 25 then raise exception 'the average member gets today''s rate: %', v; end if;
  -- The rateSet guard: a member's own rate is never overwritten.
  v := (select market_goals->'finance' from profiles where id = own);
  if (v->>'mortgageRatePct')::numeric <> 3.2 or v ? 'rateAsOf' then raise exception 'a member''s own rate (rateSet true) was overwritten: %', v; end if;
  v := (select market_goals->'finance' from profiles where id = off_m);
  if (v->>'mortgageRatePct')::numeric <> 4.6 then raise exception 'rateSet false is on the average: %', v; end if;
  v := (select market_goals from profiles where id = bare);
  if (v->'finance'->>'mortgageRatePct')::numeric <> 4.6 or (v->>'bedrooms')::int <> 2 then raise exception 'goals with no finance block get one, the rest kept: %', v; end if;
  if (select market_goals from profiles where id = none_m) is not null then raise exception 'a member with no goals is left alone'; end if;

  -- Saved profiles: the same guard, and a deleted one is left alone.
  if (select (criteria->'finance'->>'mortgageRatePct')::numeric from search_profiles where id = sp_avg) <> 4.6 then raise exception 'a saved profile on the average gets today''s rate'; end if;
  if (select (criteria->'finance'->>'mortgageRatePct')::numeric from search_profiles where id = sp_own) <> 2.9 then raise exception 'a saved profile''s own rate (rateSet true) was overwritten'; end if;
  if (select (criteria->'finance'->>'mortgageRatePct')::numeric from search_profiles where id = sp_gone) <> 4.1 then raise exception 'a deleted saved profile was changed'; end if;

  -- A second call with the same rate and date changes nothing (the first call reached every row on the average).
  j := public.sync_live_mortgage_rate(4.6, date '2026-11-19');
  if (j->>'profiles')::int <> 0 or (j->>'search_profiles')::int <> 0 then raise exception 'a second call with the same rate changes nothing: %', j; end if;

  if has_function_privilege('authenticated', 'public.sync_live_mortgage_rate(numeric, date)', 'execute')
     or has_function_privilege('anon', 'public.sync_live_mortgage_rate(numeric, date)', 'execute') then
    raise exception 'sync_live_mortgage_rate is service-role only';
  end if;

  -- Review R4 (R4-33): the quiz v2 backfill's "done" stamp is seeded, as a time, so the sync is not held on a fresh install.
  v := (select value from billing_settings where key = 'quiz_v2_backfill_done_at');
  if v is null or jsonb_typeof(v) <> 'string' then raise exception 'quiz_v2_backfill_done_at is seeded as an ISO time: %', v; end if;
  if (v #>> '{}')::timestamptz > now() + interval '1 minute' then raise exception 'quiz_v2_backfill_done_at is in the future: %', v; end if;
  raise notice 'sync_live_mortgage_rate and its rateSet guard ok';
end $$;

rollback;
