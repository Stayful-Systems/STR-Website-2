-- Batch 29 checks: the starter pack's bonus credit, the fresh-report cap and
-- the pay-again unlock. Run AFTER schema.sql: by hand in the Supabase SQL
-- editor, or by CI (.github/workflows/ci.yml, job "schema", after
-- credit-smoke.sql). One transaction, rolled back at the end: it leaves no data
-- behind. A failing check raises; success prints notices.
-- Expected figures use the live top-up spend rate (credit_spend_rate).
begin;

do $$
declare
  p uuid := gen_random_uuid();   -- a pack-only member
  q uuid := gen_random_uuid();   -- a member who joined before the pack (ordinary welcome credit)
  r uuid := gen_random_uuid();   -- a pack member who tops up afterwards
  s uuid := gen_random_uuid();   -- paid for a top-up BEFORE buying the pack
  t uuid := gen_random_uuid();   -- paid again before the bonus expired, recorded late
  w uuid := gen_random_uuid();   -- paid again only after the bonus expired
  c uuid := gen_random_uuid();   -- the fresh-report cap
  rate numeric := credit_spend_rate('topup');
  g_top uuid; g_bonus uuid; g_bonus2 uuid; g_welcome uuid;
  tx_open bigint; tx_fresh bigint; tx_saved bigint; tx_face bigint; tx_r bigint;
  res uuid; res2 uuid;
  ok boolean;
  n integer;
  j jsonb;
  v numeric;
  a record;
