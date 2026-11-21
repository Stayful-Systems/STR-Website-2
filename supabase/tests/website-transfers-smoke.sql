-- Batch 37 checks: customer websites, Phase 5 (transfer to the operator). The
-- seeds, one OPEN transfer per website (a second is refused until the first is
-- cancelled or its overlap has ended), a unique random ref, every check on
-- website_transfers, the restrict on the website, and that the table is service
-- role only. Run AFTER schema.sql: by hand in the Supabase SQL editor, or by CI
-- (.github/workflows/ci.yml, job "schema", after websites-p4-smoke.sql). One
-- transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid;
  us uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  f uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  w uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  d uuid := gen_random_uuid();
  t1 uuid;
  t2 uuid;
  r1 text;
  n integer;
  i integer;
begin
  -- ── Two throwaway members (one website each), a website funnel apiece ──
  u := us[1];
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select x, 'transfer-smoke-' || x::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(us) as x;
  insert into profiles (id, email) select x, 'transfer-smoke-' || x::text || '@example.test' from unnest(us) as x on conflict (id) do nothing;
  for i in 1..2 loop
    insert into funnels (id, user_id, public_token, name, active, kind) values (f[i], us[i], 'transfer-smoke-' || f[i]::text, 'Website', false, 'website');
    insert into websites (id, user_id, funnel_id, slug, status, settings, pages) values (w[i], us[i], f[i], 'transfer-smoke-site-' || i::text, 'live', '{}'::jsonb, '{}'::jsonb);
  end loop;

  -- ── The seeds are the plan's ──
  if (select value from billing_settings where key = 'website_transfer_overlap_days') <> '30'::jsonb then raise exception 'website_transfer_overlap_days should seed 30'; end if;
  if (select value from billing_settings where key = 'website_transfer_stuck_days') <> '5'::jsonb then raise exception 'website_transfer_stuck_days should seed 5'; end if;
  if (select value from billing_settings where key = 'website_transfer_code_from') <> '"2027-02-09"'::jsonb then raise exception 'website_transfer_code_from should seed "2027-02-09"'; end if;
  raise notice 'seeds ok';

  -- ── The private bucket ──
  if exists (select 1 from storage.buckets where id = 'website-transfers' and public) then raise exception 'the website-transfers bucket must be private'; end if;
  raise notice 'bucket ok (%)', (select count(*) from storage.buckets where id = 'website-transfers');

  -- ── A first transfer: defaults, a random ref ──
  insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
  values (w[1], u, '123-reg', '123 Reg', 'none') returning id, ref into t1, r1;
  if r1 !~ '^[a-z0-9]{16,64}$' then raise exception 'the ref should be 16 to 64 lowercase letters and digits, got %', r1; end if;
  if (select export_state from website_transfers where id = t1) <> 'pending' then raise exception 'export_state should start pending'; end if;
  if (select domain_state from website_transfers where id = t1) <> 'none' then raise exception 'domain_state should start none'; end if;
  if (select export_attempts from website_transfers where id = t1) <> 0 then raise exception 'export_attempts should start 0'; end if;
  if (select snapshot from website_transfers where id = t1) <> '{}'::jsonb then raise exception 'snapshot should start empty'; end if;
  raise notice 'insert ok';

  -- ── One open transfer per website ──
  begin
    insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
    values (w[1], u, 'namecheap', 'Namecheap', 'none');
    raise exception 'a second open transfer for one website was accepted';
  exception when unique_violation then null;
  end;
  -- Another website is its own.
  insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
  values (w[2], us[2], 'namecheap', 'Namecheap', 'none') returning id into t2;
  -- Cancelled: the slot is free again, and the cancelled row stays.
  update website_transfers set cancelled_at = now(), cancelled_by = gen_random_uuid() where id = t1;
  insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
  values (w[1], u, 'ionos', 'IONOS', 'none') returning id into t1;
  select count(*) into n from website_transfers where website_id = w[1];
  if n <> 2 then raise exception 'a cancelled transfer should stay as a row, got % rows', n; end if;
  begin
    insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
    values (w[1], u, 'godaddy', 'GoDaddy', 'none');
    raise exception 'a second open transfer after a cancel was accepted';
  exception when unique_violation then null;
  end;
  -- Overlap ended: the slot is free again.
  update website_transfers set overlap_ended_at = now() where id = t1;
  insert into website_transfers (website_id, owner_id, provider_key, provider_name, method)
  values (w[1], u, 'godaddy', 'GoDaddy', 'none');
  select count(*) into n from website_transfers where website_id = w[1];
  if n <> 3 then raise exception 'three rows expected for website 1, got %', n; end if;
  raise notice 'one open transfer per website ok';

  -- ── The ref is unique ──
  begin
    insert into website_transfers (website_id, owner_id, provider_key, provider_name, method, ref, cancelled_at)
    select w[2], us[2], 'x', 'X', 'none', r1, now();
    raise exception 'a repeated ref was accepted';
  exception when unique_violation then null;
  end;
  begin
    update website_transfers set ref = r1 where id = t2;
    raise exception 'updating to a repeated ref was accepted';
  exception when unique_violation then null;
  end;
  raise notice 'ref unique ok';

  -- ── Checks are enforced ──
  begin update website_transfers set method = 'post' where id = t2; raise exception 'an unknown method was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set export_state = 'done' where id = t2; raise exception 'an unknown export_state was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set domain_state = 'transferred' where id = t2; raise exception 'an unknown domain_state was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set export_attempts = -1 where id = t2; raise exception 'a negative export_attempts was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set export_error = repeat('x', 201) where id = t2; raise exception 'a 201-character export_error was accepted';
  exception when check_violation then null; end;
  update website_transfers set export_error = repeat('x', 200) where id = t2;
  begin update website_transfers set ips_tag = 'lower' where id = t2; raise exception 'a lowercase ips_tag was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set ips_tag = '-X' where id = t2; raise exception 'an ips_tag starting with a hyphen was accepted';
  exception when check_violation then null; end;
  update website_transfers set ips_tag = 'NAMECHEAP-INC', method = 'tag', domain_state = 'pending' where id = t2;
  begin update website_transfers set ref = 'SHORT' where id = t2; raise exception 'a short ref was accepted';
  exception when check_violation then null; end;
  begin update website_transfers set ref = repeat('A', 32) where id = t2; raise exception 'an uppercase ref was accepted';
  exception when check_violation then null; end;
  begin insert into website_transfers (website_id, owner_id, provider_name, method) values (w[2], us[2], 'No key', 'none'); raise exception 'a transfer without a provider_key was accepted';
  exception when not_null_violation then null; end;
  raise notice 'checks ok';

  -- ── Each ref is different by default ──
  if (select count(distinct ref) from website_transfers) <> (select count(*) from website_transfers) then raise exception 'default refs should all differ'; end if;

  -- ── A website with a transfer row is never deleted from under it ──
  begin
    delete from websites where id = w[2];
    raise exception 'a website with a transfer row was deleted';
  exception when foreign_key_violation then null;
  end;
  -- Nor a domain row a transfer points at.
  insert into website_domains (id, website_id, owner_id, name) values (d, w[2], us[2], 'transfer-smoke-2.co.uk');
  update website_transfers set domain_id = d, domain_name = 'transfer-smoke-2.co.uk' where id = t2;
  begin
    delete from website_domains where id = d;
    raise exception 'a domain row a transfer points at was deleted';
  exception when foreign_key_violation then null;
  end;
  raise notice 'restrict ok';

  -- ── Service role only ──
  if not (select relrowsecurity from pg_class where oid = 'public.website_transfers'::regclass) then raise exception 'row level security should be on'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'website_transfers') then raise exception 'website_transfers should have no policy'; end if;
  if has_table_privilege('anon', 'public.website_transfers', 'select') or has_table_privilege('authenticated', 'public.website_transfers', 'select') then
    raise exception 'anon and authenticated should have no access to website_transfers';
  end if;
  raise notice 'service role only ok';
end $$;

rollback;
