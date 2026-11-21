-- Batch 35 checks: the ad lead sheet tables, leads.meeting_reached_at and the seeds.
-- Run AFTER schema.sql: by hand in the Supabase SQL editor, or by CI (job "schema").
-- One transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  k uuid;
  k2 uuid;
  t text;
  n integer;
begin
  -- Both tables exist, RLS is on, there is no policy, and neither browser role can touch them.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('ad_sheet_links', 'ad_sheet_rows') and c.relrowsecurity;
  if n <> 2 then raise exception 'the ad sheet tables must both have RLS on (found %)', n; end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('ad_sheet_links', 'ad_sheet_rows');
  if n <> 0 then raise exception 'the ad sheet tables must have no policies (found %)', n; end if;

  foreach t in array array['ad_sheet_links', 'ad_sheet_rows'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('anon', 'public.' || t, 'delete') or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'anon/authenticated must have no access to %', t;
    end if;
  end loop;

  -- One link per owner and one link per spreadsheet; the state vocabulary is closed.
  insert into auth.users (id) values (u), (u2);
  insert into public.profiles (id) values (u), (u2) on conflict (id) do nothing;
  insert into public.ad_sheet_links (owner_id, spreadsheet_id) values (u, 'sheet-aaa') returning id into k;
  if (select state || last_row_read::text || rows_imported::text || untagged_count::text from public.ad_sheet_links where id = k) <> 'waiting_test_row000' then
    raise exception 'a new link must be waiting for a test row with nothing read';
  end if;
  begin
    insert into public.ad_sheet_links (owner_id, spreadsheet_id) values (u, 'sheet-bbb');
    raise exception 'a second link for one owner must be refused';
  exception when unique_violation then null; end;
  begin
    insert into public.ad_sheet_links (owner_id, spreadsheet_id) values (u2, 'sheet-aaa');
    raise exception 'one spreadsheet linked by two owners must be refused';
  exception when unique_violation then null; end;
  begin
    update public.ad_sheet_links set state = 'bogus' where id = k;
    raise exception 'an unknown link state must be refused';
  exception when check_violation then null; end;
  insert into public.ad_sheet_links (owner_id, spreadsheet_id) values (u2, 'sheet-ccc') returning id into k2;

  -- A row is unique per link and row key; the state vocabulary is closed.
  insert into public.ad_sheet_rows (link_id, owner_id, row_key, row_number, state) values (k, u, 'key-1', 2, 'imported');
  begin
    insert into public.ad_sheet_rows (link_id, owner_id, row_key, row_number, state) values (k, u, 'key-1', 3, 'imported');
    raise exception 'the same row key twice on one link must be refused';
  exception when unique_violation then null; end;
  insert into public.ad_sheet_rows (link_id, owner_id, row_key, row_number, state) values (k2, u2, 'key-1', 2, 'test');
  begin
    update public.ad_sheet_rows set state = 'bogus' where link_id = k;
    raise exception 'an unknown row state must be refused';
  exception when check_violation then null; end;

  -- A row can never carry a different owner from its link's owner.
  begin
    insert into public.ad_sheet_rows (link_id, owner_id, row_key, row_number, state) values (k, u2, 'key-2', 4, 'imported');
    raise exception 'a row whose owner differs from its link owner must be refused';
  exception when foreign_key_violation then null; end;

  -- Deleting a link deletes its rows.
  delete from public.ad_sheet_links where id = k;
  select count(*) into n from public.ad_sheet_rows where link_id = k;
  if n <> 0 then raise exception 'deleting a link must delete its rows'; end if;

  -- leads.meeting_reached_at exists and is a nullable timestamptz.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'leads' and column_name = 'meeting_reached_at'
     and data_type = 'timestamp with time zone' and is_nullable = 'YES';
  if n <> 1 then raise exception 'leads.meeting_reached_at (timestamptz, nullable) must exist'; end if;

  -- The seeds.
  select count(*) into n from public.billing_settings
   where (key, value) in (
     ('ad_sheets_enabled', 'false'::jsonb), ('ad_sheet_min_leads', '5'::jsonb),
     ('ad_sheet_quiet_days', '7'::jsonb), ('ad_sheet_outcome_pct', '50'::jsonb),
     ('ad_sheet_outcome_age_days', '14'::jsonb), ('ad_sheet_reminder_age_days', '7'::jsonb),
     ('ad_sheet_dedupe_days', '30'::jsonb), ('ad_sheet_guide_checked_at', 'null'::jsonb));
  if n <> 8 then raise exception 'the eight ad sheet settings must be seeded (found % with the default values)', n; end if;

  raise notice 'adsheets smoke: ok';
end $$;

rollback;
