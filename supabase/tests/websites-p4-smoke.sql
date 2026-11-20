-- Batch 36 checks: customer websites, Phase 4. Version publish and snapshot,
-- the 10-version cap, the once-only warning notice, and that a websites row
-- with a domain row is still never deleted from under it. Run AFTER
-- schema.sql: by hand in the Supabase SQL editor, or by CI
-- (.github/workflows/ci.yml, job "schema", after domains-smoke.sql). One
-- transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  f uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  w uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  i integer;
  j jsonb;
  n integer;
  v integer;
  ep timestamptz := now();
  s0 jsonb := '{"companyName":"Harbour"}'::jsonb;
  p0 jsonb := '{"home":{"title":"Home"}}'::jsonb;
begin
  -- ── Throwaway members, a website funnel and a website each ──
  insert into auth.users (id, email, raw_user_meta_data, instance_id, aud, role, created_at, updated_at)
  select x, 'p4-smoke-' || x::text || '@example.test', '{}'::jsonb, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now()
    from unnest(u) as x;
  insert into profiles (id, email) select x, 'p4-smoke-' || x::text || '@example.test' from unnest(u) as x on conflict (id) do nothing;
  for i in 1..2 loop
    insert into funnels (id, user_id, public_token, name, active, kind) values (f[i], u[i], 'p4-smoke-' || f[i]::text, 'Website', false, 'website');
    insert into websites (id, user_id, funnel_id, slug, status, settings, pages) values (w[i], u[i], f[i], 'p4-smoke-site-' || i::text, 'live', s0, p0);
  end loop;

  -- ── The seeds are the plan's ──
  if (select value from billing_settings where key = 'website_abandon_days') <> '90'::jsonb then raise exception 'website_abandon_days should seed 90'; end if;
  if (select value from billing_settings where key = 'website_warning_days') <> '"30,14,3"'::jsonb then raise exception 'website_warning_days should seed "30,14,3"'; end if;
  if (select value from billing_settings where key = 'website_delete_after_days') <> '90'::jsonb then raise exception 'website_delete_after_days should seed 90'; end if;
  raise notice 'seeds ok';

  -- ── The new columns start at zero ──
  if (select edit_rewrites_used from websites where id = w[1]) <> 0 then raise exception 'edit_rewrites_used should start at 0'; end if;
  begin
    update websites set edit_rewrites_used = -1 where id = w[1];
    raise exception 'a negative edit_rewrites_used was accepted';
  exception when check_violation then null;
  end;

  -- ── Snapshot: version 1 is the site as approved, once ──
  v := website_version_snapshot(w[1], u[1]);
  if v <> 1 then raise exception 'the first snapshot should be version 1, got %', v; end if;
  v := website_version_snapshot(w[1], u[1]);
  if v <> 1 then raise exception 'a second snapshot should still return 1, got %', v; end if;
  select count(*) into n from website_versions where website_id = w[1];
  if n <> 1 then raise exception 'snapshot twice should leave one version, got %', n; end if;
  if (select kind from website_versions where website_id = w[1] and version_no = 1) <> 'approved' then raise exception 'version 1 should be kind approved'; end if;
  if (select settings from website_versions where website_id = w[1] and version_no = 1) <> s0 then raise exception 'version 1 should hold the live settings'; end if;
  raise notice 'snapshot ok';

  -- ── Publish: moves the live site, deletes the draft, numbers the version ──
  insert into website_drafts (website_id, settings, pages, base_version) values (w[1], '{"companyName":"Harbour Two"}', p0, 1);
  j := website_version_publish(w[1], 1, '{"companyName":"Harbour Two"}', p0, 'publish', null, u[1]);
  if j->>'result' <> 'published' or (j->>'version_no')::int <> 2 then raise exception 'publish on the current base should be version 2, got %', j; end if;
  if (select settings->>'companyName' from websites where id = w[1]) <> 'Harbour Two' then raise exception 'publish should copy settings onto the site'; end if;
  if exists (select 1 from website_drafts where website_id = w[1]) then raise exception 'publish should delete the draft'; end if;

  -- ── A stale base changes nothing ──
  j := website_version_publish(w[1], 1, '{"companyName":"Stale"}', p0, 'publish', null, u[1]);
  if j->>'result' <> 'stale' then raise exception 'publish on an old base should be stale, got %', j; end if;
  if (select settings->>'companyName' from websites where id = w[1]) <> 'Harbour Two' then raise exception 'a stale publish must not change the site'; end if;
  select count(*) into n from website_versions where website_id = w[1];
  if n <> 2 then raise exception 'a stale publish must not add a version, got %', n; end if;
  -- A null base is only right for a site with no version at all.
  j := website_version_publish(w[1], null, '{"companyName":"NullBase"}', p0, 'publish', null, u[1]);
  if j->>'result' <> 'stale' then raise exception 'a null base on a site with versions should be stale'; end if;
  j := website_version_publish(w[2], null, '{"companyName":"First"}', p0, 'publish', null, u[2]);
  if j->>'result' <> 'published' or (j->>'version_no')::int <> 1 then raise exception 'a null base on a site with no versions should publish version 1, got %', j; end if;
  raise notice 'publish and stale ok';

  -- ── A restore is recorded as one ──
  j := website_version_publish(w[1], 2, s0, p0, 'restore', 1, u[1]);
  if j->>'result' <> 'published' or (j->>'version_no')::int <> 3 then raise exception 'restore should be version 3, got %', j; end if;
  if (select restored_from from website_versions where website_id = w[1] and version_no = 3) <> 1 then raise exception 'restored_from should be 1'; end if;
  begin
    perform website_version_publish(w[1], 3, s0, p0, 'approved', null, u[1]);
    raise exception 'publish accepted the kind approved';
  exception when raise_exception then
    if sqlerrm <> 'website_version_publish_bad_input' then raise; end if;
  end;

  -- ── The 11th publish leaves 10 versions (the oldest are pruned) ──
  v := 3;
  for i in 1..9 loop
    j := website_version_publish(w[1], v, jsonb_build_object('companyName', 'Harbour ' || (v + 1)::text), p0, 'publish', null, u[1]);
    if j->>'result' <> 'published' then raise exception 'publish % failed: %', v + 1, j; end if;
    v := (j->>'version_no')::int;
  end loop;
  -- v is now 12 (version 1 approved + 11 more); the newest 10 are 3..12.
  select count(*) into n from website_versions where website_id = w[1];
  if n <> 10 then raise exception 'the site should keep 10 versions, got %', n; end if;
  if (select min(version_no) from website_versions where website_id = w[1]) <> 3 then raise exception 'the oldest kept version should be 3'; end if;
  if jsonb_array_length(j->'pruned') <> 1 then raise exception 'the last publish should have pruned one version, got %', j->'pruned'; end if;
  raise notice 'prune ok';

  -- ── One site's versions never touch another's ──
  select count(*) into n from website_versions where website_id = w[2];
  if n <> 1 then raise exception 'the other site should still have its own single version, got %', n; end if;

  -- ── A second notice with the same key is a no-op ──
  insert into website_grace (website_id, reason, episode_started_at) values (w[1], 'abandoned', ep);
  insert into website_grace_notices (website_id, episode_started_at, stage, status) values (w[1], ep, 30, 'sent');
  insert into website_grace_notices (website_id, episode_started_at, stage, status) values (w[1], ep, 30, 'skipped') on conflict do nothing;
  select count(*) into n from website_grace_notices where website_id = w[1];
  if n <> 1 then raise exception 'a second notice with the same key should be a no-op, got %', n; end if;
  if (select status from website_grace_notices where website_id = w[1] and stage = 30) <> 'sent' then raise exception 'the first notice should be the one kept'; end if;
  begin
    insert into website_grace_notices (website_id, episode_started_at, stage) values (w[1], ep, 30);
    raise exception 'a duplicate notice without on conflict was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into website_grace (website_id, reason, episode_started_at) values (w[2], 'sulking', ep);
    raise exception 'an unknown grace reason was accepted';
  exception when check_violation then null;
  end;
  raise notice 'notices ok';

  -- ── Change requests: body 1..2000, a known status ──
  begin
    insert into website_change_requests (website_id, owner_id, body) values (w[1], u[1], '');
    raise exception 'an empty change request was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into website_change_requests (website_id, owner_id, body) values (w[1], u[1], repeat('x', 2001));
    raise exception 'a 2001-character change request was accepted';
  exception when check_violation then null;
  end;
  insert into website_change_requests (website_id, owner_id, body) values (w[1], u[1], repeat('x', 2000));
  if (select status from website_change_requests where website_id = w[1]) <> 'new' then raise exception 'a request should start new'; end if;
  begin
    update website_change_requests set status = 'maybe' where website_id = w[1];
    raise exception 'an unknown request status was accepted';
  exception when check_violation then null;
  end;
  raise notice 'requests ok';

  -- ── No new status, and a site with a domain row is still never deleted ──
  begin
    update websites set status = 'switched_off' where id = w[1];
    raise exception 'a sixth website status was accepted';
  exception when check_violation then null;
  end;
  insert into website_domains (website_id, owner_id, name) values (w[1], u[1], 'p4-smoke-1.co.uk');
  begin
    delete from websites where id = w[1];
    raise exception 'a website with a domain row was deleted';
  exception when foreign_key_violation then null;
  end;
  raise notice 'domain restrict still holds';
end $$;

rollback;
