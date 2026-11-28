-- Batch 38b checks: the notice video render queue, its settings and the sandbox unit cost.
-- Run AFTER schema.sql: by hand in the Supabase SQL editor, or by CI (job "schema").
-- One transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid := gen_random_uuid();
  p uuid;
  r uuid;
  t text;
  n integer;
begin
  -- The table exists, RLS is on, there is no policy, and neither browser role can touch it.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'ad_pack_renders' and c.relrowsecurity;
  if n <> 1 then raise exception 'ad_pack_renders must have RLS on'; end if;
  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'ad_pack_renders';
  if n <> 0 then raise exception 'ad_pack_renders must have no policies (found %)', n; end if;
  if has_table_privilege('anon', 'public.ad_pack_renders', 'select') or has_table_privilege('authenticated', 'public.ad_pack_renders', 'select')
     or has_table_privilege('authenticated', 'public.ad_pack_renders', 'insert') then
    raise exception 'anon/authenticated must have no access to ad_pack_renders';
  end if;

  insert into auth.users (id) values (u);
  insert into public.profiles (id) values (u) on conflict (id) do nothing;
  insert into public.ad_packs (owner_id, operator_code) values (u, 'RRRRRR') returning id into p;

  -- A new render is queued with nothing spent and no attempts.
  insert into public.ad_pack_renders (pack_id, version, voice_key) values (p, 1, 'jane') returning id into r;
  if (select state || attempts::text || cost_pence::text from public.ad_pack_renders where id = r) <> 'queued00' then
    raise exception 'a new render must be queued with 0 attempts and 0 spent';
  end if;

  -- The completion email: nothing is claimed on a new row; a claim is one conditional update that only one caller wins;
  -- the outcome vocabulary is closed; a reset (voice change, retry) clears it so the next result emails again.
  if (select notified_at is not null or notified_outcome is not null from public.ad_pack_renders where id = r) then
    raise exception 'a new render must have no email claimed';
  end if;
  update public.ad_pack_renders set state = 'done' where id = r;
  update public.ad_pack_renders set notified_at = now(), notified_outcome = 'ready' where id = r and state = 'done' and notified_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the first claim of the email must win (got %)', n; end if;
  update public.ad_pack_renders set notified_at = now(), notified_outcome = 'ready' where id = r and state = 'done' and notified_at is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a second claim of the same email must lose (got %)', n; end if;
  foreach t in array array['ready', 'failed', 'skipped'] loop
    update public.ad_pack_renders set notified_outcome = t where id = r;
  end loop;
  begin
    update public.ad_pack_renders set notified_outcome = 'sent' where id = r;
    raise exception 'an unknown email outcome must be refused';
  exception when check_violation then null; end;
  update public.ad_pack_renders set notified_at = null, notified_outcome = null where id = r;
  if (select notified_at is not null or notified_outcome is not null from public.ad_pack_renders where id = r) then
    raise exception 'a reset must clear the email claim';
  end if;
  update public.ad_pack_renders set state = 'queued' where id = r;

  -- A version is rendered once; the next version (a voice change) is a new row.
  begin
    insert into public.ad_pack_renders (pack_id, version, voice_key) values (p, 1, 'olivia');
    raise exception 'a second render of one pack version must be refused';
  exception when unique_violation then null; end;
  insert into public.ad_pack_renders (pack_id, version, voice_key) values (p, 2, 'olivia');

  -- The state vocabulary is closed.
  foreach t in array array['queued', 'running', 'done', 'failed'] loop
    update public.ad_pack_renders set state = t where id = r;
  end loop;
  begin
    update public.ad_pack_renders set state = 'bogus' where id = r;
    raise exception 'an unknown render state must be refused';
  exception when check_violation then null; end;

  -- Counts never go negative; the error code is short.
  begin
    update public.ad_pack_renders set attempts = -1 where id = r;
    raise exception 'negative attempts must be refused';
  exception when check_violation then null; end;
  begin
    update public.ad_pack_renders set cost_pence = -1 where id = r;
    raise exception 'a negative cost must be refused';
  exception when check_violation then null; end;
  update public.ad_pack_renders set error_code = repeat('x', 60) where id = r;
  begin
    update public.ad_pack_renders set error_code = repeat('x', 61) where id = r;
    raise exception 'an error code over 60 characters must be refused';
  exception when check_violation then null; end;

  -- Deleting a pack deletes its renders.
  delete from public.ad_packs where id = p;
  select count(*) into n from public.ad_pack_renders where pack_id = p;
  if n <> 0 then raise exception 'deleting a pack must delete its renders'; end if;

  -- The settings seeds and the sandbox unit cost.
  select count(*) into n from public.billing_settings where key in
    ('ad_pack_render_max_seconds', 'ad_pack_render_max_attempts', 'ad_pack_sandbox_vcpus');
  if n <> 3 then raise exception 'all three render settings must be seeded (found %)', n; end if;
  if (select value from public.billing_settings where key = 'ad_pack_render_max_seconds') <> '300'::jsonb then
    raise exception 'ad_pack_render_max_seconds must start at 300';
  end if;
  if (select value from public.billing_settings where key = 'ad_pack_render_max_attempts') <> '3'::jsonb then
    raise exception 'ad_pack_render_max_attempts must start at 3';
  end if;
  if (select value from public.billing_settings where key = 'ad_pack_sandbox_vcpus') <> '2'::jsonb then
    raise exception 'ad_pack_sandbox_vcpus must start at 2';
  end if;
  if exists (select 1 from public.billing_settings where key = 'ad_pack_sandbox_pence_per_cpu_second') then
    raise exception 'the sandbox price lives in unit_costs only, not in a setting';
  end if;
  if not exists (select 1 from public.unit_costs where provider = 'vercel' and unit = 'sandbox_cpu_second' and unit_cost_pence > 0) then
    raise exception 'the vercel sandbox_cpu_second unit cost must exist and be above zero';
  end if;

  -- Batch 55 step 5 (Phase 2): one row per kind per version; a row without a kind is a notice row; the kinds are closed.
  -- The pack above was deleted (cascade check), so these checks use a fresh pack.
  insert into public.ad_packs (owner_id, operator_code) values (u, 'SSSSSS') returning id into p;
  insert into public.ad_pack_renders (pack_id, version, voice_key) values (p, 1, 'jane') returning id into r;
  if (select kind from public.ad_pack_renders where id = r) <> 'notice' then raise exception 'a row without a kind must be a notice row'; end if;
  insert into public.ad_pack_renders (pack_id, version, voice_key, kind) values (p, 1, 'jane', 'example_report');
  insert into public.ad_pack_renders (pack_id, version, voice_key, kind) values (p, 1, 'jane', 'phone');
  insert into public.ad_pack_renders (pack_id, version, voice_key, kind) values (p, 1, 'jane', 'loupe');
  begin
    insert into public.ad_pack_renders (pack_id, version, voice_key, kind) values (p, 1, 'jane', 'loupe');
    raise exception 'a second loupe row of one pack version must be refused';
  exception when unique_violation then null; end;
  begin
    insert into public.ad_pack_renders (pack_id, version, voice_key, kind) values (p, 3, 'jane', 'carousel');
    raise exception 'an unknown kind must be refused';
  exception when check_violation then null; end;
  if exists (select 1 from pg_constraint where conname = 'ad_pack_renders_pack_version_key') then
    raise exception 'the old (pack_id, version) key must be gone once (pack_id, version, kind) is there';
  end if;

  raise notice 'adpacks render smoke: ok';
end $$;

rollback;
