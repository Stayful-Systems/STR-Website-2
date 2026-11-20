-- Batch 33 checks: customer website domains. The daily spend cap and its
-- claims, one active domain per site, and the once-only yearly charge. Run
-- AFTER schema.sql: by hand in the Supabase SQL editor, or by CI
-- (.github/workflows/ci.yml, job "schema", after websites-smoke.sql). One
-- transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  f uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  w uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  d uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  i integer;
  r text;
  j jsonb;
  ok boolean;
  tx_count integer;
  pay uuid;
  broke uuid;
  short uuid;
  g uuid;
begin
  -- ── Throwaway members, a website funnel, a website and a domain row each ──
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select x, 'dom-smoke-' || x::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(u) as x;
  insert into profiles (id, email) select x, 'dom-smoke-' || x::text || '@example.test' from unnest(u) as x on conflict (id) do nothing;
  for i in 1..4 loop
    insert into funnels (id, user_id, public_token, name, active, kind) values (f[i], u[i], 'dom-smoke-' || f[i]::text, 'Website', false, 'website');
    insert into websites (id, user_id, funnel_id, slug) values (w[i], u[i], f[i], 'dom-smoke-site-' || i::text);
    insert into website_domains (id, website_id, owner_id, name) values (d[i], w[i], u[i], 'dom-smoke-' || i::text || '.co.uk');
  end loop;

  -- ── The seeds are the plan's ──
  if (select value from billing_settings where key = 'domain_charge_on') <> 'false'::jsonb then raise exception 'domain_charge_on should seed false'; end if;
  if (select value from billing_settings where key = 'domain_daily_spend_cap_pence') <> '5000'::jsonb then raise exception 'domain_daily_spend_cap_pence should seed 5000'; end if;
  if (select value from billing_settings where key = 'domain_auto_buy') <> 'true'::jsonb then raise exception 'domain_auto_buy should seed true'; end if;
  raise notice 'seeds ok';

  -- ── Table rules ──
  if (select status from website_domains where id = d[1]) <> 'awaiting_admin' then raise exception 'a new domain should start awaiting_admin'; end if;
  begin
    insert into website_domains (website_id, owner_id, name) values (w[1], u[1], 'second-for-same-site.co.uk');
    raise exception 'a second active domain for the same site was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into website_domains (website_id, owner_id, name) values (w[2], u[2], 'dom-smoke-1.co.uk');
    raise exception 'the same name twice was accepted';
  exception when unique_violation then null;
  end;
  begin
    update website_domains set name = 'bad.com' where id = d[1];
    raise exception 'a name outside .co.uk was accepted';
  exception when check_violation then null;
  end;
  begin
    update website_domains set name = 'xn--bcher-kva.co.uk' where id = d[1];
    raise exception 'an xn-- name was accepted';
  exception when check_violation then null;
  end;
  begin
    update website_domains set name = '-bad.co.uk' where id = d[1];
    raise exception 'a leading hyphen was accepted';
  exception when check_violation then null;
  end;
  begin
    update website_domains set status = 'bought' where id = d[1];
    raise exception 'a bad status was accepted';
  exception when check_violation then null;
  end;
  begin
    update website_domains set last_error = repeat('x', 201) where id = d[1];
    raise exception 'a 201 character error was accepted';
  exception when check_violation then null;
  end;
  begin
    delete from websites where id = w[1];
    raise exception 'a website with a domain row was deleted';
  exception when foreign_key_violation then null;
  end;
  -- A released domain frees the site and the name.
  update website_domains set status = 'released' where id = d[4];
  insert into website_domains (website_id, owner_id, name) values (w[4], u[4], 'dom-smoke-4.co.uk');
  begin
    update websites set domain = 'dom-smoke-1.co.uk' where id = w[1];
    update websites set domain = 'DOM-SMOKE-1.co.uk' where id = w[2];
    raise exception 'one domain on two websites was accepted';
  exception when unique_violation then null;
  end;
  update websites set domain = null where id in (w[1], w[2]);
  raise notice 'table rules ok';

  -- ── The spend cap: £50, a £30 claim wins, a second £30 does not ──
  update billing_settings set value = '5000'::jsonb where key = 'domain_daily_spend_cap_pence';
  r := website_domain_spend_claim(d[1], 'register', 3000, 'register:' || d[1]::text);
  if r <> 'claimed' then raise exception 'the first £30 claim should win, got %', r; end if;
  r := website_domain_spend_claim(d[2], 'register', 3000, 'register:' || d[2]::text);
  if r <> 'over_cap' then raise exception 'a second £30 claim should be over the £50 cap, got %', r; end if;
  -- The same key twice: already, and it costs nothing more.
  r := website_domain_spend_claim(d[1], 'register', 3000, 'register:' || d[1]::text);
  if r <> 'already' then raise exception 'the same key twice should be already, got %', r; end if;
  if (select sum(pence) from website_domain_spend where uk_day = website_uk_day() and status in ('claimed', 'bought')) <> 3000 then raise exception 'a repeat claim must not add spend'; end if;
  -- A smaller claim that fits still wins.
  r := website_domain_spend_claim(d[2], 'register', 2000, 'register:' || d[2]::text);
  if r <> 'claimed' then raise exception 'a £20 claim fits under £50, got %', r; end if;
  -- Settling to bought keeps it counted; the same key is still already.
  if not website_domain_spend_settle('register:' || d[1]::text, 'bought', 'op-123') then raise exception 'settle should move a claimed row'; end if;
  if (select status from website_domain_spend where key = 'register:' || d[1]::text) <> 'bought' then raise exception 'not bought'; end if;
  if website_domain_spend_settle('register:' || d[1]::text, 'void') then raise exception 'a bought spend must never be voided'; end if;
  r := website_domain_spend_claim(d[1], 'register', 3000, 'register:' || d[1]::text);
  if r <> 'already' then raise exception 'a bought key should stay already, got %', r; end if;
  raise notice 'cap and keys ok';

  -- ── A void claim no longer counts ──
  if not website_domain_spend_settle('register:' || d[2]::text, 'void') then raise exception 'settle should void a claimed row'; end if;
  r := website_domain_spend_claim(d[3], 'register', 2000, 'register:' || d[3]::text);
  if r <> 'claimed' then raise exception 'voiding the £20 should leave room for another £20, got %', r; end if;
  -- ... and the voided key can be claimed again (it is counted again).
  r := website_domain_spend_claim(d[2], 'register', 2000, 'register:' || d[2]::text);
  if r <> 'over_cap' then raise exception 'the voided key re-claimed over the cap should be over_cap, got %', r; end if;
  update website_domain_spend set status = 'void' where key = 'register:' || d[3]::text;
  r := website_domain_spend_claim(d[2], 'register', 2000, 'register:' || d[2]::text);
  if r <> 'claimed' then raise exception 'a voided key can be claimed again, got %', r; end if;
  raise notice 'void ok';

  -- ── The cap at £0: nothing can be claimed ──
  update website_domain_spend set status = 'void';
  update billing_settings set value = '0'::jsonb where key = 'domain_daily_spend_cap_pence';
  r := website_domain_spend_claim(d[1], 'renew', 1, 'renew:' || d[1]::text || ':2027');
  if r <> 'over_cap' then raise exception 'a £0 cap should refuse even 1p, got %', r; end if;
  -- A cap setting that is not a whole number falls back to the default and never raises.
  update billing_settings set value = '"lots"'::jsonb where key = 'domain_daily_spend_cap_pence';
  r := website_domain_spend_claim(d[1], 'renew', 1, 'renew:' || d[1]::text || ':2027');
  if r <> 'claimed' then raise exception 'a bad cap setting should fall back to the default, got %', r; end if;
  update billing_settings set value = '5000'::jsonb where key = 'domain_daily_spend_cap_pence';
  -- A claim for nothing, or with no key, is refused outright.
  begin
    perform website_domain_spend_claim(d[1], 'register', 0, 'register:zero');
    raise exception 'a zero claim was accepted';
  exception when raise_exception then if sqlerrm not like 'website_domain_spend_claim_bad_input%' then raise; end if;
  end;
  begin
    perform website_domain_spend_claim(d[1], 'buy', 100, 'register:badkind');
    raise exception 'a bad kind was accepted';
  exception when raise_exception then if sqlerrm not like 'website_domain_spend_claim_bad_input%' then raise; end if;
  end;
  raise notice 'zero cap ok';

  -- ── website_domain_charge: once, then already_charged; short balance records unpaid ──
  pay := u[1]; broke := u[2]; short := u[3];
  g := credit_grant(pay, 'topup', 5000, null, 'pi:dom_smoke_pay', 'Smoke top-up');
  perform credit_grant(short, 'topup', 100, null, 'pi:dom_smoke_short', 'Smoke small top-up');

  j := website_domain_charge(jsonb_build_object('owner', pay, 'domain', d[1], 'period', '2027', 'pence', 600));
  if j->>'result' <> 'charged' then raise exception 'first charge should be charged: %', j; end if;
  select count(*) into tx_count from credit_transactions where user_id = pay and kind = 'debit';
  if tx_count <> 1 then raise exception 'expected one debit, got %', tx_count; end if;
  j := website_domain_charge(jsonb_build_object('owner', pay, 'domain', d[1], 'period', '2027', 'pence', 600));
  if j->>'result' <> 'already_charged' then raise exception 'second charge should be already_charged: %', j; end if;
  select count(*) into tx_count from credit_transactions where user_id = pay and kind = 'debit';
  if tx_count <> 1 then raise exception 'a repeat charge debited again (%)', tx_count; end if;
  -- A different year is a different charge.
  j := website_domain_charge(jsonb_build_object('owner', pay, 'domain', d[1], 'period', '2028', 'pence', 600));
  if j->>'result' <> 'charged' then raise exception 'a new period should charge: %', j; end if;

  -- No credit at all: unpaid, nothing raised, nothing debited.
  j := website_domain_charge(jsonb_build_object('owner', broke, 'domain', d[2], 'period', '2027', 'pence', 600));
  if j->>'result' <> 'unpaid' then raise exception 'a member with no credit should record unpaid: %', j; end if;
  select count(*) into tx_count from credit_transactions where user_id = broke and kind = 'debit';
  if tx_count <> 0 then raise exception 'an unpaid charge must not debit'; end if;
  -- Some credit, but short of the price: unpaid, the balance untouched.
  j := website_domain_charge(jsonb_build_object('owner', short, 'domain', d[3], 'period', '2027', 'pence', 600));
  if j->>'result' <> 'unpaid' then raise exception 'a short balance should record unpaid: %', j; end if;
  if abs((select sum(remaining_pence) from credit_grants where user_id = short) - 100) > 0.01 then raise exception 'a short balance must be left untouched'; end if;
  -- An unpaid year is recorded once: asking again does not retry the debit.
  perform credit_grant(short, 'topup', 5000, null, 'pi:dom_smoke_short2', 'Smoke top-up 2');
  j := website_domain_charge(jsonb_build_object('owner', short, 'domain', d[3], 'period', '2027', 'pence', 600));
  if j->>'result' <> 'already_charged' or j->>'status' <> 'unpaid' then raise exception 'an unpaid year must stay recorded as unpaid: %', j; end if;
  -- Bad input raises.
  begin
    perform website_domain_charge(jsonb_build_object('owner', pay, 'domain', d[1], 'period', '2029'));
    raise exception 'a charge with no price was accepted';
  exception when raise_exception then if sqlerrm not like 'website_domain_charge_bad_input%' then raise; end if;
  end;
  raise notice 'charge ok';

  -- ── The functions are for the service role only ──
  for r in select unnest(array['website_domain_spend_claim(uuid,text,integer,text)', 'website_domain_spend_settle(text,text,text)', 'website_domain_charge(jsonb)']) loop
    if has_function_privilege('anon', r, 'execute') or has_function_privilege('authenticated', r, 'execute') then raise exception '% must not be callable by members', r; end if;
    if not has_function_privilege('service_role', r, 'execute') then raise exception '% must be callable by the service role', r; end if;
  end loop;

  -- ── Tables locked down: members never write, never read the spend or the charges ──
  for r in select unnest(array['website_domain_offers', 'website_domains', 'website_domain_spend', 'website_domain_charges']) loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || r)::regclass) then raise exception '% must have RLS on', r; end if;
    if has_table_privilege('anon', 'public.' || r, 'select') then raise exception '% must not be readable by anon', r; end if;
    if has_table_privilege('authenticated', 'public.' || r, 'insert') or has_table_privilege('authenticated', 'public.' || r, 'update') or has_table_privilege('authenticated', 'public.' || r, 'delete') then
      raise exception '% must not be writable by a member', r;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.website_domain_spend', 'select') or has_table_privilege('authenticated', 'public.website_domain_charges', 'select') then
    raise exception 'the spend and charge records must not be readable by members';
  end if;
  if has_column_privilege('authenticated', 'public.website_domains', 'last_error', 'select')
     or has_column_privilege('authenticated', 'public.website_domains', 'registrar_ref', 'select')
     or has_column_privilege('authenticated', 'public.website_domains', 'cost_pence', 'select') then
    raise exception 'a member must not read a domain''s error, registrar reference or cost';
  end if;
  raise notice 'locked down ok';
