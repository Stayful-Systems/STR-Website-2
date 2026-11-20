-- Batch 34 checks: plan credit rollover. A renewal adds to unused plan credit
-- instead of wiping it, the spend order, refunds, the idle-member report and
-- the targeted removal of a refunded payment's or a trial's plan credit, and
-- (Batch 34b) the no-spend notices table and the live expiry. Run
-- AFTER schema.sql: by hand in the Supabase SQL editor, or by CI
-- (.github/workflows/ci.yml, job "schema", after the other smoke files). One
-- transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
-- Expected figures use the live top-up spend rate (credit_spend_rate).
begin;

do $$
declare
  a uuid := gen_random_uuid();   -- two plan cycles, a replay and a refund
  b uuid := gen_random_uuid();   -- the spend order
  i12 uuid := gen_random_uuid(); -- idle 12 months and a day
  i11 uuid := gen_random_uuid(); -- idle 11 months
  i0 uuid := gen_random_uuid();  -- never spent: idle since the launch date
  i4 uuid := gen_random_uuid();  -- idle 4 months (p_min_months)
  c uuid := gen_random_uuid();   -- clawback
  d uuid := gen_random_uuid();   -- the one-off's cycle flag skips an upgrade top-up
  e uuid := gen_random_uuid();   -- cumulative totals and an annual year's window
  f uuid := gen_random_uuid();   -- the live no-spend expiry (Batch 34b)
  h uuid := gen_random_uuid();   -- the no-spend expiry: no cycle grant, then the newest month
  s uuid := gen_random_uuid();   -- the no-spend expiry: a spend after the final warning
  rate numeric := credit_spend_rate('topup');
  g1 uuid; g2 uuid; g_extra uuid; g_bonus uuid; g_welcome uuid; g_top uuid;
  c1 uuid; c2 uuid; t1 uuid; t2 uuid; c_top uuid; c_trial_top uuid;
  d1 uuid; d2 uuid; d_up uuid; e1 uuid; y1 uuid; y1b uuid; y2 uuid;
  f_old uuid; f_mid uuid; f_new uuid; f_after uuid; f_top uuid; f_wel uuid;
  h_old uuid; h_new uuid; h_x uuid; s1 uuid; s2 uuid;
  v_since timestamptz;
  j jsonb;
  tx bigint;
  n integer;
  g record;
  r record;
