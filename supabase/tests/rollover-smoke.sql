-- Batch 32 checks: plan credit rollover. A renewal adds to unused plan credit
-- instead of wiping it, the spend order, refunds, the idle-member report and
-- the targeted removal of a refunded payment's or a trial's plan credit. Run
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
  c uuid := gen_random_uuid();   -- clawback
  rate numeric := credit_spend_rate('topup');
  g1 uuid; g2 uuid; g_extra uuid; g_bonus uuid; g_welcome uuid; g_top uuid;
  c1 uuid; c2 uuid; t1 uuid; t2 uuid; c_top uuid; c_trial_top uuid;
  j jsonb;
  tx bigint;
  n integer;
  g record;
  r record;
begin
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select i, 'rollover-smoke-' || i::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(array[a, b, i12, i11, i0, c]) as i;
  insert into profiles (id, email) select i, 'rollover-smoke-' || i::text || '@example.test' from unnest(array[a, b, i12, i11, i0, c]) as i on conflict (id) do nothing;

  -- ── Settings and the one-off ──
  if credit_setting_num('plan_credit_idle_months', 0) <> 12 then raise exception 'plan_credit_idle_months should be seeded at 12'; end if;
  if credit_setting_num('plan_credit_final_notice_days', 0) <> 30 then raise exception 'plan_credit_final_notice_days should be seeded at 30'; end if;
  if (select value from billing_settings where key = 'plan_credit_idle_reminder_months') <> '[3,6,12]'::jsonb then raise exception 'plan_credit_idle_reminder_months should be [3,6,12]'; end if;
  if not exists (select 1 from billing_settings where key = 'batch32_rollover_from') then raise exception 'the Batch 32 one-off should be marked'; end if;
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

  perform credit_debit(i12, 1, null, false, '{}'::jsonb);   -- a 1p spend resets the clock
  if exists (select 1 from credit_idle_plan_report() where user_id = i12) then raise exception 'a 1p debit should take the member out of the report'; end if;
  if (select count(*) from credit_transactions where user_id = i12 and kind = 'expire') <> 0 then raise exception 'the report must change nothing'; end if;
  raise notice 'idle report ok';

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

  -- ── Service role only ──
  if has_function_privilege('authenticated', 'public.credit_idle_plan_report(timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.credit_idle_plan_report(timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.credit_expire_plan_source(uuid, text, numeric, text)', 'execute')
     or has_function_privilege('anon', 'public.credit_expire_plan_source(uuid, text, numeric, text)', 'execute') then
    raise exception 'the rollover functions are service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.credit_idle_plan_report(timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.credit_expire_plan_source(uuid, text, numeric, text)', 'execute') then
    raise exception 'the service role should run the rollover functions';
  end if;
  raise notice 'privileges ok';
end $$;

rollback;
