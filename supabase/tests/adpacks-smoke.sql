-- Batch 38 checks: the ad pack tables, the lead link table, the bucket and the seeds.
-- Run AFTER schema.sql: by hand in the Supabase SQL editor, or by CI (job "schema").
-- One transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  l uuid := gen_random_uuid();
  p uuid;
  p2 uuid;
  a uuid;
  t text;
  n integer;
begin
  -- All four tables exist, RLS is on, there is no policy, and neither browser role can touch them.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('ad_packs', 'ad_pack_ads', 'ad_pack_runs', 'ad_pack_lead_links') and c.relrowsecurity;
  if n <> 4 then raise exception 'the ad pack tables must all have RLS on (found %)', n; end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('ad_packs', 'ad_pack_ads', 'ad_pack_runs', 'ad_pack_lead_links');
  if n <> 0 then raise exception 'the ad pack tables must have no policies (found %)', n; end if;

  foreach t in array array['ad_packs', 'ad_pack_ads', 'ad_pack_runs', 'ad_pack_lead_links'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception 'anon/authenticated must have no access to %', t;
    end if;
  end loop;

  -- One pack per owner, and one operator code per pack; the status vocabulary is closed.
  insert into auth.users (id) values (u), (u2);
  insert into public.profiles (id) values (u), (u2) on conflict (id) do nothing;
  insert into public.ad_packs (owner_id, operator_code) values (u, 'AAAAAA') returning id into p;
  if (select status || version::text || voice_changes::text || regen_count::text || cost_pence::text from public.ad_packs where id = p) <> 'draft1000' then
    raise exception 'a new pack must be a draft, version 1, with nothing spent';
  end if;
  begin
    insert into public.ad_packs (owner_id, operator_code) values (u, 'BBBBBB');
    raise exception 'a second pack for one owner must be refused';
  exception when unique_violation then null; end;
  begin
    insert into public.ad_packs (owner_id, operator_code) values (u2, 'AAAAAA');
    raise exception 'two packs must not share an operator code';
  exception when unique_violation then null; end;
  insert into public.ad_packs (owner_id, operator_code) values (u2, 'CCCCCC') returning id into p2;
  begin
    update public.ad_packs set status = 'bogus' where id = p;
    raise exception 'an unknown pack status must be refused';
  exception when check_violation then null; end;
  foreach t in array array['draft', 'generating', 'checks_failed', 'preview', 'approved', 'failed'] loop
    update public.ad_packs set status = t where id = p;
  end loop;

  -- An ad: the angle vocabulary is closed and its code is unique.
  insert into public.ad_pack_ads (pack_id, owner_id, version, angle, n, code)
  values (p, u, 1, '5b', 1, 'SI-AAAAAA-5B-1') returning id into a;
  insert into public.ad_pack_ads (pack_id, owner_id, version, angle, n, code) values (p, u, 1, '3a', 1, 'SI-AAAAAA-3A-1');
  insert into public.ad_pack_ads (pack_id, owner_id, version, angle, n, code) values (p, u, 1, '17', 1, 'SI-AAAAAA-17-1');
  begin
    insert into public.ad_pack_ads (pack_id, owner_id, version, angle, n, code) values (p2, u2, 1, '5b', 1, 'SI-AAAAAA-5B-1');
    raise exception 'two ads must not share a pack code';
  exception when unique_violation then null; end;
  begin
    insert into public.ad_pack_ads (pack_id, owner_id, version, angle, n, code) values (p2, u2, 1, '9z', 1, 'SI-CCCCCC-9Z-1');
    raise exception 'an unknown angle must be refused';
  exception when check_violation then null; end;

  -- A run: who ran it is closed too.
  insert into public.ad_pack_runs (pack_id, version, by, dry) values (p, 1, 'operator', false);
  insert into public.ad_pack_runs (pack_id, version, by, dry) values (p, 1, 'admin', true);
  begin
    insert into public.ad_pack_runs (pack_id, version, by) values (p, 1, 'someone');
    raise exception 'an unknown run actor must be refused';
  exception when check_violation then null; end;

  -- A lead link is one row per lead, its match vocabulary is closed, and it goes with its lead.
  insert into public.leads (id, user_id, status) values (l, u, 'new');
  insert into public.ad_pack_lead_links (lead_id, owner_id, pack_ad_id, match, ad_code_seen)
  values (l, u, a, 'code', 'SI-AAAAAA-5B-1');
  begin
    insert into public.ad_pack_lead_links (lead_id, owner_id, match) values (l, u, 'none');
    raise exception 'a second link row for one lead must be refused';
  exception when unique_violation then null; end;
  foreach t in array array['code', 'ad_id', 'none', 'foreign_code'] loop
    update public.ad_pack_lead_links set match = t where lead_id = l;
  end loop;
  begin
    update public.ad_pack_lead_links set match = 'bogus' where lead_id = l;
    raise exception 'an unknown match must be refused';
  exception when check_violation then null; end;
  -- The link keeps the lead's record if its ad row ever goes (set null), and never touches the lead.
  delete from public.ad_pack_ads where id = a;
  select count(*) into n from public.ad_pack_lead_links where lead_id = l and pack_ad_id is null;
  if n <> 1 then raise exception 'deleting an ad must leave its lead links with no ad'; end if;
  if (select status from public.leads where id = l) <> 'new' or (select crm_pushed_at from public.leads where id = l) is not null then
    raise exception 'the ad pack tables must never change leads.status or leads.crm_pushed_at';
  end if;
  delete from public.leads where id = l;
  select count(*) into n from public.ad_pack_lead_links where lead_id = l;
  if n <> 0 then raise exception 'deleting a lead must delete its ad link row'; end if;

  -- Deleting a pack deletes its ads and runs.
  delete from public.ad_packs where id = p;
  select count(*) into n from public.ad_pack_ads where pack_id = p;
  if n <> 0 then raise exception 'deleting a pack must delete its ads'; end if;
  select count(*) into n from public.ad_pack_runs where pack_id = p;
  if n <> 0 then raise exception 'deleting a pack must delete its runs'; end if;

  -- The private bucket and the settings seeds.
  if not exists (select 1 from storage.buckets where id = 'ad-packs' and public = false) then
    raise exception 'the ad-packs bucket must exist and be private';
  end if;
  -- It must accept every type the code uploads (the cached voice and its script were once refused).
  if not (select allowed_mime_types @> array['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg', 'application/json'] from storage.buckets where id = 'ad-packs') then
    raise exception 'the ad-packs bucket must allow image/jpeg, image/png, video/mp4, audio/mpeg and application/json';
  end if;
  select count(*) into n from public.billing_settings where key in
    ('ad_packs_enabled', 'ad_pack_free_regens', 'ad_pack_voice_changes', 'ad_pack_max_raw_pence', 'ad_pack_monthly_cap_pence', 'ad_pack_min_area_samples');
  if n <> 6 then raise exception 'all six ad pack settings must be seeded (found %)', n; end if;
  if (select value from public.billing_settings where key = 'ad_packs_enabled') <> 'false'::jsonb then
    raise exception 'ad_packs_enabled must start off';
  end if;
  if (select value from public.billing_settings where key = 'ad_pack_monthly_cap_pence') <> '5000'::jsonb then
    raise exception 'ad_pack_monthly_cap_pence must start at 5000';
  end if;

  raise notice 'adpacks smoke: ok';
end $$;

rollback;