begin
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select i, 'rollover-smoke-' || i::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(array[a, b, i12, i11, i0, i4, c, d, e, f, h, s]) as i;
  insert into profiles (id, email) select i, 'rollover-smoke-' || i::text || '@example.test' from unnest(array[a, b, i12, i11, i0, i4, c, d, e, f, h, s]) as i on conflict (id) do nothing;

  -- ── Settings and the one-off ──
  if credit_setting_num('plan_credit_idle_months', 0) <> 12 then raise exception 'plan_credit_idle_months should be seeded at 12'; end if;
  if credit_setting_num('plan_credit_final_notice_days', 0) <> 30 then raise exception 'plan_credit_final_notice_days should be seeded at 30'; end if;
  if (select value from billing_settings where key = 'plan_credit_idle_reminder_months') <> '[3,6,12]'::jsonb then raise exception 'plan_credit_idle_reminder_months should be [3,6,12]'; end if;
  if not exists (select 1 from billing_settings where key = 'batch34_rollover_from') then raise exception 'the Batch 34 one-off should be marked'; end if;
  if not exists (select 1 from billing_settings where key = 'plan_credit_rollover_from' and jsonb_typeof(value) = 'string') then
    raise exception 'plan_credit_rollover_from should hold the launch date';
  end if;
  raise notice 'settings ok';

  -- ── Grant £19, spend £6, next cycle: £13 + £19 = £32 ──
  j := credit_plan_cycle(a, 1900, now() + interval '30 days', 'inv:roll1_' || a::text, 'Starter plan credit');
  if not (j->>'created')::boolean or (j->>'expired')::int <> 0 then raise exception 'first cycle should create: %', j; end if;
  g1 := (j->>'grant_id')::uuid;
  select * into g from credit_grants where id = g1;
  if g.expires_at is not null then raise exception 'a cycle grant must never expire, even when an expiry is passed: %', g.expires_at; end if;
  if not g.plan_cycle or g.kind <> 'plan' then raise exception 'a cycle grant should be a plan grant marked plan_cycle: %', g; end if;
  perform credit_debit(a, 600, null, false, '{}'::jsonb);
  update credit_grants set created_at = now() - interval '1 month' where id = g1;   -- last month's grant
  j := credit_plan_cycle(a, 1900, now() + interval '60 days', 'inv:roll2_' || a::text, 'Starter plan credit');
  if not (j->>'created')::boolean or (j->>'expired')::int <> 0 then raise exception 'the next cycle should create and expire nothing: %', j; end if;
  g2 := (j->>'grant_id')::uuid;
  select * into r from credit_available(a);
  if abs(r.plan_pence - 3200) > 0.01 then raise exception 'plan credit should be 1300 rolled over + 1900 = 3200, got %', r.plan_pence; end if;
  if (select remaining_pence from credit_grants where id = g1) <> 1300 then raise exception 'the old grant should keep its 1300'; end if;
  if exists (select 1 from credit_transactions where user_id = a and kind = 'expire') then raise exception 'a renewal must write no expire row'; end if;
  raise notice 'rollover ok: %', r;

  -- ── A replayed cycle adds nothing ──
  j := credit_plan_cycle(a, 1900, now() + interval '60 days', 'inv:roll2_' || a::text, 'Starter plan credit');
  if (j->>'created')::boolean or (j->>'expired')::int <> 0 or (j->>'grant_id')::uuid <> g2 then raise exception 'a replay should return the grant and create nothing: %', j; end if;
  select count(*) into n from credit_grants where user_id = a;
  if n <> 2 then raise exception 'a replay must not add a grant (% grants)', n; end if;
  select * into r from credit_available(a);
  if abs(r.plan_pence - 3200) > 0.01 then raise exception 'a replay must not change plan credit, got %', r.plan_pence; end if;
  raise notice 'replay ok';

  -- ── Refund goes back to the source grant ──
  tx := credit_debit(a, 1500, null, false, '{}'::jsonb);   -- 1300 from last month's grant, 200 from this month's
  if (select remaining_pence from credit_grants where id = g1) <> 0 or (select remaining_pence from credit_grants where id = g2) <> 1700 then
    raise exception 'the debit should drain the old plan grant first';
  end if;
  perform credit_refund(tx, null, 'Smoke refund');
  if (select remaining_pence from credit_grants where id = g1) <> 1300 or (select remaining_pence from credit_grants where id = g2) <> 1900 then
    raise exception 'the refund should go back to the grants it came from';
  end if;
  if exists (select 1 from credit_grants where user_id = a and kind = 'adjustment') then raise exception 'a refund of rolled-over credit must not make an adjustment grant'; end if;
  raise notice 'refund ok';

  -- ── Spend order: bonus, old plan, new plan, welcome, top-up ──
  g_bonus := credit_grant_pack_bonus(jsonb_build_object('user', b, 'amount', 100, 'source_ref', 'pack_bonus:smoke_roll_' || b::text));
  j := credit_plan_cycle(b, 100, null, 'inv:order1_' || b::text, 'Plan credit');
  g1 := (j->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '1 month' where id = g1;
  j := credit_plan_cycle(b, 100, null, 'inv:order2_' || b::text, 'Plan credit');
  g2 := (j->>'grant_id')::uuid;
  g_welcome := credit_grant(b, 'welcome', 100, null, 'welcome:smoke_roll_' || b::text, 'Welcome');
  g_top := credit_grant(b, 'topup', 130, null, 'smoke_roll_top:' || b::text, 'Top-up');
  if (select scope_lifted_at from credit_grants where id = g_bonus) is not null then raise exception 'the bonus should still be restricted'; end if;
  perform credit_debit(b, 150, null, false, jsonb_build_object('action', 'deal_open'));
  if (select remaining_pence from credit_grants where id = g_bonus) <> 0 or (select remaining_pence from credit_grants where id = g1) <> 50 then
    raise exception 'spend order: the bonus first, then the old plan grant';
  end if;
  perform credit_debit(b, 100, null, false, jsonb_build_object('action', 'deal_open'));
  if (select remaining_pence from credit_grants where id = g1) <> 0 or (select remaining_pence from credit_grants where id = g2) <> 50 then
    raise exception 'spend order: the old plan grant before the new one';
  end if;
  perform credit_debit(b, 100, null, false, jsonb_build_object('action', 'deal_open'));
  if (select remaining_pence from credit_grants where id = g2) <> 0 or (select remaining_pence from credit_grants where id = g_welcome) <> 50 then
    raise exception 'spend order: the new plan grant before welcome';
  end if;
  perform credit_debit(b, 100, null, false, jsonb_build_object('action', 'deal_open'));
  if (select remaining_pence from credit_grants where id = g_welcome) <> 0 or abs((select remaining_pence from credit_grants where id = g_top) - (130 - 50 * rate)) > 0.01 then
    raise exception 'spend order: welcome before the top-up';
  end if;
  raise notice 'spend order ok';

  -- ── The idle report ──
  -- i12: last month's grant made 14 months ago, this month's a month ago, an
  -- extra (non-cycle) plan grant after it, and a top-up; last spent 12 months
  -- and a day ago. i11 the same, last spent 11 months ago. i0 never spent.
  j := credit_plan_cycle(i12, 1900, null, 'inv:idle1_' || i12::text, 'Plan credit');
  g1 := (j->>'grant_id')::uuid;
  perform credit_debit(i12, 400, null, false, '{}'::jsonb);
  update credit_transactions set at = now() - interval '12 months 1 day' where user_id = i12 and kind = 'debit';
  update credit_grants set created_at = now() - interval '14 months' where id = g1;
  j := credit_plan_cycle(i12, 1900, null, 'inv:idle2_' || i12::text, 'Plan credit');
  g2 := (j->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '1 month' where id = g2;
  g_extra := credit_grant(i12, 'plan', 500, null, 'trial:smoke_idle_' || i12::text || ':1', 'Plan credit added after the renewal');
  perform credit_grant(i12, 'topup', 1000, null, 'smoke_idle_top:' || i12::text, 'Top-up');

  j := credit_plan_cycle(i11, 1900, null, 'inv:idle1_' || i11::text, 'Plan credit');
  perform credit_debit(i11, 400, null, false, '{}'::jsonb);
  update credit_transactions set at = now() - interval '11 months' where user_id = i11 and kind = 'debit';
  update credit_grants set created_at = now() - interval '14 months' where id = (j->>'grant_id')::uuid;

  j := credit_plan_cycle(i0, 1900, null, 'inv:idle1_' || i0::text, 'Plan credit');
  update credit_grants set created_at = now() - interval '14 months' where id = (j->>'grant_id')::uuid;

  -- The launch date protects everyone: the clock never starts before it.
  if exists (select 1 from credit_idle_plan_report() where user_id in (i12, i11, i0)) then
    raise exception 'nobody can be idle for 12 months from a launch date seconds ago';
  end if;
  update billing_settings set value = to_jsonb(now() - interval '3 years') where key = 'plan_credit_rollover_from';

  select * into r from credit_idle_plan_report() where user_id = i12;
  if not found then raise exception 'a member idle 12 months should be in the report'; end if;
  if r.last_spent_at <> now() - interval '12 months 1 day' or r.idle_since <> r.last_spent_at then raise exception 'i12 dates wrong: %', r; end if;
  if r.plan_remaining_pence <> 1500 + 1900 + 500 then raise exception 'i12 plan credit should be 3900 (top-up not counted), got %', r.plan_remaining_pence; end if;
  if r.expirable_pence <> 1500 then raise exception 'only grants before the newest cycle grant can lapse: expirable should be 1500, got %', r.expirable_pence; end if;
  if exists (select 1 from credit_idle_plan_report() where user_id = i11) then raise exception 'a member idle 11 months must not be in the report'; end if;
  select * into r from credit_idle_plan_report() where user_id = i0;
  if not found or r.last_spent_at is not null or r.idle_since <> now() - interval '3 years' then raise exception 'a member who never spent is idle since the launch date: %', r; end if;
  if r.expirable_pence <> 0 then raise exception 'a member with one cycle grant has nothing expirable, got %', r.expirable_pence; end if;
  if exists (select 1 from credit_idle_plan_report() where user_id in (a, b, c)) then raise exception 'active members must not be in the report'; end if;
  -- p_min_months: a member idle about 4 months is listed for the 3-month reminder, not by the default call.
  j := credit_plan_cycle(i4, 1900, null, 'inv:idle1_' || i4::text, 'Plan credit');
  perform credit_debit(i4, 400, null, false, '{}'::jsonb);
  update credit_transactions set at = now() - interval '4 months' where user_id = i4 and kind = 'debit';
  update credit_grants set created_at = now() - interval '5 months' where id = (j->>'grant_id')::uuid;
  if exists (select 1 from credit_idle_plan_report() where user_id = i4) then raise exception 'a member idle 4 months must not be in the default report'; end if;
  if exists (select 1 from credit_idle_plan_report(now(), null) where user_id = i4) then raise exception 'p_min_months null must behave as the default'; end if;
  select * into r from credit_idle_plan_report(now(), 3) where user_id = i4;
  if not found or r.idle_since <> now() - interval '4 months' or r.plan_remaining_pence <> 1500 then raise exception 'a member idle 4 months should be listed with p_min_months => 3: %', r; end if;
  if not exists (select 1 from credit_idle_plan_report(p_min_months => 3) where user_id = i12) then raise exception 'p_min_months => 3 should still list the 12-month member'; end if;
  if exists (select 1 from credit_idle_plan_report(now(), 6) where user_id = i4) then raise exception 'a member idle 4 months must not be listed with p_min_months => 6'; end if;
  if exists (select 1 from credit_idle_plan_report(now(), 3) where user_id in (a, b, c)) then raise exception 'active members must not be in the 3-month report'; end if;

  perform credit_debit(i12, 1, null, false, '{}'::jsonb);   -- a 1p spend resets the clock
  if exists (select 1 from credit_idle_plan_report() where user_id = i12) then raise exception 'a 1p debit should take the member out of the report'; end if;
  if (select count(*) from credit_transactions where user_id = i12 and kind = 'expire') <> 0 then raise exception 'the report must change nothing'; end if;
  raise notice 'idle report ok';

  -- ── The one-off's cycle flag skips an upgrade top-up ──
  -- Pre-launch grants (none marked): two renewals and, after the newer one, an
  -- upgrade's top-up (grantUpgradeDifference's description). The one-off's
  -- predicate, run on them: the renewals are marked, the top-up is not, so the
  -- newest renewal is the cycle start and only the older renewal can lapse.
  d1 := credit_grant(d, 'plan', 1900, null, 'inv:pre1_' || d::text, 'Starter plan credit');
  d2 := credit_grant(d, 'plan', 1900, null, 'inv:pre2_' || d::text, 'Starter plan credit');
  d_up := credit_grant(d, 'plan', 2000, null, 'inv:preup_' || d::text, 'Upgrade to Pro: extra plan credit');
  update credit_grants set plan_cycle = false, created_at = now() - interval '2 months' where id = d1;
  update credit_grants set plan_cycle = false, created_at = now() - interval '1 month' where id = d2;
  update credit_grants set plan_cycle = false, created_at = now() - interval '10 days' where id = d_up;
  if credit_batch34_cycle_candidate('plan', false, 'Upgrade to Scale: extra plan credit')
     or not credit_batch34_cycle_candidate('plan', false, 'Pro plan credit')
     or not credit_batch34_cycle_candidate('plan', false, null)
     or credit_batch34_cycle_candidate('plan', true, 'Pro plan credit')
     or credit_batch34_cycle_candidate('topup', false, 'Top-up') then
    raise exception 'credit_batch34_cycle_candidate: only unmarked plan grants that are not upgrade top-ups';
  end if;
  update credit_grants set plan_cycle = true where user_id = d and credit_batch34_cycle_candidate(kind, plan_cycle, description);
  if not (select plan_cycle from credit_grants where id = d1) or not (select plan_cycle from credit_grants where id = d2) then
    raise exception 'the one-off should mark the renewals as cycle grants';
  end if;
  if (select plan_cycle from credit_grants where id = d_up) then raise exception 'the one-off must not mark an upgrade top-up as a cycle grant'; end if;
  select * into r from credit_idle_plan_report() where user_id = d;
  if not found then raise exception 'd never spent and should be in the report'; end if;
  if r.plan_remaining_pence <> 5800 or r.expirable_pence <> 1900 then
    raise exception 'the newest renewal (not the top-up after it) starts the cycle: expirable should be 1900 of 5800, got %', r;
  end if;
  raise notice 'one-off cycle flag ok';

  -- ── Clawback: stops at zero, touches only matching plan grants ──
  c1 := (credit_plan_cycle(c, 1900, null, 'inv:claw1_' || c::text, 'Plan credit')->>'grant_id')::uuid;
  perform credit_debit(c, 500, null, false, '{}'::jsonb);   -- 1400 left on c1
  update credit_grants set created_at = now() - interval '1 month' where id = c1;
  c2 := (credit_plan_cycle(c, 1900, null, 'inv:claw2_' || c::text, 'Plan credit')->>'grant_id')::uuid;
  t1 := credit_grant(c, 'plan', 500, null, 'trial:sub_claw_' || c::text || ':1', 'Trial credit');
  update credit_grants set created_at = now() - interval '2 days' where id = t1;
  t2 := credit_grant(c, 'plan', 500, null, 'trial:sub_claw_' || c::text || ':2', 'Trial credit');
  c_top := credit_grant(c, 'topup', 1000, null, 'smoke_claw_top:' || c::text, 'Top-up');
  c_trial_top := credit_grant(c, 'topup', 1000, null, 'trial:sub_claw_' || c::text || ':x', 'A top-up whose ref matches');

  j := credit_expire_plan_source(c, 'inv:claw1\_' || c::text, 1900, 'invoice_refunded');
  if (j->>'expired_pence')::numeric <> 1400 or (j->>'grants')::int <> 1 then raise exception 'the clawback should stop at the 1400 left: %', j; end if;
  if (select remaining_pence from credit_grants where id = c1) <> 0 then raise exception 'the refunded invoice''s grant should be zero'; end if;
  if (select remaining_pence from credit_grants where id = c2) <> 1900 or (select remaining_pence from credit_grants where id = c_top) <> 1000 then
    raise exception 'the clawback must touch no other grant';
  end if;
  if not exists (select 1 from credit_transactions where user_id = c and kind = 'expire' and grant_id = c1 and amount_pence = -1400
                   and metadata->>'reason' = 'invoice_refunded' and description = 'Plan credit expired') then
    raise exception 'the clawback should write an expire row with the reason';
  end if;
  j := credit_expire_plan_source(c, 'inv:claw1\_' || c::text, 1900, 'invoice_refunded');
  if (j->>'expired_pence')::numeric <> 0 or (select count(*) from credit_transactions where user_id = c and kind = 'expire') <> 1 then
    raise exception 'a second clawback should remove nothing: %', j;
  end if;

  j := credit_expire_plan_source(c, 'trial:sub\_claw\_' || c::text || ':%', 700, 'trial_cancelled');
  if (j->>'expired_pence')::numeric <> 700 or (j->>'grants')::int <> 2 then raise exception 'the trial clawback should take 700 over two grants: %', j; end if;
  if (select remaining_pence from credit_grants where id = t1) <> 0 or (select remaining_pence from credit_grants where id = t2) <> 300 then
    raise exception 'the trial clawback should take the oldest trial grant first';
  end if;
  j := credit_expire_plan_source(c, 'trial:sub\_claw\_' || c::text || ':%', null, 'trial_cancelled');
  if (j->>'expired_pence')::numeric <> 300 then raise exception 'no limit should take what is left: %', j; end if;
  if (select remaining_pence from credit_grants where id = c_trial_top) <> 1000 or (select remaining_pence from credit_grants where id = c2) <> 1900 then
    raise exception 'the trial clawback must touch only plan grants that match';
  end if;
  if exists (select 1 from credit_grants where user_id = c and remaining_pence < 0) then raise exception 'no grant may go below zero'; end if;
  raise notice 'clawback ok';

  -- ── Cumulative totals (p_total): what was removed for the reason is read under the lock ──
  e1 := (credit_plan_cycle(e, 1000, null, 'inv:tot1_' || e::text, 'Plan credit')->>'grant_id')::uuid;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 300, 'plan_refunded', true);
  if (j->>'expired_pence')::numeric <> 300 then raise exception 'a 30%% total should remove 300: %', j; end if;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 600, 'plan_refunded', true);
  if (j->>'expired_pence')::numeric <> 300 then raise exception 'a 60%% total after 30%% should remove 300 more: %', j; end if;
  if (select remaining_pence from credit_grants where id = e1) <> 400 then raise exception 'totals of 30%% then 60%% should remove 600 in all, not 900'; end if;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 600, 'plan_refunded', true);
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'the same total again removes nothing: %', j; end if;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 300, 'plan_refunded', true);
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'a lower total than already removed removes nothing (never negative): %', j; end if;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 300, 'plan_refunded');
  if (j->>'expired_pence')::numeric <> 300 or (select remaining_pence from credit_grants where id = e1) <> 100 then
    raise exception 'without p_total the amount is removed as before: %', j;
  end if;
  j := credit_expire_plan_source(e, 'inv:tot1\_' || e::text, 5000, 'plan_disputed', true);
  if (j->>'expired_pence')::numeric <> 100 or (select remaining_pence from credit_grants where id = e1) <> 0 then
    raise exception 'a total never takes a grant below zero: %', j;
  end if;

  -- ── An annual year's window (p_created_from, p_created_to) ──
  y1 := credit_plan_cycle(e, 3900, null, 'annual:subE' || e::text || ':2024-01', 'Plan credit')->>'grant_id';
  y1b := credit_plan_cycle(e, 3900, null, 'annual:subE' || e::text || ':2024-02', 'Plan credit')->>'grant_id';
  y2 := credit_plan_cycle(e, 3900, null, 'annual:subE' || e::text || ':2025-01', 'Plan credit')->>'grant_id';
  update credit_grants set created_at = '2024-01-01 00:00:05+00' where id = y1;
  update credit_grants set created_at = '2024-02-01 03:00:00+00' where id = y1b;
  update credit_grants set created_at = '2025-01-01 00:00:05+00' where id = y2;
  perform credit_debit(e, 1000, null, false, '{}'::jsonb);   -- from the oldest plan grant: year 1's first slot
  if (select remaining_pence from credit_grants where id = y1) <> 2900 then raise exception 'the debit should come off year 1''s first slot'; end if;
  -- Year 1 refunded in full: the share of what the year granted (7800), less nothing removed yet.
  j := credit_expire_plan_source(e, 'annual:subE' || e::text || ':%', 7800, 'plan_refunded', true, '2024-01-01 00:00:00+00', '2025-01-01 00:00:00+00');
  if (j->>'expired_pence')::numeric <> 6800 or (j->>'grants')::int <> 2 then raise exception 'year 1''s refund should remove its two slots'' 6800: %', j; end if;
  if (select remaining_pence from credit_grants where id = y2) <> 3900 then raise exception 'year 1''s refund must not touch year 2''s slot'; end if;
  j := credit_expire_plan_source(e, 'annual:subE' || e::text || ':%', 7800, 'plan_refunded', true, '2024-01-01 00:00:00+00', '2025-01-01 00:00:00+00');
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'year 1''s refund again removes nothing: %', j; end if;
  -- Year 2: year 1's removals under the same reason are outside its window, so they do not count against it.
  j := credit_expire_plan_source(e, 'annual:subE' || e::text || ':%', 3900, 'plan_refunded', true, '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00');
  if (j->>'expired_pence')::numeric <> 3900 or (select remaining_pence from credit_grants where id = y2) <> 0 then raise exception 'year 2''s refund should remove its own slot: %', j; end if;
  if exists (select 1 from credit_grants where user_id = e and remaining_pence < 0) then raise exception 'no grant may go below zero'; end if;
  raise notice 'cumulative totals and annual window ok';

  -- ── Batch 34b: the live no-spend expiry (credit_expire_idle_plan) ──
  -- The launch date is 3 years ago (set above). f: a cycle grant 15 months
  -- ago, last spent 13 months ago; a trial plan grant 3 months ago; this
  -- month's cycle grant 5 days ago; a plan grant 10 days ago (after the final
  -- warning, sent 31 days ago); a top-up and welcome credit.
  update billing_settings set value = to_jsonb(now() - interval '3 years') where key = 'plan_credit_rollover_from';
  f_old := (credit_plan_cycle(f, 1900, null, 'inv:nospend1_' || f::text, 'Plan credit')->>'grant_id')::uuid;
  perform credit_debit(f, 100, null, false, '{}'::jsonb);   -- 1800 left on f_old
  update credit_transactions set at = now() - interval '13 months' where user_id = f and kind = 'debit';
  update credit_grants set created_at = now() - interval '15 months' where id = f_old;
  f_mid := credit_grant(f, 'plan', 500, null, 'trial:smoke_nospend_' || f::text || ':1', 'Trial credit');
  update credit_grants set plan_cycle = false, created_at = now() - interval '3 months' where id = f_mid;
  f_new := (credit_plan_cycle(f, 1900, null, 'inv:nospend2_' || f::text, 'Plan credit')->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '5 days' where id = f_new;
  f_after := credit_grant(f, 'plan', 200, null, 'trial:smoke_nospend_' || f::text || ':2', 'Trial credit');
  update credit_grants set plan_cycle = false, created_at = now() - interval '10 days' where id = f_after;
  f_top := credit_grant(f, 'topup', 1000, null, 'smoke_nospend_top:' || f::text, 'Top-up');
  update credit_grants set created_at = now() - interval '14 months' where id = f_top;
  f_wel := credit_grant(f, 'welcome', 100, null, 'welcome:smoke_nospend_' || f::text, 'Welcome');
  update credit_grants set created_at = now() - interval '14 months' where id = f_wel;

  select idle_since into v_since from credit_idle_plan_report() where user_id = f;
  if v_since is null or v_since <> now() - interval '13 months' then raise exception 'f should be idle since its last spend: %', v_since; end if;

  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'no_final_notice' then raise exception 'no notice: nothing expires: %', j; end if;

  insert into credit_idle_notices (user_id, idle_since, stage, status, sent_at) values (f, v_since, 12, 'sent', now() - interval '10 days');
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'notice_too_recent' then raise exception 'a final notice 10 days old expires nothing: %', j; end if;

  update credit_idle_notices set status = 'skipped', sent_at = null where user_id = f and stage = 12;
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'no_final_notice' then raise exception 'a skipped final stage never counts: %', j; end if;
  update credit_idle_notices set sent_at = now() - interval '31 days' where user_id = f and stage = 12;
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'a skipped final stage never counts, even with a date: %', j; end if;

  insert into credit_idle_notices (user_id, idle_since, stage, status, sent_at) values (f, v_since, 6, 'sent', now() - interval '200 days');
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'only the final stage (12) allows the expiry: %', j; end if;
  insert into credit_idle_notices (user_id, idle_since, stage, status, sent_at) values (f, v_since - interval '1 day', 12, 'sent', now() - interval '60 days');
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 then raise exception 'a final notice from another idle run never counts: %', j; end if;
  if exists (select 1 from credit_transactions where user_id = f and kind = 'expire') then raise exception 'nothing may have expired yet'; end if;

  update credit_idle_notices set status = 'sent' where user_id = f and idle_since = v_since and stage = 12;   -- sent 31 days ago
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 2300 or (j->>'grants')::int <> 2 or j ? 'reason' then
    raise exception 'an old enough final notice expires the two plan grants made before it and before the newest month (1800 + 500): %', j;
  end if;
  if (select remaining_pence from credit_grants where id = f_old) <> 0 or (select remaining_pence from credit_grants where id = f_mid) <> 0 then
    raise exception 'the old plan grants should be zero';
  end if;
  if (select remaining_pence from credit_grants where id = f_new) <> 1900 then raise exception 'the newest month must be kept'; end if;
  if (select remaining_pence from credit_grants where id = f_after) <> 200 then raise exception 'a plan grant made after the final notice must be kept'; end if;
  if (select remaining_pence from credit_grants where id = f_top) <> 1000 or (select remaining_pence from credit_grants where id = f_wel) <> 100 then
    raise exception 'top-up and welcome credit must never expire for no spend';
  end if;
  if (select count(*) from credit_transactions where user_id = f and kind = 'expire' and metadata->>'reason' = 'no_spend'
        and description = 'Plan credit expired' and grant_id in (f_old, f_mid)) <> 2
     or exists (select 1 from credit_transactions where user_id = f and kind = 'expire' and metadata->>'reason' is distinct from 'no_spend') then
    raise exception 'each expired grant gets one expire row with reason no_spend';
  end if;
  j := credit_expire_idle_plan(f);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'none_expirable'
     or (select count(*) from credit_transactions where user_id = f and kind = 'expire') <> 2 then
    raise exception 'a second call expires nothing more: %', j;
  end if;
  raise notice 'no-spend expiry ok';

  -- h: no cycle grant known = nothing expires; then the newest cycle grant
  -- (40 days ago) protects a plan grant made after it (35 days ago), even
  -- though that grant is older than the final notice (31 days ago).
  h_old := credit_grant(h, 'plan', 1000, null, 'trial:smoke_nospend_' || h::text || ':1', 'Trial credit');
  update credit_grants set plan_cycle = false, created_at = now() - interval '15 months' where id = h_old;
  select idle_since into v_since from credit_idle_plan_report() where user_id = h;
  if v_since is null or v_since <> now() - interval '3 years' then raise exception 'h never spent: idle since the launch date: %', v_since; end if;
  insert into credit_idle_notices (user_id, idle_since, stage, status, sent_at) values (h, v_since, 12, 'sent', now() - interval '31 days');
  j := credit_expire_idle_plan(h);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'no_cycle_grant' then raise exception 'no cycle grant known: nothing expires: %', j; end if;
  h_new := (credit_plan_cycle(h, 1900, null, 'inv:nospend1_' || h::text, 'Plan credit')->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '40 days' where id = h_new;
  h_x := credit_grant(h, 'plan', 300, null, 'trial:smoke_nospend_' || h::text || ':2', 'Trial credit');
  update credit_grants set plan_cycle = false, created_at = now() - interval '35 days' where id = h_x;
  j := credit_expire_idle_plan(h);
  if (j->>'expired_pence')::numeric <> 1000 or (j->>'grants')::int <> 1 then raise exception 'only the grant before the newest cycle grant expires: %', j; end if;
  if (select remaining_pence from credit_grants where id = h_new) <> 1900 or (select remaining_pence from credit_grants where id = h_x) <> 300 then
    raise exception 'the newest month and a grant made after it must be kept';
  end if;
  raise notice 'no-spend expiry newest month ok';

  -- s: final warning sent 40 days ago, then a 1p spend: the member is not
  -- idle now, and a year later it is a new idle run the old notice does not match.
  s1 := (credit_plan_cycle(s, 1900, null, 'inv:nospend1_' || s::text, 'Plan credit')->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '15 months' where id = s1;
  s2 := (credit_plan_cycle(s, 1900, null, 'inv:nospend2_' || s::text, 'Plan credit')->>'grant_id')::uuid;
  update credit_grants set created_at = now() - interval '1 month' where id = s2;
  select idle_since into v_since from credit_idle_plan_report() where user_id = s;
  insert into credit_idle_notices (user_id, idle_since, stage, status, sent_at) values (s, v_since, 12, 'sent', now() - interval '40 days');
  perform credit_debit(s, 1, null, false, '{}'::jsonb);
  j := credit_expire_idle_plan(s);
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'not_idle' then raise exception 'a 1p spend after the notice: nothing expires: %', j; end if;
  j := credit_expire_idle_plan(s, now() + interval '13 months');
  if (j->>'expired_pence')::numeric <> 0 or j->>'reason' <> 'no_final_notice' then raise exception 'a new idle run needs its own final notice: %', j; end if;
  if exists (select 1 from credit_transactions where user_id = s and kind = 'expire') then raise exception 'a spend after the notice must expire nothing'; end if;
  raise notice 'no-spend expiry after a spend ok';

  -- ── Service role only ──
  if has_function_privilege('authenticated', 'public.credit_idle_plan_report(timestamptz, int)', 'execute')
     or has_function_privilege('anon', 'public.credit_idle_plan_report(timestamptz, int)', 'execute')
     or has_function_privilege('authenticated', 'public.credit_expire_plan_source(uuid, text, numeric, text, boolean, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.credit_expire_plan_source(uuid, text, numeric, text, boolean, timestamptz, timestamptz)', 'execute') then
    raise exception 'the rollover functions are service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.credit_idle_plan_report(timestamptz, int)', 'execute')
     or not has_function_privilege('service_role', 'public.credit_expire_plan_source(uuid, text, numeric, text, boolean, timestamptz, timestamptz)', 'execute')
     or to_regprocedure('public.credit_expire_plan_source(uuid, text, numeric, text)') is not null
     or to_regprocedure('public.credit_idle_plan_report(timestamptz)') is not null then
    raise exception 'the service role should run the rollover functions';
  end if;
  if has_function_privilege('authenticated', 'public.credit_expire_idle_plan(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.credit_expire_idle_plan(uuid, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.credit_plan_idle_since(timestamptz, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.credit_plan_idle_after()', 'execute')
     or not has_function_privilege('service_role', 'public.credit_expire_idle_plan(uuid, timestamptz)', 'execute') then
    raise exception 'credit_expire_idle_plan is service-role only';
  end if;
  if has_table_privilege('anon', 'public.credit_idle_notices', 'select')
     or has_table_privilege('authenticated', 'public.credit_idle_notices', 'select')
     or has_table_privilege('authenticated', 'public.credit_idle_notices', 'insert')
     or not (select relrowsecurity from pg_class where oid = 'public.credit_idle_notices'::regclass) then
    raise exception 'credit_idle_notices is service-role only (RLS on, no grants to anon/authenticated)';
  end if;
  raise notice 'privileges ok';
end $$;

rollback;