end $$;

-- ── A member reads their own domain and offer, and nobody else's ──
do $$
declare a uuid; b uuid; n integer; wa uuid;
begin
  select owner_id into a from website_domains where name = 'dom-smoke-1.co.uk';
  select owner_id into b from website_domains where name = 'dom-smoke-2.co.uk';
  select website_id into wa from website_domains where name = 'dom-smoke-1.co.uk';
  insert into website_domain_offers (website_id, names, prices) values (wa, array['dom-smoke-1.co.uk'], '{"dom-smoke-1.co.uk": 600}'::jsonb);
  begin
    insert into website_domain_offers (website_id, names) select website_id, array['a.co.uk','b.co.uk','c.co.uk','d.co.uk','e.co.uk','f.co.uk','g.co.uk'] from website_domains where name = 'dom-smoke-2.co.uk';
    raise exception 'an offer of seven names was accepted';
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  select count(*) into n from public.website_domains;
  if n <> 1 then reset role; raise exception 'a member should read exactly their own domain, saw %', n; end if;
  select count(*) into n from public.website_domain_offers;
  if n <> 1 then reset role; raise exception 'a member should read exactly their own offer, saw %', n; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', b::text, true);
  set local role authenticated;
  select count(*) into n from public.website_domains where name = 'dom-smoke-1.co.uk';
  if n <> 0 then reset role; raise exception 'a member must not read another member''s domain'; end if;
  select count(*) into n from public.website_domain_offers;
  reset role;
  if n <> 0 then raise exception 'a member must not read another member''s offer'; end if;
  raise notice 'own-domain policies ok';
end $$;

rollback;
