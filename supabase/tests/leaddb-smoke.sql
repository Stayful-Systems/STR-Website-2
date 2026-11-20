-- Batch 32 checks: the lead database link and delivery tables. Run AFTER
-- schema.sql: by hand in the Supabase SQL editor, or by CI (job "schema").
-- One transaction, rolled back at the end: it leaves no data behind. A failing
-- check raises; success prints notices.
begin;

do $$
declare
  u uuid := gen_random_uuid();
  l uuid := gen_random_uuid();
  n integer;
begin
  -- Both tables exist, RLS is on, and neither browser role can touch them.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('leaddb_links', 'leaddb_deliveries') and c.relrowsecurity;
  if n <> 2 then raise exception 'leaddb tables must both have RLS on (found %)', n; end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('leaddb_links', 'leaddb_deliveries');
  if n <> 0 then raise exception 'leaddb tables must have no policies (found %)', n; end if;

  if has_table_privilege('anon', 'public.leaddb_links', 'select')
     or has_table_privilege('authenticated', 'public.leaddb_links', 'select')
     or has_table_privilege('anon', 'public.leaddb_deliveries', 'select')
     or has_table_privilege('authenticated', 'public.leaddb_deliveries', 'insert') then
    raise exception 'anon/authenticated must have no access to the leaddb tables';
  end if;

  -- One link per owner; the status vocabulary is closed.
  insert into auth.users (id) values (u);
  insert into public.profiles (id) values (u) on conflict (id) do nothing;
  insert into public.leaddb_links (owner_id, email) values (u, 'owner@example.com');
  begin
    insert into public.leaddb_links (owner_id, email) values (u, 'again@example.com');
    raise exception 'a second link for one owner must be refused';
  exception when unique_violation then null; end;
  begin
    update public.leaddb_links set status = 'bogus' where owner_id = u;
    raise exception 'an unknown link status must be refused';
  exception when check_violation then null; end;
  begin
    update public.leaddb_links set lead_type = 'bogus' where owner_id = u;
    raise exception 'an unknown lead type must be refused';
  exception when check_violation then null; end;

  -- A delivery defaults to pending/0 attempts, is one row per lead, and goes with its lead.
  insert into public.leads (id, user_id, status) values (l, u, 'new');
  insert into public.leaddb_deliveries (lead_id, owner_id) values (l, u);
  if (select status || attempts::text from public.leaddb_deliveries where lead_id = l) <> 'pending0' then
    raise exception 'a new delivery must be pending with no attempts';
  end if;
  begin
    insert into public.leaddb_deliveries (lead_id, owner_id) values (l, u);
    raise exception 'a second delivery row for one lead must be refused';
  exception when unique_violation then null; end;
  begin
    update public.leaddb_deliveries set status = 'bogus' where lead_id = l;
    raise exception 'an unknown delivery status must be refused';
  exception when check_violation then null; end;
  delete from public.leads where id = l;
  select count(*) into n from public.leaddb_deliveries where lead_id = l;
  if n <> 0 then raise exception 'deleting a lead must delete its delivery row'; end if;

  raise notice 'leaddb smoke: ok';
end $$;

rollback;
