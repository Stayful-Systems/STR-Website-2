-- Batch 55 (Part A) checks: websites.mode, ad_packs.route, the two lead database route tables and the three seeds.
-- Run AFTER schema.sql: by hand in the Supabase SQL editor, or by CI (job "schema").
-- Read only: it inserts nothing. A failing check raises; success prints a notice.
begin;

do $$
declare
  n integer;
  t text;
begin
  -- websites.mode: text, not null, default 'site', closed to site / calculator.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'websites' and column_name = 'mode'
     and data_type = 'text' and is_nullable = 'NO' and column_default like '%''site''%';
  if n <> 1 then raise exception 'websites.mode (text, not null, default site) must exist'; end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.websites'::regclass and conname = 'websites_mode_check'
     and pg_get_constraintdef(oid) like '%site%' and pg_get_constraintdef(oid) like '%calculator%';
  if n <> 1 then raise exception 'websites_mode_check (site, calculator) must exist'; end if;

  -- ad_packs.route: text, not null, default 'academy', closed to academy / leaddb.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'ad_packs' and column_name = 'route'
     and data_type = 'text' and is_nullable = 'NO' and column_default like '%''academy''%';
  if n <> 1 then raise exception 'ad_packs.route (text, not null, default academy) must exist'; end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.ad_packs'::regclass and conname = 'ad_packs_route_check'
     and pg_get_constraintdef(oid) like '%academy%' and pg_get_constraintdef(oid) like '%leaddb%';
  if n <> 1 then raise exception 'ad_packs_route_check (academy, leaddb) must exist'; end if;

  -- Both new tables exist, RLS is on, there is no policy, and neither browser role can touch them.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('leaddb_ad_accounts', 'ad_pack_round_grants') and c.relrowsecurity;
  if n <> 2 then raise exception 'leaddb_ad_accounts and ad_pack_round_grants must both exist with RLS on (found %)', n; end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('leaddb_ad_accounts', 'ad_pack_round_grants');
  if n <> 0 then raise exception 'the new tables must have no policies (found %)', n; end if;

  foreach t in array array['leaddb_ad_accounts', 'ad_pack_round_grants'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('anon', 'public.' || t, 'delete') or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'anon/authenticated must have no access to %', t;
    end if;
  end loop;

  -- leaddb_ad_accounts: one row per owner (primary key) and one per lead database customer (unique); the state columns exist.
  select count(*) into n from pg_constraint
   where conrelid = 'public.leaddb_ad_accounts'::regclass and contype = 'p' and pg_get_constraintdef(oid) = 'PRIMARY KEY (owner_id)';
  if n <> 1 then raise exception 'leaddb_ad_accounts must be keyed on owner_id'; end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.leaddb_ad_accounts'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (ld_customer_id)';
  if n <> 1 then raise exception 'leaddb_ad_accounts.ld_customer_id must be unique'; end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'leaddb_ad_accounts'
     and column_name in ('ld_customer_id', 'link_id', 'allowed', 'allowed_by', 'allowed_at', 'card_on_file', 'account_status',
                         'cancel_effective_at', 'lapsed', 'state_as_of', 'created_at', 'updated_at');
  if n <> 12 then raise exception 'leaddb_ad_accounts is missing columns (found % of 12)', n; end if;

  -- ad_pack_round_grants: a reason is required, and open grants are indexed by owner.
  select count(*) into n from pg_constraint
   where conrelid = 'public.ad_pack_round_grants'::regclass and conname = 'ad_pack_round_grants_reason_check';
  if n <> 1 then raise exception 'ad_pack_round_grants must refuse an empty reason'; end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'ad_pack_round_grants' and indexname = 'ad_pack_round_grants_open_idx';
  if n <> 1 then raise exception 'ad_pack_round_grants_open_idx must exist'; end if;

  -- The seeds.
  select count(*) into n from public.billing_settings
   where (key, value) in (
     ('ad_calc_reports_per_day', '50'::jsonb), ('ad_pack_ld_round_days', '30'::jsonb), ('ad_pack_ld_monthly_cap_pence', '25000'::jsonb));
  if n <> 3 then raise exception 'the three Batch 55 settings must be seeded (found % with the default values)', n; end if;

  raise notice 'batch55 smoke: ok';
end $$;

rollback;