begin
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select i, 'pack-smoke-' || i::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(array[p, q, r, s, t, w, c]) as i;
  insert into profiles (id, email) select i, 'pack-smoke-' || i::text || '@example.test' from unnest(array[p, q, r, s, t, w, c]) as i on conflict (id) do nothing;

  -- ── The pack: £10 top-up (pi:<pack>) + £20 bonus, the way grant-server.ts grants it ──
  insert into starter_pack_purchases (payment_intent_id, user_id, status, price_pence, credit_pence, granted_at)
  values ('pi_smoke_pack_p', p, 'granted', 1000, 3000, now());
  g_top := credit_grant(p, 'topup', 1000, null, 'pi:pi_smoke_pack_p', 'Starter pack');
  g_bonus := credit_grant_pack_bonus(jsonb_build_object('user', p, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_p', 'description', 'Starter pack bonus credit'));
  g_bonus2 := credit_grant_pack_bonus(jsonb_build_object('user', p, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_p'));
  if g_bonus2 <> g_bonus then raise exception 'credit_grant_pack_bonus should be idempotent on source_ref'; end if;
  select count(*) into n from credit_grants where user_id = p;
  if n <> 2 then raise exception 'a replayed bonus must not add a grant (% grants)', n; end if;
  select * into a from credit_grants where id = g_bonus;
  if a.kind <> 'welcome' or a.scope is distinct from 'pack_bonus' or a.scope_lifted_at is not null then raise exception 'bonus not marked: %', a; end if;
  if a.expires_at is null or abs(extract(epoch from a.expires_at - (now() + interval '30 days'))) > 60 then raise exception 'bonus should expire 30 days from now, got %', a.expires_at; end if;
  if (select expires_at from credit_grants where id = g_top) is not null then raise exception 'the £10 paid must never expire'; end if;
  if member_paid_again_at(p) is not null then raise exception 'the pack''s own top-up grant is not a further payment'; end if;
  raise notice 'pack granted ok';

  -- ── Spendable per action ──
  v := credit_spendable_for(p, 'deal_open');
  if abs(v - (2000 + 1000 / rate)) > 0.01 then raise exception 'deal_open spendable wrong: %', v; end if;
  v := credit_spendable_for(p, 'full_analysis');
  if abs(v - 1000 / rate) > 0.01 then raise exception 'a fresh full analysis may only see the paid credit: %', v; end if;
  v := credit_spendable_for(p, 'full_analysis', '{"reused": true}'::jsonb);
  if abs(v - (2000 + 1000 / rate)) > 0.01 then raise exception 'a saved analysis may use the bonus: %', v; end if;
  if abs(credit_spendable_for(p, 'deal_open') - (select spendable_base_pence from credit_available(p))) > 0.0001 then
    raise exception 'for an action the bonus pays for, spendable must equal credit_available''s';
  end if;
  raise notice 'spendable per action ok';

  -- ── A deal open: paid from the bonus, first ──
  tx_open := credit_debit(p, 50, null, false, '{"action": "deal_open"}'::jsonb);
  select count(*) into n from credit_allocations where transaction_id = tx_open and grant_id <> g_bonus;
  if n <> 0 then raise exception 'a deal open must be paid from the bonus'; end if;
  -- ── A fresh full analysis: never the bonus ──
  tx_fresh := credit_debit(p, 200, null, false, '{"action": "full_analysis"}'::jsonb);
  select count(*) into n from credit_allocations where transaction_id = tx_fresh and grant_id = g_bonus;
  if n <> 0 then raise exception 'the bonus paid for a fresh report'; end if;
  if abs((select remaining_pence from credit_grants where id = g_top) - (1000 - 200 * rate)) > 0.01 then raise exception 'the fresh report should come from the paid credit'; end if;
  -- ── A saved analysis: the bonus ──
  tx_saved := credit_debit(p, 400, null, false, '{"action": "full_analysis", "reused": true}'::jsonb);
  select count(*) into n from credit_allocations where transaction_id = tx_saved and grant_id <> g_bonus;
  if n <> 0 then raise exception 'a saved analysis should be paid from the bonus'; end if;
  -- ── A daily pick: the bonus ──
  perform credit_debit(p, 10, null, true, '{"action": "cron:sourcing"}'::jsonb);
  if abs((select remaining_pence from credit_grants where id = g_bonus) - (2000 - 50 - 400 - 10)) > 0.01 then raise exception 'bonus balance wrong after opens, saved and a pick'; end if;
  raise notice 'allocation ok';

  -- ── PMI, call minutes and an unknown action never reach the bonus ──
  begin
    perform credit_debit(p, 1000, null, false, '{"action": "pmi_addon"}'::jsonb);
    raise exception 'PMI beyond the paid credit should have been refused';
  exception when sqlstate 'P0402' then null; end;
  begin
    perform credit_debit(p, 1000, null, false, '{"action": "some_future_action"}'::jsonb);
    raise exception 'an unknown action must not use the bonus';
  exception when sqlstate 'P0402' then null; end;
  begin
    perform credit_debit_face(p, 900, '{"action": "si_call"}'::jsonb);
    raise exception 'call minutes beyond the paid credit should have been refused';
  exception when sqlstate 'P0402' then null; end;
  tx_face := credit_debit_face(p, 100, '{"action": "si_call", "raw_cost_pence": 20}'::jsonb);
  select count(*) into n from credit_allocations where transaction_id = tx_face and grant_id = g_bonus;
  if n <> 0 then raise exception 'call minutes were paid from the bonus'; end if;
  v := credit_face_available_for(p, 'si_call');
  if abs(v - (select remaining_pence from credit_grants where id = g_top)) > 0.01 then raise exception 'face available for a call should be the paid credit only: %', v; end if;
  raise notice 'restricted actions ok';

  -- ── Reservations obey the rule ──
  v := credit_spendable_for(p, 'full_analysis');
  begin
    perform credit_reserve(p, 'full_analysis', gen_random_uuid(), v + 1);
    raise exception 'a fresh-report hold beyond the paid credit should have been refused';
  exception when sqlstate 'P0402' then null; end;
  res := credit_reserve(p, 'full_analysis_saved', gen_random_uuid(), v + 1);   -- the bonus may cover a saved analysis
  if abs(credit_spendable_for(p, 'full_analysis') - v) > 0.01 then raise exception 'a bonus-covered hold should not reduce what a fresh report can spend'; end if;
  res2 := credit_reserve(p, 'report', gen_random_uuid(), floor(v));
  begin
    perform credit_reserve(p, 'report', gen_random_uuid(), 2);
    raise exception 'a second paid-credit hold beyond what is left should have been refused';
  exception when sqlstate 'P0402' then null; end;
  begin
    perform credit_debit_face(p, 50, '{"action": "si_text"}'::jsonb);
    raise exception 'a face debit may not take paid credit an open hold needs (R2-13)';
  exception when sqlstate 'P0402' then null; end;
  perform credit_release(res);
  perform credit_release(res2);
  raise notice 'reservations ok';

  -- ── Refunds go back to the grant they came from ──
  tx_r := credit_refund(tx_open);
  select count(*) into n from credit_allocations where transaction_id = tx_r and grant_id <> g_bonus;
  if n <> 0 then raise exception 'a refunded deal open should go back to the bonus'; end if;
  tx_r := credit_refund(tx_fresh);
  select count(*) into n from credit_allocations where transaction_id = tx_r and grant_id <> g_top;
  if n <> 0 then raise exception 'a refunded fresh report should go back to the paid credit'; end if;
  -- An expired bonus: its share goes back to the same grant, never a new unrestricted one.
  update credit_grants set expires_at = now() - interval '1 minute' where id = g_bonus;
  select count(*) into n from credit_grants where user_id = p;
  tx_r := credit_refund(tx_saved);
  if (select count(*) from credit_grants where user_id = p) <> n then raise exception 'refunding into an expired bonus created a new grant'; end if;
  select count(*) into n from credit_allocations where transaction_id = tx_r and grant_id <> g_bonus;
  if n <> 0 then raise exception 'the expired bonus''s refund should go back to it'; end if;
  raise notice 'refunds ok';

  -- ── Expiry: only the bonus expires; the paid credit is untouched ──
  v := (select remaining_pence from credit_grants where id = g_top);
  perform credit_expire_due();
  if (select remaining_pence from credit_grants where id = g_bonus) <> 0 then raise exception 'the expired bonus should be zeroed'; end if;
  if (select remaining_pence from credit_grants where id = g_top) <> v then raise exception 'expiry touched the paid credit'; end if;
  if not exists (select 1 from credit_transactions where grant_id = g_bonus and kind = 'expire' and description = 'Starter pack bonus expired') then
    raise exception 'the expiry row should say "Starter pack bonus expired"';
  end if;
  raise notice 'expiry ok';

  -- ── Paying again lifts the restriction and the expiry ──
  insert into starter_pack_purchases (payment_intent_id, user_id, status, price_pence, credit_pence, granted_at) values ('pi_smoke_pack_r', r, 'granted', 1000, 3000, now());
  perform credit_grant(r, 'topup', 1000, null, 'pi:pi_smoke_pack_r');
  g_bonus := credit_grant_pack_bonus(jsonb_build_object('user', r, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_r'));
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id) values ('pi:pi_smoke_pack_r', r, 'starter_pack', 1000, 'pi_smoke_pack_r');
  if (select scope_lifted_at from credit_grants where id = g_bonus) is not null then raise exception 'the pack''s own payment must not lift the bonus'; end if;
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id) values ('pi:pi_smoke_topup_r', r, 'topup', 1000, 'pi_smoke_topup_r');
  select * into a from credit_grants where id = g_bonus;
  if a.scope_lifted_at is null or a.expires_at is not null then raise exception 'a top-up should lift the bonus: %', a; end if;
  if abs(credit_spendable_for(r, 'full_analysis') - credit_spendable_for(r, 'deal_open')) > 0.0001 then raise exception 'a lifted bonus pays for anything'; end if;
  tx_fresh := credit_debit(r, 100, null, false, '{"action": "full_analysis"}'::jsonb);
  if not exists (select 1 from credit_allocations where transaction_id = tx_fresh and grant_id = g_bonus) then raise exception 'a lifted bonus should pay for a fresh report (welcome first)'; end if;
  raise notice 'unlock on payment ok';

  -- ── Paid before the pack: never restricted ──
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id, paid_at) values ('pi:pi_smoke_before_s', s, 'topup', 1000, 'pi_smoke_before_s', now() - interval '3 days');
  g_bonus := credit_grant_pack_bonus(jsonb_build_object('user', s, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_s'));
  select * into a from credit_grants where id = g_bonus;
  if a.scope is distinct from 'pack_bonus' or a.scope_lifted_at is null or a.expires_at is not null then raise exception 'a member who had paid before should get the bonus lifted: %', a; end if;
  raise notice 'paid before the pack ok';

  -- ── The sweep lifts a bonus paid for before it expired (recorded late), and expires one paid for after ──
  g_bonus := credit_grant_pack_bonus(jsonb_build_object('user', t, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_t'));
  update credit_grants set expires_at = now() - interval '1 hour' where id = g_bonus;
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id, paid_at) values ('pi:pi_smoke_late_t', t, 'topup', 1000, 'pi_smoke_late_t', now() - interval '2 hours');
  g_bonus2 := credit_grant_pack_bonus(jsonb_build_object('user', w, 'amount', 2000, 'source_ref', 'pack_bonus:pi_smoke_pack_w'));
  update credit_grants set expires_at = now() - interval '2 hours' where id = g_bonus2;
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id, paid_at) values ('pi:pi_smoke_after_w', w, 'topup', 1000, 'pi_smoke_after_w', now() - interval '1 hour');
  perform credit_expire_due();
  select * into a from credit_grants where id = g_bonus;
  if a.remaining_pence <> 2000 or a.scope_lifted_at is null then raise exception 'a bonus paid for before it expired should be lifted, not expired: %', a; end if;
  if (select remaining_pence from credit_grants where id = g_bonus2) <> 0 then raise exception 'a bonus paid for only after it expired stays expired'; end if;
  raise notice 'sweep lift ok';

  -- ── The ordinary welcome credit is untouched: no scope, pays for anything ──
  g_welcome := credit_grant(q, 'welcome', 2000, null, 'welcome:' || q::text);
  if (select scope from credit_grants where id = g_welcome) is not null then raise exception 'the ordinary welcome credit must have no scope'; end if;
  tx_fresh := credit_debit(q, 200, null, false, '{"action": "full_analysis"}'::jsonb);
  if not exists (select 1 from credit_allocations where transaction_id = tx_fresh and grant_id = g_welcome) then raise exception 'welcome credit should pay for a fresh report'; end if;
  raise notice 'pre-pack member ok';

  -- ── The fresh-report cap: 3, race-safe, a released slot comes back ──
  for n in 1..3 loop
    j := pack_fresh_report_claim(jsonb_build_object('user', c, 'action_id', ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'kind', 'full_analysis', 'cap', 3, 'since', now() - interval '1 day'));
    if not (j->>'ok')::boolean then raise exception 'claim % refused: %', n, j; end if;
  end loop;
  j := pack_fresh_report_claim(jsonb_build_object('user', c, 'action_id', '00000000-0000-0000-0000-000000000004', 'kind', 'report', 'cap', 3));
  if (j->>'ok')::boolean then raise exception 'the 4th fresh report should be refused: %', j; end if;
  j := pack_fresh_report_claim(jsonb_build_object('user', c, 'action_id', '00000000-0000-0000-0000-000000000002', 'kind', 'full_analysis', 'cap', 3));
  if not (j->>'ok')::boolean then raise exception 'the same claim again is the same claim: %', j; end if;
  ok := pack_fresh_report_release('00000000-0000-0000-0000-000000000002');
  if not ok then raise exception 'release should report it released'; end if;
  j := pack_fresh_report_claim(jsonb_build_object('user', c, 'action_id', '00000000-0000-0000-0000-000000000004', 'kind', 'report', 'cap', 3));
  if not (j->>'ok')::boolean then raise exception 'a released slot should come back: %', j; end if;
  if (pack_member_state(jsonb_build_object('user', c))->>'fresh_used')::int <> 3 then raise exception 'pack_member_state fresh_used wrong'; end if;
  raise notice 'cap ok';

  -- ── pack_member_state ──
  j := pack_member_state(jsonb_build_object('user', r));
  if j->>'pack_at' is null or j->>'paid_again_at' is null or (j->>'bonus_pence')::numeric <> 0 then raise exception 'pack_member_state for a payer wrong: %', j; end if;

  -- ── The backfill runs once, and only on pack_bonus: grants ──
  insert into credit_grants (user_id, kind, priority, amount_pence, remaining_pence, spend_rate, source_ref, description)
  values (q, 'welcome', 2, 2000, 1500, 1, 'pack_bonus:pi_smoke_legacy_q', 'Starter pack bonus credit');
  delete from billing_settings where key = 'batch29_pack_bonus_marked_at';
  j := pack_bonus_backfill();
  if not (j->>'done')::boolean then raise exception 'backfill should run: %', j; end if;
  select * into a from credit_grants where source_ref = 'pack_bonus:pi_smoke_legacy_q';
  if a.scope is distinct from 'pack_bonus' or a.expires_at is null or abs(extract(epoch from a.expires_at - (now() + interval '30 days'))) > 60 then raise exception 'legacy bonus not marked / dated from release: %', a; end if;
  if (select scope from credit_grants where id = g_welcome) is not null then raise exception 'the backfill touched an ordinary welcome grant'; end if;
  j := pack_bonus_backfill();
  if (j->>'done')::boolean then raise exception 'the backfill must not run twice'; end if;
  raise notice 'backfill ok';

  -- ── Meta: RepeatPurchase is an accepted event name ──
  insert into meta_conversions (dedupe_key, event_id, event_name, user_id) values ('RepeatPurchase:' || r::text, 'pi_smoke_topup_r', 'RepeatPurchase', r);
  raise notice 'meta event ok';
end $$;

-- ── "Pack → paying" facts (/admin/weekly-active): one row per granted pack buyer ──
do $$
declare
  z uuid := gen_random_uuid();
  j jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  values (z, 'pack-smoke-facts@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now() - interval '12 days', now());
  insert into profiles (id, email) values (z, 'pack-smoke-facts@example.test') on conflict (id) do nothing;
  update profiles set created_at = now() - interval '12 days' where id = z;
  insert into starter_pack_purchases (payment_intent_id, user_id, status, price_pence, credit_pence, granted_at) values ('pi_smoke_pack_z', z, 'granted', 1000, 3000, now() - interval '10 days');
  insert into member_payments (id, user_id, kind, amount_pence, payment_intent_id, paid_at) values
    ('pi:pi_smoke_pack_z', z, 'starter_pack', 1000, 'pi_smoke_pack_z', now() - interval '10 days'),
    ('pi:pi_smoke_topup_z', z, 'topup', 1500, 'pi_smoke_topup_z', now() - interval '5 days'),
    ('inv:in_smoke_z', z, 'subscription', 1900, null, now() - interval '2 days');
  insert into activity_events (user_id, occurred_at, kind, extras) values
    (z, now() - interval '3 days', 'stage_move', '{"from": "kept", "to": "contacted"}'::jsonb),
    (z, now() - interval '9 days', 'stage_move', '{"from": "watching", "to": "kept"}'::jsonb);
  select x into j from jsonb_array_elements(pack_paying_facts('{"low_credit_pence": 500}'::jsonb)) as x where x->>'u' = z::text;
  if j is null then raise exception 'the pack buyer has no facts row'; end if;
  if jsonb_array_length(j->'paid') <> 2 then raise exception 'two further payments after the pack (the pack itself is not one): %', j->'paid'; end if;
  if j->>'contacted_at' is null then raise exception 'the move to Contacted within 30 days should count: %', j; end if;
  if (j->>'excluded')::boolean then raise exception 'not excluded'; end if;
  if (j->>'week_start')::date <> date_trunc('week', ((now() - interval '12 days') at time zone 'Europe/London'))::date then raise exception 'week_start is the UK Monday of sign-up: %', j->>'week_start'; end if;
  if j->>'campaign' is not null then raise exception 'untagged: %', j->>'campaign'; end if;
  raise notice 'pack paying facts ok';
end $$;

rollback;
