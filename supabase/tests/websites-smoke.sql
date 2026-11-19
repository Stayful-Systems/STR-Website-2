-- Batch 31 checks: customer websites. The daily free-report limit, the held
-- backlog and the once-only report charge. Run AFTER schema.sql: by hand in
-- the Supabase SQL editor, or by CI (.github/workflows/ci.yml, job "schema",
-- after pack-smoke.sql). One transaction, rolled back at the end: it leaves no
-- data behind. A failing check raises; success prints notices.
-- "The next UK day" is simulated by moving today's slots back a day, because
-- the claim takes the day from website_uk_day() and nothing else.
begin;

do $$
declare
  u uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  f uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  w uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  i integer;
  n integer;
  l uuid;
  first_lead uuid;
  held1 uuid := gen_random_uuid();
  held2 uuid := gen_random_uuid();
  live_a uuid := gen_random_uuid();
  live_b uuid := gen_random_uuid();
  r text;
  j jsonb;
  ok boolean;
  c_lead uuid := gen_random_uuid();
  pay uuid;   -- a member with credit
  broke uuid; -- a member with none
  short uuid; -- a member with less than the price
  g uuid;
  tx_count integer;
begin
  -- ── Throwaway members, a website funnel and a website each ──
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select x, 'web-smoke-' || x::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(u) as x;
  insert into profiles (id, email) select x, 'web-smoke-' || x::text || '@example.test' from unnest(u) as x on conflict (id) do nothing;
  for i in 1..5 loop
    insert into funnels (id, user_id, public_token, name, active, kind) values (f[i], u[i], 'web-smoke-' || f[i]::text, 'Website', false, 'website');
    insert into websites (id, user_id, funnel_id, slug) values (w[i], u[i], f[i], 'smoke-site-' || i::text);
  end loop;

  -- ── The seeds are the plan's ──
  if (select value from billing_settings where key = 'website_report_charge_on') <> 'false'::jsonb then raise exception 'website_report_charge_on should seed false'; end if;
  if (select value from billing_settings where key = 'website_report_pence') <> '300'::jsonb then raise exception 'website_report_pence should seed 300'; end if;
  if (select value from billing_settings where key = 'website_plan_gate_on') <> 'false'::jsonb then raise exception 'website_plan_gate_on should seed false'; end if;
  if (select value from billing_settings where key = 'website_free_reports_per_day') <> '20'::jsonb then raise exception 'website_free_reports_per_day should seed 20'; end if;
  if (select value from billing_settings where key = 'website_free_reports_per_site_per_day') <> '5'::jsonb then raise exception 'website_free_reports_per_site_per_day should seed 5'; end if;
  if website_uk_day() <> (now() at time zone 'Europe/London')::date then raise exception 'website_uk_day is not the UK date'; end if;
  raise notice 'seeds and uk day ok';

  -- ── Table rules ──
  begin
    insert into funnels (user_id, public_token, kind) values (u[1], 'web-smoke-bad-kind', 'blog');
    raise exception 'a funnel kind outside form|website was accepted';
  exception when check_violation then null;
  end;
  if (select kind from funnels where id = f[1]) <> 'website' then raise exception 'kind not stored'; end if;
  begin
    insert into websites (user_id, funnel_id, slug) values (u[1], f[2], 'second-for-same-member');
    raise exception 'a second website for one member was accepted';
  exception when unique_violation then null;
  end;
  begin
    update websites set slug = 'Bad Slug' where id = w[1];
    raise exception 'a bad slug was accepted';
  exception when check_violation then null;
  end;
  begin
    update websites set slug = 'ab' where id = w[1];
    raise exception 'a 2 character slug was accepted';
  exception when check_violation then null;
  end;
  begin
    update websites set status = 'archived' where id = w[1];
    raise exception 'a bad status was accepted';
  exception when check_violation then null;
  end;
  begin
    delete from funnels where id = f[1];
    raise exception 'a funnel with a website was deleted';
  exception when foreign_key_violation then null;
  end;
  raise notice 'table rules ok';

  -- ── One site stops at its own limit (5), the 6th is site_full ──
  for i in 1..5 loop
    r := website_free_report_claim(gen_random_uuid(), w[1], false);
    if r <> 'claimed' then raise exception 'site 1 claim % should be claimed, got %', i, r; end if;
  end loop;
  r := website_free_report_claim(gen_random_uuid(), w[1], false);
  if r <> 'site_full' then raise exception 'site 1''s 6th claim should be site_full, got %', r; end if;

  -- ── All sites stop at the day's limit (20): sites 2, 3 and 4 take 5 each ──
  for i in 2..4 loop
    for n in 1..5 loop
      l := gen_random_uuid();
      if first_lead is null then first_lead := l; end if;
      r := website_free_report_claim(l, w[i], false);
      if r <> 'claimed' then raise exception 'site % claim % should be claimed, got %', i, n, r; end if;
    end loop;
  end loop;
  -- 20 used. Site 5 has taken none, so only the day's limit can refuse.
  r := website_free_report_claim(gen_random_uuid(), w[5], false);
  if r <> 'day_full' then raise exception 'the 21st claim of the day should be day_full, got %', r; end if;
  r := website_free_report_claim(gen_random_uuid(), w[5], true);
  if r <> 'day_full' then raise exception 'a held claim past the limit should be day_full, got %', r; end if;
  select count(*) into n from website_report_slots where day = website_uk_day();
  if n <> 20 then raise exception 'exactly 20 slots should exist today, found %', n; end if;
  raise notice '21st claim refused ok';

  -- ── A second claim for the same lead is "already", even on a full day, and takes no slot ──
  r := website_free_report_claim(first_lead, w[2], false);
  if r <> 'already' then raise exception 'a second claim for one lead should be already, got %', r; end if;
  select count(*) into n from website_report_slots where day = website_uk_day();
  if n <> 20 then raise exception 'an already claim must not add a slot (%)', n; end if;
  raise notice 'already ok';

  -- ── The next day: a held report claims once ──
  update website_report_slots set day = day - 1;
  insert into leads (id, user_id, funnel_id, status) values (held1, u[5], f[5], 'new');
  insert into website_reports (lead_id, website_id, state, due_day) values (held1, w[5], 'held_cap', website_uk_day());
  r := website_free_report_claim(held1, w[5], true);
  if r <> 'claimed' then raise exception 'the next day''s held claim should be claimed, got %', r; end if;
  r := website_free_report_claim(held1, w[5], true);
  if r <> 'already' then raise exception 'the held lead''s second claim should be already, got %', r; end if;
  select count(*) into n from website_report_slots where lead_id = held1 and day = website_uk_day();
  if n <> 1 then raise exception 'the held lead should hold exactly one slot today, found %', n; end if;
  raise notice 'next day held claim once ok';

  -- ── The live claim leaves room for the held backlog ──
  -- Day limit 3, site limit 10. Two held reports are due; one live claim fits
  -- (0 used + 2 due < 3), the next does not (1 used + 2 due = 3); the held
  -- ones always do until the limit itself is reached.
  delete from website_report_slots;
  delete from website_reports;
  update billing_settings set value = '3'::jsonb where key = 'website_free_reports_per_day';
  update billing_settings set value = '10'::jsonb where key = 'website_free_reports_per_site_per_day';
  insert into leads (id, user_id, funnel_id, status) values (held2, u[5], f[5], 'new'), (live_a, u[5], f[5], 'new'), (live_b, u[5], f[5], 'new');
  insert into website_reports (lead_id, website_id, state, due_day) values
    (held1, w[5], 'held_cap', website_uk_day() - 1),
    (held2, w[5], 'held_cap', website_uk_day());
  r := website_free_report_claim(live_a, w[5], false);
  if r <> 'claimed' then raise exception 'the first live claim leaves room for the backlog, got %', r; end if;
  r := website_free_report_claim(live_b, w[5], false);
  if r <> 'day_full' then raise exception 'a live claim must be refused while the backlog fills the limit, got %', r; end if;
  r := website_free_report_claim(held1, w[5], true);
  if r <> 'claimed' then raise exception 'a held claim fits first, got %', r; end if;
  r := website_free_report_claim(live_b, w[5], false);
  if r <> 'day_full' then raise exception 'live still refused with one held report waiting, got %', r; end if;
  r := website_free_report_claim(held2, w[5], true);
  if r <> 'claimed' then raise exception 'the last held claim fits, got %', r; end if;
  r := website_free_report_claim(live_b, w[5], false);
  if r <> 'day_full' then raise exception 'live refused at the limit, got %', r; end if;
  select count(*) into n from website_report_slots where day = website_uk_day();
  if n <> 3 then raise exception 'three slots should be held today, found %', n; end if;
  -- A limit of 0 (the rollback lever) refuses everything.
  update billing_settings set value = '0'::jsonb where key = 'website_free_reports_per_day';
  r := website_free_report_claim(gen_random_uuid(), w[4], false);
  if r <> 'day_full' then raise exception 'a limit of 0 should refuse every claim, got %', r; end if;
  -- A malformed setting never raises: the default applies (20).
  update billing_settings set value = '"lots"'::jsonb where key = 'website_free_reports_per_day';
  if website_setting_int('website_free_reports_per_day', 20) <> 20 then raise exception 'a malformed setting should read as its default'; end if;
  update billing_settings set value = '20'::jsonb where key = 'website_free_reports_per_day';
  update billing_settings set value = '5'::jsonb where key = 'website_free_reports_per_site_per_day';
  raise notice 'backlog rule ok';

  -- ── website_report_charge: once, then already_charged; short balance records unpaid ──
  pay := u[1]; broke := u[2]; short := u[3];
  g := credit_grant(pay, 'topup', 1000, null, 'pi:web_smoke_pay', 'Smoke top-up');
  perform credit_grant(short, 'topup', 100, null, 'pi:web_smoke_short', 'Smoke small top-up');

  j := website_report_charge(jsonb_build_object('owner', pay, 'lead', c_lead, 'website', w[1], 'pence', 300));
  if j->>'result' <> 'charged' or (j->>'already')::boolean then raise exception 'first charge should be charged: %', j; end if;
  select count(*) into n from website_report_charges where lead_id = c_lead and status = 'charged' and txn_id is not null and pence = 300;
  if n <> 1 then raise exception 'one charged row with its transaction expected: %', j; end if;
  if abs((select remaining_pence from credit_grants where id = g) - 700) > 0.01 then raise exception 'the 300p face debit should leave 700 of 1000, got %', (select remaining_pence from credit_grants where id = g); end if;
  select count(*) into tx_count from credit_transactions where user_id = pay and kind = 'debit';
  if tx_count <> 1 then raise exception 'one debit expected, found %', tx_count; end if;

  j := website_report_charge(jsonb_build_object('owner', pay, 'lead', c_lead, 'website', w[1], 'pence', 300));
  if j->>'result' <> 'already_charged' or not (j->>'already')::boolean then raise exception 'second charge should be already_charged: %', j; end if;
  if abs((select remaining_pence from credit_grants where id = g) - 700) > 0.01 then raise exception 'a second charge debited again'; end if;
  select count(*) into tx_count from credit_transactions where user_id = pay and kind = 'debit';
  if tx_count <> 1 then raise exception 'still one debit expected, found %', tx_count; end if;
  select count(*) into n from website_report_charges where lead_id = c_lead;
  if n <> 1 then raise exception 'one guard row per lead expected, found %', n; end if;

  -- No credit at all: recorded unpaid, no raise, no debit.
  l := gen_random_uuid();
  j := website_report_charge(jsonb_build_object('owner', broke, 'lead', l, 'website', w[2], 'pence', 300));
  if j->>'result' <> 'unpaid' then raise exception 'no balance should record unpaid: %', j; end if;
  select count(*) into n from website_report_charges where lead_id = l and status = 'unpaid' and txn_id is null;
  if n <> 1 then raise exception 'an unpaid row expected for the member with no credit'; end if;
  select count(*) into tx_count from credit_transactions where user_id = broke and kind = 'debit';
  if tx_count <> 0 then raise exception 'an unpaid report must not debit'; end if;

  -- Some credit, but short of the price: unpaid, the balance untouched.
  l := gen_random_uuid();
  j := website_report_charge(jsonb_build_object('owner', short, 'lead', l, 'website', w[3], 'pence', 300));
  if j->>'result' <> 'unpaid' then raise exception 'a short balance should record unpaid: %', j; end if;
  if abs((select sum(remaining_pence) from credit_grants where user_id = short) - 100) > 0.01 then raise exception 'a short balance must be left untouched'; end if;
  -- A retry of an unpaid one does not charge it later: the row is the record.
  perform credit_grant(short, 'topup', 1000, null, 'pi:web_smoke_short2', 'Smoke top-up 2');
  j := website_report_charge(jsonb_build_object('owner', short, 'lead', l, 'website', w[3], 'pence', 300));
  if j->>'result' <> 'already_charged' or j->>'status' <> 'unpaid' then raise exception 'a retry of an unpaid report should be already_charged, status unpaid: %', j; end if;

  -- The price falls back to the one frozen on the report row.
  l := gen_random_uuid();
  insert into leads (id, user_id, funnel_id, status) values (l, u[1], f[1], 'new');
  insert into website_reports (lead_id, website_id, state, billing_mode, price_pence) values (l, w[1], 'running', 'charged', 250);
  j := website_report_charge(jsonb_build_object('owner', pay, 'lead', l, 'website', w[1]));
  if j->>'result' <> 'charged' or (j->>'pence')::numeric <> 250 then raise exception 'the frozen price should be used: %', j; end if;
  -- No price anywhere: refused.
  ok := false;
  begin
    perform website_report_charge(jsonb_build_object('owner', pay, 'lead', gen_random_uuid()));
  exception when others then ok := sqlerrm = 'website_report_charge_bad_input';
  end;
  if not ok then raise exception 'a charge with no price should be refused'; end if;
  raise notice 'report charge ok';

  -- ── A lead's deletion takes its source, report and (not its slot or charge) ──
  insert into lead_sources (lead_id, utm_source, ad_code, landing_page) values (l, 'facebook', 'SI-TEST-1', '/s/smoke-site-1');
  begin
    insert into lead_sources (lead_id, ad_code) values (live_b, repeat('x', 41));
    raise exception 'an ad code over 40 characters was accepted';
  exception when string_data_right_truncation then null;
  end;
  insert into website_report_slots (lead_id, website_id, day) values (l, w[1], website_uk_day());
  delete from leads where id = l;
  if exists (select 1 from lead_sources where lead_id = l) then raise exception 'lead_sources should cascade with the lead'; end if;
  if exists (select 1 from website_reports where lead_id = l) then raise exception 'website_reports should cascade with the lead'; end if;
  if not exists (select 1 from website_report_slots where lead_id = l) then raise exception 'the slot should outlive the lead'; end if;
  if not exists (select 1 from website_report_charges where lead_id = l) then raise exception 'the charge row should outlive the lead'; end if;
  raise notice 'cascade ok';

  -- ── Locked down: no function for the API roles, service role only ──
  for r in select unnest(array['website_uk_day()', 'website_setting_int(text,integer)', 'website_free_report_claim(uuid,uuid,boolean)', 'website_report_charge(jsonb)']) loop
    if has_function_privilege('anon', 'public.' || r, 'execute') or has_function_privilege('authenticated', 'public.' || r, 'execute') then
      raise exception '% must not be callable by anon or authenticated', r;
    end if;
    if not has_function_privilege('service_role', 'public.' || r, 'execute') then raise exception '% must be callable by service_role', r; end if;
  end loop;
  for r in select unnest(array['websites', 'lead_sources', 'website_reports', 'website_report_slots', 'website_report_charges']) loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || r)::regclass) then raise exception '% must have RLS on', r; end if;
    if has_table_privilege('anon', 'public.' || r, 'select') then raise exception '% must not be readable by anon', r; end if;
    if has_table_privilege('authenticated', 'public.' || r, 'insert') or has_table_privilege('authenticated', 'public.' || r, 'update') or has_table_privilege('authenticated', 'public.' || r, 'delete') then
      raise exception '% must not be writable by a member', r;
    end if;
  end loop;
  raise notice 'locked down ok';
end $$;

-- ── A member reads their own website and nobody else's ──
do $$
declare a uuid; b uuid; n integer;
begin
  select user_id into a from websites where slug = 'smoke-site-1';
  select user_id into b from websites where slug = 'smoke-site-2';
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  select count(*) into n from public.websites;
  reset role;
  if n <> 1 then raise exception 'a member should read exactly their own website, saw %', n; end if;
  perform set_config('request.jwt.claim.sub', b::text, true);
  set local role authenticated;
  select count(*) into n from public.websites where slug = 'smoke-site-1';
  reset role;
  if n <> 0 then raise exception 'a member must not read another member''s website'; end if;
  raise notice 'own-website policy ok';
end $$;

rollback;
