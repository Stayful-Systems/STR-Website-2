-- Stayful Intelligence — initial schema
-- Run this in the Supabase SQL editor for a fresh project.

-- =========================
-- profiles
-- =========================
-- Extends auth.users. One row per user, created on signup.
-- Access model: 5 free reports from sign-up (tracked in reports_run); after
-- that the account needs a subscription for hasAccess() to return true.
-- trial_ends_at is retained for the Monday CRM mirror only.
--
-- IMPORTANT: "is this a paying customer?" is derived from BOTH `plan` and
-- `stripe_subscription_status` (see src/lib/access.ts → accountStatus). A live
-- Stripe status wins over the plan column, so a customer whose plan write
-- failed is never mistaken for a free-trial user.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  mobile text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  -- On the live project from before this file tracked it; nothing in this app reads it.
  trial_started_at timestamptz not null default now(),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_status text,                    -- 'trialing' | 'active' | 'past_due' | 'canceled' | ...
  -- How the plan was granted: 'stripe' (webhook) or 'manual' (subscription
  -- arranged by hand and set in the dashboard). Lets a manually granted plan
  -- be told apart from one Stripe is keeping in sync.
  plan_source text,                                   -- 'stripe' | 'manual' | null
  subscription_started_at timestamptz,
  subscription_ended_at timestamptz,
  -- Monday "Trial signups" CRM mirror — itemId of the row that
  -- represents this user on the trial board (null until first push,
  -- and until MONDAY_TRIAL_BOARD_ID env vars are configured).
  monday_item_id text,
  -- Server-of-truth counters for trial usage. Monday is a mirror.
  -- reports_run is the FREE-TRIAL allowance counter and only advances while
  -- the account is on the free trial. reports_total counts every report ever
  -- run, subscribers included — use it for usage reporting, never for gating.
  reports_run integer not null default 0,
  reports_total integer not null default 0,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent: catch up existing tables from earlier schema revisions.
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists mobile text;
alter table public.profiles add column if not exists monday_item_id text;
alter table public.profiles add column if not exists reports_run integer not null default 0;
alter table public.profiles add column if not exists last_seen_at timestamptz;
-- Declared in the create-table block above but never given a catch-up alter, so
-- it is missing on any project created before it was added. The column grants
-- further down name it, and `grant update (...)` errors on a column that does
-- not exist — which would take the whole permission change down with it.
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists reports_total integer not null default 0;
alter table public.profiles add column if not exists plan_source text;
alter table public.profiles add column if not exists subscription_started_at timestamptz;
alter table public.profiles add column if not exists subscription_ended_at timestamptz;
alter table public.profiles add column if not exists trial_started_at timestamptz not null default now();

-- The Stripe webhook falls back to matching a payment by email when it has no
-- user id, and does so case-insensitively. Index the lowered email so that
-- lookup stays cheap.
create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

-- Match subscription.* events straight back to a profile.
create index if not exists profiles_stripe_subscription_id_idx
  on public.profiles (stripe_subscription_id);
create index if not exists profiles_stripe_customer_id_idx
  on public.profiles (stripe_customer_id);

-- Seed the new all-time counter from the historic trial counter, which until
-- now advanced for every user. Safe to re-run — it never lowers a value.
update public.profiles
   set reports_total = greatest(coalesce(reports_total, 0), coalesce(reports_run, 0))
 where coalesce(reports_total, 0) < coalesce(reports_run, 0);

-- ---------------------------------------------------------------
-- Repair: paying customers stuck on plan='free'
-- ---------------------------------------------------------------
-- Anyone Stripe reports as live but whose plan column never flipped was being
-- treated as a free-trial user (and shown "you have N free reports left").
-- Safe to re-run.
update public.profiles
   set plan = 'pro',
       plan_source = coalesce(plan_source, 'stripe'),
       subscription_ended_at = null
 where plan is distinct from 'pro'
   and stripe_subscription_status in ('active', 'trialing', 'past_due');

-- Mark plans that exist without any Stripe record as manually granted, so
-- they're not mistaken for stale webhook state.
update public.profiles
   set plan_source = 'manual'
 where plan = 'pro'
   and plan_source is null
   and stripe_subscription_id is null
   and stripe_subscription_status is null;

-- `plan` only ever holds 'free' or 'pro' (the paid tier is plan_code). The
-- check is inline in the create-table block above; this adds it to a table
-- created before it was. Batch 21 (A15): every check constraint in this file
-- is dropped and re-added rather than guarded by its name, so a changed
-- value list applies on re-run instead of leaving the old one in place.
do $$
begin
  alter table public.profiles drop constraint if exists profiles_plan_check;
  alter table public.profiles add constraint profiles_plan_check check (plan in ('free', 'pro'));
end $$;

alter table public.profiles enable row level security;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Batch 21 (A1): members never insert their own row. Every row is made by the
-- on_auth_user_created trigger below (security definer) or by the service
-- role; the old insert policy let a member whose row was missing create one
-- with any billing column set. Dropped and not re-created.
drop policy if exists "Users can insert own profile" on public.profiles;
-- Batch 21 (A11): "Users can update own profile" is defined once, below the
-- column grants, with both halves.

-- Auto-create a profile row whenever a new auth user is created.
-- Pulls full_name and mobile out of raw_user_meta_data — these are set
-- by signupAction via supabase.auth.signUp({ options: { data: {...} } }).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Batch 21 (A17): created_at is the auth user's, not the trigger's clock,
  -- so every date cut-off (the starter-pack cutover, the welcome backfill,
  -- Monday's "Signed up") keys on when the account was made.
  insert into public.profiles (id, email, full_name, mobile, created_at)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'mobile', ''),
    coalesce(new.created_at, now())
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- A trigger function only: never callable over the API (/rest/v1/rpc). The
-- auth service, which inserts auth.users, and the service role keep it.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin, service_role;

-- =========================
-- saved_searches
-- =========================
create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text,
  address text not null,
  guest_count integer not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists saved_searches_user_id_created_at_idx
  on public.saved_searches (user_id, created_at desc);

alter table public.saved_searches enable row level security;

drop policy if exists "Users can manage own searches" on public.saved_searches;
create policy "Users can manage own searches"
  on public.saved_searches for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================
-- Market Explorer: goal profile + watchlist
-- =========================
-- market_goals holds the user's questionnaire answers (see
-- src/lib/market/goals.ts for the shape). Editable any time; drives the
-- personalised "Your fit" score. The "Users can update own profile" policy
-- above already covers writes.
alter table public.profiles add column if not exists market_goals jsonb;
alter table public.profiles add column if not exists market_goals_updated_at timestamptz;

create table if not exists public.saved_areas (
  user_id uuid not null references public.profiles(id) on delete cascade,
  postcode_area text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, postcode_area)
);

alter table public.saved_areas enable row level security;

drop policy if exists "Users can manage own saved areas" on public.saved_areas;
create policy "Users can manage own saved areas"
  on public.saved_areas for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================
-- Market Explorer: weekly trend alerts
-- =========================
-- alert_weekly: opt-in (default on) for the weekly digest about saved areas.
-- saved_areas.last_alerted_* remember what the last digest said so the next
-- one only reports changes (a flipped enquiry trend or a confidence tier
-- crossing into Confirmed).
alter table public.profiles add column if not exists alert_weekly boolean not null default true;
alter table public.saved_areas add column if not exists last_alerted_direction text;
alter table public.saved_areas add column if not exists last_alerted_tier text;
alter table public.saved_areas add column if not exists last_alerted_at timestamptz;

-- =========================
-- Data broker: shared cache + spend ledger (service role only)
-- =========================
-- broker_cache holds every paid answer keyed by question + params so the
-- same postcode / grid cell / listing is never bought twice inside its TTL.
-- provider_calls records every call (cache hits included) so daily budgets
-- per provider and per member can be enforced and spend shown on /admin.
create table if not exists public.broker_cache (
  question text not null,
  key text not null,
  value jsonb not null,
  provider text not null,
  level int not null default 1,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (question, key)
);
alter table public.broker_cache enable row level security;

create table if not exists public.provider_calls (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  provider text not null,
  question text not null,
  key text,
  cost_pence int not null default 0,
  cache_hit boolean not null default false,
  user_id uuid,
  ok boolean not null default true,
  ms int
);
create index if not exists provider_calls_at_provider_idx on public.provider_calls (at desc, provider);
create index if not exists provider_calls_user_at_idx on public.provider_calls (user_id, at desc);
alter table public.provider_calls enable row level security;

-- =========================
-- Listing links: snapshots + a member's checked listings
-- =========================
-- listing_snapshots: one parsed snapshot per canonical listing URL, shared by
-- every member who pastes it (typed fields only, never page HTML).
create table if not exists public.listing_snapshots (
  canonical_url text primary key,
  source text not null,
  snapshot jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.listing_snapshots enable row level security;

-- checked_listings: a member's own list of listings they have looked at,
-- with the quick figures, deal maths and (later) pipeline status.
create table if not exists public.checked_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_url text not null,
  source text not null,
  kind text not null,
  postcode text,
  postcode_area text,
  lat double precision,
  lng double precision,
  snapshot jsonb not null,
  quick_estimate jsonb,
  deal jsonb,
  status text not null default 'watching',
  notes text,
  price_history jsonb not null default '[]'::jsonb,
  listing_status text,
  share_token text unique,
  last_checked_at timestamptz,
  analysed_report_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, canonical_url)
);
create index if not exists checked_listings_user_idx on public.checked_listings (user_id, updated_at desc);
alter table public.checked_listings enable row level security;
drop policy if exists "Users can manage own checked listings" on public.checked_listings;
create policy "Users can manage own checked listings"
  on public.checked_listings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Report history: every full analysis is kept so it can be reopened.
alter table public.saved_searches add column if not exists postcode text;
alter table public.saved_searches add column if not exists postcode_area text;
alter table public.saved_searches add column if not exists bedrooms int;
alter table public.saved_searches add column if not exists kind text;
alter table public.saved_searches add column if not exists source_listing jsonb;
alter table public.saved_searches add column if not exists deal jsonb;
alter table public.saved_searches add column if not exists checked_listing_id uuid;

-- =========================
-- Listing re-checks + deal sourcing (PR 1.3)
-- =========================
-- rechecked_at: when the daily re-check cron last looked at the listing.
-- Kept apart from last_checked_at (a member's own resolve) so the cron never
-- counts against the member's daily resolve cap. price_history entries are
-- { at, amount, period, status, notified } — notified flips once the change
-- has been emailed, so a failed send is retried next run rather than lost.
alter table public.checked_listings add column if not exists rechecked_at timestamptz;
create index if not exists checked_listings_recheck_idx on public.checked_listings (rechecked_at nulls first, last_checked_at);

-- sourcing_alerts: the daily pick email. Shipped opt-in (default OFF); the
-- "Daily picks" section at the end of this file flips the default to ON and
-- backfills. sourcing_last_sent_at: when the last pick went out (informational;
-- the cron's one-a-day guard reads sourcing_sent, not this).
alter table public.profiles add column if not exists sourcing_alerts boolean not null default false;
alter table public.profiles add column if not exists sourcing_last_sent_at timestamptz;

-- sourced_listings: every listing a sourcing query has ever surfaced, so
-- "new since last run" is a simple first_seen_at comparison.
create table if not exists public.sourced_listings (
  canonical_url text primary key,
  source text not null,
  kind text not null,
  query_key text not null,
  postcode_area text,
  snapshot jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists sourced_listings_seen_idx on public.sourced_listings (first_seen_at desc);
alter table public.sourced_listings enable row level security;

-- sourcing_sent: which listings each member has already been emailed.
create table if not exists public.sourcing_sent (
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_url text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, canonical_url)
);
alter table public.sourcing_sent enable row level security;

-- =========================
-- Browser extension: scoped tokens (Part 2)
-- =========================
-- A member connects the Stayful browser extension from /extension/connect,
-- which mints a random token and stores only its SHA-256 hash here. The
-- extension sends the raw token as a Bearer header to /api/ext/*; revoking
-- sets revoked_at and the token stops working immediately.
create table if not exists public.extension_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists extension_tokens_user_idx on public.extension_tokens (user_id, created_at desc);
alter table public.extension_tokens enable row level security;
drop policy if exists "Users can read own extension tokens" on public.extension_tokens;
create policy "Users can read own extension tokens"
  on public.extension_tokens for select
  using (auth.uid() = user_id);

-- =========================
-- Self-serve plan management: pause / cancel
-- =========================
-- Pause is a WINDOW, not a flag, and both ends mirror Stripe:
--
--   subscription_paused_from   the current period end at the moment they hit
--                              pause. The member keeps the time they already
--                              paid for; the pause bites afterwards.
--   subscription_paused_until  pause_collection.resumes_at.
--
-- Access is withheld only BETWEEN the two (see src/lib/access.ts -> isPaused).
-- Because it is a time comparison rather than a stored boolean, an auto-resume
-- heals itself on the next page read even if the resume webhook never lands —
-- nothing here needs a cron.
--
-- subscription_cancel_at mirrors Stripe's cancel_at, set by cancel_at_period_end.
-- The member keeps full access until then and can undo it.
alter table public.profiles add column if not exists subscription_paused_from timestamptz;
alter table public.profiles add column if not exists subscription_paused_until timestamptz;
alter table public.profiles add column if not exists subscription_cancel_at timestamptz;
alter table public.profiles add column if not exists subscription_current_period_end timestamptz;
-- What the cancel retention flow captured. Reporting only, never gating.
alter table public.profiles add column if not exists cancel_reason text;
alter table public.profiles add column if not exists cancel_reason_comment text;
alter table public.profiles add column if not exists cancel_reason_at timestamptz;

-- ---------------------------------------------------------------
-- Lock the billing columns to the service role
-- ---------------------------------------------------------------
-- "Users can update own profile" above has no column restriction, so until now
-- any signed-in member could `update profiles set plan = 'pro'` with the anon
-- key — or reset reports_run to zero for endless free reports. Shipping a
-- self-serve billing UI makes that the obvious thing to try.
--
-- Column-level grants fail closed: anything not listed here simply cannot be
-- written by a user session, whoever they are. Every column a user session
-- legitimately writes is listed; billing and usage counters deliberately are
-- not, and are written only by the webhook and the /account server actions via
-- the service-role client. Adding a user-writable column later means adding it
-- to this list.
-- sourcing_opted_out_at: set when a member turns daily picks off (goals
-- modal, /picks toggle or the unsubscribe link), cleared when they turn them
-- back on. Declared here, above the grant, because the grant names it: a
-- grant on a column that does not exist fails the whole statement.
alter table public.profiles add column if not exists sourcing_opted_out_at timestamptz;
revoke update on public.profiles from anon, authenticated;
-- Batch 21 (A4): monday_item_id is not in this list any more. The Monday
-- fallbacks (src/app/estimate/layout.tsx, src/lib/auth/sign-in-hooks.ts)
-- write it with the service role, so a member can no longer re-point their
-- own row at another Monday item.
grant update (
  full_name,
  mobile,
  last_seen_at,
  market_goals,
  market_goals_updated_at,
  alert_weekly,
  sourcing_alerts,
  sourcing_last_sent_at,
  sourcing_opted_out_at,
  updated_at
) on public.profiles to authenticated;

-- The one definition of the update policy (Batch 21, A11): both halves, so a
-- row can never be re-pointed at another user id.
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
-- =========================
-- Credit billing (usage-based, Claude-style)
-- =========================
-- Every paid provider call is priced in BASE pence (raw cost × base markup)
-- and debited from the member's credit grants in priority order:
--   plan (subscription, expires at cycle end) → welcome → top-up / adjustment.
-- Each grant carries a spend_rate frozen at creation: plan and welcome
-- credit spend at 1.0 (×5 overall), top-ups / promo / referral / admin
-- adjustments at 1.3 (×6.5 overall; 1.5 until Batch 10). Displayed balances are always grant
-- pence (what was paid); sufficiency checks use "spendable base pence" =
-- Σ remaining ÷ spend_rate minus open reservations.
-- All mutations go through the security-definer functions below, which take
-- the member's profile row lock first, so reserve / debit / grant / refund
-- serialise per member. Called via the service role only.

-- ── Plans (Stripe price ids live in env, not here) ──
create table if not exists public.billing_plans (
  code text primary key,                    -- 'starter' | 'pro' | 'scale' | 'pro_annual'
  name text not null,
  price_pence int not null,
  interval text not null,                   -- 'month' | 'year'
  monthly_credit_pence int not null,
  perks jsonb not null default '{}'::jsonb,
  sort int not null default 0,
  active boolean not null default true
);
alter table public.billing_plans add column if not exists perks jsonb not null default '{}'::jsonb;
-- Batch 21 (A2, A3): this file is the source of truth for the four plans.
-- Change a name, price or credit here and re-run it: the seed is `on conflict
-- do update` on purpose, and nothing else edits these rows (never change them
-- by hand in the dashboard, a re-run would put them back). monthly_credit_pence
-- is the credit for a billing period that began BEFORE new_pricing_from; a
-- period from that date on is granted plan_credit_pence (billing_settings,
-- Batch 10) instead, so the account pages must read the member's live grant
-- rather than this column (review finding A3; branch 21h).
insert into public.billing_plans (code, name, price_pence, interval, monthly_credit_pence, perks, sort) values
  ('starter',    'Starter',      1900,  'month', 1900,  '{"sourcingCadence":"daily","priorityRefresh":false,"phoneSupport":false,"quarterlyBriefing":false}', 1),
  ('pro',        'Pro',          3999,  'month', 5000,  '{"sourcingCadence":"daily","priorityRefresh":true,"phoneSupport":false,"quarterlyBriefing":false}', 2),
  ('scale',      'Scale',        9900,  'month', 14000, '{"sourcingCadence":"daily","priorityRefresh":true,"phoneSupport":true,"quarterlyBriefing":true}', 3),
  ('pro_annual', 'Pro (annual)', 36000, 'year',  5000,  '{"sourcingCadence":"daily","priorityRefresh":true,"phoneSupport":false,"quarterlyBriefing":true}', 4)
on conflict (code) do update set
  name = excluded.name, price_pence = excluded.price_pence, interval = excluded.interval,
  monthly_credit_pence = excluded.monthly_credit_pence, perks = excluded.perks, sort = excluded.sort;
-- Daily picks for every plan. The seed above covers the four known rows; this
-- catches any other row (a plan added by hand) that still says weekly. The DB
-- row overrides src/lib/credit/perks.ts, so without this the live site would
-- keep advertising the old cadence.
update public.billing_plans
   set perks = coalesce(perks, '{}'::jsonb) || '{"sourcingCadence":"daily"}'::jsonb
 where coalesce(perks->>'sourcingCadence', '') <> 'daily';
alter table public.billing_plans enable row level security;
drop policy if exists "Signed-in users can read plans" on public.billing_plans;
create policy "Signed-in users can read plans" on public.billing_plans for select to authenticated using (true);

-- ── Unit costs: one row per (provider, unit); seeded from src/lib/credit/costs.ts, edited on /admin/billing ──
create table if not exists public.unit_costs (
  provider text not null,
  unit text not null,
  label text not null,
  unit_cost_pence numeric(16,8) not null default 0,   -- our real cost per unit (8 places: per-token and per-character prices)
  markup numeric(6,2) not null default 5,             -- base charge = unit_cost × markup
  notes text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (provider, unit)
);
alter table public.unit_costs enable row level security;   -- no policies: service role only (raw costs never reach a browser)

-- ── Small key/value settings ──
create table if not exists public.billing_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.billing_settings enable row level security;
insert into public.billing_settings (key, value) values
  ('welcome_grant_pence', '2000'),
  ('low_balance_ratio', '0.8'),
  ('base_markup', '5'),
  -- Multiplier for white-label funnel leads (see src/lib/credit/costs.ts).
  -- Kept apart from base_markup so repricing leads cannot reprice the
  -- members-only analyser by accident.
  ('funnel_markup', '2'),
  -- Batch 21 (A10): seeded at the rate in force since Batch 10 (1.3), and the
  -- SQL fallback below says the same, so the file states one rate.
  ('spend_rates', '{"plan":1,"welcome":1,"topup":1.3,"adjustment":1.3}'),
  ('topup_presets_pence', '[1000,2500,5000]'),
  ('referral_pence', '1000')
on conflict (key) do nothing;

-- ── Credit buckets ──
create table if not exists public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,                       -- 'plan' | 'welcome' | 'topup' | 'adjustment'
  priority smallint not null,               -- consumption order: plan=1, welcome=2, topup/adjustment=3
  amount_pence numeric(14,4) not null,
  remaining_pence numeric(14,4) not null,
  spend_rate numeric(4,2) not null default 1, -- grant pence consumed per base penny
  expires_at timestamptz,                   -- plan grants only; null = never
  source_ref text,                          -- 'inv:<stripe invoice>' | 'pi:<payment intent>' | 'welcome:<user>' | 'code:<code>:<user>' | ...
  description text,
  created_at timestamptz not null default now()
);
create unique index if not exists credit_grants_source_ref_uidx on public.credit_grants (source_ref) where source_ref is not null;
create index if not exists credit_grants_consume_idx on public.credit_grants (user_id, priority, expires_at, created_at) where remaining_pence > 0;
create index if not exists credit_grants_user_idx on public.credit_grants (user_id, created_at desc);
alter table public.credit_grants enable row level security;
drop policy if exists "Users can read own credit grants" on public.credit_grants;
create policy "Users can read own credit grants" on public.credit_grants for select using (auth.uid() = user_id);
-- Batch 29 (starter pack guardrails): a grant's scope. 'pack_bonus' marks the
-- starter pack's bonus credit (never the ordinary welcome credit). While
-- scope_lifted_at is null the grant is RESTRICTED: it pays only for the actions
-- credit_bonus_pays_for allows, and it carries an expiry. A further payment
-- (top-up, auto top-up or plan invoice) lifts both: scope_lifted_at is stamped
-- and expires_at cleared. The rule is written up in src/lib/credit/pack-rules.ts.
alter table public.credit_grants add column if not exists scope text;
alter table public.credit_grants add column if not exists scope_lifted_at timestamptz;
do $$
begin
  alter table public.credit_grants drop constraint if exists credit_grants_scope_check;
  alter table public.credit_grants add constraint credit_grants_scope_check check (scope is null or scope in ('pack_bonus'));
end $$;
create index if not exists credit_grants_scope_idx on public.credit_grants (user_id) where scope is not null;
-- Batch 34 (plan credit rollover): true on a plan grant made by a plan
-- renewal (credit_plan_cycle; and, by the one-off below, every plan grant made
-- before Batch 34). The newest such grant marks the start of the current
-- cycle: the Usage page measures from it, and the 12-month no-spend rule never
-- expires it or anything added after it.
alter table public.credit_grants add column if not exists plan_cycle boolean not null default false;

-- ── Append-only ledger (the usage page) ──
create table if not exists public.credit_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,                       -- 'grant' | 'debit' | 'refund' | 'expire' | 'adjust'
  amount_pence numeric(14,4) not null,      -- grant pence moved: + in, − out
  base_pence numeric(14,4),                 -- the ×5 charge (debits / refunds)
  grant_id uuid references public.credit_grants(id),
  action_id uuid,                           -- groups every debit of one report / quick view / narration
  action text,                              -- 'report' | 'quick_view' | 'narrate' | 'speak' | 'autocomplete' | 'geocode' | 'cron:sourcing' ...
  provider text,
  unit text,
  quantity numeric(14,4),
  unit_cost_pence numeric(16,8),
  markup numeric(6,2),
  raw_cost_pence numeric(14,4),
  description text,
  provider_call_id bigint,
  metadata jsonb
);
create index if not exists credit_transactions_user_at_idx on public.credit_transactions (user_id, at desc);
create index if not exists credit_transactions_action_idx on public.credit_transactions (action_id) where action_id is not null;
alter table public.credit_transactions enable row level security;
drop policy if exists "Users can read own credit transactions" on public.credit_transactions;
create policy "Users can read own credit transactions" on public.credit_transactions for select using (auth.uid() = user_id);

-- ── Which grant(s) a debit consumed, at what rate ──
create table if not exists public.credit_allocations (
  transaction_id bigint not null references public.credit_transactions(id) on delete cascade,
  grant_id uuid not null references public.credit_grants(id),
  base_pence numeric(14,4) not null,
  grant_pence numeric(14,4) not null,
  spend_rate numeric(4,2) not null,
  primary key (transaction_id, grant_id)
);
create index if not exists credit_allocations_grant_idx on public.credit_allocations (grant_id);
alter table public.credit_allocations enable row level security;
drop policy if exists "Users can read own credit allocations" on public.credit_allocations;
create policy "Users can read own credit allocations" on public.credit_allocations for select
  using (exists (select 1 from public.credit_transactions t where t.id = transaction_id and t.user_id = auth.uid()));

-- ── Holds for in-flight multi-call actions (base pence) ──
create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  action_id uuid not null,
  max_base_pence numeric(14,4) not null,
  settled_base_pence numeric(14,4) not null default 0,
  status text not null default 'open',      -- 'open' | 'released'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null           -- expired opens are ignored by credit_available
);
create index if not exists credit_reservations_open_idx on public.credit_reservations (user_id) where status = 'open';
alter table public.credit_reservations enable row level security;
drop policy if exists "Users can read own credit reservations" on public.credit_reservations;
create policy "Users can read own credit reservations" on public.credit_reservations for select using (auth.uid() = user_id);

-- ── Stripe webhook idempotency ──
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
alter table public.stripe_events enable row level security;

-- ── Promo / referral codes ──
create table if not exists public.credit_codes (
  code text primary key,                    -- upper-case, no spaces
  kind text not null,                       -- 'promo' | 'referral'
  amount_pence int not null,
  max_redemptions int,                      -- null = unlimited
  redeemed_count int not null default 0,
  expires_at timestamptz,
  owner_user_id uuid references public.profiles(id) on delete cascade,  -- referral codes: who earns the reward
  created_by text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.credit_codes enable row level security;
create table if not exists public.credit_code_redemptions (
  code text not null references public.credit_codes(code) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);
alter table public.credit_code_redemptions enable row level security;
drop policy if exists "Users can read own code redemptions" on public.credit_code_redemptions;
create policy "Users can read own code redemptions" on public.credit_code_redemptions for select using (auth.uid() = user_id);

-- ── profiles: billing columns ──
alter table public.profiles add column if not exists plan_code text;                          -- null = free
alter table public.profiles add column if not exists stripe_price_id text;
alter table public.profiles add column if not exists stripe_default_payment_method_id text;
alter table public.profiles add column if not exists current_period_end timestamptz;
alter table public.profiles add column if not exists cancel_at_period_end boolean not null default false;
alter table public.profiles add column if not exists mobile_key text;                         -- normalised mobile, one welcome grant per number
alter table public.profiles add column if not exists welcome_checked_at timestamptz;
alter table public.profiles add column if not exists welcome_withheld_reason text;
alter table public.profiles add column if not exists auto_topup_amount_pence int;
alter table public.profiles add column if not exists auto_topup_threshold_pence int not null default 500;
-- The £5 default predates funnels and does not even cover ONE worst-case
-- enhanced run (£6.32), let alone the three concurrent ones a live public
-- funnel can produce. £20 does.
--
-- `add column if not exists` never alters an existing column's default, so
-- the change needs its own statement. Existing ROWS are deliberately left
-- alone: re-pointing a customer at a bigger charge than the one they agreed
-- to is not a migration's decision to make.
alter table public.profiles alter column auto_topup_threshold_pence set default 2000;
alter table public.profiles add column if not exists auto_topup_last_at timestamptz;
-- One pre-charge warning per cycle, in the band above the trigger.
alter table public.profiles add column if not exists last_topup_warning_email_at timestamptz;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists referral_code text;
alter table public.profiles add column if not exists referred_by_code text;
alter table public.profiles add column if not exists last_low_balance_email_at timestamptz;
alter table public.profiles add column if not exists last_out_of_credit_email_at timestamptz;
alter table public.profiles add column if not exists hit_zero_at timestamptz;
alter table public.profiles add column if not exists last_topup_at timestamptz;
create unique index if not exists profiles_mobile_key_uidx on public.profiles (mobile_key) where mobile_key is not null;
create unique index if not exists profiles_referral_code_uidx on public.profiles (referral_code) where referral_code is not null;

-- ── provider_calls: metering columns (cost_pence stays the raw cost) ──
alter table public.provider_calls add column if not exists unit text;
alter table public.provider_calls add column if not exists quantity numeric(14,4);
alter table public.provider_calls add column if not exists base_pence numeric(14,4) not null default 0;
alter table public.provider_calls add column if not exists charged_pence numeric(14,4) not null default 0;
alter table public.provider_calls add column if not exists billed_user_id uuid;
alter table public.provider_calls add column if not exists action_id uuid;
alter table public.provider_calls add column if not exists bypass boolean not null default false;
create index if not exists provider_calls_billed_user_idx on public.provider_calls (billed_user_id, at desc) where billed_user_id is not null;

-- ── Functions ──

create or replace function public.credit_setting_num(p_key text, p_default numeric)
returns numeric language sql security definer set search_path = public stable as $$
  select coalesce((select (value #>> '{}')::numeric from billing_settings where key = p_key), p_default);
$$;

create or replace function public.credit_spend_rate(p_kind text)
returns numeric language sql security definer set search_path = public stable as $$
  select coalesce((select (value ->> p_kind)::numeric from billing_settings where key = 'spend_rates'), case when p_kind in ('plan', 'welcome') then 1 else 1.3 end);
$$;

create or replace function public.credit_available(p_user uuid)
returns table (
  plan_pence numeric, welcome_pence numeric, topup_pence numeric, adjustment_pence numeric,
  spendable_base_pence numeric, reserved_base_pence numeric, plan_expires_at timestamptz
)
language sql security definer set search_path = public stable as $$
  with g as (
    select kind, remaining_pence, spend_rate, expires_at
    from credit_grants
    where user_id = p_user and (expires_at is null or expires_at > now())
  ), r as (
    select coalesce(sum(max_base_pence - settled_base_pence), 0) as reserved
    from credit_reservations
    where user_id = p_user and status = 'open' and expires_at > now()
  )
  select
    coalesce(sum(remaining_pence) filter (where kind = 'plan'), 0),
    coalesce(sum(remaining_pence) filter (where kind = 'welcome'), 0),
    coalesce(sum(remaining_pence) filter (where kind = 'topup'), 0),
    coalesce(sum(remaining_pence) filter (where kind = 'adjustment'), 0),
    coalesce(sum(remaining_pence / spend_rate), 0) - (select reserved from r),
    (select reserved from r),
    max(expires_at) filter (where kind = 'plan' and remaining_pence > 0)
  from g;
$$;

-- Batch 29: the actions a RESTRICTED grant (the starter pack's bonus, scope
-- 'pack_bonus' and not lifted) may pay for: the ones that cost us almost
-- nothing. Opening a deal, a daily pick (and the per-day Today's 5 charge), and
-- a saved analysis (the reservation action 'full_analysis_saved', or a
-- 'full_analysis' debit whose meta says reused). Everything else, and every
-- action added later, is paid from the member's other credit. Mirrored, and
-- checked against this list by a test, in src/lib/credit/pack-rules.ts.
create or replace function public.credit_bonus_pays_for(p_action text, p_meta jsonb default '{}'::jsonb)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_action, '') in ('deal_open', 'cron:sourcing', 'todays_5', 'full_analysis_saved')
      or (coalesce(p_action, '') = 'full_analysis' and coalesce(p_meta ->> 'reused', '') = 'true');
$$;

-- Batch 29: spendable base pence for ONE action. U is the unrestricted grants'
-- base value, B the restricted bonus's; open reservations are split by whether
-- their action may use the bonus (R_ok) or not (R_other). An action the bonus
-- pays for sees U + B − R_ok − R_other (exactly credit_available's figure);
-- any other action sees U − R_other − max(0, R_ok − B): the bonus-paid holds
-- are taken from the bonus first, as the debit's walk takes them.
create or replace function public.credit_spendable_for(p_user uuid, p_action text, p_meta jsonb default '{}'::jsonb)
returns numeric language sql security definer set search_path = public stable as $$
  with g as (
    select
      coalesce(sum(remaining_pence / spend_rate) filter (where not (scope is not distinct from 'pack_bonus' and scope_lifted_at is null)), 0) as u,
      coalesce(sum(remaining_pence / spend_rate) filter (where scope is not distinct from 'pack_bonus' and scope_lifted_at is null), 0) as b
    from credit_grants
    where user_id = p_user and (expires_at is null or expires_at > now())
  ), r as (
    select
      coalesce(sum(max_base_pence - settled_base_pence) filter (where credit_bonus_pays_for(action)), 0) as r_ok,
      coalesce(sum(max_base_pence - settled_base_pence) filter (where not credit_bonus_pays_for(action)), 0) as r_other
    from credit_reservations
    where user_id = p_user and status = 'open' and expires_at > now()
  )
  select case when credit_bonus_pays_for(p_action, p_meta)
    then g.u + g.b - r.r_ok - r.r_other
    else g.u - r.r_other - greatest(0, r.r_ok - g.b)
  end
  from g, r;
$$;

-- Batch 29: the displayed (face) pence a face debit for this action may use:
-- every unexpired grant with credit, less a restricted bonus the action may
-- not spend. Open reservations are the caller's to allow for (see
-- credit_debit_face's R2-13 check and src/lib/voice/charge.ts).
create or replace function public.credit_face_available_for(p_user uuid, p_action text)
returns numeric language sql security definer set search_path = public stable as $$
  select coalesce(sum(remaining_pence), 0)
  from credit_grants
  where user_id = p_user and remaining_pence > 0 and (expires_at is null or expires_at > now())
    and (credit_bonus_pays_for(p_action) or not (scope is not distinct from 'pack_bonus' and scope_lifted_at is null));
$$;

create or replace function public.credit_reserve(p_user uuid, p_action text, p_action_id uuid, p_max_base numeric, p_ttl interval default interval '10 minutes')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_spendable numeric;
  v_id uuid;
begin
  perform 1 from profiles where id = p_user for update;
  -- Batch 29: what THIS action may spend (a restricted bonus only counts for the actions it pays for).
  v_spendable := credit_spendable_for(p_user, p_action);
  if coalesce(v_spendable, 0) < p_max_base then
    raise exception 'insufficient_credit' using errcode = 'P0402',
      detail = json_build_object('required_base', p_max_base, 'spendable_base', coalesce(v_spendable, 0))::text;
  end if;
  insert into credit_reservations (user_id, action, action_id, max_base_pence, expires_at)
  values (p_user, p_action, p_action_id, p_max_base, now() + p_ttl)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.credit_release(p_reservation uuid)
returns void language sql security definer set search_path = public as $$
  update credit_reservations set status = 'released' where id = p_reservation and status = 'open';
$$;

-- Debits p_base_pence, walking grants by priority and converting through each
-- grant's spend_rate. With a reservation the hold is settled; without one the
-- spendable balance is checked first. p_allow_negative lets a call the provider
-- has already been paid for overdraw into a per-member 'overdraft' adjustment
-- grant (rate 1, base pence) which later grants repay.
-- Batch 29: a restricted grant (the starter pack's bonus) is walked only for
-- an action credit_bonus_pays_for allows, and then first; for every other
-- action it is skipped. The action is the meta's, else the reservation's.
create or replace function public.credit_debit(p_user uuid, p_base_pence numeric, p_reservation uuid default null, p_allow_negative boolean default false, p_meta jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_remaining numeric := round(p_base_pence, 4);
  v_tx bigint;
  v_total_grant numeric := 0;
  v_spendable numeric;
  v_take_base numeric;
  v_take_grant numeric;
  v_overdraft uuid;
  v_res_action text;
  v_action text;
  v_bonus_ok boolean;
  g record;
begin
  if v_remaining <= 0 then return null; end if;
  perform 1 from profiles where id = p_user for update;

  if p_reservation is not null then
    update credit_reservations set settled_base_pence = settled_base_pence + v_remaining
    where id = p_reservation and user_id = p_user
    returning action into v_res_action;
  end if;
  v_action := coalesce(nullif(p_meta ->> 'action', ''), v_res_action);
  v_bonus_ok := credit_bonus_pays_for(v_action, p_meta);
  if p_reservation is null then
    v_spendable := credit_spendable_for(p_user, v_action, p_meta);
    if coalesce(v_spendable, 0) < v_remaining and not p_allow_negative then
      raise exception 'insufficient_credit' using errcode = 'P0402',
        detail = json_build_object('required_base', v_remaining, 'spendable_base', coalesce(v_spendable, 0))::text;
    end if;
  end if;

  insert into credit_transactions (user_id, kind, amount_pence, base_pence, action_id, action, provider, unit, quantity, unit_cost_pence, markup, raw_cost_pence, description, provider_call_id, metadata)
  values (
    p_user, 'debit', 0, v_remaining,
    nullif(p_meta ->> 'action_id', '')::uuid, p_meta ->> 'action', p_meta ->> 'provider', p_meta ->> 'unit',
    nullif(p_meta ->> 'quantity', '')::numeric, nullif(p_meta ->> 'unit_cost_pence', '')::numeric, nullif(p_meta ->> 'markup', '')::numeric,
    nullif(p_meta ->> 'raw_cost_pence', '')::numeric, p_meta ->> 'description', nullif(p_meta ->> 'provider_call_id', '')::bigint,
    p_meta - array['action_id', 'action', 'provider', 'unit', 'quantity', 'unit_cost_pence', 'markup', 'raw_cost_pence', 'description', 'provider_call_id']
  ) returning id into v_tx;

  for g in
    select id, remaining_pence, spend_rate from credit_grants
    where user_id = p_user and remaining_pence > 0 and (expires_at is null or expires_at > now())
      and (v_bonus_ok or not (scope is not distinct from 'pack_bonus' and scope_lifted_at is null))
    order by (v_bonus_ok and scope is not distinct from 'pack_bonus' and scope_lifted_at is null) desc, priority, expires_at nulls last, created_at
    for update
  loop
    exit when v_remaining <= 0;
    v_take_base := least(v_remaining, round(g.remaining_pence / g.spend_rate, 4));
    if v_take_base <= 0 then continue; end if;
    v_take_grant := least(g.remaining_pence, round(v_take_base * g.spend_rate, 4));
    update credit_grants set remaining_pence = remaining_pence - v_take_grant where id = g.id;
    insert into credit_allocations (transaction_id, grant_id, base_pence, grant_pence, spend_rate) values (v_tx, g.id, v_take_base, v_take_grant, g.spend_rate);
    v_total_grant := v_total_grant + v_take_grant;
    v_remaining := v_remaining - v_take_base;
  end loop;

  if v_remaining > 0.0001 then
    if not p_allow_negative then
      raise exception 'insufficient_credit' using errcode = 'P0402',
        detail = json_build_object('required_base', p_base_pence, 'shortfall_base', v_remaining)::text;
    end if;
    select id into v_overdraft from credit_grants where user_id = p_user and source_ref = 'overdraft:' || p_user::text;
    if v_overdraft is null then
      insert into credit_grants (user_id, kind, priority, amount_pence, remaining_pence, spend_rate, source_ref, description)
      values (p_user, 'adjustment', 3, 0, 0, 1, 'overdraft:' || p_user::text, 'Overdraft (repaid by the next credit)')
      returning id into v_overdraft;
    end if;
    update credit_grants set remaining_pence = remaining_pence - v_remaining where id = v_overdraft;
    insert into credit_allocations (transaction_id, grant_id, base_pence, grant_pence, spend_rate) values (v_tx, v_overdraft, v_remaining, v_remaining, 1);
    v_total_grant := v_total_grant + v_remaining;
    v_remaining := 0;
  end if;

  update credit_transactions set amount_pence = -v_total_grant where id = v_tx;
  return v_tx;
end;
$$;

-- Reverses a debit (fully, or p_base_pence of it) back into the grants it
-- consumed; expired grants receive their share as a new adjustment grant.
-- Batch 29: except an expired starter pack bonus, whose share goes back to the
-- same (expired) grant: a new adjustment grant would turn bonus credit into
-- credit that buys anything and never expires. The sweep then zeroes it.
create or replace function public.credit_refund(p_transaction_id bigint, p_base_pence numeric default null, p_reason text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  t record;
  a record;
  v_ratio numeric;
  v_base_back numeric;
  v_total numeric := 0;
  v_grant_back numeric;
  v_tx bigint;
  v_new uuid;
  v_expired boolean;
begin
  select * into t from credit_transactions where id = p_transaction_id and kind = 'debit';
  if not found then raise exception 'debit % not found', p_transaction_id; end if;
  perform 1 from profiles where id = t.user_id for update;
  v_base_back := least(coalesce(p_base_pence, t.base_pence), t.base_pence);
  if v_base_back <= 0 then return null; end if;
  v_ratio := v_base_back / t.base_pence;
  insert into credit_transactions (user_id, kind, amount_pence, base_pence, action_id, action, provider, unit, description, metadata)
  values (t.user_id, 'refund', 0, v_base_back, t.action_id, t.action, t.provider, t.unit, coalesce(p_reason, 'Refund'), jsonb_build_object('refund_of', t.id))
  returning id into v_tx;
  for a in select al.*, g.expires_at, g.kind, g.priority, g.scope from credit_allocations al join credit_grants g on g.id = al.grant_id where al.transaction_id = t.id loop
    v_grant_back := round(a.grant_pence * v_ratio, 4);
    if v_grant_back <= 0 then continue; end if;
    v_expired := a.expires_at is not null and a.expires_at <= now() and a.scope is distinct from 'pack_bonus';
    if v_expired then
      insert into credit_grants (user_id, kind, priority, amount_pence, remaining_pence, spend_rate, description)
      values (t.user_id, 'adjustment', 3, v_grant_back, v_grant_back, a.spend_rate, 'Refund of an expired-cycle debit')
      returning id into v_new;
      insert into credit_allocations (transaction_id, grant_id, base_pence, grant_pence, spend_rate) values (v_tx, v_new, round(a.base_pence * v_ratio, 4), v_grant_back, a.spend_rate);
    else
      update credit_grants set remaining_pence = remaining_pence + v_grant_back where id = a.grant_id;
      insert into credit_allocations (transaction_id, grant_id, base_pence, grant_pence, spend_rate) values (v_tx, a.grant_id, round(a.base_pence * v_ratio, 4), v_grant_back, a.spend_rate);
    end if;
    v_total := v_total + v_grant_back;
  end loop;
  update credit_transactions set amount_pence = v_total where id = v_tx;
  return v_tx;
end;
$$;

-- Adds credit. Idempotent on p_source_ref (a replayed Stripe event returns the
-- existing grant). Repays any outstanding overdraft from the new grant first.
create or replace function public.credit_grant(p_user uuid, p_kind text, p_amount numeric, p_expires_at timestamptz default null, p_source_ref text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_rate numeric;
  v_priority smallint;
  v_overdraft record;
  v_debt_base numeric;
  v_repay_base numeric;
  v_repay_grant numeric;
begin
  if p_kind not in ('plan', 'welcome', 'topup', 'adjustment') then raise exception 'bad grant kind %', p_kind; end if;
  perform 1 from profiles where id = p_user for update;
  if p_source_ref is not null then
    select id into v_id from credit_grants where source_ref = p_source_ref;
    if v_id is not null then return v_id; end if;
  end if;
  v_rate := credit_spend_rate(p_kind);
  v_priority := case p_kind when 'plan' then 1 when 'welcome' then 2 else 3 end;
  insert into credit_grants (user_id, kind, priority, amount_pence, remaining_pence, spend_rate, expires_at, source_ref, description)
  values (p_user, p_kind, v_priority, p_amount, p_amount, v_rate, p_expires_at, p_source_ref, p_description)
  returning id into v_id;
  insert into credit_transactions (user_id, kind, amount_pence, grant_id, description, metadata)
  values (p_user, 'grant', p_amount, v_id, coalesce(p_description, initcap(p_kind) || ' credit'), jsonb_build_object('grant_kind', p_kind, 'source_ref', p_source_ref, 'expires_at', p_expires_at));

  -- Repay overdraft (base pence, rate 1) from this grant.
  select * into v_overdraft from credit_grants where user_id = p_user and source_ref = 'overdraft:' || p_user::text and remaining_pence < 0 for update;
  if found and p_amount > 0 then
    v_debt_base := -v_overdraft.remaining_pence;
    v_repay_base := least(v_debt_base, round(p_amount / v_rate, 4));
    v_repay_grant := least(p_amount, round(v_repay_base * v_rate, 4));
    update credit_grants set remaining_pence = remaining_pence + v_repay_base where id = v_overdraft.id;
    update credit_grants set remaining_pence = remaining_pence - v_repay_grant where id = v_id;
    insert into credit_transactions (user_id, kind, amount_pence, base_pence, grant_id, description, metadata)
    values (p_user, 'adjust', -v_repay_grant, v_repay_base, v_id, 'Overdraft repaid', jsonb_build_object('overdraft_grant', v_overdraft.id));
  end if;
  return v_id;
end;
$$;

-- Zeroes a member's unexpired plan grants (renewal, cancellation, downgrade).
create or replace function public.credit_expire_plan_grants(p_user uuid, p_reason text default 'cycle_ended')
returns int language plpgsql security definer set search_path = public as $$
declare
  g record;
  n int := 0;
begin
  perform 1 from profiles where id = p_user for update;
  for g in select id, remaining_pence from credit_grants where user_id = p_user and kind = 'plan' and remaining_pence > 0 and (expires_at is null or expires_at > now()) for update loop
    insert into credit_transactions (user_id, kind, amount_pence, grant_id, description, metadata)
    values (p_user, 'expire', -g.remaining_pence, g.id, 'Plan credit expired', jsonb_build_object('reason', p_reason));
    update credit_grants set remaining_pence = 0, expires_at = least(coalesce(expires_at, now()), now()) where id = g.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Sweep: write 'expire' rows for every grant past its expiry that still has credit (keeps the ledger honest).
-- Batch 29: a starter pack bonus whose member paid again before it expired is
-- lifted (restriction and expiry gone) instead of expired: the payment trigger
-- does this at once, this catches a payment recorded late. Paid (top-up)
-- grants never carry an expiry, so they never reach this sweep.
create or replace function public.credit_expire_due()
returns int language plpgsql security definer set search_path = public as $$
declare
  g record;
  n int := 0;
begin
  update credit_grants cg set scope_lifted_at = now(), expires_at = null
   where cg.scope = 'pack_bonus' and cg.scope_lifted_at is null
     and cg.expires_at is not null and cg.expires_at <= now() and cg.remaining_pence > 0
     and member_paid_again_at(cg.user_id) <= cg.expires_at;
  for g in select id, user_id, remaining_pence, scope from credit_grants where expires_at is not null and expires_at <= now() and remaining_pence > 0 for update skip locked loop
    insert into credit_transactions (user_id, kind, amount_pence, grant_id, description, metadata)
    values (g.user_id, 'expire', -g.remaining_pence, g.id,
      case when g.scope = 'pack_bonus' then 'Starter pack bonus expired' else 'Plan credit expired' end,
      jsonb_build_object('reason', 'expired'));
    update credit_grants set remaining_pence = 0 where id = g.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Promo / referral redemption. Grants the redeemer (and, for referral codes, the owner).
create or replace function public.credit_redeem_code(p_user uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  v_grant uuid;
  v_owner_grant uuid;
  v_referral numeric;
begin
  if v_code = '' then raise exception 'code_required' using errcode = 'P0403'; end if;
  perform 1 from profiles where id = p_user for update;
  select * into c from credit_codes where code = v_code for update;
  if not found or not c.active then raise exception 'code_invalid' using errcode = 'P0403'; end if;
  if c.expires_at is not null and c.expires_at <= now() then raise exception 'code_expired' using errcode = 'P0403'; end if;
  if c.max_redemptions is not null and c.redeemed_count >= c.max_redemptions then raise exception 'code_exhausted' using errcode = 'P0403'; end if;
  if c.owner_user_id = p_user then raise exception 'code_own_referral' using errcode = 'P0403'; end if;
  if exists (select 1 from credit_code_redemptions where code = v_code and user_id = p_user) then raise exception 'code_already_used' using errcode = 'P0403'; end if;
  if c.kind = 'referral' and exists (select 1 from credit_code_redemptions r join credit_codes cc on cc.code = r.code where r.user_id = p_user and cc.kind = 'referral') then
    raise exception 'referral_already_used' using errcode = 'P0403';
  end if;
  -- Batch 21 (B9): an account whose welcome credit was withheld (a disposable
  -- email, a re-used mobile, a team seat) earns no referral credit and pays
  -- the code's owner nothing; referral codes were the one abuse check left open.
  if c.kind = 'referral' and exists (select 1 from profiles where id = p_user and welcome_withheld_reason is not null) then
    raise exception 'referral_withheld' using errcode = 'P0403';
  end if;
  insert into credit_code_redemptions (code, user_id) values (v_code, p_user);
  update credit_codes set redeemed_count = redeemed_count + 1 where code = v_code;
  v_grant := credit_grant(p_user, 'adjustment', c.amount_pence, null, 'code:' || v_code || ':' || p_user::text,
    case when c.kind = 'referral' then 'Referral credit' else 'Promo code ' || v_code end);
  if c.kind = 'referral' and c.owner_user_id is not null then
    v_referral := credit_setting_num('referral_pence', 1000);
    v_owner_grant := credit_grant(c.owner_user_id, 'adjustment', v_referral, null, 'referral:' || v_code || ':' || p_user::text, 'Referral reward');
    update profiles set referred_by_code = v_code where id = p_user and referred_by_code is null;
  end if;
  return jsonb_build_object('kind', c.kind, 'amount_pence', c.amount_pence, 'grant_id', v_grant, 'owner_grant_id', v_owner_grant);
end;
$$;

revoke execute on function public.credit_setting_num(text, numeric) from public, anon, authenticated;
revoke execute on function public.credit_spend_rate(text) from public, anon, authenticated;
revoke execute on function public.credit_available(uuid) from public, anon, authenticated;
revoke execute on function public.credit_bonus_pays_for(text, jsonb) from public, anon, authenticated;
revoke execute on function public.credit_spendable_for(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.credit_face_available_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.credit_reserve(uuid, text, uuid, numeric, interval) from public, anon, authenticated;
revoke execute on function public.credit_release(uuid) from public, anon, authenticated;
revoke execute on function public.credit_debit(uuid, numeric, uuid, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.credit_refund(bigint, numeric, text) from public, anon, authenticated;
revoke execute on function public.credit_grant(uuid, text, numeric, timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.credit_expire_plan_grants(uuid, text) from public, anon, authenticated;
revoke execute on function public.credit_expire_due() from public, anon, authenticated;
revoke execute on function public.credit_redeem_code(uuid, text) from public, anon, authenticated;

-- ── Welcome credit backfill for every existing account (one-off, idempotent) ──
-- New accounts are granted by the app after the abuse checks (src/lib/credit/welcome.ts).
-- Frozen to the accounts it was written for (it ran on 12 Sep 2026): re-running
-- this file must never hand £20 to a newer account, which would skip the abuse
-- checks, a team seat's "no welcome credit" and, from Batch 20, the starter
-- pack that replaces the welcome credit for new members.
-- Batch 21 (A16): the loop itself now runs in the Batch 21 section at the end
-- of this file, where welcome_withheld_reason and team_members exist: an
-- account whose credit was withheld, or a team seat, is never granted by a
-- re-run.

-- =========================
-- Market Explorer: planning signals (direct-booking "contractor projects")
-- =========================
-- One row per postcode area: large planning applications PlanIt holds within
-- radius_km of the area's centre over the last 12 months and the 12 before.
-- Written by /api/internal/planning-signals (service role) and read into the
-- explorer snapshot; no member-facing policy, so RLS with no policies.
create table if not exists public.area_planning_signals (
  postcode_area text primary key,
  lat numeric not null,
  lng numeric not null,
  radius_km numeric not null,
  large_apps_12m integer,
  large_apps_prev_12m integer,
  fetched_at timestamptz not null default now(),
  source text not null default 'planit'
);
alter table public.area_planning_signals enable row level security;

-- =========================
-- Daily picks (one sourced property a day per member)
-- =========================
-- Daily picks are ON by default: every member who has signed in at least once
-- (welcome_checked_at set) gets one listing a day that fits their goals, or a
-- Stayful house pick when they have no goals, charged at the daily_pick unit
-- cost. Paused subscriptions are skipped by the cron. Turning picks off writes
-- sourcing_opted_out_at (declared above the profiles grant), so the backfill
-- can never re-enrol someone who opted out. Safe to re-run.
-- Review R3 (R3-18 / R2-82): the backfill itself now runs in the Batch 22f
-- section, after profiles.signup_path exists, so that a management-only
-- account (stamped there, its picks switched off) is never re-enrolled.
alter table public.profiles alter column sourcing_alerts set default true;

-- sourcing_sent grows from a (user, url) dedupe ledger into the pick record
-- the member sees on /picks and reacts to from the email. The composite
-- primary key stays: one listing can never be sent twice to the same member.
--   status    pending (row inserted before the send, so overlapping runs and a
--             crash mid-send can never produce two picks) | sent | failed
--             (Resend refused or timed out; kept so the listing is not retried)
--   token     public link token for the email buttons (/p/<token>)
--   basis     goals (from the member's filter) | house (Stayful pick)
--   reaction  yes | no, reaction_source link (email click) | form (confirmed)
alter table public.sourcing_sent add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists sourcing_sent_id_uidx on public.sourcing_sent (id);
alter table public.sourcing_sent add column if not exists token text;
create unique index if not exists sourcing_sent_token_uidx on public.sourcing_sent (token);
alter table public.sourcing_sent add column if not exists status text not null default 'sent';
alter table public.sourcing_sent add column if not exists kind text;
alter table public.sourcing_sent add column if not exists postcode_area text;
alter table public.sourcing_sent add column if not exists basis text;
alter table public.sourcing_sent add column if not exists deal jsonb;
alter table public.sourcing_sent add column if not exists fit integer;
alter table public.sourcing_sent add column if not exists charged_base_pence numeric(14,4);
alter table public.sourcing_sent add column if not exists reaction text;
alter table public.sourcing_sent add column if not exists reaction_source text;
alter table public.sourcing_sent add column if not exists reasons text[];
alter table public.sourcing_sent add column if not exists comment text;
alter table public.sourcing_sent add column if not exists responded_at timestamptz;
alter table public.sourcing_sent add column if not exists checked_listing_id uuid;
alter table public.sourcing_sent add column if not exists saved_at timestamptz;
create index if not exists sourcing_sent_user_sent_idx on public.sourcing_sent (user_id, sent_at desc);
create index if not exists sourcing_sent_sent_at_idx on public.sourcing_sent (sent_at desc);
-- Still service-role only (RLS on, no policies): /picks reads and writes
-- through the admin client after checking the session and filtering by user.

-- =========================
-- White-label lead funnels
-- =========================
-- A customer points their own form (Squarespace, an ad, wherever) at
-- /f/<public_token>. The prospect fills in a property, gets a report under
-- the customer's branding, and the run is charged to the CUSTOMER's credit
-- at the funnel markup — not to the prospect, who never has an account.
--
-- Everything here is written through the service-role client. The public
-- funnel page has no session at all, and the members-only pages read their
-- own rows through the select policies below. Nothing in this section is
-- user-writable, so none of it needs a column grant.
--
-- Deliberately NOT touching public.profiles: the access gate selects a fixed
-- column list (ACCESS_COLUMNS in src/lib/access.ts) and a select naming a
-- missing column fails the whole query and paywalls every member. Funnel
-- state lives in its own tables so that gate can never be affected.

create table if not exists public.funnels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- The credential in the public URL. Minted server-side, rotatable.
  public_token text not null unique,
  name text not null default 'My funnel',
  -- { logoUrl, primary, accent, companyName, replyToEmail } — see src/lib/funnels.
  brand jsonb not null default '{}'::jsonb,
  -- Qualification filter; shape and tolerant parse in src/lib/leads/rules.ts.
  lead_rules jsonb not null default '{}'::jsonb,
  report_depth text not null default 'standard',        -- 'standard' | 'enhanced'
  -- What happens to a lead that fails the filter: push it to the CRM flagged
  -- as not qualified, or hold it inside Stayful for the customer to review,
  -- export or promote later.
  unqualified_policy text not null default 'crm_flagged', -- 'crm_flagged' | 'hold'
  active boolean not null default true,
  -- Abuse and cost ceilings, both per UTC day. The spend cap is the backstop
  -- that turns any residual billing bug into a bounded loss rather than an
  -- unbounded one, so it applies even when the credit checks all pass.
  daily_cap integer not null default 100,
  daily_spend_cap_pence integer not null default 5000,
  -- Set when the public token was last rotated, so a leaked link can be
  -- replaced without losing the lead history attached to the funnel.
  rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists funnels_user_idx on public.funnels (user_id, created_at desc);
alter table public.funnels enable row level security;
drop policy if exists "Users can read own funnels" on public.funnels;
create policy "Users can read own funnels"
  on public.funnels for select
  using (auth.uid() = user_id);

-- leads: one row per prospect who completed a funnel.
--
-- The analysis lives HERE, in `result`, and never in saved_searches. That
-- table is the member's own analyser history and is pruned to the newest 200
-- rows per member (see /api/analyse); funnel leads saving into it would
-- evict a customer's own reports within weeks. Keeping them apart also keeps
-- the two features apart in the UI, the API and the billing history, which
-- is the point: "my reports" and "my leads" are different things.
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  -- The customer who owns this lead and paid for the report.
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Null once a funnel is deleted: the customer keeps leads they paid for.
  funnel_id uuid references public.funnels(id) on delete set null,
  -- ── The prospect ──
  name text,
  email text,
  phone text,
  -- When they agreed to the customer's privacy notice. The customer is the
  -- data controller and Stayful the processor, so this is the lawful basis
  -- for holding the rest of this row.
  consent_at timestamptz,
  -- ── The property ──
  address text,
  postcode text,
  postcode_area text,
  bedrooms integer,
  -- ── The report ──
  result jsonb,
  -- Unguessable path for the prospect's own copy; they have no account.
  report_token text unique,
  -- Supabase Storage path of the rendered PDF, once it has been stored.
  pdf_path text,
  -- ── Qualification ──
  qualified boolean,
  -- The per-rule checks behind `qualified` (LeadVerdict in src/lib/leads/rules.ts),
  -- so a customer can see WHY a lead did not make the cut.
  qualification jsonb,
  -- 'queued'  captured, report not run yet (customer had no credit)
  -- 'new'     report ran, nothing done with it yet
  -- 'pushed'  delivered to the customer's CRM
  -- 'held'    failed the filter on a 'hold' funnel; kept here for review
  -- 'exported' pulled out via the API or a CSV download
  status text not null default 'new',
  crm_item_id text,
  crm_pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_user_created_idx on public.leads (user_id, created_at desc);
create index if not exists leads_funnel_created_idx on public.leads (funnel_id, created_at desc);
-- Powers the qualified-vs-unqualified counts on /leads and /api/v1/leads/stats.
create index if not exists leads_user_qualified_idx on public.leads (user_id, qualified, created_at desc);
-- The queue drained after a top-up lands; tiny, so keep it partial.
create index if not exists leads_queued_idx on public.leads (created_at) where status = 'queued';
-- ── Pipeline stage ──
-- The customer's own sales stage, for customers without a CRM. Deliberately
-- separate from `status`, which is OUR delivery state (queued, pushed…):
-- the two answer different questions and one must not overwrite the other.
-- Fixed list, mirrored by LEAD_STAGES in src/lib/leads/stage.ts.
alter table public.leads add column if not exists stage text not null default 'new';
alter table public.leads add column if not exists stage_changed_at timestamptz;
alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage in ('new', 'contacted', 'meeting_booked', 'signed', 'lost'));

-- ── Retention ── (src/lib/leads/retention.ts, /api/internal/lead-retention)
-- A lead nobody has used for 6 months is archived, kept 7 days so it can be
-- restored, then deleted. The customer is emailed 2 days before and again
-- when it happens.
--
-- `last_activity_at` is what "used" means: the customer opening it, a
-- single-lead API/MCP read, the prospect reopening their report, or a push
-- to the CRM. The default fills EXISTING rows with the moment this runs, so
-- the clock starts at launch and old leads are not all archived on night one.
alter table public.leads add column if not exists last_activity_at timestamptz not null default now();
-- The "archiving in 2 days" email went out. Cleared by any activity.
alter table public.leads add column if not exists archive_warned_at timestamptz;
alter table public.leads add column if not exists archived_at timestamptz;
alter table public.leads add column if not exists archive_reason text;
alter table public.leads drop constraint if exists leads_archive_reason_check;
alter table public.leads add constraint leads_archive_reason_check
  check (archive_reason is null or archive_reason in ('inactive', 'manual'));
-- The "archived" email went out (inactive archives only).
alter table public.leads add column if not exists archive_notified_at timestamptz;
-- When the row is deleted. Set only once the customer has been told — a
-- manual archive tells them on screen, an inactive one by email — so a
-- failed email can never lead to data vanishing unannounced.
alter table public.leads add column if not exists purge_after timestamptz;
create index if not exists leads_user_archived_idx on public.leads (user_id, archived_at, created_at desc);
create index if not exists leads_activity_idx on public.leads (last_activity_at) where archived_at is null;
create index if not exists leads_purge_idx on public.leads (purge_after) where purge_after is not null;

alter table public.leads enable row level security;
drop policy if exists "Users can read own leads" on public.leads;
create policy "Users can read own leads"
  on public.leads for select
  using (auth.uid() = user_id);

-- crm_connections: where a customer's leads are delivered.
--
-- Holds encrypted credentials, so it is service-role only: RLS on with NO
-- policies, like unit_costs. The settings UI reads a sanitised view through
-- a server component; a raw credential must never reach a browser.
--
-- Monday board and column ids differ for every customer, so `config` carries
-- the field map (board id, group id, and the column id for each of name,
-- email, phone, report file, date, qualified) rather than assuming ours.
create table if not exists public.crm_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,                       -- 'monday' | 'webhook'
  -- AES-256-GCM, stored iv:tag:ciphertext (src/lib/crypto/secrets.ts).
  credential_enc text,
  -- Shared secret the webhook payload is signed with, same encryption.
  webhook_secret_enc text,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'unverified',    -- 'unverified' | 'ok' | 'error'
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_connections_user_idx on public.crm_connections (user_id, created_at desc);
alter table public.crm_connections enable row level security;

-- crm_deliveries: the retry queue behind every CRM push.
--
-- A push is never done inline with the prospect's request: the customer's
-- CRM being down must not cost them the lead or leave the prospect waiting.
-- /api/internal/crm-deliveries drains this with backoff.
create table if not exists public.crm_deliveries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  connection_id uuid not null references public.crm_connections(id) on delete cascade,
  status text not null default 'pending',       -- 'pending' | 'sent' | 'failed'
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The cron's only query: what is due, oldest first.
create index if not exists crm_deliveries_due_idx
  on public.crm_deliveries (next_attempt_at) where status = 'pending';
create index if not exists crm_deliveries_lead_idx on public.crm_deliveries (lead_id);
alter table public.crm_deliveries enable row level security;

-- api_keys: bearer tokens for /api/v1/* and the MCP server.
--
-- Same shape and the same hashing as extension_tokens (raw value shown once,
-- only the SHA-256 stored, so a database read can never impersonate anyone),
-- but a separate table: the shipped Chrome extension reads extension_tokens
-- and must not be disturbed. Raw keys are prefixed 'sfk_'.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  label text,
  -- e.g. {'leads:read','leads:write','analyse','markets:read'}. Empty means
  -- read-only, so a key can never gain reach by omission.
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys (user_id, created_at desc);
alter table public.api_keys enable row level security;
drop policy if exists "Users can read own api keys" on public.api_keys;
create policy "Users can read own api keys"
  on public.api_keys for select
  using (auth.uid() = user_id);

-- funnel_hits: durable rate limiting and the daily caps.
--
-- The in-memory limiter in /api/analyse is per serverless instance, which is
-- close to no limit at all across a fleet. A public endpoint that spends a
-- customer's money needs counters that survive a cold start, so they live
-- here. One row per (funnel, bucket, window): 'funnel' for the daily totals
-- the caps are checked against, 'ip:<addr>' for per-visitor throttling.
create table if not exists public.funnel_hits (
  funnel_id uuid not null references public.funnels(id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  spend_base_pence numeric(14,4) not null default 0,
  primary key (funnel_id, bucket, window_start)
);
-- Lets the sweep drop windows that have rolled over.
create index if not exists funnel_hits_window_idx on public.funnel_hits (window_start);
alter table public.funnel_hits enable row level security;

-- ── Funnel alerts: one row per funnel, kind and UTC day ──
--
-- The dedup store behind "tell the owner when their funnel stops working".
-- Every wall a funnel can hit used to be silent: a customer whose credit ran
-- dry kept collecting leads that were captured, queued and never reported on,
-- and nothing told them. A prospect landing on a paused link was invisible too.
--
-- The INSERT is the decision. Whoever creates the row sends the email and
-- everybody else conflicts and stays quiet, so a funnel that hits its ceiling
-- eighty times in a day sends one email rather than eighty — and it is decided
-- atomically, not by reading and then writing.
create table if not exists public.funnel_alerts (
  funnel_id uuid not null references public.funnels(id) on delete cascade,
  -- 'out_of_credit' | 'paused_hit' | 'daily_cap' | 'spend_cap'
  kind text not null,
  day timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (funnel_id, kind, day)
);
-- Lets a sweep drop days that have rolled over.
create index if not exists funnel_alerts_day_idx on public.funnel_alerts (day);

alter table public.funnel_alerts enable row level security;

/**
 * Claims the right to tell this funnel's owner about this wall today.
 * Returns true to exactly one caller per (funnel, kind, UTC day).
 *
 * In SQL for the same reason funnel_hit and funnel_spend_reserve are: the
 * decision has to be the write. Reading whether we have already sent and then
 * writing that we have would let concurrent submissions all decide they were
 * first and send their own copy — and the whole point is one email, not one
 * per prospect. It is a function rather than an upsert from the client so the
 * contract is ours and does not depend on how a driver reports a conflict.
 */
create or replace function public.funnel_alert_claim(
  p_funnel uuid,
  p_kind text,
  p_day timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  insert into public.funnel_alerts (funnel_id, kind, day)
  values (p_funnel, p_kind, p_day)
  on conflict (funnel_id, kind, day) do nothing;
  -- 0 when somebody else already claimed it today.
  return found;
end;
$$;

-- ── Funnel caps: atomic, because a public endpoint spends real money ──
--
-- The members-only daily cap (resolvesToday in src/lib/listing/server.ts)
-- counts rows and then checks the count. That is fine when the member is one
-- person clicking a button. On a public funnel, N concurrent requests all read
-- the same count and all pass it, so a count-then-check does not cap anything.
--
-- These do the counting and the checking in ONE statement, so concurrent
-- requests serialise on the row.

/**
 * Records an attempt and reports whether it is within the limit.
 * Returns the new count, or -1 when the attempt is over it. The row still
 * counts a refused attempt, so a flood shows up afterwards instead of being
 * invisible. p_limit <= 0 means no limit.
 */
create or replace function public.funnel_hit(
  p_funnel uuid,
  p_bucket text,
  p_window timestamptz,
  p_limit integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into public.funnel_hits (funnel_id, bucket, window_start, hits)
  values (p_funnel, p_bucket, p_window, 1)
  on conflict (funnel_id, bucket, window_start)
    do update set hits = public.funnel_hits.hits + 1
  returning hits into v_hits;

  if p_limit > 0 and v_hits > p_limit then
    return -1;
  end if;
  return v_hits;
end;
$$;

/**
 * Claims p_base_pence of the funnel's daily spend ceiling BEFORE a run, at the
 * run's worst case. Returns false when the claim would breach the cap, having
 * changed nothing.
 *
 * Reserving up front and settling afterwards is the same shape as a credit
 * reservation, and for the same reason: checking the spend so far and then
 * spending leaves a window where concurrent runs all pass the check and the
 * day's total sails past the ceiling.
 */
create or replace function public.funnel_spend_reserve(
  p_funnel uuid,
  p_window timestamptz,
  p_base_pence numeric,
  p_cap numeric
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_spend numeric;
begin
  insert into public.funnel_hits (funnel_id, bucket, window_start, spend_base_pence)
  values (p_funnel, 'funnel', p_window, p_base_pence)
  on conflict (funnel_id, bucket, window_start)
    do update set spend_base_pence = public.funnel_hits.spend_base_pence + p_base_pence
  returning spend_base_pence into v_spend;

  if p_cap > 0 and v_spend > p_cap then
    -- Put it back: the caller is not going to run, so the claim must not
    -- linger and lock out the rest of the day.
    update public.funnel_hits
       set spend_base_pence = spend_base_pence - p_base_pence
     where funnel_id = p_funnel and bucket = 'funnel' and window_start = p_window;
    return false;
  end if;
  return true;
end;
$$;

/**
 * Reconciles a reservation to what the run actually cost. The difference is
 * usually negative (the reservation is the worst case), which hands unused
 * headroom back to the rest of the day.
 */
create or replace function public.funnel_spend_settle(
  p_funnel uuid,
  p_window timestamptz,
  p_reserved numeric,
  p_actual numeric
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.funnel_hits
     set spend_base_pence = greatest(0, spend_base_pence - p_reserved + p_actual)
   where funnel_id = p_funnel and bucket = 'funnel' and window_start = p_window;
end;
$$;

/** Drops throttle windows that have rolled over. Called by the daily sweep. */
create or replace function public.funnel_hits_sweep(p_before timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.funnel_hits where window_start < p_before;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- =========================
-- Motivated sellers and landlords
-- =========================
-- The motivated-seller filter is the one pick that is allowed to be old: a
-- listing that has been sitting for months is the whole point of it. Its pool
-- reads sourced_listings by area and kind, bounded below by an age floor and
-- ordered by last sighting, so this index carries the filtering columns and
-- leaves only a small set to sort.
--
-- Nothing else is needed. The member's filter rides inside the existing
-- profiles.market_goals jsonb, and the listing-level fields (listedDate, uprn,
-- addedOrReduced, agentHash) ride inside sourced_listings.snapshot — so no
-- column is added to profiles, and ACCESS_COLUMNS in src/lib/access.ts is
-- untouched.
create index if not exists sourced_listings_area_kind_idx
  on public.sourced_listings (postcode_area, kind, first_seen_at desc);

-- The advice sent with a near-miss pick: which filter was the binding one and
-- what to change it to. Stored rather than recomputed because the one-click
-- "change it" link on /p/[token] must apply only a value WE proposed — the
-- token travels in an email, so anyone holding that email can invoke the
-- action, and accepting a value from the request would let them rewrite
-- someone else's filter to anything at all.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT READS IT. PICK_COLUMNS in
-- src/lib/listing/picks-server.ts is a fixed select, so a missing column fails
-- the whole query and takes /picks and /p/[token] down with it.
alter table public.sourcing_sent add column if not exists relaxation jsonb;

-- The motivation signals that fired for this pick, as they were claimed in the
-- email. Stored rather than recomputed so the picks page can never disagree
-- with what the member was actually told: a recomputation would be missing the
-- area median from the run that produced it, and would quietly drop a reason.
-- Same deployment rule as above — column first, then the code.
alter table public.sourcing_sent add column if not exists motivation jsonb;

-- The income screening that decided this pick was worth sending: band, the
-- figures behind it, and whether each input was confirmed or estimated. Stored
-- rather than recomputed for the same reason as motivation above — the area
-- revenue and the rent ladder move, so a recomputation would quietly disagree
-- with the numbers the member was actually shown.
-- Same deployment rule as above — column first, then the code.
alter table public.sourcing_sent add column if not exists screening jsonb;

-- =========================
-- subscription_events
-- =========================
-- Append-only history of what a subscription did and why, so churn can be
-- measured. Everything else subscription-shaped is a MUTABLE column on
-- profiles, which cannot answer the two questions the churn report asks:
--
--   "why did the ones who left at 6 months leave?"   profiles.cancel_reason is
--   overwritten by the next cancellation and, until the fix in
--   src/lib/stripe/webhook.ts, was nulled the moment the subscription actually
--   ended — so the reason was destroyed at the exact moment it became the
--   answer.
--
--   "how long did they stay?"   a member who leaves and comes back has one
--   subscription_started_at, so the two spells look like one long one.
--
-- cycle_started_at is what separates them: it is the Stripe subscription's own
-- start_date, so a win-back is a SECOND cohort rather than a longer first one.
-- Tenure is always derived (at − cycle_started_at) and never stored, for the
-- same reason the pause window is a time comparison rather than a flag —
-- nothing to drift, nothing to keep in step with a cron.
--
-- Deliberately NOT columns on profiles: ACCESS_COLUMNS in src/lib/access.ts
-- selects a fixed list, and a PostgREST select naming a column that does not
-- exist fails the whole query and bounces every member to the paywall. A
-- separate table cannot take the site down by being added a merge late.
create table if not exists public.subscription_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  -- 'started' | 'cancel_scheduled' | 'cancel_reverted' | 'ended'
  -- | 'paused' | 'resumed' | 'past_due' | 'recovered' | 'plan_changed'
  kind text not null,
  -- The subscription's own start_date. Null only for a manually granted plan
  -- that Stripe has never seen.
  cycle_started_at timestamptz,
  plan_code text,
  -- Monthly-equivalent price AS AT this event, so a later price change can
  -- never rewrite history. Annual plans are divided down (see churn.ts).
  mrr_pence integer,
  -- The cancel-reason slug. A superset of CANCEL_REASONS in
  -- src/app/account/plan-view.ts: reporting also uses 'payment_failed', which
  -- is never offered to a member because nobody chooses a dead card.
  reason text,
  reason_comment text,
  -- 'self_serve' | 'portal' | 'stripe' | 'manual' | 'backfill'. Tells an
  -- answer the member typed apart from one Stripe inferred.
  source text not null default 'stripe',
  stripe_subscription_id text,
  stripe_event_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists subscription_events_user_at_idx
  on public.subscription_events (user_id, at);
create index if not exists subscription_events_kind_at_idx
  on public.subscription_events (kind, at);

-- One Stripe delivery can legitimately produce two rows — a plan change and a
-- scheduled cancel arrive on the same event — so the guard is per (event, kind)
-- rather than per event. A replayed delivery, a second webhook endpoint and a
-- re-run of the backfill all land on the same row and are ignored.
create unique index if not exists subscription_events_stripe_event_kind_uidx
  on public.subscription_events (stripe_event_id, kind)
  where stripe_event_id is not null;

alter table public.subscription_events enable row level security;  -- no policies: service role only
-- Supabase grants the API roles privileges on new public tables by default.
-- RLS with no policies already returns nothing, but revoking says so outright.
revoke all on public.subscription_events from anon, authenticated;

-- =========================
-- Deals marketplace
-- =========================
-- A browsable pool of every currently-active listing in the top scored areas
-- that clears the income screening (src/lib/listing/screen.ts). One row per
-- listing; the address, postcode and listing URL stay on sourced_listings
-- and are only read once a member has paid to open the deal (deal_opens).
-- The grid selects PUBLIC_DEAL_COLUMNS (src/lib/marketplace/grid.ts) and never
-- the canonical_url. Service role only.
create table if not exists public.marketplace_deals (
  canonical_url text primary key references public.sourced_listings(canonical_url) on delete cascade,
  -- The public handle. Reactivation reuses the row, so the id is stable for
  -- the life of the listing and deal_opens.deal_id can never dangle.
  id uuid not null default gen_random_uuid(),
  source text not null,
  kind text not null,                        -- sale | rent
  postcode_area text,
  outcode text,
  town text,
  bedrooms int,
  price_amount numeric,                      -- sale: asking price; rent: pcm
  price_period text,                         -- total | pcm
  raw_type text,
  tenure text,
  photo text,
  photos jsonb,
  band text not null,                        -- 'qualified' while live; kept for the admin report on retirement
  screening jsonb not null,
  deal jsonb,                                -- deal.ts figures at house finance defaults
  suitability text,                          -- ok | unknown
  motivation jsonb,
  -- screening.surplus: the annual surplus over a long let (purchase) or the
  -- annual profit after rent (rent-to-rent). The ladder price and sort key.
  annual_profit numeric,
  uplift_pct numeric,                        -- purchase only
  price_history jsonb not null default '[]'::jsonb,
  reduced_at timestamptz,
  listed_date timestamptz,
  -- pending_check: qualified on the area's figures, waiting on the shortlist
  -- for its own comparables check (Batch 16). pending_verify: qualified,
  -- waiting for its first page fetch, which supplies the photo and the live
  -- status. live: on the grid.
  status text not null default 'pending_verify',
  retired_reason text,                       -- sold | under_offer | let_agreed | removed | unqualified | unsuitable | stale_listed | stale_unseen | unverifiable | admin | insufficient_data | unchecked (Batch 16)
  retired_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_checked_live_at timestamptz,
  last_confirmed_at timestamptz not null default now(),
  last_confirmed_via text not null default 'feed',   -- feed | live
  next_check_due_at timestamptz,
  -- Set by an open that could not verify the listing; the recheck takes these first.
  check_requested_at timestamptz,
  -- The last time a member's grid showed this deal: the recheck checks what
  -- members are looking at before the tail.
  last_shown_at timestamptz,
  check_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists marketplace_deals_id_uidx on public.marketplace_deals (id);
create index if not exists marketplace_deals_live_profit_idx on public.marketplace_deals (kind, annual_profit desc) where status = 'live';
create index if not exists marketplace_deals_live_area_idx on public.marketplace_deals (postcode_area, kind) where status = 'live';
create index if not exists marketplace_deals_live_seen_idx on public.marketplace_deals (first_seen_at desc) where status = 'live';
create index if not exists marketplace_deals_due_idx on public.marketplace_deals (status, next_check_due_at) where status in ('live', 'pending_verify');
alter table public.marketplace_deals enable row level security;  -- no policies: service role only
revoke all on public.marketplace_deals from anon, authenticated;

-- deal_opens: a member's unlocks. The row is inserted BEFORE the debit
-- (status pending) and flipped to open after it; the id doubles as the
-- ledger action_id, so a crash between the two is recovered by
-- actionAlreadyCharged rather than charged twice. An open row is forever:
-- a deal that later goes off market still reads in /deals/opened.
create table if not exists public.deal_opens (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_url text not null,
  deal_id uuid not null,
  status text not null default 'pending',    -- pending | open
  opened_at timestamptz not null default now(),
  charged_base_pence numeric(14,4) not null default 0,
  transaction_id bigint,
  verified_via text,                         -- live | recent_live | recent_confirm | pick | admin
  status_at_open text,
  band_at_open text,
  annual_profit_at_open numeric,
  checked_listing_id uuid,
  saved_at timestamptz,
  -- Whether this open spent a page fetch, for the per-member hourly cap.
  fetched boolean not null default false,
  primary key (user_id, canonical_url)
);
create unique index if not exists deal_opens_id_uidx on public.deal_opens (id);
create index if not exists deal_opens_user_idx on public.deal_opens (user_id, opened_at desc);
create index if not exists deal_opens_deal_idx on public.deal_opens (deal_id);
alter table public.deal_opens enable row level security;  -- no policies: service role only
revoke all on public.deal_opens from anon, authenticated;

-- marketplace_runs: one row per sweep / recheck pass, for /admin/deals.
create table if not exists public.marketplace_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                        -- sweep | recheck
  dry boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create index if not exists marketplace_runs_kind_idx on public.marketplace_runs (kind, started_at desc);
alter table public.marketplace_runs enable row level security;  -- no policies: service role only
revoke all on public.marketplace_runs from anon, authenticated;

-- marketplace_cohorts: the PropertyData motivated-seller cohorts per area,
-- refreshed weekly by the sweep (one credit per cohort per area).
create table if not exists public.marketplace_cohorts (
  postcode_area text primary key,
  payload jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);
alter table public.marketplace_cohorts enable row level security;  -- no policies: service role only
revoke all on public.marketplace_cohorts from anon, authenticated;

-- The pick that came from the pool links to its deal sheet. APPLY BEFORE
-- deploying the code that reads it: PICK_COLUMNS is a fixed select.
alter table public.sourcing_sent add column if not exists deal_id uuid;

-- Lead-form provisioning (src/app/api/internal/leads/provision): where the
-- member came from, and when they first signed in so the activation can be
-- reported back to the ad platform.
alter table public.profiles add column if not exists lead_source jsonb;
alter table public.profiles add column if not exists lead_activated_at timestamptz;

-- The open-price ladder (src/lib/marketplace/ladder.ts). Bands on annual
-- profit; editable from /admin/deals.
insert into public.billing_settings (key, value)
values ('deal_open_ladder', '[{"upTo":15000,"pence":25},{"upTo":25000,"pence":40},{"upTo":40000,"pence":60},{"upTo":60000,"pence":80},{"upTo":null,"pence":100}]'::jsonb)
on conflict (key) do nothing;

-- =========================
-- Teams (src/lib/team)
-- =========================
-- An account owner invites colleagues. One team per login: member_id is the
-- primary key. The owner has no row; owning is simply not being a member.
-- Each member's seat is a flat £10 of the OWNER's credit, charged on joining
-- and every 30 days (team_seat_charges). All three tables are service-role
-- only: RLS on, no policies — the app reads them server-side and decides.
create table if not exists public.team_members (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- True when the login was created to accept the invite. Such a login is
  -- deleted when the member is removed; a pre-existing account just leaves.
  created_via_invite boolean not null default false,
  joined_at timestamptz not null default now(),
  -- The seat is paid up to here; the seats cron renews at or after it.
  seat_paid_until timestamptz not null,
  -- Set when a renewal could not be paid. Cleared when it is.
  suspended_at timestamptz,
  constraint team_members_not_self check (owner_id <> member_id)
);
create index if not exists team_members_owner_idx on public.team_members (owner_id);
alter table public.team_members enable row level security;
revoke all on public.team_members from anon, authenticated;

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- Stored lower-case; compared to the accepting user's email.
  email text not null,
  -- sha256 of the emailed token; the token itself is never stored.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);
-- One open invite per owner per address: a resend replaces the token.
create unique index if not exists team_invites_open_idx
  on public.team_invites (owner_id, email) where accepted_at is null and revoked_at is null;
create index if not exists team_invites_email_idx on public.team_invites (email) where accepted_at is null and revoked_at is null;
alter table public.team_invites enable row level security;
revoke all on public.team_invites from anon, authenticated;

-- One row per paid seat period. The unique key is the double-charge guard:
-- the row is inserted BEFORE the debit, so a retried accept or two cron runs
-- racing on the same seat cannot both charge it.
create table if not exists public.team_seat_charges (
  id bigint generated always as identity primary key,
  member_id uuid not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  period_start timestamptz not null,
  transaction_id bigint,
  created_at timestamptz not null default now(),
  constraint team_seat_charges_period_key unique (member_id, period_start)
);
create index if not exists team_seat_charges_owner_idx on public.team_seat_charges (owner_id, created_at desc);
alter table public.team_seat_charges enable row level security;
revoke all on public.team_seat_charges from anon, authenticated;

-- credit_debit_face (a FACE debit: exactly p_face_pence of displayed balance,
-- for a seat sold as a flat £10, and for Batch 23's calls, texts and emails)
-- is defined once, in the Batch 25 section (R2-13: it leaves open
-- reservations alone). The copy that stood here was replaced on every run, so
-- an edit to it was silently lost (Review R3, R3-153).

-- ── Shared team reports ──
-- A report belongs to the ACCOUNT that paid for it (owner_id) and was run by
-- user_id. For someone on their own they are the same; a team member's
-- reports are the team's, paid from the owner's credit, and every active
-- member sees them. Backfilled so every existing report is its author's.
alter table public.saved_searches add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
update public.saved_searches set owner_id = user_id where owner_id is null;
create index if not exists saved_searches_owner_idx on public.saved_searches (owner_id, created_at desc);
-- Helpers live in `private`, a schema the API does not expose: nobody can
-- call them over /rest/v1/rpc, and they are still usable from policies and
-- triggers.
create schema if not exists private;
grant usage on schema private to authenticated;

-- The caller's team owner while their seat is active, else null.
-- team_members is service-role only, so a policy cannot read it directly;
-- this definer function answers the one question the policy needs.
create or replace function private.active_team_owner()
returns uuid language sql security definer set search_path = public stable as $$
  select owner_id from public.team_members
  where member_id = (select auth.uid()) and suspended_at is null;
$$;
revoke execute on function private.active_team_owner() from public;
grant execute on function private.active_team_owner() to authenticated;

-- Wrapped in (select ...) so each is evaluated once per query, not per row.
-- `to authenticated`: anonymous requests never evaluate it.
drop policy if exists "Team can read team searches" on public.saved_searches;
create policy "Team can read team searches"
  on public.saved_searches for select to authenticated
  using (owner_id = (select auth.uid()) or owner_id = (select private.active_team_owner()));

-- owner_id is decided by the database, never by the writer. Signed-in users
-- can write their own rows with the public key, so a client-supplied
-- owner_id would let anyone plant a report in another account's team list.
-- On insert it is derived from team membership (the team owner, else the
-- author); once set it never moves. This also covers inserts from code that
-- predates the column.
create or replace function private.saved_searches_set_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.owner_id is not null then
    new.owner_id := old.owner_id;
  else
    new.owner_id := coalesce(
      (select tm.owner_id from public.team_members tm where tm.member_id = new.user_id),
      new.user_id
    );
  end if;
  return new;
end;
$$;
revoke execute on function private.saved_searches_set_owner() from public;
drop trigger if exists saved_searches_set_owner on public.saved_searches;
create trigger saved_searches_set_owner
  before insert or update on public.saved_searches
  for each row execute function private.saved_searches_set_owner();

-- =========================
-- Early access to marketplace deals (src/lib/marketplace/visibility.ts)
-- =========================
-- An account that has ever paid (any subscription, any top-up, admins — see
-- hasEverPaid in src/lib/access.ts) sees a deal the moment it goes live.
-- Every other account, and every signed-out visitor, sees it
-- free_deal_delay_hours later. Inside that window the deal is simply absent
-- for them: not on the grid, the map, the counts, the teaser, by id, as an
-- open or as a daily pick.
--
-- live_since is stamped by the trigger on every transition to 'live' (first
-- entry, pending_verify → live, reactivation, admin restore), so none of the
-- code paths that flip the status can forget it. A live row it has not
-- stamped counts as brand new: hidden from the delayed tier, never shown
-- early. APPLY BEFORE deploying the code that reads it: DEAL_COLUMNS
-- (src/lib/marketplace/server.ts) is a fixed select, and every deal read
-- filters on this column.
alter table public.marketplace_deals add column if not exists live_since timestamptz;
create or replace function private.marketplace_deals_stamp_live()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'live' and (tg_op = 'INSERT' or old.status is distinct from 'live') then
    new.live_since := now();
  end if;
  return new;
end;
$$;
drop trigger if exists marketplace_deals_stamp_live on public.marketplace_deals;
create trigger marketplace_deals_stamp_live
  before insert or update on public.marketplace_deals
  for each row execute function private.marketplace_deals_stamp_live();
-- Rows that were live before the column existed: their first sighting is the
-- best date we have. live → live, so the trigger leaves this value alone.
update public.marketplace_deals set live_since = coalesce(live_since, first_seen_at) where status = 'live' and live_since is null;
create index if not exists marketplace_deals_live_since_idx on public.marketplace_deals (live_since) where status = 'live';
-- The window, in hours. 0 switches it off. Edit the row to change it; no deploy needed.
insert into public.billing_settings (key, value) values ('free_deal_delay_hours', '48') on conflict (key) do nothing;

-- =========================
-- Notifications panel (src/lib/notifications)
-- =========================
-- One switch per notification type, each a boolean on profiles:
--   sourcing_alerts  daily picks (with sourcing_opted_out_at, above)
--   alert_weekly     weekly area alerts
--   alert_credit     "picks paused / out of credit": the paused-picks letter
--                    and the low-balance / out-of-credit emails
-- The panel is the only place these change (service role, via
-- src/lib/notifications/server.ts); the goals modal no longer writes them.
-- Billing and receipt emails have no switch.
alter table public.profiles add column if not exists alert_credit boolean not null default true;

-- =========================
-- "Your picks have paused" (src/lib/listing/picks-paused.ts)
-- =========================
-- When the daily-picks run finds a member a property but their credit will
-- not cover it, the pick is recorded here — figures only, never the address,
-- postcode or URL — and the 08:00 cron (/api/internal/picks-paused) sends
-- one letter per member: on the first day, then at most every seven days
-- while they stay out of credit, listing everything missed since the last
-- letter, and never once they have credit again. Service role only.
create table if not exists public.sourcing_missed (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_url text not null,
  missed_at timestamptz not null default now(),
  kind text not null,                        -- sale | rent
  postcode_area text,
  bedrooms int,
  price_amount numeric,                      -- sale: asking price; rent: pcm
  price_period text,                         -- total | pcm
  annual_profit numeric,                     -- screening.surplus, £/yr
  need_pence numeric not null default 0,     -- what the pick would have cost
  emailed_at timestamptz,                    -- the letter that listed it
  superseded_at timestamptz,                 -- a pick went out after it, so it never resurfaces
  unique (user_id, canonical_url)
);
create index if not exists sourcing_missed_user_idx on public.sourcing_missed (user_id, missed_at desc);
create index if not exists sourcing_missed_pending_idx on public.sourcing_missed (missed_at) where emailed_at is null and superseded_at is null;
alter table public.sourcing_missed enable row level security;  -- no policies: service role only
revoke all on public.sourcing_missed from anon, authenticated;
-- When the last paused letter went out (null: never).
alter table public.profiles add column if not exists picks_paused_email_at timestamptz;

-- One-off "picks are now daily" notice (src/lib/listing/daily-notice-run.ts):
-- when it was sent to this member, so a second press of the admin button
-- never sends twice. Null: not yet.
alter table public.profiles add column if not exists daily_notice_sent_at timestamptz;

-- =========================
-- Batch 2: signup questions and nav
-- =========================
-- onboarding_skips (Batch 2's "Skip for now" counter) was dropped in Batch 21
-- (A7): nothing has read or written it since the welcome quiz replaced that
-- screen. See the Batch 21 section at the end of this file.

-- =========================
-- Batch 3: deal card
-- =========================
-- deal_reactions: a member's Keep or Pass on a marketplace deal, from the
-- card's buttons (src/lib/marketplace/reactions-server.ts). Both are free and
-- neither reveals the address. One row per (member, deal): the actions write
-- the target state (upsert on the key, or delete), so a double tap can never
-- make a second row. `reasons` are PICK_REASONS keys (src/lib/listing/picks.ts)
-- and only ever set on a pass; the daily picks run turns them into the same
-- rules a "no" on a pick makes. updated_at is written by the code (there is
-- no trigger) and is what "the latest answer wins" compares against
-- sourcing_sent.responded_at. Keyed on the signed-in member, not the team
-- owner: opens are shared across a team, opinions are not.
create table if not exists public.deal_reactions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  deal_id uuid not null references public.marketplace_deals(id) on delete cascade,
  reaction text not null check (reaction in ('keep', 'pass')),
  reasons text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, deal_id)
);
create index if not exists deal_reactions_user_idx on public.deal_reactions (user_id, reaction, updated_at desc);
create index if not exists deal_reactions_deal_idx on public.deal_reactions (deal_id);
alter table public.deal_reactions enable row level security;  -- no policies: service role only
revoke all on public.deal_reactions from anon, authenticated;

-- deal_shares: a public link to one marketplace deal (/d/<token>), one per
-- (sharer, deal) so sharing again hands back the same link. Same token shape
-- as a checked listing's share_token (24 random bytes, base64url). The page
-- shows only what the card shows — never the address, postcode or listing
-- link, even when the sharer has opened the deal — and carries the sharer's
-- referral code on its join button.
create table if not exists public.deal_shares (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  deal_id uuid not null references public.marketplace_deals(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists deal_shares_user_deal_uidx on public.deal_shares (user_id, deal_id);
alter table public.deal_shares enable row level security;  -- no policies: service role only
revoke all on public.deal_shares from anon, authenticated;

-- The grid embeds deal_reactions to hide a member's passes; tell PostgREST
-- about the new relationships now rather than on its next schema reload.
notify pgrst, 'reload schema';

-- =========================
-- Batch 4: today screen
-- =========================
-- today_selections: the deals Today shows a member for one day
-- (src/lib/today). Chosen once, on the member's first visit after the day
-- turns over at 07:00 UTC (the hour the picks email goes out), then read
-- back, so every reload and every device shows the same list. `day` is the
-- date that Today-day started on, in UTC. A deal stored here never comes
-- back to that member's Today on a later day. The daily pick is NOT stored:
-- it is read from sourcing_sent on every visit, because it can land after
-- the list was chosen. `advice` is the one-line "what to change" shown when
-- nothing matched exactly and the list holds the closest deal instead.
-- Service role only.
create table if not exists public.today_selections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  deal_ids uuid[] not null default '{}',
  near_miss boolean not null default false,
  advice text,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.today_selections enable row level security;  -- no policies: service role only
revoke all on public.today_selections from anon, authenticated;

-- checklist_steps: the first-week checklist on Today. One row per (member,
-- step), written when the step is first seen done in the member's own
-- activity, never self-reported. The £1 reward is a `welcome`-kind grant
-- with source_ref 'checklist:<step>:<user>', so credit_grants' unique
-- source_ref makes a second payment impossible; grant_id records it here.
-- skipped_reason says why a step will never be paid (welcome credit
-- withheld, a team member, done after the first seven days). seen_at is
-- when the "+£1 credit" line was shown. Deliberately a table, not columns
-- on profiles (see ACCESS_COLUMNS in src/lib/access.ts). Service role only.
create table if not exists public.checklist_steps (
  user_id uuid not null references public.profiles(id) on delete cascade,
  step text not null check (step in ('goals', 'keep3', 'open', 'report', 'share')),
  completed_at timestamptz not null default now(),
  grant_id uuid,
  skipped_reason text,
  seen_at timestamptz,
  primary key (user_id, step)
);
alter table public.checklist_steps enable row level security;  -- no policies: service role only
revoke all on public.checklist_steps from anon, authenticated;

-- =========================
-- Other Stayful tools on this database
-- =========================
-- Tables and functions that other Stayful tools created on the live project,
-- not this app. Declared here so this file describes the whole public
-- schema: a fresh project built from it matches live, and re-running it on
-- live changes nothing. Those tools still own these; change a definition
-- there first, then mirror it here.
-- This app only reads analyser_reports (the market explorer, planning
-- signals and the internal broker provider). The live project also has the
-- `allotment` and `outreach` schemas, which belong to other tools and are not
-- tracked in this file (`private` is this file's: it creates the schema and
-- the private.* helpers above; Batch 21, A18). `outreach` (the n8n WhatsApp outreach
-- tool) is service_role only: RLS on every table, its v_due_* views
-- security_invoker, nothing granted to anon or authenticated (set live by the
-- `security_advisor_fixes` migration).

-- analyser_reports: one row per analyser run (source 'analyser' by default).
create table if not exists public.analyser_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  address text,
  postcode text,
  postcode_area text,
  bedrooms integer,
  adr numeric,
  occupancy numeric,
  gross_revenue numeric,
  purchase_price numeric,
  lead_email text,
  source text default 'analyser',
  raw_response jsonb,
  net_revenue numeric,
  property_value_low numeric,
  property_value_high numeric,
  comp_count integer,
  comp_radius_km numeric,
  comp_avg_adr numeric,
  comp_avg_occupancy numeric,
  comp_avg_annual_revenue numeric,
  filename text,
  extraction_status text default 'ok',
  extraction_error text,
  comp_avg_rating numeric,
  comp_avg_review_count numeric,
  comp_avg_listing_age numeric,
  active_listings integer,
  listing_density numeric,
  demand_hospitals integer,
  demand_universities integer,
  demand_transport integer,
  demand_events integer,
  lat numeric,
  lng numeric,
  market_signals_version integer,
  request_id text
);
create unique index if not exists analyser_reports_source_request_id_key on public.analyser_reports (source, request_id) where request_id is not null;
create index if not exists idx_analyser_reports_area_created on public.analyser_reports (postcode_area, created_at);
create index if not exists idx_analyser_reports_bedrooms on public.analyser_reports (bedrooms);
create index if not exists idx_analyser_reports_postcode_area on public.analyser_reports (postcode_area);
alter table public.analyser_reports enable row level security;  -- no policies: service role only

-- airbtics_report_cache: Airbtics report ids kept until expires_at.
create table if not exists public.airbtics_report_cache (
  cache_key text primary key,
  report_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_airbtics_report_cache_expires on public.airbtics_report_cache (expires_at);
alter table public.airbtics_report_cache enable row level security;  -- no policies: service role only

-- admin_users / admin_password_resets: an admin sign-in (salted password
-- hashes, reset tokens). Service role only: unlike the tables around them,
-- anon and authenticated hold no grants on these at all.
create table if not exists public.admin_users (
  email text primary key,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

create table if not exists public.admin_password_resets (
  token_hash text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  requested_ip text
);
create index if not exists idx_admin_password_resets_email on public.admin_password_resets (email);
create index if not exists idx_admin_password_resets_expires on public.admin_password_resets (expires_at);
alter table public.admin_password_resets enable row level security;
revoke all on public.admin_password_resets from anon, authenticated;

-- bulk_jobs / bulk_job_rows: bulk analyser runs from a spreadsheet, one job
-- per upload and one row per property in it, claimed by workers through
-- claim_bulk_rows below.
create table if not exists public.bulk_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  filename text,
  status text not null default 'draft',
  total_rows integer not null default 0,
  runnable_rows integer not null default 0,
  header_map jsonb,
  paused_reason text,
  confirmed_at timestamptz,
  finished_at timestamptz
);
alter table public.bulk_jobs enable row level security;  -- no policies: service role only

create table if not exists public.bulk_job_rows (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.bulk_jobs(id) on delete cascade,
  row_number integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  input_email text,
  input_phone text,
  input_phone_e164 text,
  input_address text,
  input_postcode text,
  input_bedrooms integer,
  input_guests integer,
  warnings jsonb not null default '[]'::jsonb,
  monday_item_id text,
  monday_item_name text,
  match_method text,
  monday_prev_values jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 2,
  claim_token uuid,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  report_id uuid references public.analyser_reports(id) on delete set null,
  gross_revenue numeric,
  net_revenue numeric,
  long_let_monthly numeric,
  recommendation text,
  qualification text,
  uplift_pct numeric,
  data_quality_level text,
  comparables_found integer,
  monday_synced boolean not null default false,
  pdf_uploaded boolean not null default false,
  input_desired_rent numeric
);
create index if not exists idx_bulk_job_rows_claim on public.bulk_job_rows (status, claimed_at);
create index if not exists idx_bulk_job_rows_job on public.bulk_job_rows (job_id);
create unique index if not exists uq_bulk_job_rows_job_row on public.bulk_job_rows (job_id, row_number);
alter table public.bulk_job_rows enable row level security;  -- no policies: service role only
comment on column public.bulk_job_rows.input_desired_rent is 'Monthly rent the landlord is asking for, in GBP. Null when the sheet had no value, in which case the assessment estimates it and flags it as estimated.';

-- Hands a worker its next rows, capped across every worker at once.
create or replace function public.claim_bulk_rows(p_limit integer, p_claim_token uuid, p_max_inflight integer default 6, p_stale_seconds integer default 900)
returns setof public.bulk_job_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inflight int;
  v_take     int;
begin
  -- Global ceiling on rows running at once, across every worker. This is the
  -- Airbtics spend-rate throttle, not just a concurrency limit.
  select count(*) into v_inflight
    from bulk_job_rows r
   where r.status in ('claimed', 'running')
     and r.claimed_at > now() - make_interval(secs => p_stale_seconds);

  v_take := least(p_limit, greatest(p_max_inflight - v_inflight, 0));
  if v_take <= 0 then
    return;
  end if;

  return query
  with candidate as (
    select r.id
      from bulk_job_rows r
      join bulk_jobs j on j.id = r.job_id
     where j.status = 'running'
       and r.attempts < r.max_attempts
       and (
             r.status = 'pending'
             -- Reclaim anything abandoned by a killed invocation. The window is
             -- ~15x the worst-case row time, so it can't race a live worker.
             or (r.status in ('claimed', 'running')
                 and r.claimed_at < now() - make_interval(secs => p_stale_seconds))
           )
     order by j.created_at, r.row_number
     limit v_take
     for update of r skip locked
  )
  update bulk_job_rows r
     set status      = 'claimed',
         claim_token = p_claim_token,
         claimed_at  = now(),
         -- Incremented AT CLAIM, not on completion, so a row that hard-kills
         -- its worker (OOM, timeout) burns max_attempts and then stops rather
         -- than looping forever on someone else's credit.
         attempts    = r.attempts + 1,
         updated_at  = now()
    from candidate c
   where r.id = c.id
  returning r.*;
end;
$$;
revoke all on function public.claim_bulk_rows(integer, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_bulk_rows(integer, uuid, integer, integer) to service_role;

-- Text to a number, or null when it is not one.
create or replace function public.safe_numeric(t text)
returns numeric
language plpgsql
set search_path = ''
immutable
as $$
begin
  return t::numeric;
exception when others then
  return null;
end;
$$;

-- =========================
-- Batch 5: my deals
-- =========================
-- My deals (/my-deals) groups every deal a member tracks by stage. The stage
-- of a pipeline row is checked_listings.status, which gains two keys:
-- 'contacted' and 'secured' (src/lib/listing/pipeline.ts). The column is
-- plain text with no check constraint, so the new keys need no DDL, and
-- existing rows are not migrated: 'watching' is shown as "Kept".
--
-- report_started_at: a full report in flight for this pipeline row.
-- /api/analyse claims it with one conditional UPDATE before reserving any
-- credit, so a double click, a second tab or a refresh cannot start (and
-- charge) a second report for the same listing while the first runs. Cleared
-- when the run ends; a claim older than three minutes (the route's limit is
-- sixty seconds) is treated as abandoned. Not in ACCESS_COLUMNS.
alter table public.checked_listings add column if not exists report_started_at timestamptz;

-- =========================
-- Batch 6: emails and alerts
-- =========================
-- notification_sends: the ONE record of every capped member email, and so
-- the cap itself (src/lib/notify/cap.ts, sends.ts). A member gets at most
-- one non-billing email a day (the "daily" slot: Today's 5, the changes-only
-- email, the picks-paused letter, an admin notice) and on Mondays one more
-- (the "weekly" slot: Your week). The unique key is the cap: whoever inserts
-- the row owns the slot, so two passes, two crons or a retry can never send
-- a second one. Billing and receipt emails never touch this table.
--
-- status: claimed (the slot is ours, nothing sent yet) → sending (the email
-- is going to Resend) → sent | failed. A claim that never reached Resend and
-- is older than a few minutes may be taken over (claim_notification_slot); a
-- `sending` row never is, because the email may have gone. `day` is the UTC
-- date, the same day the picks' "sent today" guard uses. `summary` records
-- what went (deal ids, alert ids, counts), never an address. Service role
-- only. Deliberately a table, not columns on profiles (ACCESS_COLUMNS).
create table if not exists public.notification_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  slot text not null,                         -- daily | weekly
  kind text not null,                         -- todays_5 | deal_changes | picks_paused | your_week | notice
  channel text not null default 'email',      -- Batch 8 adds 'sms', with its own rows
  status text not null default 'claimed',     -- claimed | sending | sent | failed
  summary jsonb not null default '{}'::jsonb,
  -- One-click unsubscribe for this email (/api/notify/unsubscribe/<token>).
  unsubscribe_token text,
  claimed_at timestamptz not null default now(),
  sending_at timestamptz,
  sent_at timestamptz
);
create unique index if not exists notification_sends_slot_uidx on public.notification_sends (user_id, day, slot, channel);
create index if not exists notification_sends_day_idx on public.notification_sends (day, slot);
create unique index if not exists notification_sends_unsub_uidx on public.notification_sends (unsubscribe_token) where unsubscribe_token is not null;
do $$
begin
  alter table public.notification_sends drop constraint if exists notification_sends_slot_check;
  alter table public.notification_sends add constraint notification_sends_slot_check check (slot in ('daily', 'weekly'));
  alter table public.notification_sends drop constraint if exists notification_sends_status_check;
  alter table public.notification_sends add constraint notification_sends_status_check check (status in ('claimed', 'sending', 'sent', 'failed'));
end $$;
alter table public.notification_sends enable row level security;  -- no policies: service role only
revoke all on public.notification_sends from anon, authenticated;

-- Claim a slot, or take over a stale claim that never reached Resend.
-- Returns the row id when the slot is now the caller's, null when it is
-- taken. One statement each way, so two callers can never both win.
create or replace function public.claim_notification_slot(
  p_user uuid,
  p_day date,
  p_slot text,
  p_kind text,
  p_channel text default 'email',
  p_stale_after interval default interval '5 minutes'
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notification_sends (user_id, day, slot, kind, channel)
  values (p_user, p_day, p_slot, p_kind, p_channel)
  on conflict (user_id, day, slot, channel) do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;
  update public.notification_sends
     set kind = p_kind, claimed_at = now(), summary = '{}'::jsonb, unsubscribe_token = null
   where user_id = p_user and day = p_day and slot = p_slot and channel = p_channel
     and status = 'claimed' and claimed_at < now() - p_stale_after
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.claim_notification_slot(uuid, date, text, text, text, interval) from public, anon, authenticated;
grant execute on function public.claim_notification_slot(uuid, date, text, text, text, interval) to service_role;

-- deal_alerts: one row per member per change on a deal they track (Part C:
-- price drop, back on market, nearly gone, gone). Pipeline rows and kept
-- marketplace deals share it: one alert model. Written by the 06:55
-- collector (/api/internal/deal-alerts); the unique key makes a re-run a
-- no-op. Pending = notified_at is null, whatever send_id says; notified_at
-- is set only after the email carrying it was sent (finish_notification_send),
-- so an alert in a failed email goes in the next one. deal_key is Batch 5's
-- key for the deal on My deals ('d-<deal id>' for a marketplace deal, with
-- or without a pipeline row; 'l-<row id>' for a listing the member added):
-- one stream per deal whichever list it is on, and never a URL, so an
-- unopened deal's listing can never leak through here. Service role only.
create table if not exists public.deal_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  alert_type text not null,                   -- price_drop | back_on_market | nearly_gone | gone
  source text not null,                       -- pipeline | marketplace
  deal_key text not null,                    -- 'd-<deal id>' | 'l-<checked_listings id>'
  deal_id uuid,
  checked_listing_id uuid,
  event_at timestamptz not null,              -- the change's own timestamp
  payload jsonb not null default '{}'::jsonb, -- old/new price, profit, statuses, watcher count
  send_id uuid,                               -- the notification_sends row that carried it
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists deal_alerts_event_uidx on public.deal_alerts (user_id, alert_type, deal_key, event_at);
create index if not exists deal_alerts_pending_idx on public.deal_alerts (user_id, created_at) where notified_at is null;
create index if not exists deal_alerts_user_idx on public.deal_alerts (user_id, created_at desc);
do $$
begin
  alter table public.deal_alerts drop constraint if exists deal_alerts_type_check;
  alter table public.deal_alerts add constraint deal_alerts_type_check check (alert_type in ('price_drop', 'back_on_market', 'nearly_gone', 'gone'));
  alter table public.deal_alerts drop constraint if exists deal_alerts_source_check;
  alter table public.deal_alerts add constraint deal_alerts_source_check check (source in ('pipeline', 'marketplace'));
end $$;
alter table public.deal_alerts enable row level security;  -- no policies: service role only
revoke all on public.deal_alerts from anon, authenticated;

-- Close a send: the slot sent or failed, and — only when it was sent — the
-- alerts it carried marked notified, in one transaction.
create or replace function public.finish_notification_send(
  p_id uuid,
  p_sent boolean,
  p_summary jsonb default null,
  p_alert_ids uuid[] default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.notification_sends
     set status = case when p_sent then 'sent' else 'failed' end,
         sent_at = case when p_sent then now() else null end,
         summary = coalesce(p_summary, summary)
   where id = p_id;
  if p_sent and p_alert_ids is not null and cardinality(p_alert_ids) > 0 then
    update public.deal_alerts
       set notified_at = now(), send_id = p_id
     where id = any(p_alert_ids) and notified_at is null;
  end if;
end;
$$;
revoke all on function public.finish_notification_send(uuid, boolean, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.finish_notification_send(uuid, boolean, jsonb, uuid[]) to service_role;

-- Two notification switches (src/lib/notifications/registry.ts), on by
-- default like the others. Written only by the notifications writer (service
-- role), so no column grant. NOT in ACCESS_COLUMNS: a database that has not
-- had this run reads them as their default and nothing else is affected.
--   alert_tracked  "Changes on deals I'm tracking": the daily alerts and
--                  Your week's recap of your deals
--   alert_missed   "Weekly: deals I missed": Your week's first section
alter table public.profiles add column if not exists alert_tracked boolean not null default true;
alter table public.profiles add column if not exists alert_missed boolean not null default true;

-- Back on market: a deal retired as sold / under offer / let agreed /
-- removed that the feed shows again is revived to pending_verify, and goes
-- live (re-stamping live_since, so the early-access window restarts) only
-- once a page read confirms it. These record that it came back and from
-- what. Read separately, never in DEAL_COLUMNS.
alter table public.marketplace_deals add column if not exists revived_at timestamptz;
alter table public.marketplace_deals add column if not exists revived_from text;

-- =========================
-- Batch 7: pipeline actions
-- =========================
-- The next step shown on each My deals item and deal page
-- (src/lib/pipeline, src/app/my-deals/_components/NextStepSlot.tsx).
--
-- billing_settings 'offer_discount_bands': the Offer stage's discount bands
-- (src/lib/pipeline/offer-rules.ts), edited at /admin/next-steps.
-- Deliberately NOT seeded. With no row, the offer range shows the member's
-- target figure only and never a guessed discount. Shape:
--   { "purchase":   [ { "minMonths": 6, "minReductions": 2, "discountPct": 8 }, ... ],
--     "rentToRent": [ { "minWeeks": 4, "discountPct": 5 }, ... ] }
--
-- pipeline_checklist_ticks: ticks on the Viewing and Secured checklists, one
-- row per ticked item, per person (like stages). item_key is the My deals
-- key ('d-<dealId>' or 'l-<checkedListingId>'), which stays the same when a
-- deal gains a pipeline row. item_id is the checklist item's id in
-- src/lib/pipeline/next-steps.ts. Untick deletes the row. Written by the
-- server actions after checking the deal is the member's
-- (src/app/my-deals/next-step-actions.ts), so service role only.
create table if not exists public.pipeline_checklist_ticks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_key text not null,
  item_id text not null,
  ticked_at timestamptz not null default now(),
  primary key (user_id, item_key, item_id)
);
alter table public.pipeline_checklist_ticks enable row level security;  -- no policies: service role only
revoke all on public.pipeline_checklist_ticks from anon, authenticated;

-- pipeline_step_events: which next-step tools members use, one row per use.
-- Append-only, service role only (src/lib/pipeline/events.ts).
--   action   'copy' | 'email' (a message), 'tick' | 'untick' (a checklist
--            item), 'advance' (the one-tap stage button), 'enquiry' (the
--            Secured stage's "Talk to us")
--   stage    the stage the member was at (Batch 5's keys: 'watching' = Kept)
--   item_id  the message id, checklist item id, or for 'advance' the stage moved to
create table if not exists public.pipeline_step_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_key text not null,
  stage text not null,
  deal_kind text not null,
  action text not null,
  item_id text,
  at timestamptz not null default now()
);
create index if not exists pipeline_step_events_user_idx on public.pipeline_step_events (user_id, at desc);
create index if not exists pipeline_step_events_at_idx on public.pipeline_step_events (at desc);
alter table public.pipeline_step_events enable row level security;  -- no policies: service role only
revoke all on public.pipeline_step_events from anon, authenticated;

-- =========================
-- Batch 8: sms
-- =========================
-- Text alerts (src/lib/sms). OFF for everyone, existing members included,
-- until a member verifies a UK mobile and switches texts on. At most one text
-- a member a day (Batch 6's notification_sends, channel 'sms') and a monthly
-- cap (billing_settings.sms_monthly_cap), 08:00–20:00 UK time only. Texts are
-- free to members: the cost is house spend, logged in provider_calls and here.
-- Nothing below is in ACCESS_COLUMNS.

-- The per-type switches (src/lib/notifications/registry.ts, channel 'sms').
-- Off by default. Turned on together when a member verifies their number,
-- then each can be turned off in Account → Notifications. Written only by the
-- notifications writer (service role), so no column grant. They are in
-- NOTIFICATION_COLUMNS, a fixed select; readNotifications falls back to the
-- older column list when these are missing, so the panel keeps working if
-- the code deploys before this is run. NOT in ACCESS_COLUMNS.
alter table public.profiles add column if not exists sms_price_drop boolean not null default false;
alter table public.profiles add column if not exists sms_back_on_market boolean not null default false;
alter table public.profiles add column if not exists sms_nearly_gone boolean not null default false;
alter table public.profiles add column if not exists sms_gone boolean not null default false;

-- sms_contacts: the member's texting number and its state. One row per member
-- who has started verifying. `enabled` is the member's own on/off. `stopped_at`
-- is a reply of STOP (or Twilio refusing with 21610): a hard block on every
-- text to that number, on every account, until START clears it. Verification
-- swaps the number in only once the new one is proved, so a change of number
-- never sends to an unverified phone. Service role only.
create table if not exists public.sms_contacts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  phone_e164 text,
  verified_at timestamptz,
  enabled boolean not null default false,
  consent_at timestamptz,
  consent_source text,                        -- signup | account
  stopped_at timestamptz,
  stop_source text,                           -- keyword | twilio | admin
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One account per verified number, so a STOP can never be ambiguous.
create unique index if not exists sms_contacts_verified_phone_uidx on public.sms_contacts (phone_e164) where verified_at is not null;
create index if not exists sms_contacts_phone_idx on public.sms_contacts (phone_e164);
alter table public.sms_contacts enable row level security;  -- no policies: service role only
revoke all on public.sms_contacts from anon, authenticated;

-- sms_verifications: one row per code sent. The code itself is never stored,
-- only an HMAC of (id, code). Ten minutes, five guesses (counted by
-- sms_verification_attempt before the compare); a newer code supersedes it.
create table if not exists public.sms_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  phone_e164 text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  verified_at timestamptz,
  superseded_at timestamptz
);
create index if not exists sms_verifications_user_idx on public.sms_verifications (user_id, created_at desc);
alter table public.sms_verifications enable row level security;  -- no policies: service role only
revoke all on public.sms_verifications from anon, authenticated;

-- Take one guess: counts it and hands back the hash only while the code is
-- still open (unexpired, unused, not replaced, under five guesses). One
-- statement, so parallel guesses can never get past five. The limit here and
-- MAX_ATTEMPTS in src/lib/sms/verify.ts are the same number.
create or replace function public.sms_verification_attempt(p_id uuid, p_user uuid)
returns table (code_hash text, phone_e164 text, attempts int, created_at timestamptz)
language sql
set search_path = ''
as $$
  update public.sms_verifications v
     set attempts = v.attempts + 1
   where v.id = p_id
     and v.user_id = p_user
     and v.verified_at is null
     and v.superseded_at is null
     and v.expires_at > now()
     and v.attempts < 5
  returning v.code_hash, v.phone_e164, v.attempts, v.created_at;
$$;
revoke all on function public.sms_verification_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sms_verification_attempt(uuid, uuid) to service_role;

-- sms_messages: every text sent (verification codes and alerts) and every
-- keyword received, with Twilio's sid, delivery status and price, so the
-- spend can be reconciled against Twilio. `alert_ids` are the deal_alerts a
-- text told: an alert is never texted twice. Inbound rows keep the keyword,
-- never the member's words. `outcome`: pending (about to call Twilio) →
-- accepted | refused | unknown (the call failed mid-way; the text may have
-- gone, so it counts as sent) | dry_run. Service role only.
create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  direction text not null,                    -- outbound | inbound
  kind text not null,                         -- verify | alert | keyword | standout | nudge (Batch 25) | call (Review R3: a call's texts)
  phone_e164 text not null,
  body text,
  alert_ids uuid[] not null default '{}'::uuid[],
  send_id uuid,                               -- the notification_sends row an alert text used
  dry_run boolean not null default false,
  outcome text not null default 'pending',
  twilio_sid text,
  status text,
  status_at timestamptz,
  error_code int,
  segments int,
  price numeric,
  price_unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sms_messages_sid_uidx on public.sms_messages (twilio_sid) where twilio_sid is not null;
create index if not exists sms_messages_user_idx on public.sms_messages (user_id, created_at desc);
create index if not exists sms_messages_phone_idx on public.sms_messages (phone_e164, created_at desc);
create index if not exists sms_messages_unpriced_idx on public.sms_messages (created_at) where twilio_sid is not null and price is null;
do $$
begin
  alter table public.sms_messages drop constraint if exists sms_messages_direction_check;
  alter table public.sms_messages add constraint sms_messages_direction_check check (direction in ('outbound', 'inbound'));
  alter table public.sms_messages drop constraint if exists sms_messages_kind_check;
  alter table public.sms_messages add constraint sms_messages_kind_check check (kind in ('verify', 'alert', 'keyword', 'standout', 'nudge', 'call'));
  alter table public.sms_messages drop constraint if exists sms_messages_outcome_check;
  alter table public.sms_messages add constraint sms_messages_outcome_check check (outcome in ('pending', 'accepted', 'refused', 'unknown', 'dry_run', 'received'));
end $$;
alter table public.sms_messages enable row level security;  -- no policies: service role only
revoke all on public.sms_messages from anon, authenticated;

-- The monthly cap: texts a member may get per UK calendar month. Editable
-- without a deploy.
insert into public.billing_settings (key, value) values ('sms_monthly_cap', '8'::jsonb)
on conflict (key) do nothing;

-- =========================
-- Batch 9: activity tracking
-- =========================
-- One log of what members do in the app, and their visits
-- (src/lib/activity). Weekly active members is worked out from these on
-- /admin/weekly-active. src/lib/activity/kinds.ts lists the kinds and which
-- of them count towards weekly active.
--
-- Service role only, like every table since Batch 3: RLS on, no policies,
-- nothing granted to anon or authenticated. A member cannot read a row, their
-- own included; every write goes through the functions below.
--
-- Nothing here touches profiles and nothing is in ACCESS_COLUMNS, so running
-- this late breaks no page: until it runs, logging fails quietly with a
-- warning and the admin page says the schema is missing.
--
-- Every function takes ONE jsonb argument, so adding a field never changes
-- its signature. A changed signature would leave a second overload behind,
-- and PostgREST refuses to choose between two (PGRST203), which would stop
-- logging without a word.

-- activity_events: one row per member action.
--   user_id     who acted. For a team member, the member, never the owner who paid.
--   occurred_at when they did it (taken when the action happens, not when the row is written)
--   kind        see src/lib/activity/kinds.ts. Checked in code, not here, so a
--               later batch can add one without a schema change.
--   deal_id     marketplace_deals.id. No foreign key: the history outlives the deal.
--   visit_id    activity_visits.id. No foreign key: retention prunes both by age,
--               and a key would make every visit delete scan this table.
--   source      web | email_link | sms_link | system | extension | api
--               (how the member got there: an in-app action inherits how its
--               visit started). Checked in code.
--   extras      a few small facts: stage from/to, report tier, pass reasons.
--               Never an address, a postcode or a link; the code refuses them.
--               'env' is set on preview deployments.
--   profile_id  saved profiles (Batch 13). Unused until then.
--   dedupe_key  the action's own id where it has one ('report:<actionId>',
--               'topup:pi:<id>'): a repeat of it is ignored. A plain unique
--               index, not a partial one: nulls never collide, and ON CONFLICT
--               cannot use a partial index without repeating its predicate.
--   backfilled  written by activity_backfill from older tables, not live.
create table if not exists public.activity_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  kind text not null,
  deal_id uuid,
  visit_id uuid,
  source text not null default 'web',
  extras jsonb not null default '{}'::jsonb,
  profile_id uuid,
  dedupe_key text,
  backfilled boolean not null default false
);
create unique index if not exists activity_events_dedupe_uidx on public.activity_events (user_id, dedupe_key);
create index if not exists activity_events_key_idx on public.activity_events (dedupe_key) where dedupe_key is not null;
create index if not exists activity_events_at_idx on public.activity_events (occurred_at);
create index if not exists activity_events_user_idx on public.activity_events (user_id, occurred_at desc);
create index if not exists activity_events_kind_idx on public.activity_events (kind, occurred_at);
create index if not exists activity_events_deal_idx on public.activity_events (deal_id) where deal_id is not null;
alter table public.activity_events enable row level security;  -- no policies: service role only
revoke all on public.activity_events from anon, authenticated;

-- activity_visits: one row per visit. A visit starts on the first
-- members-only page, return to the tab, or in-app action after 30 minutes of
-- nothing, and ends at its last heartbeat (last_seen_at). The heartbeat is
-- src/components/activity/VisitHeartbeat.tsx.
--   page_count    pages loaded or navigated to in the visit
--   action_count  counted actions logged during it
--   entry_source  web | email_link | sms_link: how the visit began
create table if not exists public.activity_visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  page_count integer not null default 0,
  action_count integer not null default 0,
  entry_source text not null default 'web'
);
create index if not exists activity_visits_user_idx on public.activity_visits (user_id, last_seen_at desc);
create index if not exists activity_visits_started_idx on public.activity_visits (started_at);
alter table public.activity_visits enable row level security;  -- no policies: service role only
revoke all on public.activity_visits from anon, authenticated;

-- activity_meta: a few stored values. 'backfill_cutoff' is fixed by the
-- first real backfill run: the time of the first event logged live in
-- production. The backfill only ever copies history from before it, so a
-- second run, or retention later deleting that first event, can never make it
-- copy something that was also logged live.
create table if not exists public.activity_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.activity_meta enable row level security;  -- no policies: service role only
revoke all on public.activity_meta from anon, authenticated;

-- activity_excluded_accounts: test and team accounts switched out of every
-- weekly-active figure on /admin/weekly-active. Admin emails (ADMIN_EMAILS)
-- and @stayful.co.uk addresses are left out in code without a row here.
create table if not exists public.activity_excluded_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reason text,
  added_by text,
  added_at timestamptz not null default now()
);
alter table public.activity_excluded_accounts enable row level security;  -- no policies: service role only
revoke all on public.activity_excluded_accounts from anon, authenticated;

-- activity_log(p): records one event. Returns its id, or null when it was a
-- repeat. The fields of p:
--   user, kind            required
--   at                    when it happened (default now)
--   deal                  marketplace_deals.id
--   listing_url           a listing's canonical URL, turned into the deal id
--                         here and never stored
--   source, extras, profile, dedupe_key
--   window_seconds        double-submit guard (default 60; 0 turns it off):
--                         an event the same as the member's latest one (kind,
--                         deal and extras) within this many seconds is a
--                         repeat. Only when there is no dedupe_key.
--   visit                 'extend': attach to the member's open visit, starting
--                         one when there is none (an in-app action);
--                         'attach': attach only if one is open; 'none'
--   counted               adds one to the visit's action_count
-- A per-member advisory lock makes the checks and the insert one step, so
-- two racing requests (a double click, two tabs) cannot both get through.
create or replace function public.activity_log(p jsonb)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_kind text := nullif(p->>'kind', '');
  v_at timestamptz := coalesce(nullif(p->>'at', '')::timestamptz, now());
  v_deal uuid := nullif(p->>'deal', '')::uuid;
  v_url text := nullif(p->>'listing_url', '');
  v_source text := nullif(p->>'source', '');
  v_extras jsonb := coalesce(p->'extras', '{}'::jsonb);
  v_key text := nullif(p->>'dedupe_key', '');
  v_window integer := coalesce(nullif(p->>'window_seconds', '')::integer, 60);
  v_mode text := coalesce(nullif(p->>'visit', ''), 'attach');
  v_counted boolean := coalesce(nullif(p->>'counted', '')::boolean, false);
  v_profile uuid := nullif(p->>'profile', '')::uuid;
  v_visit uuid;
  v_visit_source text;
  v_last record;
  v_id bigint;
begin
  if v_user is null or v_kind is null then
    return null;
  end if;
  if jsonb_typeof(v_extras) is distinct from 'object' then
    v_extras := '{}'::jsonb;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activity:' || v_user::text, 0));

  if v_deal is null and v_url is not null then
    select d.id into v_deal from public.marketplace_deals d where d.canonical_url = v_url;
  end if;

  if v_key is null and v_window > 0 then
    select e.kind, e.deal_id, e.extras, e.occurred_at into v_last
      from public.activity_events e
     where e.user_id = v_user and not e.backfilled
     order by e.occurred_at desc, e.id desc
     limit 1;
    if found
       and v_last.kind = v_kind
       and v_last.deal_id is not distinct from v_deal
       and v_last.extras = v_extras
       and abs(extract(epoch from (v_at - v_last.occurred_at))) < v_window then
      return null;
    end if;
  end if;

  if v_mode in ('attach', 'extend') then
    select v.id, v.entry_source into v_visit, v_visit_source
      from public.activity_visits v
     where v.user_id = v_user
       and v.last_seen_at >= v_at - interval '30 minutes'
       and v.started_at <= v_at + interval '1 minute'
     order by v.last_seen_at desc
     limit 1;
    if v_visit is null and v_mode = 'extend' then
      insert into public.activity_visits (user_id, started_at, last_seen_at, page_count, entry_source)
      values (v_user, v_at, v_at, 0, coalesce(v_source, 'web'))
      returning id, entry_source into v_visit, v_visit_source;
    end if;
  end if;

  insert into public.activity_events (user_id, occurred_at, kind, deal_id, visit_id, source, extras, profile_id, dedupe_key)
  values (v_user, v_at, v_kind, v_deal, v_visit, coalesce(v_source, v_visit_source, 'web'), v_extras, v_profile, v_key)
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is not null and v_visit is not null and (v_counted or v_mode = 'extend') then
    update public.activity_visits
       set action_count = action_count + (case when v_counted then 1 else 0 end),
           last_seen_at = case when v_mode = 'extend' then greatest(last_seen_at, v_at) else last_seen_at end
     where id = v_visit;
  end if;
  return v_id;
end;
$$;
revoke all on function public.activity_log(jsonb) from public, anon, authenticated;
grant execute on function public.activity_log(jsonb) to service_role;

-- activity_visit_touch(p): one heartbeat. Returns the visit's id (null for a
-- closing beat when no visit is open). The fields of p:
--   user     required
--   kind     'load' (a page load), 'page' (a navigation), 'beat' (still here,
--            every minute while the tab is shown and in use), 'resume' (the
--            tab shown again), 'hide' (the tab hidden or closed)
--   pages    navigations counted in the browser since the last write
--   via      'email' | 'sms' when the page was reached from our email or text
--   at       default now
-- A visit seen in the last 30 minutes is extended; otherwise a new one
-- starts, except on 'hide'. A bare beat within 20 seconds of the last write
-- is dropped (two tabs); a page count or a closing beat never is.
create or replace function public.activity_visit_touch(p jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'beat');
  v_now timestamptz := coalesce(nullif(p->>'at', '')::timestamptz, now());
  v_pages integer := greatest(coalesce(nullif(p->>'pages', '')::integer, 0), 0)
                     + case when v_kind in ('load', 'page') then 1 else 0 end;
  v_source text := case p->>'via' when 'email' then 'email_link' when 'sms' then 'sms_link' else 'web' end;
  v_id uuid;
  v_last timestamptz;
begin
  if v_user is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('activity:' || v_user::text, 0));

  select v.id, v.last_seen_at into v_id, v_last
    from public.activity_visits v
   where v.user_id = v_user and v.last_seen_at >= v_now - interval '30 minutes'
   order by v.last_seen_at desc
   limit 1;

  if v_id is not null then
    if v_kind = 'beat' and v_pages = 0 and v_last >= v_now - interval '20 seconds' then
      return v_id;
    end if;
    update public.activity_visits
       set last_seen_at = greatest(last_seen_at, v_now),
           page_count = page_count + v_pages
     where id = v_id;
    return v_id;
  end if;

  if v_kind = 'hide' then
    return null;
  end if;
  insert into public.activity_visits (user_id, started_at, last_seen_at, page_count, entry_source)
  values (v_user, v_now, v_now, greatest(v_pages, 1), v_source)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.activity_visit_touch(jsonb) from public, anon, authenticated;
grant execute on function public.activity_visit_touch(jsonb) to service_role;

-- activity_weekly_facts(p): everything /admin/weekly-active needs, in one
-- jsonb value, so no 1,000-row select limit applies. Weeks are Monday 00:00
-- to Sunday 23:59, UK time. src/lib/activity/metrics.ts does the sums; this
-- only groups. The fields of p:
--   weeks       how many weeks, the current one included (default 12, max 52)
--   now         default now
--   qualifying  kinds that count towards weekly active
--   counted     kinds that count as actions
-- Batch 21: members carry signed_in (auth.users.last_sign_in_at is set), so
-- a sign-up that never confirmed its email can be left out of the base (E3);
-- events a preview deployment stamped with extras.env never count (E27).
-- Security definer so it can read auth.users.
create or replace function public.activity_weekly_facts(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(nullif(p->>'now', '')::timestamptz, now());
  v_weeks integer := least(greatest(coalesce(nullif(p->>'weeks', '')::integer, 12), 1), 52);
  v_qual text[] := array(select jsonb_array_elements_text(coalesce(p->'qualifying', '[]'::jsonb)));
  v_counted text[] := array(select jsonb_array_elements_text(coalesce(p->'counted', '[]'::jsonb)));
  v_this date := (date_trunc('week', v_now at time zone 'Europe/London'))::date;
  v_first date := v_this - (v_weeks - 1) * 7;
  v_t0 timestamptz := (v_first::timestamp) at time zone 'Europe/London';
  v_t1 timestamptz := ((v_this + 7)::timestamp) at time zone 'Europe/London';
begin
  return jsonb_build_object(
    'now', v_now,
    'first_week', v_first,
    'this_week', v_this,
    'weeks', v_weeks,
    -- Live tracking began with the first event logged in production (a
    -- preview on the live database stamps extras.env), as for the backfill
    -- cutoff; visits count from then too, so a preview's visits never make
    -- the weeks before the release look tracked.
    'tracking_since', (select min(e.occurred_at) from public.activity_events e where not e.backfilled and not (e.extras ? 'env')),
    'visits_since', greatest(
      (select min(v.started_at) from public.activity_visits v),
      (select min(e.occurred_at) from public.activity_events e where not e.backfilled and not (e.extras ? 'env'))
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', pr.id,
        'email', lower(trim(pr.email)),
        'name', nullif(trim(pr.full_name), ''),
        'created_at', pr.created_at,
        'plan', pr.plan,
        'plan_code', pr.plan_code,
        'plan_source', pr.plan_source,
        'status', pr.stripe_subscription_status,
        'sub_started', pr.subscription_started_at,
        'sub_ended', pr.subscription_ended_at,
        'paused_from', pr.subscription_paused_from,
        'paused_until', pr.subscription_paused_until,
        'owner', tm.owner_id,
        'signed_in', (au.last_sign_in_at is not null)
      ) order by pr.created_at), '[]'::jsonb)
      from public.profiles pr
      left join public.team_members tm on tm.member_id = pr.id
      left join auth.users au on au.id = pr.id
    ),
    'excluded', (
      select coalesce(jsonb_agg(jsonb_build_object('u', x.user_id, 'reason', x.reason)), '[]'::jsonb)
      from public.activity_excluded_accounts x
    ),
    -- Real money: card top-ups and paid subscription invoices, less any that
    -- were refunded or disputed (a matching '<ref>:refunded' adjustment).
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object('u', q.user_id, 'first', q.first_at, 'before', q.last_before, 'list', q.recent)), '[]'::jsonb)
      from (
        select g.user_id,
               min(g.created_at) as first_at,
               max(g.created_at) filter (where g.created_at < v_t0 - interval '90 days') as last_before,
               coalesce(jsonb_agg(g.created_at order by g.created_at) filter (where g.created_at >= v_t0 - interval '90 days' and g.created_at < v_t1), '[]'::jsonb) as recent
        from public.credit_grants g
        where (g.kind = 'topup' or (g.kind = 'plan' and g.source_ref like 'inv:%'))
          and not exists (
            select 1 from public.credit_grants r
            where r.user_id = g.user_id and r.kind = 'adjustment'
              and r.source_ref in (g.source_ref || ':refunded', g.source_ref || ':disputed')
          )
        group by g.user_id
      ) q
    ),
    'sub_events', (
      select coalesce(jsonb_agg(jsonb_build_object('u', se.user_id, 'k', se.kind, 'at', se.at) order by se.at), '[]'::jsonb)
      from public.subscription_events se
      where se.kind in ('started', 'ended', 'paused', 'resumed')
    ),
    'qdays', (
      select coalesce(jsonb_agg(jsonb_build_object('u', q.user_id, 'd', q.days)), '[]'::jsonb)
      from (
        select e.user_id, jsonb_agg(distinct (e.occurred_at at time zone 'Europe/London')::date) as days
        from public.activity_events e
        where e.occurred_at >= v_t0 - interval '31 days' and e.occurred_at < v_t1 and e.kind = any(v_qual) and not (e.extras ? 'env')
        group by e.user_id
      ) q
    ),
    'weekly', (
      select coalesce(jsonb_agg(jsonb_build_object('u', w.user_id, 'w', w.wk, 'c', w.c, 'r', w.r)), '[]'::jsonb)
      from (
        select e.user_id,
               (date_trunc('week', e.occurred_at at time zone 'Europe/London'))::date as wk,
               count(*) filter (where e.kind = any(v_counted)) as c,
               count(*) filter (where e.kind = 'report_run') as r
        from public.activity_events e
        where e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not (e.extras ? 'env')
        group by 1, 2
      ) w
    ),
    'visits', (
      select coalesce(jsonb_agg(jsonb_build_object('u', v.user_id, 'w', v.wk, 'n', v.n, 'a', v.a, 's', v.secs)), '[]'::jsonb)
      from (
        select vi.user_id,
               (date_trunc('week', vi.started_at at time zone 'Europe/London'))::date as wk,
               count(*) as n,
               sum(vi.action_count) as a,
               jsonb_agg(greatest(round(extract(epoch from (vi.last_seen_at - vi.started_at)))::integer, 0)) as secs
        from public.activity_visits vi
        where vi.started_at >= v_t0 and vi.started_at < v_t1
        group by 1, 2
      ) v
    ),
    -- Opens and whether the same person ran a report on the same deal within
    -- 14 days. matured: the 14 days are over.
    'opens', (
      select coalesce(jsonb_agg(jsonb_build_object('u', o.user_id, 'w', o.wk, 'n', o.n, 'm', o.matured, 'cm', o.conv_matured, 'c', o.conv)), '[]'::jsonb)
      from (
        select op.user_id,
               (date_trunc('week', op.occurred_at at time zone 'Europe/London'))::date as wk,
               count(*) as n,
               count(*) filter (where op.occurred_at <= v_now - interval '14 days') as matured,
               count(*) filter (where op.reported) as conv,
               count(*) filter (where op.reported and op.occurred_at <= v_now - interval '14 days') as conv_matured
        from (
          select e.user_id, e.occurred_at,
                 exists (
                   select 1 from public.activity_events r
                   where r.user_id = e.user_id and r.kind = 'report_run' and r.deal_id = e.deal_id
                     and r.occurred_at >= e.occurred_at and r.occurred_at < e.occurred_at + interval '14 days'
                 ) as reported
          from public.activity_events e
          where e.kind = 'deal_open' and e.deal_id is not null and e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not (e.extras ? 'env')
        ) op
        group by 1, 2
      ) o
    ),
    -- Keep rate on Today's 5: for each Today list a member actually viewed
    -- (a today_view event in that Today-day, which turns over at 07:00 UTC),
    -- the deals it showed (the stored list and the morning pick, at most 5)
    -- and how many of those they kept during that Today-day.
    'today', (
      select coalesce(jsonb_agg(jsonb_build_object('u', t.user_id, 'w', t.wk, 'shown', t.shown, 'kept', t.kept)), '[]'::jsonb)
      from (
        select l.user_id,
               (date_trunc('week', l.first_view at time zone 'Europe/London'))::date as wk,
               sum(least(cardinality(l.ids), 5)) as shown,
               sum(least(l.kept, 5)) as kept
        from (
          select tv.user_id, tv.first_view, tv.ids,
                 (select count(distinct k.deal_id) from public.activity_events k
                   where k.user_id = tv.user_id and k.kind = 'keep' and k.deal_id = any(tv.ids)
                     and k.occurred_at >= tv.day_start and k.occurred_at < tv.day_start + interval '1 day') as kept
          from (
            select vw.user_id, vw.first_view, vw.day_start,
                   array(select distinct x from unnest(coalesce(ts.deal_ids, '{}'::uuid[]) || coalesce(pk.ids, '{}'::uuid[])) x) as ids
            from (
              select e.user_id,
                     ((e.occurred_at - interval '7 hours') at time zone 'UTC')::date as td,
                     (((((e.occurred_at - interval '7 hours') at time zone 'UTC')::date)::timestamp + interval '7 hours') at time zone 'UTC') as day_start,
                     min(e.occurred_at) as first_view
              from public.activity_events e
              where e.kind = 'today_view' and e.occurred_at >= v_t0 and e.occurred_at < v_t1 and not (e.extras ? 'env')
              group by 1, 2, 3
            ) vw
            left join public.today_selections ts on ts.user_id = vw.user_id and ts.day = vw.td
            left join lateral (
              select array[s.deal_id] as ids
              from public.sourcing_sent s
              where s.user_id = vw.user_id and s.status = 'sent' and s.deal_id is not null
                and s.sent_at >= vw.day_start and s.sent_at < vw.day_start + interval '1 day'
              order by s.sent_at desc
              limit 1
            ) pk on true
          ) tv
        ) l
        where cardinality(l.ids) > 0
        group by 1, 2
      ) t
    ),
    'last', (
      select coalesce(jsonb_agg(jsonb_build_object('u', la.user_id, 'k', la.kind, 'at', la.occurred_at)), '[]'::jsonb)
      from (
        select distinct on (e.user_id) e.user_id, e.kind, e.occurred_at
        from public.activity_events e
        where (e.kind = any(v_counted) or e.kind = any(v_qual)) and not (e.extras ? 'env')
        order by e.user_id, e.occurred_at desc
      ) la
    )
  );
end;
$$;
revoke all on function public.activity_weekly_facts(jsonb) from public, anon, authenticated;
grant execute on function public.activity_weekly_facts(jsonb) to service_role;

-- activity_backfill(p): copies history from the tables that already record
-- member actions into activity_events, marked backfilled. p.apply = false
-- (the default) only counts. Safe to run any number of times:
--   - only rows from before the cutoff (the first event logged live in
--     production, fixed on the first real run) and inside the 24 months
--     retention keeps
--   - every copied row has a key ('bf:<table>:<id>', or the live key where
--     one exists) and a key that is already there, for anyone, is skipped
-- Not copied: today_selections (the morning cron makes most of those rows,
-- so one is no sign the member looked at Today) and checklist_steps (each
-- step repeats the open, keep, report or share that completed it).
-- The real run is refused until something has been logged live in
-- production: run on a preview before merging, it would fix the cutoff too
-- early and leave a gap between the preview and the release.
create or replace function public.activity_backfill(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_apply boolean := coalesce(nullif(p->>'apply', '')::boolean, false);
  v_floor timestamptz := now() - interval '24 months';
  v_stored timestamptz;
  v_first_live timestamptz;
  v_cutoff timestamptz;
  v_sources jsonb;
  v_inserted bigint;
begin
  select nullif(m.value->>'cutoff', '')::timestamptz into v_stored from public.activity_meta m where m.key = 'backfill_cutoff';
  select min(e.occurred_at) into v_first_live from public.activity_events e where not e.backfilled and not (e.extras ? 'env');
  v_cutoff := coalesce(v_stored, v_first_live);

  if v_apply then
    if v_cutoff is null then
      return jsonb_build_object('dry', false, 'error', 'not_live');
    end if;
    if v_stored is null then
      insert into public.activity_meta (key, value) values ('backfill_cutoff', jsonb_build_object('cutoff', v_cutoff))
      on conflict (key) do nothing;
      select nullif(m.value->>'cutoff', '')::timestamptz into v_cutoff from public.activity_meta m where m.key = 'backfill_cutoff';
    end if;
  end if;

  with src (s, user_id, occurred_at, kind, deal_id, source, extras, dedupe_key) as (
    -- Deals a member chose to open: not the daily pick's automatic open, not
    -- an admin's free look. A team member's open is stored against the owner
    -- who paid; the member who pressed the button is on the charge.
    select 'deal_opens', coalesce(nullif(ct.metadata->>'member_id', '')::uuid, o.user_id), o.opened_at, 'deal_open', o.deal_id, 'web',
           '{}'::jsonb, 'bf:deal_opens:' || o.id::text
    from public.deal_opens o
    left join public.credit_transactions ct on ct.id = o.transaction_id
    where o.status = 'open' and coalesce(o.verified_via, '') not in ('pick', 'admin')
    union all
    -- Keep / Pass: only the current state is kept, so this is the latest one.
    select 'deal_reactions', r.user_id, r.updated_at, case when r.reaction = 'keep' then 'keep' else 'pass' end, r.deal_id, 'web',
           case when r.reaction = 'pass' and cardinality(r.reasons) > 0 then jsonb_build_object('reasons', to_jsonb(r.reasons)) else '{}'::jsonb end,
           'bf:deal_reactions:' || r.user_id::text || ':' || r.deal_id::text
    from public.deal_reactions r
    union all
    -- Reports (tier unknown). A report run on a marketplace deal's own listing
    -- is tied to the deal.
    select 'saved_searches', s.user_id, s.created_at, 'report_run', md.id, 'web',
           jsonb_build_object('from', case when md.id is not null then 'deal' when s.checked_listing_id is not null then 'listing' else 'address' end),
           'bf:saved_searches:' || s.id::text
    from public.saved_searches s
    left join public.checked_listings cl on cl.id = s.checked_listing_id
    left join public.marketplace_deals md on md.canonical_url = cl.canonical_url
    union all
    -- A share: the first time only (sharing again reuses the link).
    select 'deal_shares', sh.user_id, sh.created_at, 'deal_share', sh.deal_id, 'web',
           '{}'::jsonb, 'bf:deal_shares:' || sh.user_id::text || ':' || sh.deal_id::text
    from public.deal_shares sh
    union all
    -- Top-ups. Manual and automatic cannot be told apart here, so they are
    -- kept as their own kind, which does not count towards weekly active.
    -- Same key as a live top-up.
    select 'credit_grants', g.user_id, g.created_at, 'topup_unknown', null::uuid, 'system',
           jsonb_build_object('amount_pence', g.amount_pence), 'topup:' || g.source_ref
    from public.credit_grants g
    where g.kind = 'topup' and g.source_ref is not null
      and not exists (
        select 1 from public.credit_grants x
        where x.user_id = g.user_id and x.kind = 'adjustment'
          and x.source_ref in (g.source_ref || ':refunded', g.source_ref || ':disputed')
      )
    union all
    -- Answers to the daily pick from the email or its page ("Yes, more like
    -- this" / "Not for me"). The link can be clicked by a mail scanner, so
    -- these never count towards weekly active.
    select 'sourcing_sent', ss.user_id, ss.responded_at, 'email_feedback', ss.deal_id, 'email_link',
           jsonb_strip_nulls(jsonb_build_object(
             'answer', ss.reaction,
             'via', ss.reaction_source,
             'reasons', case when cardinality(ss.reasons) > 0 then to_jsonb(ss.reasons) end
           )),
           'bf:sourcing_sent:' || ss.id::text
    from public.sourcing_sent ss
    where ss.reaction is not null and ss.responded_at is not null
    union all
    -- Batch 7's next-step tools. The one-tap stage button is a stage move.
    select 'pipeline_step_events', pe.user_id, pe.at,
           case when pe.action = 'advance' then 'stage_move' else 'next_step' end,
           case when pe.item_key ~ '^d-[0-9a-fA-F-]{36}$' then substr(pe.item_key, 3)::uuid end,
           'web',
           case when pe.action = 'advance'
                then jsonb_strip_nulls(jsonb_build_object('from', pe.stage, 'to', pe.item_id, 'via', 'next_step',
                       'item', case when pe.item_key like 'l-%' then pe.item_key end))
                else jsonb_strip_nulls(jsonb_build_object('action', pe.action, 'stage', pe.stage, 'step', pe.item_id,
                       'item', case when pe.item_key like 'l-%' then pe.item_key end))
           end,
           'bf:pipeline_step_events:' || pe.id::text
    from public.pipeline_step_events pe
    union all
    -- Plan changes the member made. A start is keyed by subscription: the
    -- Stripe webhook records it twice (checkout, then the subscription).
    -- Resumes Stripe reports on its own may be the pause simply ending, so
    -- only the member's own are copied.
    select 'subscription_events', se.user_id, se.at,
           case se.kind when 'started' then 'plan_start' when 'plan_changed' then 'plan_change' when 'paused' then 'plan_pause'
             when 'resumed' then 'plan_resume' when 'cancel_scheduled' then 'plan_cancel' else 'plan_cancel_undone' end,
           null::uuid,
           case when se.source = 'self_serve' then 'web' else 'system' end,
           jsonb_strip_nulls(jsonb_build_object('plan', se.plan_code)),
           case when se.kind = 'started' and se.stripe_subscription_id is not null
                then 'plan_start:' || se.stripe_subscription_id
                else 'bf:subscription_events:' || se.id::text end
    from public.subscription_events se
    where se.kind in ('started', 'plan_changed', 'paused', 'cancel_scheduled', 'cancel_reverted')
       or (se.kind = 'resumed' and se.source = 'self_serve')
  ), cand as (
    select distinct on (src.user_id, src.dedupe_key) src.*
    from src
    where src.occurred_at is not null
      and src.occurred_at < coalesce(v_cutoff, now())
      and src.occurred_at >= v_floor
      and exists (select 1 from public.profiles pr where pr.id = src.user_id)
    order by src.user_id, src.dedupe_key, src.occurred_at
  ), fresh as (
    select c.* from cand c
    where not exists (select 1 from public.activity_events e where e.dedupe_key = c.dedupe_key)
  ), ins as (
    insert into public.activity_events (user_id, occurred_at, kind, deal_id, source, extras, dedupe_key, backfilled)
    select f.user_id, f.occurred_at, f.kind, f.deal_id, f.source, f.extras, f.dedupe_key, true
    from fresh f
    where v_apply
    on conflict (user_id, dedupe_key) do nothing
    returning 1
  )
  select
    (select coalesce(jsonb_object_agg(t.s, jsonb_build_object('found', t.found, 'new', t.fresh)), '{}'::jsonb)
       from (select c.s, count(*) as found, count(f.dedupe_key) as fresh
               from cand c left join fresh f on f.user_id = c.user_id and f.dedupe_key = c.dedupe_key
              group by c.s) t),
    (select count(*) from ins)
  into v_sources, v_inserted;

  return jsonb_build_object(
    'dry', not v_apply,
    'cutoff', v_cutoff,
    'cutoff_fixed', v_stored is not null or v_apply,
    'floor', v_floor,
    'sources', v_sources,
    'inserted', v_inserted
  );
end;
$$;
revoke all on function public.activity_backfill(jsonb) from public, anon, authenticated;
grant execute on function public.activity_backfill(jsonb) to service_role;

-- activity_retention(p): the daily cron's work. Deletes events and visits
-- older than p.before, at most p.limit of each per run (default 50,000); with
-- p.apply = false (the default) it only counts. Refuses a cutoff less than a
-- year old, so a wrong date can never empty the log.
create or replace function public.activity_retention(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_before timestamptz := nullif(p->>'before', '')::timestamptz;
  v_apply boolean := coalesce(nullif(p->>'apply', '')::boolean, false);
  v_limit integer := least(greatest(coalesce(nullif(p->>'limit', '')::integer, 50000), 1), 500000);
  v_events bigint;
  v_visits bigint;
begin
  if v_before is null or v_before > now() - interval '12 months' then
    raise exception 'activity_retention: before must be at least 12 months ago';
  end if;
  if not v_apply then
    select count(*) into v_events from public.activity_events e where e.occurred_at < v_before;
    select count(*) into v_visits from public.activity_visits v where v.started_at < v_before;
    return jsonb_build_object('dry', true, 'before', v_before, 'events', v_events, 'visits', v_visits);
  end if;
  with gone as (
    delete from public.activity_events e
    where e.id in (select x.id from public.activity_events x where x.occurred_at < v_before order by x.occurred_at limit v_limit)
    returning 1
  ) select count(*) into v_events from gone;
  with gone as (
    delete from public.activity_visits v
    where v.id in (select x.id from public.activity_visits x where x.started_at < v_before order by x.started_at limit v_limit)
    returning 1
  ) select count(*) into v_visits from gone;
  return jsonb_build_object(
    'dry', false,
    'before', v_before,
    'events', v_events,
    'visits', v_visits,
    'more', exists (select 1 from public.activity_events e where e.occurred_at < v_before)
         or exists (select 1 from public.activity_visits v where v.started_at < v_before)
  );
end;
$$;
revoke all on function public.activity_retention(jsonb) from public, anon, authenticated;
grant execute on function public.activity_retention(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 10: analyser path + pricing
-- =========================
-- Fixed prices for deals in the feed, daily deals, 1:1 plan credit and a
-- lower top-up rate (src/lib/credit/deal-pricing.ts reads every key below;
-- /admin/billing edits them). All in base pence: what a member on a plan
-- pays. Top-up credit pays base × its spend rate. Inserted only when
-- missing, so an edit made on /admin/billing survives a re-run.
--   full_analysis_pence   a Full analysis of a feed deal; a Quick look
--                         already paid for that deal comes off it
--   pmi_addon_pence       the optional PMI second opinion, on top
--   todays_5_daily_pence  one day of daily deals (Today's 5), charged only
--                         on a day it is delivered, from new_pricing_from
--   analysis_reuse_days   a saved analysis of the same deal younger than
--                         this is reused instead of paying the providers again
--   plan_credit_pence     monthly plan credit from new_pricing_from, applied
--                         at each subscriber's first renewal on or after it
--                         (annual: the first ANNUAL renewal)
--   new_pricing_from      the date plan credit and daily deals change. null
--                         until it is set on /admin/billing, which only allows
--                         a date at least 14 days after the members' notice
--   profit_range_pct      the area-estimate profit range either side, by the
--                         screening's confidence (capped at 25 in the code)
-- None of this is in ACCESS_COLUMNS.
insert into public.billing_settings (key, value) values
  ('full_analysis_pence', '400'::jsonb),
  ('pmi_addon_pence', '200'::jsonb),
  ('todays_5_daily_pence', '33'::jsonb),
  ('analysis_reuse_days', '30'::jsonb),
  ('plan_credit_pence', '{"starter":1900,"pro":3999,"scale":9900,"pro_annual":3000}'::jsonb),
  ('new_pricing_from', 'null'::jsonb),
  ('profit_range_pct', '{"high":10,"medium":15,"low":25}'::jsonb)
on conflict (key) do nothing;

-- Top-up and adjustment (promo, referral, admin) credit spend at 1.3×, down
-- from 1.5×. A grant's spend_rate is frozen when it is made, so balances
-- bought before today are moved to 1.3 as well (decided 27 Sep 2026: one
-- rate, in the member's favour). Past debits keep the rate they were taken
-- at in credit_allocations. The overdraft grant (rate 1) is not touched.
-- Runs ONCE, marked by the batch10_rates_applied_at row: re-running this file
-- must never undo a later change of rate made on /admin/billing.
do $$
begin
  if not exists (select 1 from public.billing_settings where key = 'batch10_rates_applied_at') then
    update public.billing_settings
       set value = value || '{"topup":1.3,"adjustment":1.3}'::jsonb, updated_at = now()
     where key = 'spend_rates';
    update public.credit_grants
       set spend_rate = 1.3
     where kind in ('topup', 'adjustment') and spend_rate = 1.5 and remaining_pence > 0;
    insert into public.billing_settings (key, value) values ('batch10_rates_applied_at', to_jsonb(now()));
  end if;
end $$;

-- ── Saved analyses (src/lib/analysis/reuse.ts) ──
-- A Full analysis of a feed deal, kept so the next Full analysis of the same
-- deal within analysis_reuse_days reuses it instead of paying the providers
-- again. Only what the providers said about the PROPERTY is kept: never the
-- member's deal maths, cash flow, finance, name, notes, stage or report id.
-- Written only by the server from a fresh run (never copied from
-- saved_searches, which its author can edit). Service role only.
create table if not exists public.deal_analyses (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  canonical_url text not null,
  input_key text not null,                   -- the fixed inputs the providers were asked (deal-input.ts)
  inputs jsonb not null,
  result jsonb not null,                     -- { result, stampDuty, stampDutyPrice }: see SharedAnalysis
  has_second_opinion boolean not null default false,
  raw_cost_pence numeric(14,4) not null default 0,
  action_id uuid,                            -- the purchase that ran it (provider_calls.action_id)
  analysed_at timestamptz not null default now(),
  second_opinion_at timestamptz
);
create index if not exists deal_analyses_lookup_idx on public.deal_analyses (deal_id, input_key, analysed_at desc);
alter table public.deal_analyses enable row level security;  -- no policies: service role only
revoke all on public.deal_analyses from anon, authenticated;

-- ── Full analysis and PMI purchases (src/lib/analysis/deal-analysis.ts) ──
-- One row per purchase; its id is the ledger action_id of its debits. The
-- row is claimed (pending) BEFORE anything is charged, and one pending row per
-- account and deal (or per report, for PMI) is the double-tap guard: a second
-- tab gets "already running". A Full analysis is charged only once the
-- analysis is complete and saved; a failed one is marked failed and costs
-- nothing (a Quick look it charged on the way stays: the deal is open).
--   user_id    the account that pays (a team member's owner)
--   buyer_id   who pressed the button; the report is theirs
--   quoted_base_pence       the total the member confirmed, Quick look included
--   analysis_base_pence     the Full analysis debit: its price less open_credit
--   pmi_base_pence          the PMI debit, taken only if PMI answered
--   open_credit_base_pence  what the account paid to open the deal, off the price
create table if not exists public.analysis_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,                        -- full_analysis | pmi_addon
  status text not null default 'pending',    -- pending | complete | failed
  deal_id uuid,
  canonical_url text,
  report_id uuid,                            -- the report made (full_analysis) or added to (pmi_addon)
  analysis_id uuid,                          -- the deal_analyses row used
  with_pmi boolean not null default false,
  input_key text,
  inputs jsonb,
  quoted_base_pence numeric(14,4),
  analysis_base_pence numeric(14,4) not null default 0,
  pmi_base_pence numeric(14,4) not null default 0,
  open_credit_base_pence numeric(14,4) not null default 0,
  opened_by_purchase boolean not null default false,
  open_action_id uuid,                       -- the deal_opens row this purchase opened (its debit's action_id)
  reservation_id uuid,
  reused boolean,
  second_opinion boolean,                    -- PMI answered (only then is pmi_addon charged)
  charged_base_pence numeric(14,4) not null default 0,
  transaction_ids bigint[] not null default '{}',
  failure text,
  ready_at timestamptz,
  run_started_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists analysis_purchases_running_uidx on public.analysis_purchases (user_id, deal_id) where kind = 'full_analysis' and status = 'pending';
create unique index if not exists analysis_purchases_pmi_running_uidx on public.analysis_purchases (report_id) where kind = 'pmi_addon' and status = 'pending';
create index if not exists analysis_purchases_user_idx on public.analysis_purchases (user_id, created_at desc);
create index if not exists analysis_purchases_deal_idx on public.analysis_purchases (deal_id, user_id, created_at desc);
alter table public.analysis_purchases enable row level security;  -- no policies: service role only
revoke all on public.analysis_purchases from anon, authenticated;

-- A report made by a Full analysis of a feed deal says which deal (the deal
-- page finds it by this, pipeline row or not) and when its figures were
-- found, which the report shows as "Analysed on" when that was before today.
-- Such reports are never pruned by the 200-report limit: they were paid for.
alter table public.saved_searches add column if not exists deal_id uuid;
alter table public.saved_searches add column if not exists analysed_at timestamptz;
create index if not exists saved_searches_deal_idx on public.saved_searches (owner_id, deal_id) where deal_id is not null;
-- Only the server sets them (a Full analysis it ran and charged for): the
-- cards, the deal page and the purchase itself trust them. Signed-in members
-- can write their own saved_searches rows with the public key (the policy
-- above is FOR ALL), so from them a value is dropped on insert and kept as it
-- was on update. The service role (the server) and the SQL editor are not
-- touched. A plain (invoker) function: current_user is the caller's role.
create or replace function private.saved_searches_keep_analysis()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.deal_id := null;
      new.analysed_at := null;
    else
      new.deal_id := old.deal_id;
      new.analysed_at := old.analysed_at;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.saved_searches_keep_analysis() from public;
drop trigger if exists saved_searches_keep_analysis on public.saved_searches;
create trigger saved_searches_keep_analysis
  before insert or update on public.saved_searches
  for each row execute function private.saved_searches_keep_analysis();

-- ── Daily deals: one charge per member per day (src/lib/listing/daily-deals-server.ts) ──
-- From new_pricing_from, a delivered Today's 5 costs todays_5_daily_pence,
-- once per member per UTC day, charged to the account that pays (a team
-- member's owner). The row is inserted BEFORE the debit: (user_id, day) is
-- the guard that the 07:00 picks passes, the 08:10 digest and any retry can
-- never charge one member twice for one day. charged_base_pence and
-- transaction_id are written only once the debit has gone through.
create table if not exists public.daily_deal_charges (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  payer_id uuid not null references public.profiles(id) on delete cascade,
  run text not null,                         -- picks | digest
  send_ref text,                             -- the sourcing_sent row, or the digest's send token
  charged_base_pence numeric(14,4) not null default 0,
  transaction_id bigint,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
create unique index if not exists daily_deal_charges_id_uidx on public.daily_deal_charges (id);
create index if not exists daily_deal_charges_payer_idx on public.daily_deal_charges (payer_id, day desc);
alter table public.daily_deal_charges enable row level security;  -- no policies: service role only
revoke all on public.daily_deal_charges from anon, authenticated;

-- ── The members' notice of these prices (src/lib/credit/pricing-notice-run.ts) ──
-- Sent by hand from /admin/billing after a dry run, at least 14 days before
-- new_pricing_from. Stamped on each profile as it is sent, so a second press
-- never mails anyone twice; the latest stamp also sets the earliest date the
-- new pricing may start (/admin/billing). pricing_notice_date is the date the
-- notice announced: the new pricing takes effect only once one has been
-- announced, and never before the date announced (effectivePricingDate).
alter table public.profiles add column if not exists pricing_notice_sent_at timestamptz;
insert into public.billing_settings (key, value) values ('pricing_notice_date', 'null'::jsonb)
on conflict (key) do nothing;

-- =========================
-- Batch 12: profile quiz
-- =========================
-- The profile quiz (src/lib/profile): every member answers ~20 questions,
-- one per screen. The search-criteria answers go into profiles.market_goals
-- (bumped to version 2 in code; no SQL change), the "about you" answers into
-- the column below, and the bookkeeping — which questions are answered,
-- where they stopped, the £5 — into profile_quiz. None of this is in
-- ACCESS_COLUMNS (src/lib/access.ts), and must not become so.

-- ── profiles.about_you: Section A, the member's own answers (src/lib/profile/about.ts) ──
-- Written by the member's own session, like market_goals, so it is granted
-- to `authenticated` (the row policy limits them to their own row). Declared
-- above the grant, because the grant names it.
alter table public.profiles add column if not exists about_you jsonb;
alter table public.profiles add column if not exists about_you_updated_at timestamptz;
grant update (about_you, about_you_updated_at) on public.profiles to authenticated;

-- ── profile_quiz: one row per member who has started (src/lib/profile/state.ts) ──
--   answered               {question_id: {at, notSure}}: the questions answered,
--                          a real answer or "Not sure". Stored, not derived, so
--                          "Not sure" can be told from never asked
--   last_question          where they were last: the admin drop-off table
--   credit_grant_id        the £5 (credit_grants), once paid; unique on the
--                          grant's source_ref 'profile_complete:<user>' so a
--                          retry can never pay twice
--   credit_skipped_reason  why it will never be paid (team_member,
--                          welcome_withheld): the welcome check's own verdict
--   reminder_collapsed_day the Today-day the reminder card was collapsed for;
--                          it returns the next day and never stops until complete
-- Service role only: a member can never mark their own quiz complete or paid.
create table if not exists public.profile_quiz (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_question text,
  answered jsonb not null default '{}'::jsonb,
  finish_later_at timestamptz,
  resumed_at timestamptz,
  credit_grant_id uuid,
  credit_skipped_reason text,
  reminder_collapsed_day date,
  updated_at timestamptz not null default now()
);
create index if not exists profile_quiz_completed_idx on public.profile_quiz (completed_at);
alter table public.profile_quiz enable row level security;  -- no policies: service role only
revoke all on public.profile_quiz from anon, authenticated;

-- ── Settings (src/lib/credit/unit-costs.ts reads them; /admin/billing edits them) ──
--   profile_complete_pence       the one-off credit for a complete profile
--   profile_credit_min_real_pct  the share of the non-mandatory questions that
--                                need a real answer (not "Not sure") before
--                                it is paid, so answering everything "Not
--                                sure" earns nothing
insert into public.billing_settings (key, value) values
  ('profile_complete_pence', '500'::jsonb),
  ('profile_credit_min_real_pct', '75'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 13: saved profiles
-- =========================
-- Up to five saved profiles per member (src/lib/profiles). A profile is one
-- set of search criteria: the same MarketGoals jsonb as profiles.market_goals,
-- the "specific areas" answer (saved_areas) and the quiz's answered marks
-- (profile_quiz.answered). "About you" (profiles.about_you), the quiz gate and
-- the £5 stay one per member, exactly as Batch 12 built them.
--
-- ONE profile per member is active: the one the header shows. Its criteria
-- are ALSO the live profiles.market_goals / saved_areas / profile_quiz.answered
-- that every existing reader and writer already uses. The triggers below copy
-- any change of those into the active profile's row, so the quiz, the Advanced
-- form, the relaxation link and lead provisioning never need to know which
-- profile is active. select_search_profile swaps them in one transaction.
-- Everything that runs per profile (the daily run, the digest, emails, My
-- deals) reads search_profiles.
--
-- Running = not paused and not deleted: gets its own Today's 5 in the daily
-- email and its own daily charge. Paused only by the member (no auto-pause).
-- Deletes are soft, so deals keep their profile and read "(deleted profile)".
-- Team members keep exactly one profile (src/lib/profiles/rules.ts).
-- Nothing here is in ACCESS_COLUMNS (src/lib/access.ts), and must not become so.
-- Everything is additive: this section can be run before the code is merged.

create table if not exists public.search_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  criteria jsonb,                              -- MarketGoals; null = no preferences yet (house picks)
  areas text[] not null default '{}',          -- postcode areas: the "specific areas" answer
  answered jsonb not null default '{}'::jsonb, -- the quiz's {question: {at, notSure}} marks for this profile
  for_client boolean not null default false,   -- set up for someone else (the permission reminder)
  copied_from uuid,                            -- the profile it was copied from (analytics only)
  is_active boolean not null default false,    -- the one the header shows; its criteria are also profiles.market_goals
  paused_at timestamptz,                       -- daily deals paused by the member; null = running
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  alter table public.search_profiles drop constraint if exists search_profiles_name_check;
  alter table public.search_profiles add constraint search_profiles_name_check check (char_length(btrim(name)) between 1 and 40);
end $$;
create unique index if not exists search_profiles_active_uidx on public.search_profiles (user_id) where is_active and deleted_at is null;
create unique index if not exists search_profiles_name_uidx on public.search_profiles (user_id, lower(btrim(name))) where deleted_at is null;
create index if not exists search_profiles_user_idx on public.search_profiles (user_id, created_at);
create index if not exists search_profiles_running_idx on public.search_profiles (user_id) where deleted_at is null and paused_at is null;
alter table public.search_profiles enable row level security;  -- no policies: service role only
revoke all on public.search_profiles from anon, authenticated;

-- ── Each profile's Today list for a day (src/lib/today/selection.ts) ──
-- today_selections is keyed (user_id, day): one list a member. This is the
-- same thing per profile. today_selections is left as it was (history, and a
-- rollback keeps working); its rows are copied here for the first profile.
create table if not exists public.profile_today_lists (
  profile_id uuid not null references public.search_profiles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  deal_ids uuid[] not null default '{}',
  near_miss boolean not null default false,
  advice text,
  created_at timestamptz not null default now(),
  primary key (profile_id, day)
);
create index if not exists profile_today_lists_user_day_idx on public.profile_today_lists (user_id, day);
alter table public.profile_today_lists enable row level security;  -- no policies: service role only
revoke all on public.profile_today_lists from anon, authenticated;

-- ── One daily-deals charge per profile per day (src/lib/listing/daily-deals-server.ts) ──
-- Batch 10's daily_deal_charges is keyed (user_id, day): one charge a member.
-- A member with three running profiles is charged three times a day, so the
-- guard row moves here, keyed (profile_id, day), inserted BEFORE the debit
-- exactly as Batch 10's is. daily_deal_charges is left as it was; a legacy row
-- for the same member and day counts as the active profile's charge.
create table if not exists public.profile_daily_charges (
  id uuid not null default gen_random_uuid(),
  profile_id uuid not null references public.search_profiles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  payer_id uuid not null references public.profiles(id) on delete cascade,
  run text not null,                         -- picks | digest
  send_ref text,
  charged_base_pence numeric(14,4) not null default 0,
  transaction_id bigint,
  created_at timestamptz not null default now(),
  primary key (profile_id, day)
);
create unique index if not exists profile_daily_charges_id_uidx on public.profile_daily_charges (id);
create index if not exists profile_daily_charges_user_day_idx on public.profile_daily_charges (user_id, day);
create index if not exists profile_daily_charges_payer_idx on public.profile_daily_charges (payer_id, day desc);
alter table public.profile_daily_charges enable row level security;  -- no policies: service role only
revoke all on public.profile_daily_charges from anon, authenticated;

-- ── Which profile a pick, a Keep / Pass, a pipeline row, an open or a miss belongs to ──
-- Nullable: untagged history is attached to the member's first profile below.
-- A team member's open is recorded against the owner (deal_opens.user_id is
-- the payer), so opens are tagged only when the opener pays for themselves.
alter table public.sourcing_sent add column if not exists profile_id uuid references public.search_profiles(id) on delete set null;
alter table public.deal_reactions add column if not exists profile_id uuid references public.search_profiles(id) on delete set null;
alter table public.checked_listings add column if not exists profile_id uuid references public.search_profiles(id) on delete set null;
alter table public.deal_opens add column if not exists profile_id uuid references public.search_profiles(id) on delete set null;
alter table public.sourcing_missed add column if not exists profile_id uuid references public.search_profiles(id) on delete set null;
create index if not exists sourcing_sent_profile_idx on public.sourcing_sent (profile_id) where profile_id is not null;
create index if not exists deal_reactions_profile_idx on public.deal_reactions (profile_id) where profile_id is not null;
create index if not exists checked_listings_profile_idx on public.checked_listings (profile_id) where profile_id is not null;
create index if not exists deal_opens_profile_idx on public.deal_opens (profile_id) where profile_id is not null;
create index if not exists sourcing_missed_profile_idx on public.sourcing_missed (profile_id) where profile_id is not null;

-- ── Every member's first profile, "My deals", holding what they have now ──
insert into public.search_profiles (user_id, name, criteria, areas, answered, is_active)
select p.id,
       'My deals',
       p.market_goals,
       coalesce((select array_agg(s.postcode_area order by s.postcode_area) from public.saved_areas s where s.user_id = p.id), '{}'),
       coalesce((select q.answered from public.profile_quiz q where q.user_id = p.id), '{}'::jsonb),
       true
  from public.profiles p
 where not exists (select 1 from public.search_profiles sp where sp.user_id = p.id);

-- ── Untagged history belongs to the member's first profile ──
-- Only rows from before the first profile ever existed: after that the
-- triggers below tag every new row, so a re-run never relabels anything (and
-- never pins a team member's untagged open on the owner's profile).
do $$
declare
  v_cutover timestamptz := (select min(created_at) from public.search_profiles);
begin
  if v_cutover is null then return; end if;
  with first_profile as (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at)
  update public.sourcing_sent t set profile_id = f.id from first_profile f where t.profile_id is null and f.user_id = t.user_id and t.sent_at < v_cutover;
  with first_profile as (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at)
  update public.deal_reactions t set profile_id = f.id from first_profile f where t.profile_id is null and f.user_id = t.user_id and t.created_at < v_cutover;
  with first_profile as (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at)
  update public.checked_listings t set profile_id = f.id from first_profile f where t.profile_id is null and f.user_id = t.user_id and t.created_at < v_cutover;
  with first_profile as (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at)
  update public.deal_opens t set profile_id = f.id from first_profile f where t.profile_id is null and f.user_id = t.user_id and t.opened_at < v_cutover;
  with first_profile as (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at)
  update public.sourcing_missed t set profile_id = f.id from first_profile f where t.profile_id is null and f.user_id = t.user_id and t.missed_at < v_cutover;
end $$;
insert into public.profile_today_lists (profile_id, user_id, day, deal_ids, near_miss, advice, created_at)
select f.id, t.user_id, t.day, t.deal_ids, t.near_miss, t.advice, t.created_at
  from public.today_selections t
  join (select distinct on (user_id) user_id, id from public.search_profiles order by user_id, created_at) f on f.user_id = t.user_id
on conflict (profile_id, day) do nothing;

-- ── New rows are tagged with the member's active profile unless the code says otherwise ──
-- Security definer: members insert pipeline rows through their own session
-- and cannot read search_profiles. The code still sets profile_id wherever
-- it matters (a pick's own profile, the profile a card was shown under).
create or replace function private.search_profiles_tag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.profile_id is null then
    select sp.id into new.profile_id from public.search_profiles sp
     where sp.user_id = new.user_id and sp.is_active and sp.deleted_at is null;
  end if;
  return new;
end;
$$;
revoke execute on function private.search_profiles_tag() from public;
drop trigger if exists search_profiles_tag on public.sourcing_sent;
create trigger search_profiles_tag before insert on public.sourcing_sent for each row execute function private.search_profiles_tag();
drop trigger if exists search_profiles_tag on public.deal_reactions;
create trigger search_profiles_tag before insert on public.deal_reactions for each row execute function private.search_profiles_tag();
drop trigger if exists search_profiles_tag on public.checked_listings;
create trigger search_profiles_tag before insert on public.checked_listings for each row execute function private.search_profiles_tag();
drop trigger if exists search_profiles_tag on public.sourcing_missed;
create trigger search_profiles_tag before insert on public.sourcing_missed for each row execute function private.search_profiles_tag();

-- ── The live copies keep the active profile up to date ──
create or replace function private.search_profiles_sync_goals()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.search_profiles
     set criteria = new.market_goals, updated_at = now()
   where user_id = new.id and is_active and deleted_at is null;
  return new;
end;
$$;
revoke execute on function private.search_profiles_sync_goals() from public;
drop trigger if exists search_profiles_sync_goals on public.profiles;
create trigger search_profiles_sync_goals after update of market_goals on public.profiles
  for each row when (old.market_goals is distinct from new.market_goals)
  execute function private.search_profiles_sync_goals();

create or replace function private.search_profiles_sync_areas()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
begin
  update public.search_profiles
     set areas = coalesce((select array_agg(s.postcode_area order by s.postcode_area) from public.saved_areas s where s.user_id = v_user), '{}'),
         updated_at = now()
   where user_id = v_user and is_active and deleted_at is null;
  return null;
end;
$$;
revoke execute on function private.search_profiles_sync_areas() from public;
drop trigger if exists search_profiles_sync_areas on public.saved_areas;
create trigger search_profiles_sync_areas after insert or delete on public.saved_areas
  for each row execute function private.search_profiles_sync_areas();

create or replace function private.search_profiles_sync_answered()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.search_profiles
     set answered = new.answered, updated_at = now()
   where user_id = new.user_id and is_active and deleted_at is null;
  return new;
end;
$$;
revoke execute on function private.search_profiles_sync_answered() from public;
drop trigger if exists search_profiles_sync_answered on public.profile_quiz;
create trigger search_profiles_sync_answered after insert or update of answered on public.profile_quiz
  for each row execute function private.search_profiles_sync_answered();

-- ── Create: the limit is checked under the member's row lock, so two at once cannot make a sixth ──
-- p: {user, name, criteria, areas, answered, for_client, copied_from}
-- Raises profile_limit (P0409) at billing_settings.saved_profiles_max.
create or replace function public.create_search_profile(p jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_max integer := coalesce((select (value #>> '{}')::integer from public.billing_settings where key = 'saved_profiles_max'), 5);
  v_count integer;
  v_id uuid;
begin
  if v_user is null then raise exception 'profile_user_required'; end if;
  perform 1 from public.profiles where id = v_user for no key update;
  select count(*) into v_count from public.search_profiles where user_id = v_user and deleted_at is null;
  if v_count >= v_max then
    raise exception 'profile_limit' using errcode = 'P0409', detail = json_build_object('max', v_max)::text;
  end if;
  insert into public.search_profiles (user_id, name, criteria, areas, answered, for_client, copied_from, is_active)
  values (
    v_user,
    btrim(p->>'name'),
    p->'criteria',
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'areas', '[]'::jsonb)) x), '{}'),
    coalesce(p->'answered', '{}'::jsonb),
    coalesce((p->>'for_client')::boolean, false),
    nullif(p->>'copied_from', '')::uuid,
    v_count = 0
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_search_profile(jsonb) from public, anon, authenticated;
grant execute on function public.create_search_profile(jsonb) to service_role;

-- ── Switch: save the old active profile, load the new one into the live copies ──
-- p: {user, profile, shared: [question ids stored in about_you]}
-- The About-you marks are the member's, not the profile's, so they are kept
-- as they are; every other mark comes from the profile switched to.
-- Raises profile_not_found (P0404) for a deleted, unknown or someone else's profile.
create or replace function public.select_search_profile(p jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_target uuid := nullif(p->>'profile', '')::uuid;
  v_shared text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'shared', '[]'::jsonb)) x), '{}');
  v_row public.search_profiles%rowtype;
  v_old uuid;
begin
  perform 1 from public.profiles where id = v_user for no key update;
  select * into v_row from public.search_profiles where id = v_target and user_id = v_user and deleted_at is null;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0404';
  end if;
  select id into v_old from public.search_profiles where user_id = v_user and is_active and deleted_at is null;
  if v_old = v_target then return v_target; end if;
  if v_old is not null then
    update public.search_profiles sp
       set is_active = false,
           criteria = pr.market_goals,
           areas = coalesce((select array_agg(s.postcode_area order by s.postcode_area) from public.saved_areas s where s.user_id = v_user), '{}'),
           answered = coalesce((select q.answered from public.profile_quiz q where q.user_id = v_user), sp.answered),
           updated_at = now()
      from public.profiles pr
     where sp.id = v_old and pr.id = v_user;
  end if;
  update public.search_profiles set is_active = true, updated_at = now() where id = v_target;
  update public.profiles set market_goals = v_row.criteria, market_goals_updated_at = now() where id = v_user;
  delete from public.saved_areas where user_id = v_user and not (postcode_area = any (v_row.areas));
  insert into public.saved_areas (user_id, postcode_area)
  select v_user, a from unnest(v_row.areas) a
  on conflict (user_id, postcode_area) do nothing;
  update public.profile_quiz q
     set answered = (v_row.answered - v_shared)
                    || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(q.answered) e where e.key = any (v_shared)), '{}'::jsonb),
         updated_at = now()
   where q.user_id = v_user;
  return v_target;
end;
$$;
revoke all on function public.select_search_profile(jsonb) from public, anon, authenticated;
grant execute on function public.select_search_profile(jsonb) to service_role;

-- ── Setting: how many profiles a member may keep (read by maxProfilesSetting in src/lib/profiles/server.ts) ──
insert into public.billing_settings (key, value) values ('saved_profiles_max', '5'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 14: tailoring
-- =========================
-- What a member's answers do to their Today (src/lib/tailoring). Run AFTER
-- Batch 13's section: it adds to that section's tables. Everything is
-- additive and idempotent, service role only, and nothing here is in
-- ACCESS_COLUMNS (src/lib/access.ts), nor may it become so. The code reads
-- every column below in a query of its own, so this section can be run
-- before or after the code is deployed: until it is, members simply get no
-- must-have switches and no "never shown twice" record for replaced cards.

-- ── A profile's must-have / nice-to-have switches (src/lib/tailoring/profile.ts) ──
-- {criterion: 'must' | 'nice'}, only what the member set; anything absent is
-- the default. Its own column, outside criteria, so the goal writers (the
-- quiz, the Advanced form, the relaxation link) can never overwrite it.
alter table public.search_profiles add column if not exists filter_modes jsonb not null default '{}'::jsonb;

-- ── What a re-choose took off today's list, and the day's must-have count ──
-- shown_ids: deals shown on the list and then replaced (a switch, a widen, an
-- accepted prompt), so "never shown twice" still holds for them. deal_ids
-- keeps what is on the list now.
-- tailoring: {mustMatches, capped}, the deals meeting every must-have when
-- the list was chosen, for "N deals match you" on Today.
alter table public.profile_today_lists add column if not exists shown_ids uuid[] not null default '{}';
alter table public.profile_today_lists add column if not exists tailoring jsonb;

-- ── When each behaviour prompt was shown and answered (src/lib/tailoring/behaviour.ts) ──
-- "I've noticed you've kept 9 houses, but you said flats only. Want me to
-- include houses?" (Batch 25's wording). One row per member, profile and
-- question: asked at most once a week, and not for 30 days after "keep my
-- answer". scope is the profile's id, or 'member' for a member with no
-- profile row yet.
create table if not exists public.tailoring_prompts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null,
  question text not null,
  last_shown_at timestamptz,
  answered_at timestamptz,
  answer text check (answer in ('accepted', 'dismissed')),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, question)
);
alter table public.tailoring_prompts enable row level security;  -- no policies: service role only
revoke all on public.tailoring_prompts from anon, authenticated;

notify pgrst, 'reload schema';

-- =========================
-- Batch 15: demand-led sourcing
-- =========================
-- Members' running saved profiles steer which extra areas get searched
-- (src/lib/sourcing-demand). An area × kind that at least
-- billing_settings.demand_min_members members want, and that the
-- marketplace sweep does not already cover, is searched by the
-- /api/internal/demand-sourcing cron, within a provider-spend cap per UK
-- calendar month (billing_settings.demand_monthly_cap_pence). The sweep's
-- own list is never shortened by any of this. Service role only. Nothing
-- here is in ACCESS_COLUMNS (src/lib/access.ts), and must not become so.
-- Everything is additive: this section can be run before the code is merged,
-- and until it is run the demand cron searches nothing (it fails closed).

-- demand_searches: one row per demand-led search. A search claims its
-- worst-case cost first (demand_search_reserve) and is settled to what its
-- metered provider calls actually cost. The month's spend is the settled
-- costs plus any open claims at their reserve, so a pass that dies
-- mid-search errs on the safe side. status: reserved → answered (the broker
-- gave listings) | unavailable (it gave none) | failed (an error, or a claim
-- left open and closed at its reserve). At most one reserved or answered
-- search per area × kind per UK day, so a scheduled pass and an admin's
-- "run a pass" can never both search the same area.
create table if not exists public.demand_searches (
  id uuid primary key default gen_random_uuid(),
  month date not null,                         -- first day of the UK calendar month the spend counts against
  day date not null,                           -- the UK day, for "searched today"
  postcode_area text not null,
  kind text not null,                          -- sale | rent
  query_key text not null,
  status text not null default 'reserved',
  reserve_pence numeric(14,4) not null default 0,
  cost_pence numeric(14,4),                    -- raw provider cost, once settled
  provider text,                               -- the broker rung that answered: pmi | onthemarket
  cached boolean,
  listings int,
  new_deals int,
  members int not null default 0,              -- the demand when it was searched
  paying_members int not null default 0,
  action_id uuid not null,                     -- provider_calls.action_id of this search's calls
  run_id uuid,
  triggered_by text not null default 'cron',   -- cron, or the admin's email for "run a pass"
  reserved_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists demand_searches_month_idx on public.demand_searches (month);
create index if not exists demand_searches_reserved_idx on public.demand_searches (reserved_at desc);
create unique index if not exists demand_searches_daily_uidx on public.demand_searches (day, postcode_area, kind) where status in ('reserved', 'answered');
do $$
begin
  alter table public.demand_searches drop constraint if exists demand_searches_kind_check;
  alter table public.demand_searches add constraint demand_searches_kind_check check (kind in ('sale', 'rent'));
  alter table public.demand_searches drop constraint if exists demand_searches_status_check;
  alter table public.demand_searches add constraint demand_searches_status_check check (status in ('reserved', 'answered', 'unavailable', 'failed'));
end $$;
alter table public.demand_searches enable row level security;  -- no policies: service role only
revoke all on public.demand_searches from anon, authenticated;

-- Claims one search. p: {month, day, area, kind, key, reserve_pence,
-- cap_pence, action_id, run_id, triggered_by, members, paying_members}.
-- Returns {id, refused, spent_pence}. refused is null (go ahead), 'cap' (the
-- month's spend plus this reserve would pass the cap; a cap of 0 refuses
-- everything) or 'duplicate' (already reserved or answered today). The claim
-- has to be the write: one transaction-scoped lock serialises claims, so
-- parallel passes can never both slip under the cap on the same figure.
create or replace function public.demand_search_reserve(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_month date := (p->>'month')::date;
  v_reserve numeric := greatest(0, coalesce((p->>'reserve_pence')::numeric, 0));
  v_cap numeric := coalesce((p->>'cap_pence')::numeric, 0);
  v_spent numeric;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('public.demand_searches'));
  select coalesce(sum(case when s.settled_at is null then s.reserve_pence else coalesce(s.cost_pence, 0) end), 0)
    into v_spent
    from public.demand_searches s
   where s.month = v_month;
  if v_cap <= 0 or v_spent + v_reserve > v_cap then
    return jsonb_build_object('id', null, 'refused', 'cap', 'spent_pence', v_spent);
  end if;
  insert into public.demand_searches (month, day, postcode_area, kind, query_key, reserve_pence, members, paying_members, action_id, run_id, triggered_by)
  values (
    v_month,
    (p->>'day')::date,
    p->>'area',
    p->>'kind',
    p->>'key',
    v_reserve,
    coalesce((p->>'members')::int, 0),
    coalesce((p->>'paying_members')::int, 0),
    (p->>'action_id')::uuid,
    nullif(p->>'run_id', '')::uuid,
    coalesce(nullif(p->>'triggered_by', ''), 'cron')
  )
  on conflict (day, postcode_area, kind) where status in ('reserved', 'answered') do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('id', null, 'refused', 'duplicate', 'spent_pence', v_spent);
  end if;
  return jsonb_build_object('id', v_id, 'refused', null, 'spent_pence', v_spent + v_reserve);
end;
$$;
revoke all on function public.demand_search_reserve(jsonb) from public, anon, authenticated;
grant execute on function public.demand_search_reserve(jsonb) to service_role;

-- The month's figures for the cap check and /admin/demand. p: {month}.
-- Summed here so no caller ever has to page through the rows.
create or replace function public.demand_sourcing_month(p jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'spent_pence', coalesce(sum(case when s.settled_at is null then s.reserve_pence else coalesce(s.cost_pence, 0) end), 0),
    'open_pence', coalesce(sum(case when s.settled_at is null then s.reserve_pence else 0 end), 0),
    'searches', count(*),
    'answered', count(*) filter (where s.status = 'answered'),
    'new_deals', coalesce(sum(s.new_deals), 0)
  )
  from public.demand_searches s
  where s.month = (p->>'month')::date;
$$;
revoke all on function public.demand_sourcing_month(jsonb) from public, anon, authenticated;
grant execute on function public.demand_sourcing_month(jsonb) to service_role;

-- ── Settings (src/lib/sourcing-demand/settings.ts has the defaults and bounds; /admin/demand edits them) ──
--   demand_min_members            members whose running profiles must want an area × kind before it is searched
--   demand_monthly_cap_pence      provider spend on demand-led searches per UK calendar month (10000 = £100)
--   demand_paying_weight          how much a paying member counts in the search order (not in the threshold)
--   demand_radius_areas           a "near me" radius adds the home area plus up to this many nearest areas inside it
--   demand_active_days            a member counts only if seen in the app within this many days
--   demand_max_areas_per_profile  the most areas one profile adds
insert into public.billing_settings (key, value) values
  ('demand_min_members', '2'::jsonb),
  ('demand_monthly_cap_pence', '10000'::jsonb),
  ('demand_paying_weight', '2'::jsonb),
  ('demand_radius_areas', '5'::jsonb),
  ('demand_active_days', '30'::jsonb),
  ('demand_max_areas_per_profile', '10'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 16: deal quality
-- =========================
-- Each marketplace deal is checked on its own Airbnb comparables before it is
-- shown; cheaper-entry deal streams; past reports cleaned up; spend safety
-- (src/lib/deal-quality). Every statement is idempotent: re-running this
-- section changes nothing. Service role only. Nothing here is in
-- ACCESS_COLUMNS (src/lib/access.ts), and must not become so.

-- ── Settings (defaults and bounds in code; a missing or bad row takes the default) ──
--   r2r_qualified_profit   the rent-to-rent bar: £ a year of profit after rent and running
--                          costs (src/lib/listing/screen.ts parseR2rBar: whole pounds from
--                          £4,000, the medium bar, to £20,000; was £8,000). Edited on /admin/deals.
insert into public.billing_settings (key, value) values
  ('r2r_qualified_profit', '6000'::jsonb)
on conflict (key) do nothing;

-- ── Auction lots (Part E; src/lib/deal-quality/auction.ts has the defaults and bounds) ──
--   auction_model   how an auction lot is priced from its guide: the usual uplift (%), the
--                   buyer's premium (£1,500 inc VAT in a traditional room; the modern method's
--                   4.5% + VAT, at least £6,000), and the bridging loan it completes on
--                   (70% LTV, 0.85% a month, 2% arrangement, £2,000 legal and valuation,
--                   12 months) before refinancing onto the member's own mortgage.
insert into public.billing_settings (key, value) values
  ('auction_model', '{"upliftPct": 15, "traditionalPremium": 1500, "modernPremiumPct": 4.5, "vatPct": 20, "modernPremiumMin": 6000, "bridgingLtvPct": 70, "bridgingMonthlyPct": 0.85, "arrangementPct": 2, "legalAndValuation": 2000, "termMonths": 12}'::jsonb)
on conflict (key) do nothing;

-- ── Past reports: the Monday backfill clean-up (Part D; src/lib/deal-quality/backfill.ts) ──
-- analyser_reports_removed: every analyser_reports row the clean-up removes,
-- archived whole before it is deleted (an exact duplicate of another row, or
-- an earlier analysis of the same file), with the row it gave way to. Nothing
-- is deleted unless its archive row was written. Service role only.
create table if not exists public.analyser_reports_removed (
  id uuid primary key,                 -- the removed row's own id
  removed_at timestamptz not null default now(),
  reason text not null,                -- exact_duplicate | reanalysed
  kept_id uuid,                        -- the row that stays in its place
  removed_by text,                     -- the admin's email, or 'internal'
  row jsonb not null                   -- the whole row as it was
);
alter table public.analyser_reports_removed enable row level security;  -- no policies: service role only
revoke all on public.analyser_reports_removed from anon, authenticated;

-- ── Spend safety (Part H) ──
--   area_rent_daily_attempts   the most PropertyData long-let lookups the market snapshot may
--                              make for its areas in a UTC day, failed attempts included
--                              (src/lib/market/area-longlet.ts). 0 stops them.
insert into public.billing_settings (key, value) values
  ('area_rent_daily_attempts', '40'::jsonb)
on conflict (key) do nothing;

-- provider_calls.cost_pence is a whole number, so a 2.5p PropertyData credit
-- logged as 3p and a 0.395p geocode as 0. raw_pence keeps the exact cost the
-- meter priced (null on rows written before this column); spend reads use
-- coalesce(raw_pence, cost_pence).
alter table public.provider_calls add column if not exists raw_pence numeric(14,4);

-- Spend reads that see every row. PostgREST returns at most 1,000 rows a
-- query, so the admin spend views and the broker's daily budget summed only
-- the first 1,000 calls of a day or week: during the 12–25 Sep valuation-rent
-- loop the budgets could not bind and the views showed a fraction of it.
-- Service role only.

-- A provider's spend since p_since by the broker's own lookups (questions not
-- named '<provider>.<unit>'), all payers or one: the broker's daily budget.
create or replace function public.provider_spend_since(p_provider text, p_since timestamptz, p_user uuid default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(coalesce(c.raw_pence, c.cost_pence)), 0)::numeric
  from public.provider_calls c
  where c.provider = p_provider
    and c.ok
    and c.at >= p_since
    and c.question not like p_provider || '.%'
    and (p_user is null or c.user_id = p_user);
$$;
revoke all on function public.provider_spend_since(text, timestamptz, uuid) from public, anon, authenticated;

-- Calls and spend per UTC day and provider since p_since: the admin dashboard.
create or replace function public.provider_spend_daily(p_since timestamptz)
returns table (day text, provider text, calls bigint, cache_hits bigint, failed bigint, pence numeric)
language sql
stable
set search_path = ''
as $$
  select to_char(c.at at time zone 'UTC', 'YYYY-MM-DD'), c.provider, count(*), count(*) filter (where c.cache_hit), count(*) filter (where not c.ok),
         coalesce(sum(coalesce(c.raw_pence, c.cost_pence)), 0)::numeric
  from public.provider_calls c
  where c.at >= p_since
  group by 1, 2;
$$;
revoke all on function public.provider_spend_daily(timestamptz) from public, anon, authenticated;

-- Paid calls per provider × unit since p_since, with what was charged and
-- what was house spend: /admin/billing.
create or replace function public.provider_spend_by_unit(p_since timestamptz)
returns table (provider text, unit text, calls bigint, raw_pence numeric, charged_pence numeric, house_pence numeric)
language sql
stable
set search_path = ''
as $$
  select c.provider, coalesce(c.unit, ''), count(*),
         coalesce(sum(coalesce(c.raw_pence, c.cost_pence)), 0)::numeric,
         coalesce(sum(c.charged_pence), 0)::numeric,
         coalesce(sum(coalesce(c.raw_pence, c.cost_pence)) filter (where not coalesce(c.charged_pence, 0) > 0), 0)::numeric
  from public.provider_calls c
  where c.at >= p_since and c.ok and not c.cache_hit
  group by 1, 2;
$$;
revoke all on function public.provider_spend_by_unit(timestamptz) from public, anon, authenticated;

-- ── The three streams and the nationwide low-entry search (Part F; src/lib/deal-quality/streams.ts) ──
--   low_entry        the low-entry stream's bar (a sale the house deal model gets into for at most
--                    maxCashIn, £), and the nationwide search's price cap (£), bedroom floor, weekly
--                    spend cap (raw pence, Monday to Sunday UK time) and areas a pass. Bounds in
--                    src/lib/deal-quality/config.ts; edited on /admin/deals.
--   deal_comps       the deal check's comparables search (Step 0, Part B): target count, radius
--   deal_confidence  steps, minimum, setting check; the confidence bands; the daily checks' limits.
--   deal_checks      Defaults and bounds in src/lib/deal-quality/config.ts.
insert into public.billing_settings (key, value) values
  ('low_entry', '{"maxCashIn": 50000, "searchMaxPrice": 135000, "minBedrooms": 1, "weeklyCapPence": 400, "areasPerPass": 8}'::jsonb),
  ('deal_comps', '{"targetCount": 12, "radiiKm": [0.8, 2, 5, 12, 25], "maxRadiusKm": 25, "minComps": 5, "setting": {"minRadiusKm": 5, "neighbourKm": 1.5, "ratio": 3, "minCluster": 3}}'::jsonb),
  ('deal_confidence', '{"highPct": 20, "mediumPct": 40, "mediumMaxComps": 7}'::jsonb),
  ('deal_checks', '{"perDay": 20, "dailyCapPence": 100, "split": {"top60": 6, "low_entry": 8, "r2r": 6}, "maxCallsPerCheck": 3, "validDays": 180, "shortlistExpiryDays": 7, "recheckCeilingPence": 1200}'::jsonb)
on conflict (key) do nothing;

-- marketplace_deals.stream: which stream a deal is in — top60 (a sale in the
-- sweep's areas), low_entry (a sale the house finance gets into for at most
-- the low-entry cash; an auction lot at its auction price) or r2r (a rental).
-- Set when the record is built (src/lib/marketplace/record.ts); the code
-- writes it through writeWithoutMissing, so a database without the column
-- still takes the row. Rows from before the column are filled in once, from
-- the house-finance deal they carry, at the seeded £50,000 bar.
alter table public.marketplace_deals add column if not exists stream text;
create index if not exists marketplace_deals_live_stream_idx on public.marketplace_deals (stream, kind) where status = 'live';
update public.marketplace_deals
set stream = case
  when kind = 'rent' then 'r2r'
  when deal->>'kind' = 'purchase' and (deal->>'cashRequired')::numeric > 0 and (deal->>'cashRequired')::numeric <= 50000 then 'low_entry'
  else 'top60'
end
where stream is null;
-- marketplace_runs.kind also takes 'low_entry_search' (src/lib/deal-quality/low-entry-run.ts).

-- ── The daily paid checks (Part B; src/lib/deal-quality/checks.ts, checks-run.ts, recheck-comps-run.ts) ──
-- No new column. A qualifying listing now waits as marketplace_deals.status
-- 'pending_check' (the shortlist: invisible to members, like pending_verify)
-- for its own Airbnb comparables check; the check it gets is kept on the
-- deal's own screening (screening.check: gross, adr, occupancy, compCount,
-- spreadPct, confidence, radiusKm, calls, pence, checkedAt, bedrooms, kind),
-- so every later re-screen builds on it while it is good, and a database
-- that has not run this section still takes every row. While a deal is
-- shortlisted, next_check_due_at is when it is dropped unchecked and
-- check_failures counts its failed searches (three retire it as
-- unverifiable). Two more retired_reason values: 'insufficient_data' (too
-- few similar homes within the widest radius: never shown, never revived)
-- and 'unchecked' (dropped from the shortlist, or retired by the admin
-- button; revived onto the shortlist like unqualified). marketplace_runs.kind
-- also takes 'deal_checks' (the nightly job) and 'deal_recheck' (the one-off
-- re-check of live deals, and the retire-unchecked button), each with who
-- ran it; today's runs are what the day's cap is read from. A check also
-- writes an analyser_reports row with source 'deal_comps', keyed on the deal
-- id (request_id) so a re-check replaces it, carrying the outward code only
-- (never the full postcode, the address or the listing): those rows feed the
-- area and district figures and stay out of the single-postcode figure
-- (src/lib/market/quality.ts).
create index if not exists marketplace_deals_shortlist_idx on public.marketplace_deals (annual_profit desc) where status = 'pending_check';

notify pgrst, 'reload schema';

-- =========================
-- Batch 17: project deals
-- =========================
-- Project (BRRR) deals: sale listings whose own words say they need work,
-- photo-checked within a daily allowance, costed as a guide, valued after
-- works against sold prices and shown only when the value added is real
-- (src/lib/project). And "Which deals do you want to see?" per profile
-- (src/lib/profile/deal-types.ts): that needs no column, it lives in the
-- profile's goals JSON (search_profiles.criteria, profiles.market_goals).
--
-- Run Batch 16's section first: this one builds on its 'pending_check'
-- status and its stream column. Every statement is idempotent: re-running
-- this section changes nothing. Service role only. Nothing here is in
-- ACCESS_COLUMNS (src/lib/access.ts), and must not become so; no new
-- column is in CARD_COLUMNS or DEAL_COLUMNS either: the app reads them with
-- their own tolerant selects, so it keeps working before this is run.

-- ── marketplace_deals ──
-- needs_work: the listing's renovation wording as our own phrase keys
--   ({flag, score, phrases}, src/lib/project/needs-work.ts); never its words.
-- project: a Project deal's card numbers (src/lib/project/headline.ts
--   ProjectCardData: works range, value after works, value added, months,
--   cash range, money left in). Numbers only: never a line, a reason or a
--   photo; those stay in project_estimates, read only after an open.
alter table public.marketplace_deals add column if not exists needs_work jsonb;
alter table public.marketplace_deals add column if not exists project jsonb;
create index if not exists marketplace_deals_live_project_idx on public.marketplace_deals ((project is not null), kind) where status = 'live';
create index if not exists marketplace_deals_project_shortlist_idx on public.marketplace_deals (first_seen_at) where status = 'pending_check' and stream = 'project';
-- marketplace_deals.stream also takes 'project': a sale held on the shortlist
-- for its comparables check and then its Project photo check. New
-- retired_reason values, none of them revived:
--   not_project           it needs work, but the value added does not pass
--   project_excluded      non-standard construction, a lease under 80 years,
--                         listed, a conservation area, structural red flags
--   project_no_evidence   fewer than 5 sold prices of its type within 3 miles
--   project_uncheckable   flagged, but its page can never be read (Zoopla)
-- marketplace_runs.kind also takes 'project_checks' (the project job, with
-- who ran it) and 'project_backfill' (the one-off pass over the live deals
-- whose words say they need work, dry runs included).

-- ── project_checks: one photo-check claim a listing a UK day ──
-- Claimed through project_claim_check (below) before the call is made, so
-- the day's allowance and spend cap hold across concurrent runs. The photo
-- URLs, the validated answer and the tokens stay here, private.
create table if not exists public.project_checks (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null,
  deal_id uuid,
  check_day date not null,                      -- the UK day it was claimed on
  status text not null default 'claimed',      -- claimed | done | refused | invalid | max_tokens | unavailable | failed
  model text,                                   -- the model that answered
  fell_back boolean not null default false,     -- a refusal re-run on the fallback
  photos jsonb,                                 -- the photo URLs sent, in order: the answer's numbers refer to these
  floorplans jsonb,
  findings jsonb,                               -- the validated answer (src/lib/project/photo-check-schema.ts)
  usage jsonb,                                  -- tokens a hop, at the model that ran it
  cost_pence numeric(12,4) not null default 0,  -- raw provider spend
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists project_checks_day_uidx on public.project_checks (canonical_url, check_day);
create index if not exists project_checks_check_day_idx on public.project_checks (check_day);
alter table public.project_checks enable row level security;  -- no policies: service role only
revoke all on public.project_checks from anon, authenticated;

-- ── project_prep: a candidate's day of free and cheaper steps ──
-- Each UK day a candidate is prepped before its photo check: its page read
-- again (the photos and floorplans the check will look at, by URL), the
-- exclusions, the free best case, the planning checks and the sold-price
-- ceiling (both through the broker, so a repeat within its cache is free).
-- Also the days a step failed: three and the listing is let go. Private:
-- the photo URLs are never shown before a deal is opened.
create table if not exists public.project_prep (
  canonical_url text primary key,
  deal_id uuid,
  price numeric,                                -- the asking price the steps were taken at
  prepped_on date,                              -- the UK day of the page read
  photos jsonb,                                 -- the page's photo URLs, in order (at most project_checks.maxPhotos)
  floorplans jsonb,
  facts jsonb,                                  -- bedrooms, bathrooms, type, floor area, tax country
  best_case jsonb,
  exclusion text,
  ceiling jsonb,                                -- {value, sales, radiusMiles, basis}; null: not enough evidence
  sold_checked_at timestamptz,
  designation jsonb,                            -- {listed, conservation} from PropertyData
  designation_checked_at timestamptz,
  outcome text,                                 -- ready | excluded | not_project | no_evidence | auction | released | retired | failed
  failed_days int not null default 0,
  last_failed_day date,
  updated_at timestamptz not null default now()
);
alter table public.project_prep enable row level security;  -- no policies: service role only
revoke all on public.project_prep from anon, authenticated;

-- ── project_estimates: the full estimate, read only after the deal is opened ──
-- The lines with their reasons and photo numbers, the works, the value and
-- the finance (src/lib/project/estimate.ts), with the photo URLs the
-- numbers refer to. The deal sheet's working section reads it for a member
-- who has opened the deal; nothing else shows it.
create table if not exists public.project_estimates (
  deal_id uuid primary key,
  canonical_url text not null,
  version int not null default 1,
  price numeric not null,
  estimate jsonb not null,
  photos jsonb not null default '[]'::jsonb,
  check_id uuid,
  estimated_at timestamptz not null default now()
);
create index if not exists project_estimates_url_idx on public.project_estimates (canonical_url);
alter table public.project_estimates enable row level security;  -- no policies: service role only
revoke all on public.project_estimates from anon, authenticated;

-- ── project_member_figures: a member's own working, every version kept ──
-- Private to the member: never shown to anyone else, never used to change
-- the house estimate. At most one locked version a member a deal.
create table if not exists public.project_member_figures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  deal_id uuid not null,
  version int not null,
  lines jsonb not null,
  figures jsonb not null,
  locked boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists project_member_figures_version_uidx on public.project_member_figures (user_id, deal_id, version);
create unique index if not exists project_member_figures_locked_uidx on public.project_member_figures (user_id, deal_id) where locked;
alter table public.project_member_figures enable row level security;  -- no policies: service role only
revoke all on public.project_member_figures from anon, authenticated;

-- ── project_claim_check: one photo check claimed against the day's allowance ──
-- Under an advisory lock, so two runs cannot both take the last slot: a
-- listing is checked at most once a UK day, at most p_max times a day in
-- all, and only while the day's spend plus this check's worst case stays
-- within p_cap_pence. The claim is written at that worst case, so a check
-- still running (or one whose run died before writing its cost) counts in
-- full against the cap; the run replaces it with the real cost. Returns
-- {ok, reason}. Service role only.
create or replace function public.project_claim_check(p_url text, p_deal uuid, p_day date, p_max int, p_cap_pence numeric, p_worst_pence numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used int;
  v_spent numeric;
begin
  perform pg_advisory_xact_lock(hashtext('project_claim_check'));
  if exists (select 1 from public.project_checks where canonical_url = p_url and check_day = p_day) then
    return jsonb_build_object('ok', false, 'reason', 'already_today');
  end if;
  select count(*), coalesce(sum(cost_pence), 0) into v_used, v_spent from public.project_checks where check_day = p_day;
  if v_used >= greatest(p_max, 0) then
    return jsonb_build_object('ok', false, 'reason', 'allowance');
  end if;
  if v_spent + greatest(p_worst_pence, 0) > greatest(p_cap_pence, 0) then
    return jsonb_build_object('ok', false, 'reason', 'cap');
  end if;
  insert into public.project_checks (canonical_url, deal_id, check_day, status, cost_pence) values (p_url, p_deal, p_day, 'claimed', greatest(p_worst_pence, 0));
  return jsonb_build_object('ok', true, 'reason', null);
end;
$$;
revoke all on function public.project_claim_check(text, uuid, date, int, numeric, numeric) from public, anon, authenticated;
grant execute on function public.project_claim_check(text, uuid, date, int, numeric, numeric) to service_role;

-- ── Settings (defaults and bounds in code, src/lib/project/config.ts and src/lib/today/mix.ts; a missing or bad row takes the default) ──
--   project_rates        the works lines' rates (£, VAT included), the kitchen size factors, contingency %
--   project_quantities   rooms, carpets, windows, doors and damp walls from the bedrooms; the rewire's baseline
--   project_value        value after works: 2× visible, 1× hidden and can't-tell works; the test: value added
--                        (value − price − works at the high end) of at least £15,000 and 10% of the value;
--                        the refinance at 75% of the value
--   project_ceiling      sold prices: 0.5 → 3 miles until 10 sales (at least 5), weights 1 / 0.75 / 0.5 / 0.25,
--                        the weighted 75th percentile, the last 24 months
--   project_costs        buying costs (£2,500; £3,500 with a bridge), months held, the level thresholds
--                        (full above £15k of works, light under £5k), the bridge's terms
--   project_checks       the job's switch (off), sold-price lookups a day, days before giving up, photos sent,
--                        reuse window, the planning checks, the model's effort
--   today_mix            Today's mix of deal types: 2 Short-let / 2 Rent-to-rent / 1 BRRR, 3 / 2 for two types,
--                        shifted over 14 days' Keeps at 3 Keeps a slot, at least 1 of each chosen type
-- The photo checks' allowance (5 a UK day) and Batch 17's spend line (250p a
-- UK day: photo checks, sold prices and planning checks together) sit in
-- Batch 16's deal_checks row as projectPhotoChecks / projectCapPence, beside
-- that cap on /admin/deals; read with those defaults while the row lacks them.
insert into public.billing_settings (key, value) values
  ('project_rates', '{"waste":300,"rewire":4500,"boiler":2500,"radiator":300,"waterTank":2500,"pipework":500,"bathroom":2000,"plaster":500,"skirting":650,"paint":350,"kitchen":4000,"kitchenFactors":{"small":1,"big":1.5,"extra_big":2},"carpet":250,"roof":3000,"window":400,"outsideDoor":600,"internalDoor":300,"damp":350,"contingencyPct":10}'::jsonb),
  ('project_quantities', '{"roomsPlusBedrooms":2,"carpetsPlusBedrooms":1,"windowsPlusRooms":1,"outsideDoorsHouse":2,"outsideDoorsFlat":1,"dampWallsHouse":4,"dampWallsFlat":2,"defaultBathrooms":1,"rewireBaselineRooms":5,"rewireBaselineSqft":900}'::jsonb),
  ('project_value', '{"visibleMultiplier":2,"hiddenMultiplier":1,"minUplift":15000,"minUpliftPctOfValue":10,"refinancePct":75}'::jsonb),
  ('project_ceiling', '{"radiiMiles":[0.5,1,2,3],"weights":[1,0.75,0.5,0.25],"months":24,"targetSales":10,"minSales":5,"quantile":0.75}'::jsonb),
  ('project_costs', '{"buyingCosts":2500,"buyingCostsBridging":3500,"monthsLight":2,"monthsFull":4,"monthsFullLarge":6,"largeFromBedrooms":4,"bridgeWorksPct":0,"arrangementFee":true,"legalAndValuation":false,"fullAboveWorks":15000,"lightBelowWorks":5000}'::jsonb),
  ('project_checks', '{"enabled":false,"soldLookupsPerDay":15,"giveUpDays":3,"maxPhotos":10,"reuseDays":60,"planningChecks":true,"effort":"medium"}'::jsonb),
  ('today_mix', '{"all":{"buy_str":2,"brrr":1,"r2r":2},"two":[3,2],"windowDays":14,"keepsPerSlot":3,"floor":1}'::jsonb)
on conflict (key) do nothing;

-- =========================
-- Batch 18: feedback and announcements
-- =========================
-- Members tell us about bugs and ideas from inside the app, and we tell them
-- what became of them (src/lib/feedback): a report per send, a status email
-- per report and status, and announcements shown as one banner at the top of
-- the members' pages. Every table here is service role only (RLS on, no
-- policies, nothing granted to anon or authenticated): a member sends and
-- reads their own reports only through the app's routes, which take the
-- member from the session, so the daily limit and the email to the admin
-- address cannot be skipped by writing to a table directly. Screenshots live
-- in the private storage bucket 'feedback-screenshots' (below), shown to
-- admins only through links that expire after five minutes, and deleted by
-- /api/internal/feedback-retention after
-- billing_settings.feedback_screenshot_retention_days. Nothing is charged.
-- Nothing here is in ACCESS_COLUMNS (src/lib/access.ts), and must not become
-- so. Everything is additive: this section can be run before the code is
-- merged, and until it is run the form says it cannot send, the banner shows
-- nothing and the admin pages say to run it.

-- ── feedback_reports: one row per bug report or idea (src/lib/feedback/server.ts) ──
--   ref              the short number people use ("#123")
--   kind             bug | feature
--   body             the member's text, plain (src/lib/feedback/rules.ts cleanText)
--   status           new | planned | done (reads Fixed on a bug, Built on an
--                    idea) | not_doing
--   duplicate_of     the original, once admin marks this a duplicate: it then
--                    follows the original's status and message, and is left
--                    out of the totals. Never itself (checked) and never a
--                    chain (the app points duplicates at the original)
--   admin_note       private to admins; never shown to the member
--   status_message   the one line sent with the latest status email, also
--                    shown on "Your feedback"
--   context          what the form captured, for admins only: the page,
--                    device, screen, app version, plan, team, active profile
--   client_key       the form's own id for this send: a retry comes back as
--                    the same report (feedback_submit)
--   admin_emailed_at when the email to the admin address went; null until it
--                    has, and the daily retention run retries it
create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  ref bigint generated always as identity unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  body text not null,
  status text not null default 'new',
  duplicate_of uuid references public.feedback_reports(id) on delete set null,
  admin_note text,
  status_message text,
  status_changed_at timestamptz,
  context jsonb not null default '{}'::jsonb,
  client_key text not null,
  screenshot_count int not null default 0,
  admin_emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists feedback_reports_client_key_uidx on public.feedback_reports (user_id, client_key);
create index if not exists feedback_reports_created_idx on public.feedback_reports (created_at desc);
create index if not exists feedback_reports_user_idx on public.feedback_reports (user_id, created_at desc);
create index if not exists feedback_reports_duplicate_idx on public.feedback_reports (duplicate_of) where duplicate_of is not null;
create index if not exists feedback_reports_unemailed_idx on public.feedback_reports (created_at) where admin_emailed_at is null;
do $$
begin
  alter table public.feedback_reports drop constraint if exists feedback_reports_kind_check;
  alter table public.feedback_reports add constraint feedback_reports_kind_check check (kind in ('bug', 'feature'));
  alter table public.feedback_reports drop constraint if exists feedback_reports_status_check;
  alter table public.feedback_reports add constraint feedback_reports_status_check check (status in ('new', 'planned', 'done', 'not_doing'));
  alter table public.feedback_reports drop constraint if exists feedback_reports_body_check;
  alter table public.feedback_reports add constraint feedback_reports_body_check check (char_length(body) between 1 and 2000);
  alter table public.feedback_reports drop constraint if exists feedback_reports_message_check;
  alter table public.feedback_reports add constraint feedback_reports_message_check check (status_message is null or char_length(status_message) <= 200);
  alter table public.feedback_reports drop constraint if exists feedback_reports_not_own_duplicate;
  alter table public.feedback_reports add constraint feedback_reports_not_own_duplicate check (duplicate_of is null or duplicate_of <> id);
end $$;
alter table public.feedback_reports enable row level security;  -- no policies: service role only
revoke all on public.feedback_reports from anon, authenticated;

-- ── feedback_screenshots: the images sent with a report (src/lib/feedback/storage.ts) ──
-- One row per image in the private bucket, written before the upload. If the
-- upload fails, the image is removed (in case it landed) before the row, so
-- no stored image is ever without its row.
-- report_id is set to null when the report goes (the account was deleted),
-- so the retention run still finds the image and removes it. deleted_at: the
-- image has been removed from the bucket after the retention period; the row
-- stays, so admin can say so.
create table if not exists public.feedback_screenshots (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.feedback_reports(id) on delete set null,
  path text not null unique,
  content_type text not null,
  bytes int not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists feedback_screenshots_report_idx on public.feedback_screenshots (report_id);
create index if not exists feedback_screenshots_live_idx on public.feedback_screenshots (created_at) where deleted_at is null;
alter table public.feedback_screenshots enable row level security;  -- no policies: service role only
revoke all on public.feedback_screenshots from anon, authenticated;

-- ── feedback_status_emails: one per report and status (src/lib/feedback/server.ts) ──
-- When admin moves a report to planned, done or not_doing, its reporter and
-- the reporters of its duplicates are emailed: one email per member, keyed on
-- that member's own report. The unique (report_id, status) is the rule "each
-- status at most once": a report that goes Planned → New → Planned is told
-- Planned once. state: claimed → sent | failed | skipped (no email address).
-- The claim is the write (feedback_status_claim): a failed row, or one left
-- claimed after its send died, can be taken again; a sent one never.
create table if not exists public.feedback_status_emails (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.feedback_reports(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null,
  message text,
  state text not null default 'claimed',
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
create unique index if not exists feedback_status_emails_uidx on public.feedback_status_emails (report_id, status);
create index if not exists feedback_status_emails_user_idx on public.feedback_status_emails (user_id);
do $$
begin
  alter table public.feedback_status_emails drop constraint if exists feedback_status_emails_status_check;
  alter table public.feedback_status_emails add constraint feedback_status_emails_status_check check (status in ('planned', 'done', 'not_doing'));
  alter table public.feedback_status_emails drop constraint if exists feedback_status_emails_state_check;
  alter table public.feedback_status_emails add constraint feedback_status_emails_state_check check (state in ('claimed', 'sent', 'failed', 'skipped'));
end $$;
alter table public.feedback_status_emails enable row level security;  -- no policies: service role only
revoke all on public.feedback_status_emails from anon, authenticated;

-- ── Submit: the retry check and the daily limit are one step under the member's row lock ──
-- p: {user, kind, body, context, client_key, limit}. Returns {outcome, id,
-- ref, used, limit}. outcome: 'created'; 'duplicate' when this client_key has
-- been sent already (the same report comes back and nothing is written); or
-- 'limit' when the member has sent p.limit reports this UK day. The limit is
-- billing_settings.feedback_daily_limit, parsed and clamped in
-- src/lib/feedback/rules.ts and passed in, so a badly saved setting can
-- never make every send fail. Locking the member's profiles row (as
-- create_search_profile does) means two sends at once cannot both slip under
-- the limit, and a double tap cannot make two reports.
create or replace function public.feedback_submit(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_key text := nullif(btrim(coalesce(p->>'client_key', '')), '');
  v_limit integer := greatest(1, coalesce((p->>'limit')::integer, 10));
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London';
  v_used integer;
  v_id uuid;
  v_ref bigint;
begin
  if v_user is null or v_key is null then raise exception 'feedback_submit_bad_input'; end if;
  perform 1 from public.profiles where id = v_user for no key update;
  select r.id, r.ref into v_id, v_ref from public.feedback_reports r where r.user_id = v_user and r.client_key = v_key;
  if v_id is not null then
    return jsonb_build_object('outcome', 'duplicate', 'id', v_id, 'ref', v_ref);
  end if;
  select count(*) into v_used from public.feedback_reports r where r.user_id = v_user and r.created_at >= v_day_start;
  if v_used >= v_limit then
    return jsonb_build_object('outcome', 'limit', 'used', v_used, 'limit', v_limit);
  end if;
  insert into public.feedback_reports (user_id, kind, body, context, client_key)
  values (v_user, p->>'kind', p->>'body', coalesce(p->'context', '{}'::jsonb), v_key)
  returning id, ref into v_id, v_ref;
  return jsonb_build_object('outcome', 'created', 'id', v_id, 'ref', v_ref, 'used', v_used + 1, 'limit', v_limit);
end;
$$;
revoke all on function public.feedback_submit(jsonb) from public, anon, authenticated;
grant execute on function public.feedback_submit(jsonb) to service_role;

-- ── Claim a status email: whoever makes (or retakes) the row sends it ──
-- p: {report, user, status, message, stale_seconds}. Returns true when the
-- caller should send: a new row, a failed one, or one left 'claimed' longer
-- than stale_seconds (the send died). A sent or skipped row is never taken
-- again, so a double press, a retry or two admins at once send one email.
create or replace function public.feedback_status_claim(p jsonb)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_report uuid := (p->>'report')::uuid;
  v_status text := p->>'status';
  v_stale integer := greatest(60, coalesce((p->>'stale_seconds')::integer, 600));
  v_id uuid;
begin
  insert into public.feedback_status_emails (report_id, user_id, status, message)
  values (v_report, (p->>'user')::uuid, v_status, nullif(p->>'message', ''))
  on conflict (report_id, status) do nothing
  returning id into v_id;
  if v_id is not null then return true; end if;
  update public.feedback_status_emails e
     set state = 'claimed', claimed_at = now(), message = nullif(p->>'message', ''), error = null
   where e.report_id = v_report
     and e.status = v_status
     and (e.state = 'failed' or (e.state = 'claimed' and e.claimed_at < now() - make_interval(secs => v_stale)))
  returning e.id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.feedback_status_claim(jsonb) from public, anon, authenticated;
grant execute on function public.feedback_status_claim(jsonb) to service_role;

-- ── announcements: what's new, shown to members as one banner (src/lib/feedback/announcements.ts) ──
--   kind            feature ("New feature") | fix ("Bug fix")
--   link_path       an optional page on this site for "Take a look": a path,
--                   never another site (src/lib/feedback/rules.ts memberPath;
--                   the check below is the same rule's floor)
--   report_ids      the reports it answers, for admin
--   published_at    when it went live. A member sees it only if they joined
--                   before this, and only for
--                   billing_settings.announcement_max_age_days
--   unpublished_at  taken down: nobody sees it from then on (published again,
--                   this is cleared and published_at restarts)
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text not null,
  link_path text,
  report_ids uuid[] not null default '{}',
  published_at timestamptz,
  unpublished_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists announcements_live_idx on public.announcements (published_at desc) where published_at is not null and unpublished_at is null;
do $$
begin
  alter table public.announcements drop constraint if exists announcements_kind_check;
  alter table public.announcements add constraint announcements_kind_check check (kind in ('feature', 'fix'));
  alter table public.announcements drop constraint if exists announcements_title_check;
  alter table public.announcements add constraint announcements_title_check check (char_length(title) between 1 and 80);
  alter table public.announcements drop constraint if exists announcements_body_check;
  alter table public.announcements add constraint announcements_body_check check (char_length(body) between 1 and 300);
  alter table public.announcements drop constraint if exists announcements_link_check;
  alter table public.announcements add constraint announcements_link_check check (
    link_path is null
    or (char_length(link_path) <= 300 and link_path ~ '^/[!-~]*$' and link_path !~ '^//' and strpos(link_path, E'\\') = 0)
  );
end $$;
alter table public.announcements enable row level security;  -- no policies: service role only
revoke all on public.announcements from anon, authenticated;

-- ── announcement_views: what each member was shown and did (src/lib/feedback/announcements-server.ts) ──
-- shown_at when the banner first had it on their screen (never from a
-- prefetch: only the browser reports it). dismissed_at or clicked_at ("Take
-- a look") and it is never shown to them again. The admin page's views,
-- dismissals and click-through come from here.
create table if not exists public.announcement_views (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  shown_at timestamptz,
  dismissed_at timestamptz,
  clicked_at timestamptz,
  primary key (announcement_id, user_id)
);
-- A Dismiss also covers the ones folded under "N more", which were never
-- seen, so a row can exist without shown_at. (A table made by an earlier
-- draft of this section had it not null with a default.)
alter table public.announcement_views alter column shown_at drop not null;
alter table public.announcement_views alter column shown_at drop default;
create index if not exists announcement_views_user_idx on public.announcement_views (user_id);
alter table public.announcement_views enable row level security;  -- no policies: service role only
revoke all on public.announcement_views from anon, authenticated;

-- The admin list's figures, per announcement: members shown it, dismissed
-- it and tapped "Take a look" (click-through is clicked / shown). Counted in
-- the database rather than by reading every view. p is unused, kept for
-- the one-jsonb rule.
create or replace function public.announcement_stats(p jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', v.announcement_id, 'shown', v.shown, 'dismissed', v.dismissed, 'clicked', v.clicked)), '[]'::jsonb)
  from (
    select announcement_id, count(shown_at) as shown, count(dismissed_at) as dismissed, count(clicked_at) as clicked
    from public.announcement_views
    group by announcement_id
  ) v;
$$;
revoke all on function public.announcement_stats(jsonb) from public, anon, authenticated;
grant execute on function public.announcement_stats(jsonb) to service_role;

-- ── Settings (src/lib/feedback/config.ts; edited on /admin/feedback and /admin/announcements) ──
--   feedback_daily_limit               reports one member may send in a UK day
--   feedback_max_screenshots           screenshots on one report (0 turns them off)
--   feedback_screenshot_max_mb         the biggest image a member may pick, before
--                                      the browser shrinks it
--   feedback_screenshot_retention_days days a screenshot is kept (never below 7)
--   feedback_admin_email               where every new report is emailed
--   announcement_max_age_days          announcements older than this are not shown
insert into public.billing_settings (key, value) values
  ('feedback_daily_limit', '10'::jsonb),
  ('feedback_max_screenshots', '3'::jsonb),
  ('feedback_screenshot_max_mb', '5'::jsonb),
  ('feedback_screenshot_retention_days', '90'::jsonb),
  ('feedback_admin_email', '"zac@stayful.co.uk"'::jsonb),
  ('announcement_max_age_days', '30'::jsonb)
on conflict (key) do nothing;

-- ── The private bucket for screenshots (src/lib/feedback/storage.ts) ──
-- Private, and there is no storage.objects policy for it, so only the service
-- role can read or write it; an admin sees an image through a signed link
-- that expires after five minutes. file_size_limit is a ceiling only (the
-- most feedback_screenshot_max_mb can be set to); the app checks the real
-- limit first. Created here rather than by hand so it can never start out
-- public, and "on conflict" puts it back to private if it was ever switched.
-- If this storage schema is too old for these columns, it raises a notice
-- instead of stopping the run: create the bucket by hand then (README,
-- "Switch on feedback").
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('feedback-screenshots', 'feedback-screenshots', false, 20971520, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise notice 'The feedback-screenshots bucket was not created (%): create it by hand, private.', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- =========================
-- Batch 19: consent and attribution
-- =========================
-- Cookie consent, the Meta pixel and Conversions API, and where members came
-- from (src/lib/tracking, src/lib/meta). Every table here is service role only
-- (RLS on, no policies, nothing granted to anon or authenticated): the app's
-- routes take the member from the session. Nothing is charged. Nothing here is
-- in ACCESS_COLUMNS (src/lib/access.ts), and must not become so, and nothing
-- is added to profiles. Everything is additive: this section can be run
-- before the code is merged, and until it is run the banner still works (the
-- choice is kept on the device), nothing is recorded or sent to Meta, and
-- /admin/signups says to run it.

-- ── consent_records: proof of every cookie choice (src/lib/tracking/consent-server.ts) ──
--   visitor_id  the random device id kept in the sf_consent cookie
--   user_id     the member: signed in when they chose, or attached when they
--               signed up or in on that device. Set to null if the account is
--               deleted, so the proof stays (it then holds no personal data)
--   choice      accept | reject
--   source      banner | signup | settings (the Cookie settings link)
--   version     the wording shown (cookie-v1, …). New wording means a new
--               version, so every choice stays tied to what the person saw
create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  visitor_id uuid not null,
  user_id uuid references public.profiles(id) on delete set null,
  choice text not null,
  source text not null,
  version text not null
);
create index if not exists consent_records_visitor_idx on public.consent_records (visitor_id, created_at desc);
create index if not exists consent_records_user_idx on public.consent_records (user_id, created_at desc) where user_id is not null;
do $$
begin
  alter table public.consent_records drop constraint if exists consent_records_choice_check;
  alter table public.consent_records add constraint consent_records_choice_check check (choice in ('accept', 'reject'));
  alter table public.consent_records drop constraint if exists consent_records_source_check;
  alter table public.consent_records add constraint consent_records_source_check check (source in ('banner', 'signup', 'settings'));
  alter table public.consent_records drop constraint if exists consent_records_version_check;
  alter table public.consent_records add constraint consent_records_version_check check (char_length(version) between 1 and 40);
end $$;
alter table public.consent_records enable row level security;  -- no policies: service role only
revoke all on public.consent_records from anon, authenticated;

-- ── member_consent: each member's latest choice, which the server obeys ──
--   choice/chosen_at  the newest choice wins, whichever device it came from
--                     (member_consent_set below)
--   record_id         the consent_records row it came from
--   ctx_*             the member's last-seen browser details (IP, user agent,
--                     _fbp, _fbc), kept only while the choice is Accept and
--                     cleared the moment it is Reject. Used only for a
--                     Conversions API event that happens with no browser in
--                     the request (a Stripe payment); refreshed at most hourly
create table if not exists public.member_consent (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  choice text not null,
  chosen_at timestamptz not null,
  source text not null,
  version text not null,
  record_id uuid references public.consent_records(id) on delete set null,
  ctx_ip text,
  ctx_ua text,
  ctx_fbp text,
  ctx_fbc text,
  ctx_at timestamptz,
  updated_at timestamptz not null default now()
);
do $$
begin
  alter table public.member_consent drop constraint if exists member_consent_choice_check;
  alter table public.member_consent add constraint member_consent_choice_check check (choice in ('accept', 'reject'));
end $$;
alter table public.member_consent enable row level security;  -- no policies: service role only
revoke all on public.member_consent from anon, authenticated;

-- ── member_consent_set: the newest choice wins, in one statement ──
-- p: {user, choice, chosen_at, source, version, record_id}. Returns the row
-- the member now has: {choice, chosen_at, applied}. applied is false when a
-- newer choice was already saved (another device), which then stands. A
-- Reject clears the stored browser details in the same write.
create or replace function public.member_consent_set(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_choice text := p->>'choice';
  -- Never later than now: a device with a fast clock must not freeze the choice.
  v_at timestamptz := least(coalesce(nullif(p->>'chosen_at', '')::timestamptz, now()), now());
  v_applied boolean := false;
  v_row public.member_consent%rowtype;
begin
  if v_user is null or v_choice not in ('accept', 'reject') then
    return jsonb_build_object('applied', false, 'choice', null, 'chosen_at', null);
  end if;
  insert into public.member_consent as mc (user_id, choice, chosen_at, source, version, record_id, updated_at)
  values (v_user, v_choice, v_at, coalesce(p->>'source', 'banner'), coalesce(p->>'version', 'cookie-v1'), nullif(p->>'record_id', '')::uuid, now())
  on conflict (user_id) do update set
    choice = excluded.choice,
    chosen_at = excluded.chosen_at,
    source = excluded.source,
    version = excluded.version,
    record_id = excluded.record_id,
    ctx_ip = case when excluded.choice = 'reject' then null else mc.ctx_ip end,
    ctx_ua = case when excluded.choice = 'reject' then null else mc.ctx_ua end,
    ctx_fbp = case when excluded.choice = 'reject' then null else mc.ctx_fbp end,
    ctx_fbc = case when excluded.choice = 'reject' then null else mc.ctx_fbc end,
    ctx_at = case when excluded.choice = 'reject' then null else mc.ctx_at end,
    updated_at = now()
  where mc.chosen_at <= excluded.chosen_at
  returning true into v_applied;
  select * into v_row from public.member_consent where user_id = v_user;
  return jsonb_build_object('applied', coalesce(v_applied, false), 'choice', v_row.choice, 'chosen_at', v_row.chosen_at);
end $$;
revoke all on function public.member_consent_set(jsonb) from public, anon, authenticated;
grant execute on function public.member_consent_set(jsonb) to service_role;

-- ── member_attribution: where a member came from, first touch, once ──
-- Written once when a website account is created (src/lib/tracking/signup-server.ts):
-- at the moment the email sign-up form is submitted (so confirming on another
-- device cannot lose it), or on the Google callback. Never overwritten
-- (insert … on conflict do nothing). Existing members have no row and are
-- "direct / unknown"; there is no backfill. Lead-form accounts have no row
-- either: the report reads profiles.lead_source for them.
--   env           production | preview | development: previews write to this
--                 database too, and only production rows are reported
--   signup_method email | google
--   team_invite   the sign-up was to join someone's team (left out of the report)
--   fbclid(_at)   the Meta click id and when it was seen, kept to build fbc
--                 for the member's Conversions API events
--   landing_path  the first page, without its query; ids and tokens replaced
--   captured_via  form | cookie | redirect (Google's return) | none
create table if not exists public.member_attribution (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  env text not null default 'production',
  signup_method text not null,
  team_invite boolean not null default false,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  fbclid_at timestamptz,
  landing_path text,
  referrer_domain text,
  captured_via text not null default 'none'
);
create index if not exists member_attribution_created_idx on public.member_attribution (created_at);
do $$
begin
  alter table public.member_attribution drop constraint if exists member_attribution_method_check;
  alter table public.member_attribution add constraint member_attribution_method_check check (signup_method in ('email', 'google'));
  alter table public.member_attribution drop constraint if exists member_attribution_via_check;
  alter table public.member_attribution add constraint member_attribution_via_check check (captured_via in ('form', 'cookie', 'redirect', 'none'));
  alter table public.member_attribution drop constraint if exists member_attribution_lengths_check;
  alter table public.member_attribution add constraint member_attribution_lengths_check check (
    coalesce(char_length(utm_source), 0) <= 200 and coalesce(char_length(utm_medium), 0) <= 200
    and coalesce(char_length(utm_campaign), 0) <= 200 and coalesce(char_length(utm_content), 0) <= 200
    and coalesce(char_length(utm_term), 0) <= 200 and coalesce(char_length(fbclid), 0) <= 500
    and coalesce(char_length(landing_path), 0) <= 200 and coalesce(char_length(referrer_domain), 0) <= 200
  );
end $$;
alter table public.member_attribution enable row level security;  -- no policies: service role only
revoke all on public.member_attribution from anon, authenticated;

-- ── meta_conversions: every conversion we know of, sent to Meta or not (src/lib/meta/conversions.ts) ──
-- One row per conversion, keyed on dedupe_key (the only unique key), inserted
-- before anything is sent: only the caller whose insert went in may send, so
-- a Stripe redelivery, the webhook and the one-click route, or a retry can
-- never send twice. The row is written even without consent, so "once per
-- account" holds if the member accepts later; it is sent only if they accept
-- within the release window (src/lib/tracking/config.ts).
--   dedupe_key          CompleteRegistration:<user>, ProfileComplete:<user>,
--                       FirstReport:<user>, Subscribe:<user>, Purchase:<payment intent>
--                       (Batch 29: Purchase:<user>, the starter pack only, once
--                       per member), RepeatPurchase:<user> (Batch 29: a pack
--                       buyer's first payment after the pack, once per member)
--   event_id            what Meta de-duplicates the browser and server copies on
--                       (a random id, the Stripe invoice or the PaymentIntent)
--   env                 production | preview | development: only production
--                       rows are ever sent or fired
--   consented           the member's choice was Accept when it was recorded or released
--   server_status       held (no consent yet) | pending | sending | sent |
--                       failed | skipped; server_note says why (never the token)
--   test_event          sent with META_TEST_EVENT_CODE (Test events only)
--   browser_claimed_at  the browser fired it (claimed once, atomically)
create table if not exists public.meta_conversions (
  dedupe_key text primary key,
  event_id text not null,
  event_name text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  env text not null default 'production',
  value_pence integer,
  currency text,
  consented boolean not null default false,
  released_at timestamptz,
  server_status text not null default 'pending',
  server_note text,
  server_http integer,
  server_sent_at timestamptz,
  test_event boolean not null default false,
  browser_claimed_at timestamptz
);
create index if not exists meta_conversions_user_idx on public.meta_conversions (user_id, created_at desc);
create index if not exists meta_conversions_created_idx on public.meta_conversions (created_at desc);
create index if not exists meta_conversions_event_idx on public.meta_conversions (event_id);
do $$
begin
  alter table public.meta_conversions drop constraint if exists meta_conversions_event_check;
  -- Batch 29 added RepeatPurchase. Batch 22f's mc_signup / mc_pack_paid / funnel_live are
  -- deliberately NOT here yet (left as they were; see docs/batch-29.md, question 15).
  alter table public.meta_conversions add constraint meta_conversions_event_check check (event_name in ('CompleteRegistration', 'ProfileComplete', 'FirstReport', 'Subscribe', 'Purchase', 'RepeatPurchase'));
  alter table public.meta_conversions drop constraint if exists meta_conversions_status_check;
  alter table public.meta_conversions add constraint meta_conversions_status_check check (server_status in ('held', 'pending', 'sending', 'sent', 'failed', 'skipped'));
  alter table public.meta_conversions drop constraint if exists meta_conversions_note_check;
  alter table public.meta_conversions add constraint meta_conversions_note_check check (server_note is null or char_length(server_note) <= 300);
end $$;
alter table public.meta_conversions enable row level security;  -- no policies: service role only
revoke all on public.meta_conversions from anon, authenticated;

-- ── When tracking started ──
-- Set once, the first time this section runs, and never changed: the sign-up
-- journey events (CompleteRegistration, ProfileComplete, FirstReport) count
-- only for accounts created after it, and Subscribe only for subscriptions
-- started after it, so existing members' renewals and old quizzes never fire.
-- A fact rather than a setting: not on /admin/billing.
insert into public.billing_settings (key, value) values ('meta_tracking_since', to_jsonb(now()))
on conflict (key) do nothing;

-- ── signup_source_facts: what /admin/signups adds up (src/lib/tracking/report-server.ts) ──
-- p: {from, to} (timestamps; either may be null). One entry per account
-- created in the range that has a member_attribution row (a website sign-up)
-- or came from a lead form (profiles.lead_source): its attribution, whether it
-- has signed in, when it finished the profile, its first report (report_run
-- or full_analysis) and its first real payment (a card top-up or a paid
-- subscription invoice, annual included, less refunds and disputes), and
-- whether it redeemed a referral code (profiles.referred_by_code; Review R3,
-- R3-96: the code itself never leaves the table). Weekly active is not here:
-- the page reuses Batch 9's activity_weekly_facts.
-- security definer: it reads auth.users.last_sign_in_at.
create or replace function public.signup_source_facts(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(nullif(p->>'from', '')::timestamptz, '-infinity'::timestamptz);
  v_to timestamptz := coalesce(nullif(p->>'to', '')::timestamptz, 'infinity'::timestamptz);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'u', pr.id,
      'email', pr.email,
      'created', pr.created_at,
      'signed_in', au.last_sign_in_at is not null,
      'lead', case when pr.lead_source is not null then coalesce(pr.lead_source->>'source', 'lead_form') end,
      'a', case when ma.user_id is null then null else jsonb_build_object(
        'src', ma.utm_source, 'med', ma.utm_medium, 'cmp', ma.utm_campaign, 'cnt', ma.utm_content,
        'fb', ma.fbclid is not null, 'ref', ma.referrer_domain, 'env', ma.env,
        'method', ma.signup_method, 'team', ma.team_invite) end,
      'profile_done', pq.completed_at,
      'first_report', fr.at,
      'first_paid', fp.at,
      'referred', pr.referred_by_code is not null
    ) order by pr.created_at)
    from public.profiles pr
    left join auth.users au on au.id = pr.id
    left join public.member_attribution ma on ma.user_id = pr.id
    left join public.profile_quiz pq on pq.user_id = pr.id
    left join lateral (
      select min(e.occurred_at) as at from public.activity_events e
      where e.user_id = pr.id and e.kind in ('report_run', 'full_analysis')
    ) fr on true
    left join lateral (
      select min(g.created_at) as at from public.credit_grants g
      where g.user_id = pr.id
        and (g.kind = 'topup' or (g.kind = 'plan' and (g.source_ref like 'inv:%' or g.source_ref like 'annual:%')))
        and not exists (
          select 1 from public.credit_grants r
          where r.user_id = g.user_id and r.kind = 'adjustment'
            and r.source_ref in (g.source_ref || ':refunded', g.source_ref || ':disputed')
        )
    ) fp on true
    where pr.created_at >= v_from and pr.created_at < v_to
      and (ma.user_id is not null or pr.lead_source is not null)
  ), '[]'::jsonb);
end $$;
revoke all on function public.signup_source_facts(jsonb) from public, anon, authenticated;
grant execute on function public.signup_source_facts(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 20: starter pack, inactivity and Monday sync
-- =========================
-- The £10 starter pack (src/lib/starter-pack), the payments behind "Total
-- paid" (src/lib/payments), the inactivity rules (src/lib/inactivity) and the
-- Monday sales-funnel sync (src/lib/crm/monday-funnel). Every new table is
-- service role only. Nothing is added to ACCESS_COLUMNS: the code reads each
-- new column in a query of its own, so until this section is run the pack is
-- never offered, nobody is paused and nothing is written to Monday.

-- ── profiles: Batch 20 columns ──
alter table public.profiles add column if not exists starter_pack_bought_at timestamptz;          -- the pack was granted
alter table public.profiles add column if not exists starter_pack_snoozed_until timestamptz;      -- "Not now" on the Today card
alter table public.profiles add column if not exists reengage_since timestamptz;                  -- inactive_reengage_days without a qualifying action
alter table public.profiles add column if not exists picks_paused_inactive_at timestamptz;        -- picks_pause_inactive_days: daily picks paused
alter table public.profiles add column if not exists picks_paused_inactive_email_at timestamptz;  -- the "while you're away" letter for this pause

-- ── Settings (inserted only when missing, so an edit on /admin/lifecycle survives a re-run) ──
-- starter_pack_from and inactivity_from start empty: the pack and the
-- inactivity rules are off until a date is set (src/lib/lifecycle/settings.ts).
insert into public.billing_settings (key, value) values
  ('starter_pack_from', 'null'),
  ('starter_pack_price_pence', '1000'),
  ('starter_pack_credit_pence', '3000'),
  ('starter_pack_snooze_days', '7'),
  ('low_credit_pence', '500'),
  ('inactive_reengage_days', '14'),
  ('picks_pause_inactive_days', '25'),
  ('inactivity_from', 'null')
on conflict (key) do nothing;

-- ── starter_pack_purchases: one starter pack per person, ever ──
-- One row per PaymentIntent that tried to buy a pack. A pack is claimed
-- (reserved) after the card is authorised and before it is captured, so a
-- repeat is cancelled without ever being charged; captured, it is granted.
-- Only reserved and granted rows hold the identity (the partial unique
-- indexes), so a blocked or failed attempt never stops a later one. The rows
-- are kept when an account is deleted: "once per person, ever".
--   status       reserved | granted | blocked | failed
--   blocked_by   account | email | mobile | card | race (why it was refused)
--   email_key    profiles.email, trimmed and lower-cased (emailKey)
--   mobile_key   normaliseMobile(profiles.mobile), whether or not the account holds profiles.mobile_key
create table if not exists public.starter_pack_purchases (
  payment_intent_id text primary key,
  user_id uuid references public.profiles(id) on delete set null,
  status text not null default 'reserved',
  blocked_by text,
  email_key text,
  mobile_key text,
  card_fingerprint text,
  price_pence integer not null,
  credit_pence integer not null,
  amount_paid_pence integer,
  currency text,
  consent_at timestamptz,
  consent_version text,
  refunded_pence integer not null default 0,
  created_at timestamptz not null default now(),
  granted_at timestamptz,
  -- Batch 21 (B44): when the card hold was captured (the money taken), stamped
  -- by src/lib/starter-pack/grant-server.ts from Batch 21c. The 8-day sweep in
  -- starter_pack_claim leaves a captured row alone, so a pack that was paid
  -- for but not yet granted can never be re-sold or turned into a plain top-up.
  captured_at timestamptz
);
alter table public.starter_pack_purchases add column if not exists captured_at timestamptz;
create unique index if not exists starter_pack_user_uidx on public.starter_pack_purchases (user_id) where status in ('reserved', 'granted') and user_id is not null;
create unique index if not exists starter_pack_email_uidx on public.starter_pack_purchases (email_key) where status in ('reserved', 'granted') and email_key is not null;
create unique index if not exists starter_pack_mobile_uidx on public.starter_pack_purchases (mobile_key) where status in ('reserved', 'granted') and mobile_key is not null;
create unique index if not exists starter_pack_card_uidx on public.starter_pack_purchases (card_fingerprint) where status in ('reserved', 'granted') and card_fingerprint is not null;
create index if not exists starter_pack_purchases_user_idx on public.starter_pack_purchases (user_id);
do $$
begin
  alter table public.starter_pack_purchases drop constraint if exists starter_pack_status_check;
  alter table public.starter_pack_purchases add constraint starter_pack_status_check check (status in ('reserved', 'granted', 'blocked', 'failed'));
  alter table public.starter_pack_purchases drop constraint if exists starter_pack_blocked_by_check;
  alter table public.starter_pack_purchases add constraint starter_pack_blocked_by_check check (blocked_by is null or blocked_by in ('account', 'email', 'mobile', 'card', 'race'));
end $$;
alter table public.starter_pack_purchases enable row level security;  -- no policies: service role only
revoke all on public.starter_pack_purchases from anon, authenticated;

-- starter_pack_claim(p): the once-per-person decision, atomically.
-- p: {pi, user, email_key, mobile_key, card, price, credit, currency,
--     consent_at, consent_version}. Serialised on the member's profile row;
-- the partial unique indexes settle two accounts racing with the same email,
-- number or card. A reservation that was never captured stops blocking after
-- 8 days (Stripe drops an uncaptured hold after 7); one marked captured_at
-- (Batch 21, B44) keeps blocking until it is granted.
-- Returns {status, replay, blocked_by}: replay is true when this PaymentIntent
-- was already claimed (a redelivery), with the status it has.
create or replace function public.starter_pack_claim(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_pi text := nullif(p->>'pi', '');
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_email text := nullif(p->>'email_key', '');
  v_mobile text := nullif(p->>'mobile_key', '');
  v_card text := nullif(p->>'card', '');
  v_row public.starter_pack_purchases%rowtype;
  v_by text;
begin
  if v_pi is null or v_user is null then raise exception 'starter_pack_claim needs pi and user'; end if;
  perform 1 from public.profiles where id = v_user for update;
  select * into v_row from public.starter_pack_purchases where payment_intent_id = v_pi;
  if found then
    return jsonb_build_object('status', v_row.status, 'replay', true, 'blocked_by', v_row.blocked_by);
  end if;
  update public.starter_pack_purchases set status = 'failed'
   where status = 'reserved' and captured_at is null and created_at < now() - interval '8 days';
  v_by := case
    when exists (select 1 from public.starter_pack_purchases s where s.user_id = v_user and s.status in ('reserved', 'granted')) then 'account'
    when v_email is not null and exists (select 1 from public.starter_pack_purchases s where s.email_key = v_email and s.status in ('reserved', 'granted')) then 'email'
    when v_mobile is not null and exists (select 1 from public.starter_pack_purchases s where s.mobile_key = v_mobile and s.status in ('reserved', 'granted')) then 'mobile'
    when v_card is not null and exists (select 1 from public.starter_pack_purchases s where s.card_fingerprint = v_card and s.status in ('reserved', 'granted')) then 'card'
  end;
  if v_by is null then
    begin
      insert into public.starter_pack_purchases (payment_intent_id, user_id, status, email_key, mobile_key, card_fingerprint, price_pence, credit_pence, currency, consent_at, consent_version)
      values (v_pi, v_user, 'reserved', v_email, v_mobile, v_card, (p->>'price')::integer, (p->>'credit')::integer, nullif(p->>'currency', ''), nullif(p->>'consent_at', '')::timestamptz, nullif(p->>'consent_version', ''));
      return jsonb_build_object('status', 'reserved', 'replay', false, 'blocked_by', null);
    exception when unique_violation then
      v_by := 'race';
    end;
  end if;
  insert into public.starter_pack_purchases (payment_intent_id, user_id, status, blocked_by, email_key, mobile_key, card_fingerprint, price_pence, credit_pence, currency, consent_at, consent_version)
  values (v_pi, v_user, 'blocked', v_by, v_email, v_mobile, v_card, (p->>'price')::integer, (p->>'credit')::integer, nullif(p->>'currency', ''), nullif(p->>'consent_at', '')::timestamptz, nullif(p->>'consent_version', ''));
  return jsonb_build_object('status', 'blocked', 'replay', false, 'blocked_by', v_by);
end $$;
revoke all on function public.starter_pack_claim(jsonb) from public, anon, authenticated;
grant execute on function public.starter_pack_claim(jsonb) to service_role;

-- starter_pack_clawback(p): {user, base, target, refunded, description}. A
-- pack's refund or dispute, cumulatively: takes back what is still owed, the
-- target less the adjustments already made under `base` (the first is `base`
-- itself, a later one `base:<refunded>`). Read and written under the
-- member's profile row lock, so two refunds handled at once see each other.
-- Returns the pence this call took back.
create or replace function public.starter_pack_clawback(p jsonb)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_base text := nullif(p->>'base', '');
  v_target numeric := greatest(0, coalesce((p->>'target')::numeric, 0));
  v_taken numeric;
  v_diff numeric;
begin
  if v_user is null or v_base is null then raise exception 'starter_pack_clawback needs user and base'; end if;
  perform 1 from public.profiles where id = v_user for update;
  select coalesce(sum(greatest(0, -g.amount_pence)), 0) into v_taken
    from public.credit_grants g
   where g.user_id = v_user and g.kind = 'adjustment'
     and (g.source_ref = v_base or left(g.source_ref, length(v_base) + 1) = v_base || ':');
  v_diff := round(v_target - v_taken);
  if v_diff <= 0 then return 0; end if;
  perform public.credit_grant(v_user, 'adjustment', -v_diff, null,
    case when v_taken > 0 then v_base || ':' || coalesce(nullif(p->>'refunded', ''), '0') else v_base end,
    nullif(p->>'description', ''));
  return v_diff;
end $$;
revoke all on function public.starter_pack_clawback(jsonb) from public, anon, authenticated;
grant execute on function public.starter_pack_clawback(jsonb) to service_role;

-- ── member_payments / member_refunds: what "Total paid" adds up (src/lib/payments) ──
-- Every successful payment, keyed by its Stripe id, amount as charged (VAT
-- included): 'pi:<payment intent>' for a starter pack or a top-up,
-- 'inv:<invoice>' for a subscription invoice. Refunds are kept per charge as
-- the charge's cumulative amount_refunded, set and never added, so a
-- redelivered or out-of-order event cannot count twice. Total paid =
-- payments - refunds of those payments (matched on the PaymentIntent; an
-- invoice's is looked up when it is paid), never below 0. Nothing from before
-- Batch 20 is here, so a refund of an older payment is not taken off.
create table if not exists public.member_payments (
  id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  amount_pence integer not null,
  currency text not null default 'gbp',
  plan_code text,
  payment_intent_id text,
  paid_at timestamptz not null default now()
);
create index if not exists member_payments_user_idx on public.member_payments (user_id, paid_at);
create index if not exists member_payments_pi_idx on public.member_payments (payment_intent_id) where payment_intent_id is not null;
do $$
begin
  alter table public.member_payments drop constraint if exists member_payments_kind_check;
  alter table public.member_payments add constraint member_payments_kind_check check (kind in ('starter_pack', 'topup', 'auto_topup', 'subscription'));
end $$;
alter table public.member_payments enable row level security;  -- no policies: service role only
revoke all on public.member_payments from anon, authenticated;

create table if not exists public.member_refunds (
  charge_id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  payment_intent_id text,
  amount_refunded_pence integer not null,
  updated_at timestamptz not null default now()
);
create index if not exists member_refunds_user_idx on public.member_refunds (user_id);
create index if not exists member_refunds_pi_idx on public.member_refunds (payment_intent_id) where payment_intent_id is not null;
alter table public.member_refunds enable row level security;  -- no policies: service role only
revoke all on public.member_refunds from anon, authenticated;

-- member_refund_set(p): {charge, user, pi, amount}. Keeps the largest
-- cumulative amount seen for the charge (an older event arriving late never
-- lowers it). Returns the amount now stored.
create or replace function public.member_refund_set(p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_amount integer;
begin
  insert into public.member_refunds (charge_id, user_id, payment_intent_id, amount_refunded_pence)
  values (p->>'charge', (p->>'user')::uuid, nullif(p->>'pi', ''), greatest(0, (p->>'amount')::integer))
  on conflict (charge_id) do update
    set amount_refunded_pence = greatest(public.member_refunds.amount_refunded_pence, excluded.amount_refunded_pence),
        payment_intent_id = coalesce(public.member_refunds.payment_intent_id, excluded.payment_intent_id),
        updated_at = now()
  returning amount_refunded_pence into v_amount;
  return v_amount;
end $$;
revoke all on function public.member_refund_set(jsonb) from public, anon, authenticated;
grant execute on function public.member_refund_set(jsonb) to service_role;

-- ── member_active_days: one row per member per UK day with a qualifying action ──
-- Batch 9's definition, stored once: an activity_events row whose kind is in
-- QUALIFYING_KINDS (passed in by src/lib/inactivity, never written here), on
-- its UK date. Filled from activity_events past a watermark on its id, so
-- the nightly never rescans the log, a late backfilled row is still picked
-- up, and the totals outlive the log's 24-month retention.
create table if not exists public.member_active_days (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);
alter table public.member_active_days enable row level security;  -- no policies: service role only
revoke all on public.member_active_days from anon, authenticated;

-- ── member_engaged_days: the UK days a member engaged by email or text ──
-- A click from one of our emails or texts, an answer or a setting changed
-- from one (the kinds are passed in by src/lib/inactivity), but never one
-- that turned something off (extras.on false: an unsubscribe). Record-only for
-- weekly active, so kept apart from member_active_days (which Monday's Last
-- active, Active days and Active weeks read); they keep a member from being
-- counted as quiet. Filled in the same pass over activity_events.
create table if not exists public.member_engaged_days (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);
alter table public.member_engaged_days enable row level security;  -- no policies: service role only
revoke all on public.member_engaged_days from anon, authenticated;

create table if not exists public.member_active_days_state (
  id smallint primary key default 1,
  last_event_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
do $$
begin
  alter table public.member_active_days_state drop constraint if exists member_active_days_state_one_row;
  alter table public.member_active_days_state add constraint member_active_days_state_one_row check (id = 1);
end $$;
insert into public.member_active_days_state (id) values (1) on conflict (id) do nothing;
alter table public.member_active_days_state enable row level security;  -- no policies: service role only
revoke all on public.member_active_days_state from anon, authenticated;

-- lifecycle_active_days_sync(p): {qualifying: [kinds], engaged: [kinds],
-- apply, limit}. Adds the (member, UK day) pairs of up to `limit`
-- activity_events rows past the watermark, the qualifying kinds to
-- member_active_days and the engaged (email and text) kinds to
-- member_engaged_days (not an unsubscribe: extras.on false), and moves the
-- watermark on. apply = false counts what it would add and changes nothing,
-- and lists each member's latest day of either among them (`pending`), so a
-- dry run's preview counts actions since the last nightly. Returns
-- {from, to, added, engaged_added, more, pending}.
-- Batch 21 (E23): only rows older than two minutes are taken, so a row whose
-- insert commits after the read but whose id is below the new watermark is
-- never skipped for good (an id is handed out when the insert starts; the
-- watermark only moves past rows that have had time to commit). Batch 21
-- (E27): a preview deployment's rows (extras.env) never count.
create or replace function public.lifecycle_active_days_sync(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_qual text[] := coalesce(array(select jsonb_array_elements_text(p->'qualifying')), '{}'::text[]);
  v_engaged text[] := coalesce(array(select jsonb_array_elements_text(p->'engaged')), '{}'::text[]);
  v_apply boolean := coalesce((p->>'apply')::boolean, false);
  v_limit integer := least(greatest(coalesce((p->>'limit')::integer, 50000), 1), 200000);
  v_cutoff timestamptz := now() - interval '2 minutes';
  v_from bigint;
  v_to bigint;
  v_added integer := 0;
  v_engaged_added integer := 0;
  v_pending jsonb;
begin
  if cardinality(v_qual) = 0 then raise exception 'lifecycle_active_days_sync needs the qualifying kinds'; end if;
  -- A dry run writes nothing, not even the watermark's row.
  if v_apply then
    insert into public.member_active_days_state (id) values (1) on conflict (id) do nothing;
    select last_event_id into v_from from public.member_active_days_state where id = 1 for update;
  else
    select last_event_id into v_from from public.member_active_days_state where id = 1;
  end if;
  v_from := coalesce(v_from, 0);
  select max(x.id) into v_to from (select e.id from public.activity_events e where e.id > v_from and e.occurred_at < v_cutoff order by e.id limit v_limit) x;
  if v_to is null then
    return jsonb_build_object('from', v_from, 'to', v_from, 'added', 0, 'engaged_added', 0, 'more', false);
  end if;
  if v_apply then
    insert into public.member_active_days (user_id, day)
    select distinct e.user_id, (e.occurred_at at time zone 'Europe/London')::date
      from public.activity_events e
     where e.id > v_from and e.id <= v_to and e.kind = any(v_qual) and not (e.extras ? 'env')
    on conflict do nothing;
    get diagnostics v_added = row_count;
    if cardinality(v_engaged) > 0 then
      insert into public.member_engaged_days (user_id, day)
      select distinct e.user_id, (e.occurred_at at time zone 'Europe/London')::date
        from public.activity_events e
       where e.id > v_from and e.id <= v_to and e.kind = any(v_engaged)
         and coalesce(e.extras->>'on', '') <> 'false' and not (e.extras ? 'env')
      on conflict do nothing;
      get diagnostics v_engaged_added = row_count;
    end if;
    update public.member_active_days_state set last_event_id = v_to, updated_at = now() where id = 1;
  else
    select count(*) into v_added from (
      select distinct e.user_id, (e.occurred_at at time zone 'Europe/London')::date as day
        from public.activity_events e
       where e.id > v_from and e.id <= v_to and e.kind = any(v_qual) and not (e.extras ? 'env')
    ) n
    where not exists (select 1 from public.member_active_days d where d.user_id = n.user_id and d.day = n.day);
    select coalesce(jsonb_agg(jsonb_build_object('u', x.user_id, 'day', x.day)), '[]'::jsonb) into v_pending from (
      select e.user_id, max((e.occurred_at at time zone 'Europe/London')::date) as day
        from public.activity_events e
       where e.id > v_from and e.id <= v_to and not (e.extras ? 'env')
         and (e.kind = any(v_qual) or (e.kind = any(v_engaged) and coalesce(e.extras->>'on', '') <> 'false'))
       group by e.user_id
    ) x;
  end if;
  return jsonb_build_object('from', v_from, 'to', v_to, 'added', v_added, 'engaged_added', v_engaged_added,
    'more', exists (select 1 from public.activity_events e where e.id > v_to and e.occurred_at < v_cutoff), 'pending', v_pending);
end $$;
revoke all on function public.lifecycle_active_days_sync(jsonb) from public, anon, authenticated;
grant execute on function public.lifecycle_active_days_sync(jsonb) to service_role;

-- lifecycle_member_stats(p): {users: [uuid]}. Per member: the last UK day
-- with a qualifying action, how many such days and how many UK weeks (Monday
-- to Sunday, as Batch 9 counts them) since sign-up; the last UK day they
-- engaged at all, by email or text included (what inactivity counts from,
-- `last_engaged`); what they have paid
-- (payments and refunds as above, the first payment, paid top-ups that are
-- not fully refunded and the latest); and whether they bought the pack.
create or replace function public.lifecycle_member_stats(p jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with u as (
    select distinct x::uuid as id from jsonb_array_elements_text(coalesce(p->'users', '[]'::jsonb)) x
  ), a as (
    select d.user_id, max(d.day) as last_day, count(*) as days, count(distinct date_trunc('week', d.day::timestamp)) as weeks
      from public.member_active_days d join u on u.id = d.user_id
     group by d.user_id
  ), eng as (
    select g.user_id, max(g.day) as last_day
      from public.member_engaged_days g join u on u.id = g.user_id
     group by g.user_id
  ), pay as (
    select m.user_id, sum(m.amount_pence) as paid, min(m.paid_at) as first_paid
      from public.member_payments m join u on u.id = m.user_id
     group by m.user_id
  ), ref as (
    -- Only refunds of the payments counted above (matched on the PaymentIntent),
    -- each at most the payment: a refund of a payment from before Batch 20, or
    -- one never recorded, is not taken off what was never added.
    select m.user_id, sum(least(m.amount_pence, rr.refunded)) as refunded
      from public.member_payments m join u on u.id = m.user_id
      join lateral (
        select sum(r.amount_refunded_pence) as refunded from public.member_refunds r
         where r.payment_intent_id = m.payment_intent_id and r.user_id = m.user_id
      ) rr on rr.refunded is not null
     where m.payment_intent_id is not null
     group by m.user_id
  ), top as (
    select m.user_id, count(*) as topups, max(m.paid_at) as last_topup
      from public.member_payments m join u on u.id = m.user_id
     where m.kind in ('topup', 'auto_topup')
       and coalesce((select sum(r.amount_refunded_pence) from public.member_refunds r where r.payment_intent_id = m.payment_intent_id), 0) < m.amount_pence
     group by m.user_id
  ), pack as (
    select s.user_id, min(s.granted_at) as bought_at
      from public.starter_pack_purchases s join u on u.id = s.user_id
     where s.status = 'granted'
     group by s.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'u', u.id,
    'last_day', a.last_day,
    'last_engaged', greatest(a.last_day, eng.last_day),
    'days', coalesce(a.days, 0),
    'weeks', coalesce(a.weeks, 0),
    'paid', coalesce(pay.paid, 0),
    'refunded', coalesce(ref.refunded, 0),
    'first_paid', pay.first_paid,
    'topups', coalesce(top.topups, 0),
    'last_topup', top.last_topup,
    'pack_at', pack.bought_at
  )), '[]'::jsonb)
  from u
  left join a on a.user_id = u.id
  left join eng on eng.user_id = u.id
  left join pay on pay.user_id = u.id
  left join ref on ref.user_id = u.id
  left join top on top.user_id = u.id
  left join pack on pack.user_id = u.id;
$$;
revoke all on function public.lifecycle_member_stats(jsonb) from public, anon, authenticated;
grant execute on function public.lifecycle_member_stats(jsonb) to service_role;

-- lifecycle_balances(p): {users: [uuid]}. Each member's displayed balance
-- (every unexpired bucket) through the ledger's own credit_available, so the
-- nightly reads a whole page of members in one call and never has a second
-- balance formula.
create or replace function public.lifecycle_balances(p jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'u', u.id,
    'total', round(b.plan_pence + b.welcome_pence + b.topup_pence + b.adjustment_pence, 4),
    'spendable', round(b.spendable_base_pence, 4)
  )), '[]'::jsonb)
  from (select distinct x::uuid as id from jsonb_array_elements_text(coalesce(p->'users', '[]'::jsonb)) x) u
  cross join lateral public.credit_available(u.id) b;
$$;
revoke all on function public.lifecycle_balances(jsonb) from public, anon, authenticated;
grant execute on function public.lifecycle_balances(jsonb) to service_role;

-- ── Mobile numbers (Part D): the oldest account keeps a shared number ──
-- mobile_key_assign(p): {key, keep, apply}. Gives `key` to the account
-- `keep` and takes it from any other account holding it, in one transaction
-- (the unique index allows one holder). Nothing else on the profiles changes.
-- apply = false reports what it would do. Returns {taken_from: [uuid], set}.
create or replace function public.mobile_key_assign(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(p->>'key', '');
  v_keep uuid := nullif(p->>'keep', '')::uuid;
  v_apply boolean := coalesce((p->>'apply')::boolean, false);
  v_taken uuid[];
  v_set boolean;
begin
  if v_key is null or v_keep is null then raise exception 'mobile_key_assign needs key and keep'; end if;
  select coalesce(array_agg(id), '{}') into v_taken from public.profiles where mobile_key = v_key and id <> v_keep;
  select not exists (select 1 from public.profiles where id = v_keep and mobile_key is not distinct from v_key) into v_set;
  if v_apply then
    update public.profiles set mobile_key = null where mobile_key = v_key and id <> v_keep;
    update public.profiles set mobile_key = v_key where id = v_keep and mobile_key is distinct from v_key;
  end if;
  return jsonb_build_object('taken_from', to_jsonb(v_taken), 'set', v_set);
end $$;
revoke all on function public.mobile_key_assign(jsonb) from public, anon, authenticated;
grant execute on function public.mobile_key_assign(jsonb) to service_role;

-- ── monday_funnel_queue: members whose Monday row needs updating ──
-- An event (a payment, a plan change, low credit, coming back...) never talks
-- to Monday itself: it queues the member here, and /api/internal/monday-funnel
-- drains the queue every 10 minutes. One row per member, so a burst of events
-- is one update.
create table if not exists public.monday_funnel_queue (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reasons text[] not null default '{}',
  queued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  last_attempt_at timestamptz
);
create index if not exists monday_funnel_queue_at_idx on public.monday_funnel_queue (queued_at);
alter table public.monday_funnel_queue enable row level security;  -- no policies: service role only
revoke all on public.monday_funnel_queue from anon, authenticated;

-- monday_funnel_enqueue(p): {user, reason}. Adds the member, or the reason
-- to their queued row (at most 10 kept); a re-queue resets the attempt count
-- and moves queued_at on, so a drain that read the row before it deletes
-- only the row it read (the newer event waits for the next drain).
create or replace function public.monday_funnel_enqueue(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := left(coalesce(nullif(p->>'reason', ''), 'event'), 40);
begin
  insert into public.monday_funnel_queue (user_id, reasons) values ((p->>'user')::uuid, array[v_reason])
  on conflict (user_id) do update
    set reasons = (select array(select distinct r from unnest(public.monday_funnel_queue.reasons || array[v_reason]) r limit 10)),
        queued_at = now(),
        attempts = 0;
end $$;
revoke all on function public.monday_funnel_enqueue(jsonb) from public, anon, authenticated;
grant execute on function public.monday_funnel_enqueue(jsonb) to service_role;

-- ── monday_funnel_runs / monday_funnel_lock: the nightly's progress and the one-writer lease ──
-- One row per UK day of the nightly pass: when it started and finished, the
-- inactivity step and what it did (stats; a pass resumes where the last one
-- stopped; Batch 21 (A13) dropped the unused `cursor` column). The lease makes
-- sure only one run (the cron, or a backfill from /admin/lifecycle) writes to
-- Monday at a time.
create table if not exists public.monday_funnel_runs (
  day date primary key,
  started_at timestamptz,
  finished_at timestamptz,
  inactivity_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.monday_funnel_runs enable row level security;  -- no policies: service role only
revoke all on public.monday_funnel_runs from anon, authenticated;

create table if not exists public.monday_funnel_lock (
  id smallint primary key default 1,
  holder text,
  lease_until timestamptz
);
do $$
begin
  alter table public.monday_funnel_lock drop constraint if exists monday_funnel_lock_one_row;
  alter table public.monday_funnel_lock add constraint monday_funnel_lock_one_row check (id = 1);
end $$;
insert into public.monday_funnel_lock (id) values (1) on conflict (id) do nothing;
alter table public.monday_funnel_lock enable row level security;  -- no policies: service role only
revoke all on public.monday_funnel_lock from anon, authenticated;

-- monday_funnel_lease(p): {holder, seconds, release}. Takes the lease when it
-- is free, expired or already this holder's; release gives it back. Returns
-- whether the caller holds it now.
create or replace function public.monday_funnel_lease(p jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_holder text := nullif(p->>'holder', '');
  v_ok boolean;
begin
  if v_holder is null then raise exception 'monday_funnel_lease needs a holder'; end if;
  insert into public.monday_funnel_lock (id) values (1) on conflict (id) do nothing;
  if coalesce((p->>'release')::boolean, false) then
    update public.monday_funnel_lock set holder = null, lease_until = null where id = 1 and holder = v_holder;
    return false;
  end if;
  update public.monday_funnel_lock
     set holder = v_holder,
         lease_until = now() + make_interval(secs => least(greatest(coalesce((p->>'seconds')::integer, 60), 10), 900))
   where id = 1 and (holder is null or lease_until is null or lease_until < now() or holder = v_holder)
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.monday_funnel_lease(jsonb) from public, anon, authenticated;
grant execute on function public.monday_funnel_lease(jsonb) to service_role;

-- =========================
-- Batch 21: review fixes
-- =========================
-- The schema half of the Batch 21 review (docs/reviews/batch-21-review.md,
-- branch 21a). Everything here is idempotent; the one-off block is marked by a
-- billing_settings row. The in-place edits elsewhere in this file carry a
-- "Batch 21 (Xn)" comment naming the finding. CI runs this file twice on a
-- fresh Postgres and then supabase/tests/credit-smoke.sql (G4).

-- (A7) onboarding_skips: dead since the welcome quiz; nothing reads or writes it.
alter table public.profiles drop column if exists onboarding_skips;

-- (A13) monday_funnel_runs.cursor: never written or read; progress is in stats.
alter table public.monday_funnel_runs drop column if exists cursor;

-- (A9) profiles.updated_at was never maintained: it always equalled
-- created_at. A trigger keeps it honest for every writer.
create or replace function private.profiles_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke execute on function private.profiles_touch_updated_at() from public;
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.profiles_touch_updated_at();

-- (A12) The funnel counters were left executable by anon and authenticated.
-- Every caller (src/lib/funnels/caps.ts, alerts.ts, the sweep) uses the
-- service role. safe_numeric is left as it was: a pure parser that other
-- tools on the live project may call.
revoke all on function public.funnel_hit(uuid, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.funnel_spend_reserve(uuid, timestamptz, numeric, numeric) from public, anon, authenticated;
revoke all on function public.funnel_spend_settle(uuid, timestamptz, numeric, numeric) from public, anon, authenticated;
revoke all on function public.funnel_hits_sweep(timestamptz) from public, anon, authenticated;
revoke all on function public.funnel_alert_claim(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.funnel_hit(uuid, text, timestamptz, integer), public.funnel_spend_reserve(uuid, timestamptz, numeric, numeric), public.funnel_spend_settle(uuid, timestamptz, numeric, numeric), public.funnel_hits_sweep(timestamptz), public.funnel_alert_claim(uuid, text, timestamptz) to service_role;

-- (D24) provider_calls is read by action_id when a demand search settles its
-- claim (src/lib/sourcing-demand/server.ts) and when an action's spend is
-- summed (src/lib/credit/action.ts): a scan of the whole table each time.
create index if not exists provider_calls_action_idx on public.provider_calls (action_id) where action_id is not null;

-- (C4) leads.input: the whole parsed analysis input (property type,
-- bathrooms, parking, outdoor space, ...), so a queued lead is re-run as the
-- prospect described the property, not from address, postcode and bedrooms
-- alone. Written by the funnel route from Batch 21g; null for older leads.
alter table public.leads add column if not exists input jsonb;

-- (B1) credit_plan_cycle: a new plan cycle in ONE transaction under the
-- member's row lock: the source_ref check and the new grant. As separate calls
-- (src/lib/stripe/grants.ts before Batch 21c) a second, concurrent delivery of
-- the same invoice could pass the check and grant twice. Returns
-- {grant_id, created, expired}: a replay returns the existing grant and
-- creates nothing.
-- Batch 34 (plan credit rollover): a renewal no longer expires the open plan
-- grants (credit_expire_plan_grants is no longer called): unused plan credit
-- rolls over. The new grant never expires (p_expires_at is IGNORED, so app
-- code that still passes a period end is safe) and is marked plan_cycle.
-- 'expired' is always 0, kept for the callers.
create or replace function public.credit_plan_cycle(p_user uuid, p_amount numeric, p_expires_at timestamptz, p_source_ref text, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if p_source_ref is null or p_source_ref = '' then raise exception 'credit_plan_cycle needs a source_ref'; end if;
  perform 1 from profiles where id = p_user for update;
  select id into v_id from credit_grants where source_ref = p_source_ref;
  if v_id is not null then
    return jsonb_build_object('grant_id', v_id, 'created', false, 'expired', 0);
  end if;
  v_id := credit_grant(p_user, 'plan', p_amount, null, p_source_ref, p_description);
  update credit_grants set plan_cycle = true where id = v_id;
  return jsonb_build_object('grant_id', v_id, 'created', true, 'expired', 0);
end $$;
revoke all on function public.credit_plan_cycle(uuid, numeric, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.credit_plan_cycle(uuid, numeric, timestamptz, text, text) to service_role;

-- (B2) Shadow-mode overdrafts. With CREDIT_ENFORCE off every metered action
-- ran at £0 and debited into the member's 'overdraft:<user>' grant, which
-- every later grant (the £10 pack's £30 included) repaid first, and which
-- would refuse the member everything the day enforcement is switched on.
-- Decided 1 Oct 2026 (review question 1): forgive them, once. The function
-- stays for the admin tools; the block below runs once, marked in
-- billing_settings (batch21_overdrafts_forgiven_at holds the count).
create or replace function public.credit_forgive_overdrafts(p_reason text default 'forgiven')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_debt numeric;
  n int := 0;
  v_total numeric := 0;
begin
  for g in select id, user_id from credit_grants where source_ref like 'overdraft:%' and remaining_pence < 0 order by user_id loop
    -- The member's row lock serialises this with their debits and grants, so
    -- the amount written off is the amount still owed at that moment.
    perform 1 from profiles where id = g.user_id for update;
    select -remaining_pence into v_debt from credit_grants where id = g.id and remaining_pence < 0 for update;
    if v_debt is null then continue; end if;
    insert into credit_transactions (user_id, kind, amount_pence, base_pence, grant_id, description, metadata)
    values (g.user_id, 'adjust', v_debt, v_debt, g.id, 'Overdraft forgiven', jsonb_build_object('reason', p_reason, 'overdraft_grant', g.id));
    update credit_grants set remaining_pence = 0 where id = g.id;
    n := n + 1;
    v_total := v_total + v_debt;
  end loop;
  return jsonb_build_object('members', n, 'pence', v_total);
end $$;
revoke all on function public.credit_forgive_overdrafts(text) from public, anon, authenticated;
grant execute on function public.credit_forgive_overdrafts(text) to service_role;
do $$
declare r jsonb;
begin
  if not exists (select 1 from public.billing_settings where key = 'batch21_overdrafts_forgiven_at') then
    r := public.credit_forgive_overdrafts('batch21_shadow_mode');
    insert into public.billing_settings (key, value) values ('batch21_overdrafts_forgiven_at', jsonb_build_object('at', now()) || r);
  end if;
end $$;

-- (A16) The welcome-credit backfill, moved here from the credit section so it
-- can see welcome_withheld_reason and team_members: an account whose credit
-- was withheld, or that is a team seat, is never granted by a re-run. Frozen
-- to accounts created before 13 Sep 2026 (it ran on 12 Sep 2026); new
-- accounts are decided by src/lib/credit/welcome.ts.
do $$
declare p record;
begin
  for p in
    select id from public.profiles
     where profiles.created_at < timestamptz '2026-09-13 00:00:00+00'
       and profiles.welcome_withheld_reason is null
       and not exists (select 1 from public.credit_grants g where g.user_id = profiles.id and g.kind = 'welcome')
       and not exists (select 1 from public.team_members tm where tm.member_id = profiles.id)
  loop
    perform public.credit_grant(p.id, 'welcome', public.credit_setting_num('welcome_grant_pence', 2000), null, 'welcome:' || p.id::text, 'Welcome credit');
    update public.profiles set welcome_checked_at = now() where id = p.id;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- =========================
-- Batch 22: signup reveal
-- =========================
-- The signup reveal and the Stayful Intelligence view (src/lib/intelligence),
-- the member searches behind them (src/lib/sourcing-demand/member-search*.ts),
-- the welcome and first-deep-report prices (src/lib/analysis/offers*.ts),
-- resuming after a top-up (src/lib/billing/resume-rules.ts) and the call
-- choice. Every new table is service role only. Nothing is added to
-- ACCESS_COLUMNS: each new column is read in a query of its own, so until this
-- section is run no reveal is shown, no search runs and no offer is priced.

-- ── Settings (inserted only when missing, so an edit on /admin/billing survives a re-run) ──
-- reveal_from is stamped once, the first time this section runs: accounts
-- created at or after it are "new members" for the reveal. Existing members
-- never see it.
insert into public.billing_settings (key, value) values ('reveal_from', to_jsonb(now()))
on conflict (key) do nothing;
insert into public.billing_settings (key, value) values
  ('accuracy_advanced_pct', '50'),
  ('reveal_low_match_pct', '70'),
  ('reveal_small_count', '20'),
  ('strong_match_pct', '90'),
  ('strong_match_min_checked', '5'),
  ('signup_search_cap_pence', '50'),
  ('signup_thin_stock', '5'),
  ('signup_search_fresh_hours', '24'),
  ('signup_confirm_live_max', '5'),
  ('signup_income_checks_max', '3'),
  ('signup_search_monthly_cap_pence', '2000'),
  ('member_search_confirms_per_hour', '40'),
  ('deep_search_markup', '5'),
  ('deep_search_max_raw_pence', '300'),
  ('deep_search_monthly_cap_pence', '5000'),
  ('deep_search_first_discount_pct', '50'),
  ('deep_search_nearby_areas', '3'),
  ('reveal_analysis_discount_pct', '50'),
  ('reveal_welcome_days', '7'),
  ('deep_first_run_extra_pence', '100'),
  ('reveal_auto_topup_amount_pence', '2500'),
  ('reveal_auto_topup_threshold_pence', '500'),
  ('si_call_pence_per_min', '65'),
  ('si_text_pence', '22'),
  ('si_email_pence', '20')
on conflict (key) do nothing;

-- ── profiles: the call choice ──
-- "Calls from Stayful Intelligence": off until the member ticks it (the
-- history is in si_call_consents; the number is sms_contacts').
alter table public.profiles add column if not exists si_calls boolean not null default false;
alter table public.profiles add column if not exists si_calls_changed_at timestamptz;

-- ── si_call_consents: every change to the call choice, with its wording ──
-- Batch 19's consent_records is the cookie banner's (visitor_id, accept |
-- reject, banner | signup | settings), so call consent has its own.
create table if not exists public.si_call_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  choice text not null check (choice in ('on', 'off')),
  source text not null check (source in ('welcome', 'settings')),
  version text not null check (char_length(version) between 1 and 40),
  created_at timestamptz not null default now()
);
create index if not exists si_call_consents_user_idx on public.si_call_consents (user_id, created_at desc);
alter table public.si_call_consents enable row level security;  -- no policies: service role only
revoke all on public.si_call_consents from anon, authenticated;

-- ── profile_today_lists.choice: what the day's choice read ──
-- {checked, meeting, capped, nearby, finds}: "I checked N live deals". Written
-- only by the request that stored the list (never by a race loser).
alter table public.profile_today_lists add column if not exists choice jsonb;

-- ── signup_reveals: one per member, written before the reveal renders ──
--   deal_ids        the 3 shown (best match first)
--   offer_deal_ids  the deals the welcome price applies to
--   shown_ids       kept equal to deal_ids (a card a later search replaced is on profile_today_lists.shown_ids)
--   layer           which layer found #1 (1 stock, 2 signup search, 3 what-if)
create table if not exists public.signup_reveals (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  profile_id uuid references public.search_profiles(id) on delete set null,
  day date not null,
  deal_ids uuid[] not null default '{}',
  offer_deal_ids uuid[] not null default '{}',
  shown_ids uuid[] not null default '{}',
  level smallint,
  checked integer,
  layer smallint,
  no_match boolean not null default false,
  strong boolean not null default false,
  search_id uuid,
  viewed_at timestamptz,
  first_keep_at timestamptz,
  first_keep_ms integer,
  choices_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists signup_reveals_created_idx on public.signup_reveals (created_at desc);
alter table public.signup_reveals enable row level security;  -- no policies: service role only
revoke all on public.signup_reveals from anon, authenticated;

-- ── member_searches: a member's own search (signup: free; deep: paid) ──
-- id is the action id of its provider calls and its ledger debit.
--   status       queued | running | done | failed
--   cap_raw_pence      this search's raw-cost cap; claimed_raw_pence what its
--                      steps have claimed (member_search_claim) and raw_pence
--                      what they actually cost (member_search_true_up)
--   about / up_to      the deep search's quote, in base pence
create table if not exists public.member_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  payer_id uuid references public.profiles(id) on delete set null,
  profile_id uuid references public.search_profiles(id) on delete set null,
  purpose text not null check (purpose in ('signup', 'deep')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  plan jsonb,
  cursor jsonb,
  lease_until timestamptz,
  cap_raw_pence numeric(14,4) not null default 0,
  claimed_raw_pence numeric(14,4) not null default 0,
  raw_pence numeric(14,4) not null default 0,
  about_base_pence numeric(14,4),
  up_to_base_pence numeric(14,4),
  discount_pct integer not null default 0,
  first_discount boolean not null default false,
  reservation_id uuid,
  charged_base_pence numeric(14,4) not null default 0,
  transaction_id bigint,
  stop_reason text,
  found integer not null default 0,
  confirmed integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index if not exists member_searches_signup_uidx on public.member_searches (user_id) where purpose = 'signup';
create unique index if not exists member_searches_active_uidx on public.member_searches (user_id) where status in ('queued', 'running');
-- One first-time discount per paying account: held while the search runs and
-- once it charged; a search that charged nothing frees it.
create unique index if not exists member_searches_first_discount_uidx on public.member_searches (payer_id)
  where first_discount and (status in ('queued', 'running') or charged_base_pence > 0);
create index if not exists member_searches_due_idx on public.member_searches (status, lease_until) where status in ('queued', 'running');
create index if not exists member_searches_month_idx on public.member_searches (purpose, created_at);
alter table public.member_searches enable row level security;  -- no policies: service role only
revoke all on public.member_searches from anon, authenticated;

-- ── member_search_finds: deals a member's search inserted ──
-- unique(deal_id): one finder per deal, so a free member's early access to
-- their own finds can never be shared.
create table if not exists public.member_search_finds (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.member_searches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  deal_id uuid not null unique,
  found_at timestamptz not null default now(),
  confirmed_at timestamptz,
  checked_at timestamptz
);
create index if not exists member_search_finds_user_idx on public.member_search_finds (user_id, found_at desc);
create index if not exists member_search_finds_search_idx on public.member_search_finds (search_id);
alter table public.member_search_finds enable row level security;  -- no policies: service role only
revoke all on public.member_search_finds from anon, authenticated;

-- ── resume_intents: what to start when a member comes back from paying ──
create table if not exists public.resume_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('analyses')),
  items jsonb not null default '[]',
  return_path text not null,
  status text not null default 'open' check (status in ('open', 'done', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists resume_intents_user_idx on public.resume_intents (user_id, created_at desc) where status = 'open';
alter table public.resume_intents enable row level security;  -- no policies: service role only
revoke all on public.resume_intents from anon, authenticated;

-- ── analysis_purchases: the offer a purchase was priced at ──
--   offer       welcome | welcome_deep | first_deep | first_pmi | welcome_btl (Batch 28) (null: list price)
--   first_deep  this purchase is the account's first deep report
alter table public.analysis_purchases add column if not exists offer text;
alter table public.analysis_purchases add column if not exists first_deep boolean not null default false;
-- Dropped and re-added on every run (Review R3, R3-74 / R2-119: guarded by
-- name, a changed offer list never applied to a database that had the check).
do $$
begin
  alter table public.analysis_purchases drop constraint if exists analysis_purchases_offer_check;
  alter table public.analysis_purchases add constraint analysis_purchases_offer_check
    check (offer is null or offer in ('welcome', 'welcome_deep', 'first_deep', 'first_pmi', 'welcome_btl'));
end $$;
-- One welcome-priced analysis per member and deal; one first deep report per
-- paying account. A failed purchase frees its claim.
create unique index if not exists analysis_purchases_welcome_uidx on public.analysis_purchases (buyer_id, deal_id)
  where offer in ('welcome', 'welcome_deep') and status <> 'failed';
create unique index if not exists analysis_purchases_first_deep_uidx on public.analysis_purchases (buyer_id)
  where first_deep and status <> 'failed';

-- ── member_search_claim / member_search_true_up ──
-- Every paid step of a member search is claimed BEFORE it runs, against the
-- search's own cap and the month's ceiling for its purpose
-- (signup_search_monthly_cap_pence / deep_search_monthly_cap_pence), under one
-- advisory lock per purpose so two searches can't both take the last pennies.
-- After the step, true_up swaps the claim for what it actually cost.
--   claim   {search_id, pence}           -> {ok, reason?, claimed, month}
--   true_up {search_id, claimed, actual} -> {claimed, raw}
create or replace function public.member_search_claim(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p ->> 'search_id')::uuid;
  v_pence numeric := coalesce((p ->> 'pence')::numeric, 0);
  v_purpose text;
  s record;
  v_month numeric;
  v_cap numeric;
begin
  if v_pence < 0 then raise exception 'member_search_claim: negative pence'; end if;
  select purpose into v_purpose from member_searches where id = v_id;
  if v_purpose is null then return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  perform pg_advisory_xact_lock(hashtext('member_search_' || v_purpose));
  select id, purpose, cap_raw_pence, claimed_raw_pence, status into s from member_searches where id = v_id for update;
  if s.status not in ('queued', 'running') then return jsonb_build_object('ok', false, 'reason', 'finished'); end if;
  if s.claimed_raw_pence + v_pence > s.cap_raw_pence then
    return jsonb_build_object('ok', false, 'reason', 'cap', 'claimed', s.claimed_raw_pence);
  end if;
  v_cap := credit_setting_num(case when s.purpose = 'deep' then 'deep_search_monthly_cap_pence' else 'signup_search_monthly_cap_pence' end,
                              case when s.purpose = 'deep' then 5000 else 2000 end);
  select coalesce(sum(greatest(claimed_raw_pence, raw_pence)), 0) into v_month
    from member_searches where purpose = s.purpose and created_at >= date_trunc('month', now());
  if v_month + v_pence > v_cap then
    return jsonb_build_object('ok', false, 'reason', 'month', 'claimed', s.claimed_raw_pence, 'month', v_month);
  end if;
  update member_searches set claimed_raw_pence = claimed_raw_pence + v_pence where id = v_id;
  return jsonb_build_object('ok', true, 'claimed', s.claimed_raw_pence + v_pence, 'month', v_month + v_pence);
end $$;
revoke all on function public.member_search_claim(jsonb) from public, anon, authenticated;
grant execute on function public.member_search_claim(jsonb) to service_role;

create or replace function public.member_search_true_up(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p ->> 'search_id')::uuid;
  v_claimed numeric := coalesce((p ->> 'claimed')::numeric, 0);
  v_actual numeric := coalesce((p ->> 'actual')::numeric, 0);
  v_purpose text;
  r record;
begin
  select purpose into v_purpose from member_searches where id = v_id;
  if v_purpose is null then return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  perform pg_advisory_xact_lock(hashtext('member_search_' || v_purpose));
  update member_searches
     set claimed_raw_pence = greatest(claimed_raw_pence - v_claimed + v_actual, 0),
         raw_pence = raw_pence + greatest(v_actual, 0)
   where id = v_id
  returning claimed_raw_pence, raw_pence into r;
  return jsonb_build_object('ok', true, 'claimed', r.claimed_raw_pence, 'raw', r.raw_pence);
end $$;
revoke all on function public.member_search_true_up(jsonb) from public, anon, authenticated;
grant execute on function public.member_search_true_up(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 23: Stayful Intelligence calls
-- =========================
-- Calls and texts from Stayful Intelligence (src/lib/voice): the intro call,
-- the low-credit call and callbacks to the Batch 8 number, through ElevenLabs
-- Conversational AI on Twilio. Every table is service role only. Nothing is
-- added to profiles or to ACCESS_COLUMNS. Until this section is run the
-- calls code reads "schema missing" and places nothing.
--
-- The safety rules live in the database as unique indexes, so no race can
-- break them:
--   one outbound call per member per UK day   si_calls_log_one_a_day_uidx
--   one call in flight per member             si_calls_log_in_flight_uidx
--   one intro call per member, ever           si_calls_log_intro_uidx
--   one low-credit call per credit landing    si_calls_log_low_credit_uidx
-- and every charge has one guard row (si_call_charges.charge_key), so a
-- webhook redelivery never charges or texts twice.

-- ── Settings (inserted only when missing, so an admin edit survives a re-run) ──
-- Reused, not duplicated: low_credit_pence (the £5 trigger),
-- reveal_auto_topup_amount_pence / reveal_auto_topup_threshold_pence (£25 /
-- £5), si_text_pence, si_email_pence, feedback_admin_email (the handoff
-- address).
insert into public.billing_settings (key, value) values
  ('si_outbound_start_hour', '9'),
  ('si_outbound_end_hour', '19'),
  ('si_outbound_weekdays', '[1, 2, 3, 4, 5]'),
  ('si_max_outbound_calls_per_uk_day', '1'),
  ('si_low_credit_spent_ratio', '0.8'),
  ('si_low_credit_window_days', '7'),
  ('si_low_credit_min_member_days', '3'),
  ('si_max_call_seconds', '600'),
  ('si_texts_per_call_max', '2'),
  ('si_wrap_up_seconds', '45'),
  ('si_transcript_retention_days', '90'),
  ('si_sms_auto_replies_per_number_day', '3')
on conflict (key) do nothing;

-- ── si_conversations: one conversation, any channel (call now; sms; chat in Batch 26) ──
-- Batch 24's learning loop reads these. Turns are deleted after
-- si_transcript_retention_days (transcript_purged_at); questions are kept.
create table if not exists public.si_conversations (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('call', 'sms', 'chat')),
  user_id uuid references public.profiles(id) on delete set null,
  persona_version text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript_purged_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists si_conversations_user_idx on public.si_conversations (user_id, started_at desc);
create index if not exists si_conversations_started_idx on public.si_conversations (started_at desc);
alter table public.si_conversations enable row level security;  -- no policies: service role only
revoke all on public.si_conversations from anon, authenticated;

-- Each member question and each agent reply, in order. knowledge_ref is the
-- knowledge entry used to answer (Batch 24), when there is one.
create table if not exists public.si_conversation_turns (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.si_conversations(id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('member', 'agent')),
  text text not null,
  at timestamptz not null default now(),
  knowledge_ref text
);
create unique index if not exists si_conversation_turns_seq_uidx on public.si_conversation_turns (conversation_id, seq);
create index if not exists si_conversation_turns_at_idx on public.si_conversation_turns (at);
alter table public.si_conversation_turns enable row level security;  -- no policies: service role only
revoke all on public.si_conversation_turns from anon, authenticated;

-- One row per question, with how it went. Kept after the transcript purge.
create table if not exists public.si_conversation_questions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.si_conversations(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 500),
  outcome text not null check (outcome in ('answered', 'low_confidence', 'could_not_answer', 'member_unhappy', 'handed_off')),
  knowledge_ref text,
  source text not null default 'tool',
  at timestamptz not null default now()
);
-- The one list (Review R3, R3-83): 'chat' is Batch 26's (R2-87). A later
-- section cannot widen a check this one re-adds on every run.
-- 'routed' (Review R3, R3-37): the quick box sent the member to the full view: neither an answer nor a gap.
do $$ begin
  alter table public.si_conversation_questions drop constraint if exists si_conversation_questions_source_check;
  alter table public.si_conversation_questions add constraint si_conversation_questions_source_check check (source in ('tool', 'analysis', 'sms', 'chat'));
  alter table public.si_conversation_questions drop constraint if exists si_conversation_questions_outcome_check;
  alter table public.si_conversation_questions add constraint si_conversation_questions_outcome_check check (outcome in ('answered', 'low_confidence', 'could_not_answer', 'member_unhappy', 'handed_off', 'routed'));
end $$;
create index if not exists si_conversation_questions_conv_idx on public.si_conversation_questions (conversation_id, at);
create index if not exists si_conversation_questions_outcome_idx on public.si_conversation_questions (outcome, at desc);
alter table public.si_conversation_questions enable row level security;  -- no policies: service role only
revoke all on public.si_conversation_questions from anon, authenticated;

-- ── si_calls_log: every call, placed, received or blocked ──
--   call_type      the one list is src/lib/voice/config.ts CALL_TYPES (Batch
--                  25 added 'deal' to the check below, in place: a later
--                  section cannot widen a check this one re-adds on every run)
--   status         queued | ringing (placed, in progress) | answered | missed |
--                  voicemail | failed | blocked (the safety rule said no;
--                  blocked_reason says why)
--   uk_day         the UK day an outbound call was placed (null until then)
--   trigger_ref    what fired it (the low-credit call: the credit landing's grant id)
--   context        why we called / what the agent was told (intro, low_credit,
--                  deal, missed_intro, missed_low_credit, missed_deal, member,
--                  unknown). Batch 25: a deal call's trigger_ref is the deal id.
--   caller_hash    unknown inbound callers: a hash of the number, never the number
create table if not exists public.si_calls_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  call_type text not null,
  status text not null,
  blocked_reason text,
  trigger_ref text,
  context text,
  uk_day date,
  not_before timestamptz,
  queued_at timestamptz not null default now(),
  placed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  seconds integer,
  charged_pence integer not null default 0,
  raw_cost_pence numeric(12, 4),
  texts_sent integer not null default 0,
  fallback_sent_at timestamptz,
  handoff boolean not null default false,
  el_conversation_id text,
  twilio_call_sid text,
  caller_hash text,
  conversation_id uuid references public.si_conversations(id) on delete set null,
  persona_version text,
  error text,
  updated_at timestamptz not null default now()
);
do $$ begin
  alter table public.si_calls_log drop constraint if exists si_calls_log_call_type_check;
  alter table public.si_calls_log add constraint si_calls_log_call_type_check check (call_type in ('intro', 'low_credit', 'callback', 'deal'));
  alter table public.si_calls_log drop constraint if exists si_calls_log_status_check;
  alter table public.si_calls_log add constraint si_calls_log_status_check check (status in ('queued', 'ringing', 'answered', 'missed', 'voicemail', 'failed', 'blocked'));
end $$;
create unique index if not exists si_calls_log_el_conv_uidx on public.si_calls_log (el_conversation_id) where el_conversation_id is not null;
create unique index if not exists si_calls_log_call_sid_uidx on public.si_calls_log (twilio_call_sid) where twilio_call_sid is not null;
create unique index if not exists si_calls_log_one_a_day_uidx on public.si_calls_log (user_id, uk_day) where direction = 'outbound' and uk_day is not null;
create unique index if not exists si_calls_log_in_flight_uidx on public.si_calls_log (user_id) where direction = 'outbound' and status in ('queued', 'ringing');
create unique index if not exists si_calls_log_intro_uidx on public.si_calls_log (user_id) where call_type = 'intro';
create unique index if not exists si_calls_log_low_credit_uidx on public.si_calls_log (user_id, trigger_ref) where call_type = 'low_credit';
create index if not exists si_calls_log_user_idx on public.si_calls_log (user_id, queued_at desc);
create index if not exists si_calls_log_queued_idx on public.si_calls_log (queued_at desc);
create index if not exists si_calls_log_due_idx on public.si_calls_log (not_before) where status = 'queued';
alter table public.si_calls_log enable row level security;  -- no policies: service role only
revoke all on public.si_calls_log from anon, authenticated;

-- ── si_call_charges: one guard row per charge ──
-- charge_key: call:<id>:minutes, call:<id>:text:<template>,
-- call:<id>:email:fallback, sms:<MessageSid>. Inserted before the debit; a
-- duplicate key means "already charged".
create table if not exists public.si_call_charges (
  id uuid primary key default gen_random_uuid(),
  charge_key text not null unique,
  call_id uuid references public.si_calls_log(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('minutes', 'text', 'email')),
  quantity numeric(12, 4) not null default 1,
  charged_pence integer not null default 0,
  transaction_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists si_call_charges_call_idx on public.si_call_charges (call_id);
create index if not exists si_call_charges_user_idx on public.si_call_charges (user_id, created_at desc);
alter table public.si_call_charges enable row level security;  -- no policies: service role only
revoke all on public.si_call_charges from anon, authenticated;

-- ── si_webhook_events: claim-then-process, like stripe_events ──
create table if not exists public.si_webhook_events (
  provider text not null,
  event_key text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  primary key (provider, event_key)
);
alter table public.si_webhook_events enable row level security;  -- no policies: service role only
revoke all on public.si_webhook_events from anon, authenticated;

-- ── si_tool_calls: every server-tool call the agent makes (rate limits count these) ──
create table if not exists public.si_tool_calls (
  id bigint generated always as identity primary key,
  call_id uuid references public.si_calls_log(id) on delete cascade,
  tool text not null,
  ok boolean not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index if not exists si_tool_calls_call_idx on public.si_tool_calls (call_id, tool);
alter table public.si_tool_calls enable row level security;  -- no policies: service role only
revoke all on public.si_tool_calls from anon, authenticated;

notify pgrst, 'reload schema';

-- =========================
-- Batch 22c: cheap deals first
-- =========================
-- "Low entry" now means a cheap price: a sale with an asking price of at most
-- low_entry.cheapMaxPrice (£150,000), an auction lot at its auction price
-- (src/lib/deal-quality/streams.ts). It used to mean a cash in of at most
-- low_entry.maxCashIn (£50,000), which stays stored but is no longer used.
-- Purchases under low_entry.lenderMinPrice (£75,000) carry a lender note on
-- their card and deal sheet; no figure changes.
--
-- The settings move ONCE, marked by the batch22c_cheap_applied_at row, so
-- re-running this file never undoes a later change made on /admin/deals.
-- Each value only moves if it is still at the decided value it replaces:
--   low_entry    adds cheapMaxPrice 150000 and lenderMinPrice 75000 where
--                missing; searchMaxPrice 135000 → 150000 (the nationwide
--                search's ceiling; LOW_ENTRY_SEARCH_ENABLED is untouched)
--   deal_checks  split top60 6 / low_entry 8 / r2r 6 → 3 / 12 / 5 (the Project
--                share is kept), and lowEntryShortlistExpiryDays 14 where
--                missing (a cheap candidate waits 14 days for its check, not 7)
-- The code reads the same defaults when a field is missing, so the site
-- behaves the same before this section is run.
--
-- No new column, no change to ACCESS_COLUMNS, no new cron. The stream column
-- of existing deals is re-worked by the re-stream backfill
-- (/api/internal/restream-backfill?dry=1 first, or the /admin/deals buttons),
-- not here. marketplace_runs.kind also takes 'restream_backfill' and
-- 'cheap_rescreen' (no constraint on the column).
do $$
begin
  if not exists (select 1 from public.billing_settings where key = 'batch22c_cheap_applied_at') then
    update public.billing_settings
       set value = jsonb_build_object('cheapMaxPrice', 150000, 'lenderMinPrice', 75000)
                   || value
                   || case when (value->>'searchMaxPrice') = '135000' then '{"searchMaxPrice": 150000}'::jsonb else '{}'::jsonb end,
           updated_at = now()
     where key = 'low_entry';
    update public.billing_settings
       set value = jsonb_build_object('lowEntryShortlistExpiryDays', 14)
                   || value
                   || case
                        when value->'split'->>'top60' = '6' and value->'split'->>'low_entry' = '8' and value->'split'->>'r2r' = '6'
                        then jsonb_build_object('split', (value->'split') || '{"top60": 3, "low_entry": 12, "r2r": 5}'::jsonb)
                        else '{}'::jsonb
                      end,
           updated_at = now()
     where key = 'deal_checks';
    insert into public.billing_settings (key, value) values ('batch22c_cheap_applied_at', to_jsonb(now()));
  end if;
end $$;

notify pgrst, 'reload schema';

-- =========================
-- Batch 22d: start again
-- =========================
-- "Start again" on /profile resets the ACTIVE saved profile's answers (and
-- optionally "About you"), hides the tracked deals the member chooses from
-- My deals, and restarts what Today learns from their Keeps, Passes and opens
-- for that profile. "Start blank" on /profiles makes a new profile with no
-- answers. src/lib/profiles/reset.ts holds the rules.
--
--   profile_restarts      one row per reset or blank profile. The admin
--                         resets panel, the learning cutoff (only what came
--                         after a profile's latest restart counts), the
--                         "no daily deals until the mandatory questions are
--                         answered" rule and the "no signup reveal" rule
--                         all read it.
--   hidden_tracked_deals  My deals entries the member cleared, by the entry's
--                         key ('d-<deal id>' or 'l-<checked listing id>',
--                         src/lib/listing/tracked.ts). Hidden, never deleted:
--                         nothing here writes deal_reactions (a clear is not a
--                         Pass), deal_opens or checked_listings. Restorable
--                         for 30 days (restored_at); an entry the member acts
--                         on again after it was hidden shows again.
--
-- The £5 is untouched: reset_search_profile never writes credit_grant_id,
-- credit_skipped_reason or completed_at. Everything is additive, idempotent
-- and service role only; nothing here is in ACCESS_COLUMNS (src/lib/access.ts),
-- nor may it become so. No backfill and no cron. Every read of these tables is
-- a query of its own that fails open, so this section can be run before or
-- after the code is deployed.

create table if not exists public.profile_restarts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  profile_id uuid references public.search_profiles(id) on delete set null,
  kind text not null,                 -- reset | blank
  answers text,                       -- reset only: search | everything
  deals text,                         -- reset only: keep_all | clear_all | choose
  deals_kept integer not null default 0,
  deals_cleared integer not null default 0,
  created_at timestamptz not null default now()
);
do $$
begin
  alter table public.profile_restarts drop constraint if exists profile_restarts_kind_check;
  alter table public.profile_restarts add constraint profile_restarts_kind_check check (kind in ('reset', 'blank'));
  alter table public.profile_restarts drop constraint if exists profile_restarts_answers_check;
  alter table public.profile_restarts add constraint profile_restarts_answers_check check (answers is null or answers in ('search', 'everything'));
  alter table public.profile_restarts drop constraint if exists profile_restarts_deals_check;
  alter table public.profile_restarts add constraint profile_restarts_deals_check check (deals is null or deals in ('keep_all', 'clear_all', 'choose'));
end $$;
create index if not exists profile_restarts_created_idx on public.profile_restarts (created_at);
create index if not exists profile_restarts_user_idx on public.profile_restarts (user_id, created_at desc);
create index if not exists profile_restarts_profile_idx on public.profile_restarts (profile_id, created_at desc) where profile_id is not null;
alter table public.profile_restarts enable row level security;  -- no policies: service role only
revoke all on public.profile_restarts from anon, authenticated;

create table if not exists public.hidden_tracked_deals (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_key text not null,
  profile_id uuid references public.search_profiles(id) on delete set null,
  restart_id uuid references public.profile_restarts(id) on delete set null,
  hidden_at timestamptz not null default now(),
  restored_at timestamptz,
  primary key (user_id, item_key)
);
do $$
begin
  alter table public.hidden_tracked_deals drop constraint if exists hidden_tracked_deals_key_check;
  alter table public.hidden_tracked_deals add constraint hidden_tracked_deals_key_check check (item_key ~ '^[dl]-[0-9A-Za-z-]{1,64}$');
end $$;
create index if not exists hidden_tracked_deals_hidden_idx on public.hidden_tracked_deals (user_id, hidden_at desc);
alter table public.hidden_tracked_deals enable row level security;  -- no policies: service role only
revoke all on public.hidden_tracked_deals from anon, authenticated;

-- ── Reset: one transaction under the member's row lock ──
-- p: {user, answers: 'search'|'everything', deals: 'keep_all'|'clear_all'|'choose',
--     kept, cleared, shared: [question ids stored in about_you], hide: [entry keys]}
-- Always the member's ACTIVE live profile: no profile id is taken from the
-- caller. The live copies (profiles.market_goals, saved_areas,
-- profile_quiz.answered) are cleared, and Batch 13's triggers carry that into
-- the active profile's row only; other profiles are not touched (except
-- "About you", which is shared, under 'everything'). The £5 columns and
-- completed_at are never written. Raises profile_not_found (P0404).
create or replace function public.reset_search_profile(p jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_answers text := p->>'answers';
  v_deals text := p->>'deals';
  v_shared text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'shared', '[]'::jsonb)) x), '{}');
  v_profile uuid;
  v_id uuid;
begin
  if v_user is null then raise exception 'profile_user_required'; end if;
  if v_answers is null or v_answers not in ('search', 'everything') then raise exception 'reset_answers_invalid'; end if;
  if v_deals is null or v_deals not in ('keep_all', 'clear_all', 'choose') then raise exception 'reset_deals_invalid'; end if;
  perform 1 from public.profiles where id = v_user for no key update;
  select id into v_profile from public.search_profiles where user_id = v_user and is_active and deleted_at is null;
  if v_profile is null then
    raise exception 'profile_not_found' using errcode = 'P0404';
  end if;

  insert into public.profile_restarts (user_id, profile_id, kind, answers, deals, deals_kept, deals_cleared)
  values (v_user, v_profile, 'reset', v_answers, v_deals, greatest(coalesce((p->>'kept')::integer, 0), 0), greatest(coalesce((p->>'cleared')::integer, 0), 0))
  returning id into v_id;

  if v_answers = 'everything' then
    update public.profiles set market_goals = null, market_goals_updated_at = now(), about_you = null, about_you_updated_at = now() where id = v_user;
  else
    update public.profiles set market_goals = null, market_goals_updated_at = now() where id = v_user;
  end if;
  delete from public.saved_areas where user_id = v_user;

  insert into public.profile_quiz as q (user_id, answered, updated_at)
  values (v_user, '{}'::jsonb, now())
  on conflict (user_id) do update
     set answered = case
                      when v_answers = 'everything' then '{}'::jsonb
                      else coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(q.answered) e where e.key = any (v_shared)), '{}'::jsonb)
                    end,
         last_question = null,
         finish_later_at = null,
         updated_at = now();

  update public.search_profiles set filter_modes = '{}'::jsonb, updated_at = now() where id = v_profile;

  insert into public.hidden_tracked_deals (user_id, item_key, profile_id, restart_id, hidden_at, restored_at)
  select v_user, k, v_profile, v_id, now(), null
    from (select distinct x as k from jsonb_array_elements_text(coalesce(p->'hide', '[]'::jsonb)) x) keys
  on conflict (user_id, item_key) do update
     set profile_id = excluded.profile_id, restart_id = excluded.restart_id, hidden_at = excluded.hidden_at, restored_at = null;

  return v_id;
end;
$$;
revoke all on function public.reset_search_profile(jsonb) from public, anon, authenticated;
grant execute on function public.reset_search_profile(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 22e: Home, "properties scanned for you"
-- =========================
-- Home (/home) shows how many properties Stayful Intelligence has screened
-- for the member since they joined (src/lib/home/scan-days.ts holds the
-- definition). Every screening job already writes each listing once into
-- sourced_listings (first_seen_at is set on insert and never moves), so:
--
--   listing_scan_days      per UK day, postcode area and kind: how many
--                          listings were first screened that day. RECOUNTED
--                          from sourced_listings by record_listing_scan_days,
--                          never added to, so a job run twice or a listing
--                          re-screened on three days cannot move a count.
--                          The sweep, the daily picks and the low-entry
--                          search each call it once when they finish
--                          (yesterday and today); dry runs never reach it.
--   member_scan_baselines  what was live in the member's areas when they
--                          joined: worked out once, the first time Home
--                          loads after their joining day has ended.
--
-- Below, the table is filled from the listings already stored: a recount of
-- real rows, not an estimate. Nothing was recorded before sourced_listings
-- began, so members who joined earlier are counted from then. Everything is
-- additive, idempotent and service role only; nothing here is in
-- ACCESS_COLUMNS (src/lib/access.ts). No cron.

create table if not exists public.listing_scan_days (
  day date not null,
  postcode_area text not null,
  kind text not null,
  new_listings integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, postcode_area, kind)
);
do $$
begin
  alter table public.listing_scan_days drop constraint if exists listing_scan_days_kind_check;
  alter table public.listing_scan_days add constraint listing_scan_days_kind_check check (kind in ('sale', 'rent'));
end $$;
alter table public.listing_scan_days enable row level security;  -- no policies: service role only
revoke all on public.listing_scan_days from anon, authenticated;

-- Recount the given UK days from sourced_listings and replace their rows.
create or replace function public.record_listing_scan_days(p_days date[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_days date[] := coalesce((select array_agg(distinct d) from unnest(p_days) d where d is not null), '{}');
  v_from timestamptz;
  v_to timestamptz;
  v_rows integer := 0;
begin
  if cardinality(v_days) = 0 then return 0; end if;
  if cardinality(v_days) > 4000 then raise exception 'scan_days_too_many'; end if;
  v_from := (select min(d) from unnest(v_days) d)::timestamp at time zone 'Europe/London';
  v_to := ((select max(d) from unnest(v_days) d) + 1)::timestamp at time zone 'Europe/London';

  with recount as (
    select (l.first_seen_at at time zone 'Europe/London')::date as day, upper(l.postcode_area) as postcode_area, l.kind, count(*)::integer as n
      from public.sourced_listings l
     where l.first_seen_at >= v_from and l.first_seen_at < v_to
       and l.postcode_area is not null and l.kind in ('sale', 'rent')
       and (l.first_seen_at at time zone 'Europe/London')::date = any (v_days)
     group by 1, 2, 3
  ), gone as (
    delete from public.listing_scan_days s
     where s.day = any (v_days)
       and not exists (select 1 from recount r where r.day = s.day and r.postcode_area = s.postcode_area and r.kind = s.kind)
    returning 1
  ), written as (
    insert into public.listing_scan_days (day, postcode_area, kind, new_listings, updated_at)
    select r.day, r.postcode_area, r.kind, r.n, now() from recount r
    on conflict (day, postcode_area, kind) do update
       set new_listings = excluded.new_listings,
           updated_at = case when public.listing_scan_days.new_listings = excluded.new_listings then public.listing_scan_days.updated_at else now() end
    returning 1
  )
  select (select count(*) from written)::integer + (select count(*) from gone)::integer into v_rows;
  return v_rows;
end;
$$;
revoke all on function public.record_listing_scan_days(date[]) from public, anon, authenticated;
grant execute on function public.record_listing_scan_days(date[]) to service_role;

create table if not exists public.member_scan_baselines (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  join_day date not null,
  baseline integer not null default 0,
  areas text[],                        -- null: every area
  kinds text[] not null,
  computed_at timestamptz not null default now()
);
alter table public.member_scan_baselines enable row level security;  -- no policies: service role only
revoke all on public.member_scan_baselines from anon, authenticated;

-- A member's two numbers. p: {user, join_day, today, areas (null = every
-- area), kinds}. The baseline is read back once stored; until the joining
-- day has ended it is worked out live and not stored. Returns
-- {baseline, new_since, stored}.
create or replace function public.member_scanned(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_join date := (p->>'join_day')::date;
  v_today date := (p->>'today')::date;
  v_areas text[] := case when jsonb_typeof(p->'areas') = 'array' then (select array_agg(upper(x)) from jsonb_array_elements_text(p->'areas') x) end;
  v_kinds text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'kinds', '[]'::jsonb)) x where x in ('sale', 'rent')), '{}');
  v_base integer;
  v_new integer;
  v_stored boolean := false;
begin
  if v_user is null or v_join is null or v_today is null then raise exception 'member_scanned_bad_input'; end if;
  if v_areas is not null and cardinality(v_areas) = 0 then v_areas := '{}'; end if;

  select b.baseline into v_base from public.member_scan_baselines b where b.user_id = v_user;
  if found then
    v_stored := true;
  else
    select count(*)::integer into v_base
      from public.sourced_listings l
     where l.first_seen_at < ((v_join + 1)::timestamp at time zone 'Europe/London')
       and l.last_seen_at >= (v_join::timestamp at time zone 'Europe/London')
       and l.kind = any (v_kinds)
       and (v_areas is null or upper(l.postcode_area) = any (v_areas));
    if v_join < v_today then
      insert into public.member_scan_baselines (user_id, join_day, baseline, areas, kinds)
      values (v_user, v_join, v_base, v_areas, v_kinds)
      on conflict (user_id) do nothing;
      v_stored := true;
    end if;
  end if;

  select coalesce(sum(s.new_listings), 0)::integer into v_new
    from public.listing_scan_days s
   where s.day > v_join
     and s.kind = any (v_kinds)
     and (v_areas is null or s.postcode_area = any (v_areas));

  return jsonb_build_object('baseline', coalesce(v_base, 0), 'new_since', v_new, 'stored', v_stored);
end;
$$;
revoke all on function public.member_scanned(jsonb) from public, anon, authenticated;
grant execute on function public.member_scanned(jsonb) to service_role;

-- Fill listing_scan_days from what is already stored (every day since the
-- first listing), exactly, once: stamped in billing_settings
-- (listing_scan_days_backfill) when it has run, so a later schema run leaves
-- the daily job's rows alone. Before Review R3 (R3-128 / R2-121) every run
-- recounted every day and, once the span passed record_listing_scan_days's
-- 4000-day limit, aborted the whole file; the days are now counted in runs of
-- at most 4000. Returns {filled, days, rows} or {filled: false, reason}.
create or replace function public.listing_scan_days_backfill()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
  v_first date := (select (min(l.first_seen_at) at time zone 'Europe/London')::date from public.sourced_listings l);
  v_from date;
  v_to date;
  v_days integer := 0;
  v_rows integer := 0;
begin
  if exists (select 1 from public.billing_settings s where s.key = 'listing_scan_days_backfill') then
    return jsonb_build_object('filled', false, 'reason', 'done');
  end if;
  if v_first is null then return jsonb_build_object('filled', false, 'reason', 'no_listings'); end if;
  v_from := least(v_first, v_today);
  while v_from <= v_today loop
    v_to := least(v_today, v_from + 3999);
    v_rows := v_rows + public.record_listing_scan_days(array(select generate_series(v_from, v_to, interval '1 day')::date));
    v_days := v_days + (v_to - v_from + 1);
    v_from := v_to + 1;
  end loop;
  insert into public.billing_settings (key, value)
    values ('listing_scan_days_backfill', jsonb_build_object('at', now(), 'from', least(v_first, v_today), 'to', v_today, 'days', v_days, 'rows', v_rows))
    on conflict (key) do nothing;
  return jsonb_build_object('filled', true, 'days', v_days, 'rows', v_rows);
end $$;
revoke all on function public.listing_scan_days_backfill() from public, anon, authenticated;
grant execute on function public.listing_scan_days_backfill() to service_role;
do $$ begin perform public.listing_scan_days_backfill(); end $$;

notify pgrst, 'reload schema';

-- =========================
-- Batch 22f: management companies
-- =========================
-- A management company's own ad lands on /for-management-companies; an
-- account whose first touch is that page (or who chooses the branded lead
-- form from the quiz or Account) is stamped here, and every rule reads the
-- stamp, never the URL or a cookie again. Their funnel leads are priced by
-- volume tier per UK calendar month (src/lib/funnels/tiers.ts), and each
-- finished lead is emailed to the owner.

-- ── profiles: the stamp, and the funnel-price notice ──
-- Written only by the service role (never granted to `authenticated`), and
-- not in ACCESS_COLUMNS: it changes where a member lands and which gates they
-- meet, never what they may use.
alter table public.profiles add column if not exists signup_path text;
alter table public.profiles drop constraint if exists profiles_signup_path_check;
alter table public.profiles add constraint profiles_signup_path_check
  check (signup_path is null or signup_path in ('management'));
alter table public.profiles add column if not exists signup_path_at timestamptz;
-- How the stamp was set: first_touch | start | quiz | account.
alter table public.profiles add column if not exists signup_path_via text;
create index if not exists profiles_signup_path_idx on public.profiles (signup_path_at) where signup_path is not null;

-- Batch 10's daily-picks backfill, moved here (Review R3, R3-18 / R2-82): a
-- member never sent a pick and never opted out is enrolled, unless they are a
-- management-only account (src/lib/management/stamp-server.ts switches their
-- picks off when it stamps them; before this guard every schema run switched
-- them back on). Safe to re-run. Review R4 (R4-34): the same update, in a
-- function so supabase/tests/credit-smoke.sql can prove the guard holds;
-- every schema run still calls it once. Returns how many members it enrolled.
create or replace function public.daily_picks_backfill()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  update public.profiles
     set sourcing_alerts = true
   where sourcing_alerts = false
     and sourcing_opted_out_at is null
     and sourcing_last_sent_at is null
     and signup_path is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.daily_picks_backfill() from public, anon, authenticated;
grant execute on function public.daily_picks_backfill() to service_role;
do $$ begin perform public.daily_picks_backfill(); end $$;
-- The funnel-price email (NOT the members' pricing_notice_sent_at, which is for
-- the investor prices): stamped per owner after a successful send. A legacy
-- owner moves to tier pricing funnel_notice_days after this.
alter table public.profiles add column if not exists funnel_price_notice_sent_at timestamptz;

-- ── funnels: "Email me each new lead" (default on) ──
alter table public.funnels add column if not exists notify_new_lead boolean not null default true;
-- First time this funnel went live (for "median minutes sign-up to live").
alter table public.funnels add column if not exists first_live_at timestamptz;

-- ── leads: the owner's new-lead email, once per lead across retries ──
-- Claimed (set) before the send and cleared again if the send fails.
alter table public.leads add column if not exists owner_notified_at timestamptz;

-- ── billing_settings: the tiers ──
-- funnel_tiers_from is when tier pricing started: an owner whose first funnel
-- predates it stays on funnel_markup until funnel_notice_days after their
-- funnel-price email. Seeded once, at the moment this first runs.
insert into public.billing_settings (key, value) values
  ('funnel_tiers', '[{"from":1,"pence":500},{"from":21,"pence":400},{"from":61,"pence":325},{"from":151,"pence":250}]'),
  ('funnel_enhanced_extra_pence', '200'),
  ('funnel_notice_days', '30'),
  ('funnel_tiers_from', to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
on conflict (key) do nothing;

-- ── funnel_lead_months: charged funnel leads per owner per UK calendar month ──
create table if not exists public.funnel_lead_months (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  month date not null,
  leads integer not null default 0 check (leads >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, month)
);
alter table public.funnel_lead_months enable row level security;  -- no policies: service role only
revoke all on public.funnel_lead_months from anon, authenticated;

-- ── funnel_lead_charges: one row per charged lead (the guard and the record) ──
-- lead_id is deliberately not a foreign key: leads are purged after six months
-- of inactivity, and what was charged stays countable.
create table if not exists public.funnel_lead_charges (
  lead_id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  funnel_id uuid,
  month date not null,
  n integer,
  base_pence numeric,
  enhanced boolean not null default false,
  tx_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists funnel_lead_charges_owner_idx on public.funnel_lead_charges (owner_id, month);
create index if not exists funnel_lead_charges_month_idx on public.funnel_lead_charges (month);
alter table public.funnel_lead_charges enable row level security;  -- no policies: service role only
revoke all on public.funnel_lead_charges from anon, authenticated;

-- funnel_lead_charge(p): number a finished lead in its owner's UK month and
-- charge its tier price, in one statement.
--   p: {owner, lead, funnel, enhanced, reservation, tiers, enhanced_extra, meta}
--   tiers / enhanced_extra come from the app's validated settings (tiers.ts);
--   missing, the seeded defaults apply.
-- Once per lead: the guard row goes in first, so a retry, the drain and the
-- live route can never charge the same lead twice (they get the first
-- charge back with already = true). Two different leads finishing together
-- are serialised by the month row's lock, so they never share a number. The
-- debit is credit_debit's, unchanged: spend rates apply as for every charge.
-- (Proven with 25 parallel calls: n 1..25, one debit each, no deadlock.)
create or replace function public.funnel_lead_charge(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := nullif(p->>'owner', '')::uuid;
  v_lead uuid := nullif(p->>'lead', '')::uuid;
  v_funnel uuid := nullif(p->>'funnel', '')::uuid;
  v_enh boolean := coalesce((p->>'enhanced')::boolean, false);
  v_res uuid := nullif(p->>'reservation', '')::uuid;
  v_tiers jsonb := case when jsonb_typeof(p->'tiers') = 'array' and jsonb_array_length(p->'tiers') > 0 then p->'tiers'
                        else '[{"from":1,"pence":500},{"from":21,"pence":400},{"from":61,"pence":325},{"from":151,"pence":250}]'::jsonb end;
  v_extra numeric := coalesce(nullif(p->>'enhanced_extra', '')::numeric, 200);
  v_meta jsonb := case when jsonb_typeof(p->'meta') = 'object' then p->'meta' else '{}'::jsonb end;
  v_month date := date_trunc('month', now() at time zone 'Europe/London')::date;
  v_n integer;
  v_price numeric;
  v_tx bigint;
  v_row public.funnel_lead_charges;
begin
  if v_owner is null or v_lead is null then raise exception 'funnel_lead_charge_bad_input'; end if;
  -- The owner's row first, as credit_debit locks it: every charge for an owner
  -- queues here, before the guard and month rows take their foreign-key share
  -- locks on it (which would otherwise deadlock against credit_debit's lock).
  perform 1 from public.profiles where id = v_owner for update;

  insert into public.funnel_lead_charges (lead_id, owner_id, funnel_id, month, enhanced)
  values (v_lead, v_owner, v_funnel, v_month, v_enh)
  on conflict (lead_id) do nothing;
  if not found then
    select * into v_row from public.funnel_lead_charges where lead_id = v_lead;
    return jsonb_build_object('already', true, 'n', v_row.n, 'base_pence', v_row.base_pence, 'tx', v_row.tx_id, 'month', v_row.month);
  end if;

  insert into public.funnel_lead_months (owner_id, month, leads) values (v_owner, v_month, 1)
  on conflict (owner_id, month) do update set leads = public.funnel_lead_months.leads + 1, updated_at = now()
  returning leads into v_n;

  select (t->>'pence')::numeric into v_price
    from jsonb_array_elements(v_tiers) t
   where (t->>'from')::integer <= v_n
   order by (t->>'from')::integer desc
   limit 1;
  if v_price is null or v_price <= 0 then raise exception 'funnel_lead_charge_no_tier'; end if;
  v_price := v_price + case when v_enh then greatest(v_extra, 0) else 0 end;

  v_tx := public.credit_debit(v_owner, v_price, v_res, true,
    v_meta || jsonb_build_object('funnel_id', v_funnel, 'lead_id', v_lead, 'lead_number', v_n, 'lead_month', v_month,
                                 'quantity', 1, 'unit_cost_pence', 0, 'markup', 1));

  update public.funnel_lead_charges set n = v_n, base_pence = v_price, tx_id = v_tx where lead_id = v_lead;
  return jsonb_build_object('already', false, 'n', v_n, 'base_pence', v_price, 'tx', v_tx, 'month', v_month);
end;
$$;
revoke all on function public.funnel_lead_charge(jsonb) from public, anon, authenticated;
grant execute on function public.funnel_lead_charge(jsonb) to service_role;

-- ── mc_page_views: the marketing page's anonymous view count, per UK day ──
-- No user, no cookie, no IP: a count. `tagged` counts views that arrived
-- from an ad or a tagged link (utm_* or fbclid).
create table if not exists public.mc_page_views (
  day date primary key,
  views integer not null default 0,
  tagged integer not null default 0
);
alter table public.mc_page_views enable row level security;  -- no policies: service role only
revoke all on public.mc_page_views from anon, authenticated;

create or replace function public.mc_page_view_hit(p_tagged boolean)
returns void language sql security definer set search_path = public as $$
  insert into public.mc_page_views (day, views, tagged)
  values ((now() at time zone 'Europe/London')::date, 1, case when p_tagged then 1 else 0 end)
  on conflict (day) do update set views = public.mc_page_views.views + 1,
                                  tagged = public.mc_page_views.tagged + case when p_tagged then 1 else 0 end;
$$;
revoke all on function public.mc_page_view_hit(boolean) from public, anon, authenticated;
grant execute on function public.mc_page_view_hit(boolean) to service_role;


-- =========================
-- Batch 23b: the morning briefing
-- =========================
-- Stayful Intelligence opens each member's daily email with a short briefing
-- (src/lib/briefing). Code builds a fact sheet; the AI writes the words; a
-- validator checks every number against the sheet before anything is used.
--
--   briefing_day_counts  one row per UK day: the pool's honest counts at the
--                        time the briefing pass took them (new listings
--                        screened yesterday, live deals, deals that went live
--                        yesterday). Named for what they are: the pool is
--                        never "screened overnight".
--   member_briefings     one row per member per UK day: the briefing itself
--                        (greeting, opener, subject, nudges), the facts it
--                        used, the angle, persona version, model, the charge
--                        (action_id groups its ledger rows), and what the
--                        member did with it (seen in app, dismissed, played,
--                        "Useful" / "Not for me"). The unique (user, day) row
--                        is the claim: a retry never writes or charges twice.
--
-- The kill switch is billing_settings.briefings_enabled (true/false). The two
-- Haiku unit rows are seeded here too, so the first briefing never prices at
-- 0 before credit-sweep's reseed runs. Everything is additive, idempotent and
-- service role only; nothing here is in ACCESS_COLUMNS (src/lib/access.ts).

create table if not exists public.briefing_day_counts (
  uk_day date primary key,
  taken_at timestamptz not null default now(),
  screened_yesterday integer not null default 0,
  live_pool integer not null default 0,
  went_live_yesterday integer not null default 0
);
alter table public.briefing_day_counts enable row level security;  -- no policies: service role only
revoke all on public.briefing_day_counts from anon, authenticated;

create table if not exists public.member_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  uk_day date not null,
  status text not null default 'generating',
  angle text,
  greeting text,
  opener text,
  subject text,
  nudges jsonb not null default '[]'::jsonb,
  facts jsonb,
  facts_used text[],
  persona_version text,
  model text,
  ai_attempted boolean not null default false,
  reject_reason text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  action_id uuid,
  charge_pence numeric(14,4) not null default 0,
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  seen_email_at timestamptz,
  shown_in_app_at timestamptz,
  dismissed_at timestamptz,
  played_count integer not null default 0,
  feedback text,
  feedback_at timestamptz,
  unique (user_id, uk_day)
);
do $$
begin
  alter table public.member_briefings drop constraint if exists member_briefings_status_check;
  alter table public.member_briefings add constraint member_briefings_status_check check (status in ('generating', 'ready', 'template', 'skipped'));
  alter table public.member_briefings drop constraint if exists member_briefings_feedback_check;
  alter table public.member_briefings add constraint member_briefings_feedback_check check (feedback is null or feedback in ('useful', 'not_for_me'));
end $$;
create index if not exists member_briefings_day_idx on public.member_briefings (uk_day, status);
-- Review R3 (R3-62): when the day's email actually carried the briefing.
alter table public.member_briefings add column if not exists emailed_at timestamptz;
alter table public.member_briefings enable row level security;  -- no policies: service role only
revoke all on public.member_briefings from anon, authenticated;

-- Review R3 (R3-68): seeded OFF, so running this section never switches charged AI briefings on by itself;
-- Zac flips it on in /admin/billing after the ?dry=1 review. The ceiling is a setting too (3p by default).
insert into public.billing_settings (key, value) values ('briefings_enabled', 'false')
on conflict (key) do nothing;
insert into public.billing_settings (key, value) values ('briefing_ceiling_pence', '3')
on conflict (key) do nothing;

insert into public.unit_costs (provider, unit, label, unit_cost_pence, markup, notes) values
  ('anthropic', 'haiku45_input_token', 'Anthropic input token (Haiku 4.5)', 0.000079, 5, '$1 per million tokens at 79p a dollar'),
  ('anthropic', 'haiku45_output_token', 'Anthropic output token (Haiku 4.5)', 0.000395, 5, '$5 per million tokens at 79p a dollar')
on conflict (provider, unit) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 24: Stayful Intelligence knowledge
-- =========================
-- One knowledge base for every channel Stayful Intelligence answers on: the
-- question chips (Batch 22), calls (Batch 23) and the typed chat (Batch 26).
-- Nothing goes live without Zac's approval on /admin/intelligence/knowledge;
-- every figure in an answer is a {placeholder} resolved from settings when
-- the answer is shown (src/lib/knowledge). A nightly job groups the
-- questions Stayful Intelligence could not answer and drafts one answer per
-- group for Zac to approve (house spend, capped).
--
--   si_knowledge                 one row per answer, by a stable slug. The live
--                                columns (question … show_when) are what members
--                                can get; `draft` holds a pending proposal and is
--                                never shown to a member. Every update bumps
--                                `version` (trigger), so a write can be made
--                                conditional on what was read.
--   si_knowledge_live            the only way to read answers for members: live,
--                                approved, not stale, not retired. No draft column.
--   si_knowledge_history         every created / edited / approved / rejected /
--                                staled / seeded / retired event, with before/after.
--   si_knowledge_gaps            the nightly job's groups of unanswered questions:
--                                a label, counts by channel and outcome, and the
--                                entry drafted for it (or the entry it matched).
--   si_knowledge_gap_questions   which question went into which group (each
--                                question is grouped once; deleted with it).
--   si_gap_runs                  one row per nightly run and per Monday email
--                                (the claim: never twice), plus one per dry run;
--                                each carries what it spent on models.
--   si_member_facts              what a member asked Stayful Intelligence to
--                                remember, only after they said yes. The member
--                                sees and deletes them in Account.
--
-- Every table is service role only (RLS on, no policies, nothing granted to
-- anon or authenticated). Nothing here is in ACCESS_COLUMNS
-- (src/lib/access.ts), and must not become so. Everything is additive and
-- idempotent; until this runs, the Stayful Intelligence chips and the agent's
-- knowledge are empty and the nightly job does nothing (it fails closed).

create table if not exists public.si_knowledge (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  question text,
  variants text[] not null default '{}',
  answer text,
  category text,
  channels text[] not null default '{}',
  show_when text,
  draft jsonb,
  draft_state text not null default 'none',
  draft_hash text,
  draft_source text,
  draft_note text,
  draft_at timestamptz,
  version integer not null default 1,
  approved_at timestamptz,
  approved_by text,
  stale_reason text,
  stale_at timestamptz,
  retired_at timestamptz,
  source text not null,
  seed_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  alter table public.si_knowledge drop constraint if exists si_knowledge_draft_state_check;
  alter table public.si_knowledge add constraint si_knowledge_draft_state_check check (draft_state in ('none', 'pending', 'rejected'));
  alter table public.si_knowledge drop constraint if exists si_knowledge_source_check;
  alter table public.si_knowledge add constraint si_knowledge_source_check check (source in ('seed', 'gap', 'manual'));
  alter table public.si_knowledge drop constraint if exists si_knowledge_draft_source_check;
  alter table public.si_knowledge add constraint si_knowledge_draft_source_check check (draft_source is null or draft_source in ('seed', 'gap', 'manual'));
  alter table public.si_knowledge drop constraint if exists si_knowledge_slug_check;
  alter table public.si_knowledge add constraint si_knowledge_slug_check check (slug ~ '^[a-z][a-z0-9_]{1,47}$');
end $$;
create index if not exists si_knowledge_updated_idx on public.si_knowledge (updated_at desc);
alter table public.si_knowledge enable row level security;  -- no policies: service role only
revoke all on public.si_knowledge from anon, authenticated;

-- Every update bumps the version and the time, so conditional writes are exact.
create or replace function public.si_knowledge_bump()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.si_knowledge_bump() from public, anon, authenticated;
drop trigger if exists si_knowledge_bump on public.si_knowledge;
create trigger si_knowledge_bump before update on public.si_knowledge for each row execute function public.si_knowledge_bump();

create or replace view public.si_knowledge_live with (security_invoker = true) as
  select id, slug, version, question, variants, answer, category, channels, show_when, approved_at
  from public.si_knowledge
  where answer is not null and question is not null and category is not null
    and approved_at is not null  -- Review R3 (R3-125): live means approved, not just "has an answer"
    and stale_reason is null and retired_at is null;
revoke all on public.si_knowledge_live from anon, authenticated;

create table if not exists public.si_knowledge_history (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.si_knowledge(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  version integer,
  before jsonb,
  after jsonb,
  note text
);
create index if not exists si_knowledge_history_entry_idx on public.si_knowledge_history (entry_id, at desc);
alter table public.si_knowledge_history enable row level security;  -- no policies: service role only
revoke all on public.si_knowledge_history from anon, authenticated;

-- Approve: the pending draft becomes the live answer, or (mode 'live') a stale
-- entry's live answer is approved again as it stands. Refused unless the row
-- is still the version (and the draft the hash) the admin was shown, so a seed
-- run or the nightly job can never swap the text under the click.
create or replace function public.si_knowledge_approve(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_version integer := (p->>'version')::integer;
  v_hash text := p->>'hash';
  v_by text := coalesce(nullif(p->>'by', ''), 'admin');
  v_mode text := coalesce(p->>'mode', 'draft');
  r public.si_knowledge%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_new integer;
begin
  select * into r from public.si_knowledge where id = v_id for update;
  if not found then return jsonb_build_object('refused', 'missing'); end if;
  if r.version is distinct from v_version then return jsonb_build_object('refused', 'changed'); end if;
  if r.retired_at is not null then return jsonb_build_object('refused', 'retired'); end if;
  v_before := jsonb_build_object('question', r.question, 'variants', to_jsonb(r.variants), 'answer', r.answer, 'category', r.category,
    'channels', to_jsonb(r.channels), 'show_when', r.show_when, 'stale_reason', r.stale_reason);
  if v_mode = 'live' then
    if r.answer is null or r.stale_reason is null then return jsonb_build_object('refused', 'not_stale'); end if;
    update public.si_knowledge set stale_reason = null, stale_at = null, approved_at = now(), approved_by = v_by
      where id = v_id returning version into v_new;
    v_after := v_before - 'stale_reason';
  else
    if r.draft_state <> 'pending' or r.draft is null then return jsonb_build_object('refused', 'no_draft'); end if;
    if r.draft_hash is distinct from v_hash then return jsonb_build_object('refused', 'changed'); end if;
    update public.si_knowledge set
      question = r.draft->>'question',
      variants = coalesce(array(select jsonb_array_elements_text(coalesce(r.draft->'variants', '[]'::jsonb))), '{}'),
      answer = r.draft->>'answer',
      category = r.draft->>'category',
      channels = coalesce(array(select jsonb_array_elements_text(coalesce(r.draft->'channels', '[]'::jsonb))), '{}'),
      show_when = nullif(r.draft->>'show_when', ''),
      draft = null, draft_state = 'none', draft_hash = null, draft_source = null, draft_note = null, draft_at = null,
      stale_reason = null, stale_at = null, approved_at = now(), approved_by = v_by
      where id = v_id returning version into v_new;
    v_after := r.draft;
  end if;
  insert into public.si_knowledge_history (entry_id, actor, action, version, before, after)
    values (v_id, v_by, 'approved', v_new, v_before, v_after);
  return jsonb_build_object('id', v_id, 'version', v_new);
end $$;
revoke all on function public.si_knowledge_approve(jsonb) from public, anon, authenticated;
grant execute on function public.si_knowledge_approve(jsonb) to service_role;

create table if not exists public.si_knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status text not null default 'open',
  entry_id uuid references public.si_knowledge(id) on delete set null,
  match_kind text,
  asked integer not null default 0,
  asked_since_decision integer not null default 0,
  channels jsonb not null default '{}'::jsonb,
  outcomes jsonb not null default '{}'::jsonb,
  draft_attempts integer not null default 0,
  last_error text,
  uncovered boolean not null default false,
  first_asked_at timestamptz,
  last_asked_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  alter table public.si_knowledge_gaps drop constraint if exists si_knowledge_gaps_status_check;
  alter table public.si_knowledge_gaps add constraint si_knowledge_gaps_status_check check (status in ('open', 'drafted', 'covered', 'rejected', 'dismissed', 'failed'));
  alter table public.si_knowledge_gaps drop constraint if exists si_knowledge_gaps_match_check;
  alter table public.si_knowledge_gaps add constraint si_knowledge_gaps_match_check check (match_kind is null or match_kind in ('draft', 'approved', 'rejected'));
  alter table public.si_knowledge_gaps drop constraint if exists si_knowledge_gaps_label_check;
  alter table public.si_knowledge_gaps add constraint si_knowledge_gaps_label_check check (char_length(label) between 1 and 300);
end $$;
create index if not exists si_knowledge_gaps_status_idx on public.si_knowledge_gaps (status, asked desc);
create index if not exists si_knowledge_gaps_first_idx on public.si_knowledge_gaps (first_asked_at desc);
alter table public.si_knowledge_gaps enable row level security;  -- no policies: service role only
revoke all on public.si_knowledge_gaps from anon, authenticated;

create table if not exists public.si_knowledge_gap_questions (
  question_id uuid primary key references public.si_conversation_questions(id) on delete cascade,
  gap_id uuid references public.si_knowledge_gaps(id) on delete cascade,
  grouped_at timestamptz not null default now()
);
create index if not exists si_knowledge_gap_questions_gap_idx on public.si_knowledge_gap_questions (gap_id);
alter table public.si_knowledge_gap_questions enable row level security;  -- no policies: service role only
revoke all on public.si_knowledge_gap_questions from anon, authenticated;

create table if not exists public.si_gap_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  run_key text not null,
  status text not null default 'running',
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  cost_pence numeric(14,4) not null default 0,
  report jsonb
);
do $$
begin
  alter table public.si_gap_runs drop constraint if exists si_gap_runs_kind_check;
  alter table public.si_gap_runs add constraint si_gap_runs_kind_check check (kind in ('nightly', 'weekly', 'dry'));
  alter table public.si_gap_runs drop constraint if exists si_gap_runs_status_check;
  alter table public.si_gap_runs add constraint si_gap_runs_status_check check (status in ('running', 'done', 'failed'));
end $$;
create unique index if not exists si_gap_runs_once_uidx on public.si_gap_runs (kind, run_key) where kind in ('nightly', 'weekly');
create index if not exists si_gap_runs_claimed_idx on public.si_gap_runs (claimed_at desc);
alter table public.si_gap_runs enable row level security;  -- no policies: service role only
revoke all on public.si_gap_runs from anon, authenticated;

-- The once-only claim for a nightly run (run_key = the UK day) or a Monday
-- email (run_key = the week's Monday). A run already done, or one still
-- running inside stale_ms, is not claimed again; a failed or abandoned one is.
create or replace function public.si_gap_claim(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_kind text := p->>'kind';
  v_key text := p->>'run_key';
  v_stale interval := make_interval(secs => greatest(60, coalesce((p->>'stale_ms')::numeric, 1800000) / 1000));
  v_id uuid;
  v_cost numeric := 0;
begin
  if v_kind not in ('nightly', 'weekly') or coalesce(v_key, '') = '' then return jsonb_build_object('refused', 'bad_args'); end if;
  insert into public.si_gap_runs (kind, run_key) values (v_kind, v_key)
    on conflict (kind, run_key) where kind in ('nightly', 'weekly') do nothing
    returning id into v_id;
  if v_id is null then
    -- A retry keeps what the failed attempt spent (cost_pence), so the month's cap still counts it.
    update public.si_gap_runs set status = 'running', claimed_at = now(), finished_at = null
      where kind = v_kind and run_key = v_key
        and (status = 'failed' or (status = 'running' and claimed_at < now() - v_stale))
      returning id, cost_pence into v_id, v_cost;
  end if;
  return jsonb_build_object('id', v_id, 'cost_pence', coalesce(v_cost, 0));
end $$;
revoke all on function public.si_gap_claim(jsonb) from public, anon, authenticated;
grant execute on function public.si_gap_claim(jsonb) to service_role;

create table if not exists public.si_member_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fact text not null,
  asked text,
  channel text not null,
  confirmed_via text not null,
  conversation_id uuid references public.si_conversations(id) on delete set null,
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now()
);
do $$
begin
  alter table public.si_member_facts drop constraint if exists si_member_facts_fact_check;
  alter table public.si_member_facts add constraint si_member_facts_fact_check check (char_length(fact) between 1 and 160);
  alter table public.si_member_facts drop constraint if exists si_member_facts_asked_check;
  alter table public.si_member_facts add constraint si_member_facts_asked_check check (asked is null or char_length(asked) <= 300);
  alter table public.si_member_facts drop constraint if exists si_member_facts_channel_check;
  alter table public.si_member_facts add constraint si_member_facts_channel_check check (channel in ('call', 'chat', 'view'));
  alter table public.si_member_facts drop constraint if exists si_member_facts_confirmed_check;
  alter table public.si_member_facts add constraint si_member_facts_confirmed_check check (confirmed_via in ('call_yes', 'chat_yes', 'app'));
end $$;
create unique index if not exists si_member_facts_once_uidx on public.si_member_facts (user_id, lower(fact));
create index if not exists si_member_facts_user_idx on public.si_member_facts (user_id, created_at desc);
alter table public.si_member_facts enable row level security;  -- no policies: service role only
revoke all on public.si_member_facts from anon, authenticated;

-- Remember a confirmed fact: one member at a time (advisory lock), refused at
-- the cap or as a repeat, so two confirmations at once can never pass the cap.
create or replace function public.si_fact_remember(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_user uuid := (p->>'user_id')::uuid;
  v_fact text := btrim(coalesce(p->>'fact', ''));
  v_max integer := greatest(0, coalesce((p->>'max')::integer, 30));
  v_n integer;
  v_id uuid;
begin
  if v_user is null or v_fact = '' then return jsonb_build_object('refused', 'bad_args'); end if;
  perform pg_advisory_xact_lock(hashtext('public.si_member_facts:' || v_user::text));
  if exists (select 1 from public.si_member_facts f where f.user_id = v_user and lower(f.fact) = lower(v_fact)) then
    return jsonb_build_object('refused', 'duplicate');
  end if;
  select count(*) into v_n from public.si_member_facts f where f.user_id = v_user;
  if v_n >= v_max then return jsonb_build_object('refused', 'cap'); end if;
  insert into public.si_member_facts (user_id, fact, asked, channel, confirmed_via, conversation_id, confirmed_at)
    values (v_user, v_fact, nullif(btrim(coalesce(p->>'asked', '')), ''), p->>'channel', p->>'confirmed_via',
      nullif(p->>'conversation_id', '')::uuid, coalesce((p->>'confirmed_at')::timestamptz, now()))
    returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;
revoke all on function public.si_fact_remember(jsonb) from public, anon, authenticated;
grant execute on function public.si_fact_remember(jsonb) to service_role;

-- Retention for the learning log: members' questions (and their outcomes) are
-- kept si_question_retention_months, then deleted oldest first, with any gap
-- whose questions have all gone. Refuses a cutoff less than a year old,
-- whatever is asked. apply false (the default) only counts.
-- Review R3 (R3-100 / R2-154): with them, the conversations past the cutoff
-- whose questions have all gone (their turns went at
-- si_transcript_retention_days) and the call records past it. Intro rows
-- stay: si_calls_log_intro_uidx is how "one intro ever" is kept.
create or replace function public.si_question_retention(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_before timestamptz := (p->>'before')::timestamptz;
  v_apply boolean := coalesce((p->>'apply')::boolean, false);
  v_limit integer := least(200000, greatest(1, coalesce((p->>'limit')::integer, 20000)));
  v_questions integer;
  v_gaps integer;
  v_conversations integer;
  v_calls integer;
  v_more boolean;
begin
  if v_before is null or v_before > now() - interval '12 months' then
    raise exception 'si_question_retention: the cutoff must be at least 12 months ago';
  end if;
  if not v_apply then
    select count(*) into v_questions from public.si_conversation_questions q where q.at < v_before;
    select count(*) into v_gaps from public.si_knowledge_gaps g
      where g.last_asked_at < v_before;
    select count(*) into v_conversations from public.si_conversations c
      where c.started_at < v_before and not exists (select 1 from public.si_conversation_questions q where q.conversation_id = c.id);
    select count(*) into v_calls from public.si_calls_log l where l.queued_at < v_before and l.call_type <> 'intro';
    return jsonb_build_object('dry', true, 'before', v_before, 'questions', v_questions, 'gaps', v_gaps, 'conversations', v_conversations, 'calls', v_calls, 'more', v_questions > v_limit);
  end if;
  with gone as (
    delete from public.si_conversation_questions q
    where q.id in (select x.id from public.si_conversation_questions x where x.at < v_before order by x.at limit v_limit)
    returning 1
  ) select count(*) into v_questions from gone;
  with gone as (
    delete from public.si_knowledge_gaps g
    where g.last_asked_at < v_before
      and not exists (select 1 from public.si_knowledge_gap_questions gq where gq.gap_id = g.id)
    returning 1
  ) select count(*) into v_gaps from gone;
  with gone as (
    delete from public.si_conversations c
    where c.started_at < v_before
      and not exists (select 1 from public.si_conversation_questions q where q.conversation_id = c.id)
    returning 1
  ) select count(*) into v_conversations from gone;
  with gone as (
    delete from public.si_calls_log l
    where l.queued_at < v_before and l.call_type <> 'intro'
    returning 1
  ) select count(*) into v_calls from gone;
  select exists (select 1 from public.si_conversation_questions q where q.at < v_before) into v_more;
  return jsonb_build_object('dry', false, 'before', v_before, 'questions', v_questions, 'gaps', v_gaps, 'conversations', v_conversations, 'calls', v_calls, 'more', v_more);
end $$;
revoke all on function public.si_question_retention(jsonb) from public, anon, authenticated;
grant execute on function public.si_question_retention(jsonb) to service_role;

-- The nightly job's next questions: those with an outcome in p.outcomes that
-- no run has grouped yet, oldest first, at most p.limit, with the
-- conversation's channel. Grouped ones are excluded here, before the limit,
-- so the job always moves on to new questions. For a "member unhappy" row
-- from the post-call analysis, `prior` is the question asked just before it
-- in the same conversation (the one to learn from).
create or replace function public.si_gap_new_questions(p jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'question', x.question, 'outcome', x.outcome, 'source', x.source, 'at', x.at, 'conversation_id', x.conversation_id, 'channel', x.channel, 'prior', x.prior) order by x.at), '[]'::jsonb)
  from (
    select q.id, q.question, q.outcome, q.source, q.at, q.conversation_id, c.channel,
      case when q.outcome = 'member_unhappy' and q.source = 'analysis' then (
        select q2.question from public.si_conversation_questions q2
        where q2.conversation_id = q.conversation_id and q2.outcome <> 'member_unhappy' and q2.at <= q.at
        order by q2.at desc limit 1
      ) end as prior
    from public.si_conversation_questions q
    join public.si_conversations c on c.id = q.conversation_id
    where q.outcome in (select jsonb_array_elements_text(coalesce(p->'outcomes', '[]'::jsonb)))
      and not exists (select 1 from public.si_knowledge_gap_questions gq where gq.question_id = q.id)
    order by q.at
    limit least(2000, greatest(1, coalesce((p->>'limit')::integer, 200)))
  ) x
$$;
revoke all on function public.si_gap_new_questions(jsonb) from public, anon, authenticated;
grant execute on function public.si_gap_new_questions(jsonb) to service_role;

-- Coverage (/admin/intelligence/coverage and the Monday email): the questions
-- asked from p.since (to p.until), counted by UK week (its Monday), channel,
-- outcome and the knowledge entry used. One jsonb array, so no row limit
-- cuts it short; no member id or question text leaves the table.
create or replace function public.si_question_counts(p jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('week', x.week, 'channel', x.channel, 'outcome', x.outcome, 'ref', x.ref, 'n', x.n)), '[]'::jsonb)
  from (
    select to_char(date_trunc('week', q.at at time zone 'Europe/London'), 'YYYY-MM-DD') as week,
           c.channel, q.outcome, left(q.knowledge_ref, 80) as ref, count(*)::integer as n
    from public.si_conversation_questions q
    join public.si_conversations c on c.id = q.conversation_id
    where q.at >= (p->>'since')::timestamptz
      and (p->>'until' is null or q.at < (p->>'until')::timestamptz)
    group by 1, 2, 3, 4
  ) x
$$;
revoke all on function public.si_question_counts(jsonb) from public, anon, authenticated;
grant execute on function public.si_question_counts(jsonb) to service_role;

-- Settings (defaults and bounds in src/lib/knowledge/settings.ts; a missing or
-- bad row takes the default). Edited on /admin/intelligence/knowledge and /gaps.
--   si_kb_answer_min_confidence   a typed question matched at or above this is answered
--   si_kb_low_confidence_min      between this and the above: low confidence; below: not answered
--   si_gap_max_groups_per_night   the most answers the nightly job drafts in one night
--   si_gap_max_questions          the most new questions it reads in one night
--   si_gap_monthly_cap_pence      its model spend per UK month, raw pence (house spend)
--   si_facts_max                  the most facts kept per member
--   si_question_retention_months  members' questions are deleted after this (never under 12)
insert into public.billing_settings (key, value) values
  ('si_kb_answer_min_confidence', '0.55'::jsonb),
  ('si_kb_low_confidence_min', '0.3'::jsonb),
  ('si_gap_max_groups_per_night', '20'::jsonb),
  ('si_gap_max_questions', '200'::jsonb),
  ('si_gap_monthly_cap_pence', '1500'::jsonb),
  ('si_facts_max', '30'::jsonb),
  ('si_question_retention_months', '24'::jsonb)
on conflict (key) do nothing;

-- The nightly job's prompt-cache units (the input and output rows came with
-- Batches 17 and 23b). Also in src/lib/credit/costs.ts.
insert into public.unit_costs (provider, unit, label, unit_cost_pence, markup, notes) values
  ('anthropic', 'haiku45_cache_read_token', 'Anthropic cache read token (Haiku 4.5)', 0.0000079, 5, '$0.10 per million tokens at 79p a dollar'),
  ('anthropic', 'haiku45_cache_write_token', 'Anthropic cache write token (Haiku 4.5)', 0.00009875, 5, '$1.25 per million tokens at 79p a dollar'),
  ('anthropic', 'sonnet55_cache_read_token', 'Anthropic cache read token (Sonnet 5.5)', 0.0000158, 5, '$0.20 per million tokens at 79p a dollar'),
  ('anthropic', 'sonnet55_cache_write_token', 'Anthropic cache write token (Sonnet 5.5)', 0.0001975, 5, '$2.50 per million tokens at 79p a dollar')
on conflict (provider, unit) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 25: standout-deal calls
-- =========================
-- A deal that fits a member better than anything else is saved straight into
-- their My deals ("Saved for you by Stayful Intelligence", free to open) by
-- an hourly job (/api/internal/standout, src/lib/standout), and at most
-- standout_calls_per_month times a calendar month Stayful Intelligence rings
-- them about it (Batch 23's queue, call_type 'deal'). Every judgement is a
-- row in standout_decisions with its reason, so admin (/admin/standout) and
-- Batch 26's chat can say why a member was or wasn't called. Also here: the
-- slower-spender nudge's once-per-credit claim. Additive; nothing is added to
-- ACCESS_COLUMNS. Two check lists earlier in the file were widened in place
-- (sms_messages.kind: standout, nudge; si_calls_log.call_type: deal).

-- ── deal_reactions.saved_by: who made a Keep ──
-- null = the member; 'stayful_intelligence' = an auto-save. Every member
-- write (Keep, Pass, a stage move, an email answer) sets it back to null, so
-- a save the member acts on becomes their own. Things that learn from or
-- reward a member's Keeps (tailoring, picks feedback, the £1 checklist step,
-- other members' "getting attention" counts, Your week) skip SI saves.
alter table public.deal_reactions add column if not exists saved_by text;
do $$ begin
  alter table public.deal_reactions drop constraint if exists deal_reactions_saved_by_check;
  alter table public.deal_reactions add constraint deal_reactions_saved_by_check check (saved_by is null or saved_by = 'stayful_intelligence');
end $$;
create index if not exists deal_reactions_saved_by_idx on public.deal_reactions (user_id) where saved_by is not null;

-- ── standout_runs: one row per pass of the job, and its watermarks ──
--   paid_through   deals that went live up to here were judged for paying members
--   free_through   deals that went live up to here were judged for free members
--                  (it trails paid_through by free_deal_delay_hours)
-- The next pass starts a few minutes before each, so a recheck committing late
-- is never missed; standout_decisions' unique index stops a second judgement.
create table if not exists public.standout_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'cron',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  paid_through timestamptz,
  free_through timestamptz,
  summary jsonb not null default '{}'::jsonb
);
do $$ begin
  alter table public.standout_runs drop constraint if exists standout_runs_kind_check;
  alter table public.standout_runs add constraint standout_runs_kind_check check (kind in ('cron', 'admin'));
end $$;
create index if not exists standout_runs_finished_idx on public.standout_runs (finished_at desc) where finished_at is not null;
alter table public.standout_runs enable row level security;  -- no policies: service role only
revoke all on public.standout_runs from anon, authenticated;

-- ── standout_decisions: every judgement, and what happened next ──
--   deal_id null      a member-level reason (no minimum-profit answer, no
--                     primary profile, a client or paused profile, …), at most
--                     one row per member, day and reason
--   outcome           standout | not_standout | skipped | waiting (a listing
--                     to recheck before it can count)
--   reason            a code from src/lib/standout/reasons.ts
--   profit_basis      range (the low end of the profit range) | after_works |
--                     after_refinance (Batch 17's BRRR figures)
--   notify            call | email ("Saved for you") | none
--   link_token        the short /si/deal/<token> link in texts (never the listing)
-- Not-standout rows are deleted after standout_keep_days; standout rows stay.
create table if not exists public.standout_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  profile_id uuid references public.search_profiles(id) on delete set null,
  deal_id uuid references public.marketplace_deals(id) on delete cascade,
  deal_type text,
  uk_day date not null,
  tier text not null,
  outcome text not null,
  reason text not null,
  match_pct integer,
  met integer,
  checked integer,
  reveal_pct integer,
  profit_low_pcm integer,
  profit_high_pcm integer,
  profit_basis text,
  min_profit_pcm integer,
  live_confirmed_at timestamptz,
  saved_at timestamptz,
  notify text,
  call_id uuid references public.si_calls_log(id) on delete set null,
  call_status text,
  link_token text,
  texted_at timestamptz,
  emailed_at timestamptz,
  not_for_me_at timestamptz,
  opened_at timestamptz,
  stage_moved_at timestamptz,
  forced boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ begin
  alter table public.standout_decisions drop constraint if exists standout_decisions_tier_check;
  alter table public.standout_decisions add constraint standout_decisions_tier_check check (tier in ('paid', 'free'));
  alter table public.standout_decisions drop constraint if exists standout_decisions_outcome_check;
  alter table public.standout_decisions add constraint standout_decisions_outcome_check check (outcome in ('standout', 'not_standout', 'skipped', 'waiting'));
  alter table public.standout_decisions drop constraint if exists standout_decisions_notify_check;
  alter table public.standout_decisions add constraint standout_decisions_notify_check check (notify is null or notify in ('call', 'email', 'none'));
  alter table public.standout_decisions drop constraint if exists standout_decisions_basis_check;
  alter table public.standout_decisions add constraint standout_decisions_basis_check check (profit_basis is null or profit_basis in ('range', 'after_works', 'after_refinance'));
end $$;
-- Not partial, so an upsert can name it (a null deal_id never collides).
create unique index if not exists standout_decisions_deal_uidx on public.standout_decisions (user_id, deal_id);
create unique index if not exists standout_decisions_member_uidx on public.standout_decisions (user_id, uk_day, reason) where deal_id is null;
create unique index if not exists standout_decisions_token_uidx on public.standout_decisions (link_token) where link_token is not null;
create index if not exists standout_decisions_created_idx on public.standout_decisions (created_at desc);
create index if not exists standout_decisions_saved_idx on public.standout_decisions (user_id, saved_at desc) where saved_at is not null;
create index if not exists standout_decisions_waiting_idx on public.standout_decisions (outcome) where outcome = 'waiting';
alter table public.standout_decisions enable row level security;  -- no policies: service role only
revoke all on public.standout_decisions from anon, authenticated;

-- ── credit_nudges: the slower-spender nudge, once per credit landing ──
-- A member who took slower_spender_min_days–_max_days to get down to
-- low_credit_pence after their most recent credit (Batch 23's latestLanding)
-- gets one text + email with the auto top-up link, instead of that cycle's
-- £5 notice. Claimed when decided; sent in the first slot of the text window.
--   status   due (claimed, not sent yet) | sent | skipped (nothing could go)
create table if not exists public.credit_nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  landing_id text not null,
  days_to_low integer,
  status text not null default 'due',
  decided_at timestamptz not null default now(),
  sent_at timestamptz,
  text_sent boolean not null default false,
  email_sent boolean not null default false,
  skip_reason text,
  unique (user_id, landing_id)
);
do $$ begin
  alter table public.credit_nudges drop constraint if exists credit_nudges_status_check;
  alter table public.credit_nudges add constraint credit_nudges_status_check check (status in ('due', 'sent', 'skipped'));
end $$;
create index if not exists credit_nudges_due_idx on public.credit_nudges (decided_at) where status = 'due';
alter table public.credit_nudges enable row level security;  -- no policies: service role only
revoke all on public.credit_nudges from anon, authenticated;

-- ── Deal calls: one per member per deal (R2-168) ──
-- Without it a deal call that has ended could be queued again for the same
-- deal by the next pass. trigger_ref is the deal id.
-- Review R3 (R3-104): a deal call that failed at the provider is not the deal's one call; it may be queued once more
-- (the standout plan allows one retry, then tells the member by email).
-- Review R4 (R4-47): the older index (without the failed-row exception) is dropped once; a re-run finds the new
-- one and leaves it untouched, so the calls cron's inserts never wait on a rebuild.
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'si_calls_log_deal_uidx' and indexdef not like '%failed%') then
    drop index public.si_calls_log_deal_uidx;
  end if;
end $$;
create unique index if not exists si_calls_log_deal_uidx on public.si_calls_log (user_id, trigger_ref) where call_type = 'deal' and status <> 'failed';

-- ── A face debit never takes credit an open reservation holds (R2-13) ──
-- Batch 23's calls (minutes, texts, the missed-call email), this batch's deal
-- texts and nudges, and team seats all debit through credit_debit_face. It
-- checked the grants alone, so a call could spend credit a running analysis,
-- deep search or funnel lead had reserved, and that action then overdrew (or,
-- for a deep search, went free). Redefined here as it was, plus one check:
-- the base pence the walk takes may not exceed credit_available's spendable
-- base (the grants' base value less open reservations). This is the one
-- definition: the Teams section's earlier copy was removed (Review R3, R3-153).
-- Batch 29: a restricted starter pack bonus is walked only for an action
-- credit_bonus_pays_for allows (none of today's face debits: calls, texts,
-- emails, nudges and seats are all paid from other credit), and the R2-13
-- check uses that action's spendable base (credit_spendable_for).
create or replace function public.credit_debit_face(p_user uuid, p_face_pence numeric, p_meta jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_remaining numeric := round(p_face_pence, 4);
  v_available numeric;
  v_spendable_base numeric;
  v_tx bigint;
  v_total_base numeric := 0;
  v_take_grant numeric;
  v_take_base numeric;
  v_action text := nullif(p_meta ->> 'action', '');
  v_bonus_ok boolean;
  g record;
begin
  if v_remaining <= 0 then return null; end if;
  perform 1 from profiles where id = p_user for update;
  v_bonus_ok := credit_bonus_pays_for(v_action, p_meta);

  v_available := credit_face_available_for(p_user, v_action);
  if v_available < v_remaining then
    raise exception 'insufficient_credit' using errcode = 'P0402',
      detail = json_build_object('required_face', v_remaining, 'available_face', v_available)::text;
  end if;
  v_spendable_base := coalesce(credit_spendable_for(p_user, v_action, p_meta), 0);

  insert into credit_transactions (user_id, kind, amount_pence, base_pence, action_id, action, description, metadata)
  values (
    p_user, 'debit', -v_remaining, 0,
    nullif(p_meta ->> 'action_id', '')::uuid, p_meta ->> 'action', p_meta ->> 'description',
    p_meta - array['action_id', 'action', 'description']
  ) returning id into v_tx;

  for g in
    select id, remaining_pence, spend_rate from credit_grants
    where user_id = p_user and remaining_pence > 0 and (expires_at is null or expires_at > now())
      and (v_bonus_ok or not (scope is not distinct from 'pack_bonus' and scope_lifted_at is null))
    order by (v_bonus_ok and scope is not distinct from 'pack_bonus' and scope_lifted_at is null) desc, priority, expires_at nulls last, created_at
    for update
  loop
    exit when v_remaining <= 0;
    v_take_grant := least(v_remaining, g.remaining_pence);
    v_take_base := round(v_take_grant / g.spend_rate, 4);
    update credit_grants set remaining_pence = remaining_pence - v_take_grant where id = g.id;
    insert into credit_allocations (transaction_id, grant_id, base_pence, grant_pence, spend_rate) values (v_tx, g.id, v_take_base, v_take_grant, g.spend_rate);
    v_total_base := v_total_base + v_take_base;
    v_remaining := v_remaining - v_take_grant;
  end loop;

  if v_remaining > 0.0001 then
    raise exception 'insufficient_credit' using errcode = 'P0402',
      detail = json_build_object('required_face', p_face_pence, 'shortfall_face', v_remaining)::text;
  end if;
  -- R2-13: what is left must still cover every open reservation (the raise undoes the walk).
  if v_total_base > v_spendable_base + 0.0001 then
    raise exception 'insufficient_credit' using errcode = 'P0402',
      detail = json_build_object('required_face', p_face_pence, 'required_base', v_total_base, 'spendable_base', v_spendable_base)::text;
  end if;

  update credit_transactions set base_pence = v_total_base where id = v_tx;
  return v_tx;
end;
$$;
revoke execute on function public.credit_debit_face(uuid, numeric, jsonb) from public, anon, authenticated;

-- Settings (defaults and bounds in src/lib/standout/settings.ts; a missing or
-- bad row takes the default). Edited on /admin/standout.
--   standout_min_match_pct           match (met ÷ checked) at or above this…
--   standout_min_checked             …over at least this many checked answers
--   standout_profit_over_min_pct     the low end of the profit at least this % above the member's minimum
--   standout_live_confirm_hours      the listing confirmed live within this; older is rechecked first
--   standout_calls_per_month         deal calls a member may get in a UK calendar month
--   standout_call_min_balance_pence  no deal call below this balance (Batch 23's own minute-plus-texts check also applies)
--   standout_rechecks_per_run        listings a pass may recheck itself; the rest wait for the hourly recheck
--   standout_max_per_day             standouts saved for a member in a UK day (the best); 0 = no limit
--   standout_beat_best_days          a standout must make more than every deal at least as good shown or saved to the member in this many days; 0 = off
--   standout_keep_days               not-standout decisions are kept this long
--   slower_spender_min_days / _max_days   the nudge's window: days from the most recent credit to the £5 mark
insert into public.billing_settings (key, value) values
  ('standout_min_match_pct', '90'::jsonb),
  ('standout_min_checked', '5'::jsonb),
  ('standout_profit_over_min_pct', '25'::jsonb),
  ('standout_live_confirm_hours', '6'::jsonb),
  ('standout_calls_per_month', '2'::jsonb),
  ('standout_call_min_balance_pence', '100'::jsonb),
  ('standout_rechecks_per_run', '3'::jsonb),
  ('standout_max_per_day', '1'::jsonb),
  ('standout_beat_best_days', '30'::jsonb),
  ('standout_keep_days', '90'::jsonb),
  ('slower_spender_min_days', '8'::jsonb),
  ('slower_spender_max_days', '21'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 26: typed chat
-- =========================
-- Stayful Intelligence answers typed questions in two places: quick answers
-- under the header eye (Haiku 4.5, knowledge only) and the full view's text
-- box (Sonnet 5.5, knowledge plus read-only tools over the member's own
-- deals). Both are charged actual tokens × si_chat_markup through the credit
-- system (reserve, meter, release), once, only for a delivered answer; a
-- failed, empty, refused or "I don't know" answer is logged as house spend
-- and never charged. The question and answer text live only in Batch 23's
-- conversation log (channel 'chat'); chat_turns holds the tokens, the charge
-- and the retry guard, never any text. Code: src/lib/chat. Additive; nothing
-- is added to ACCESS_COLUMNS.

-- R2-87: a question in the log can come from the chat ('chat' is in
-- si_conversation_questions_source_check, in the Batch 23 section).

-- ── chat_turns: one row per typed question ──
--   id              also the ledger action_id of its charge (credit_transactions.action_id)
--   user_id         who asked; nulled after si_transcript_retention_days and when they delete their history
--   payer_id        whose credit paid (a team member's owner); nulled with user_id
--   client_turn_id  the browser's id for this send: a retry or reconnect with the same id never asks or charges twice
--   surface         quick | full
--   status          pending (one per member at a time) | answered (charged) | no_answer (don't know, ask in the full view, refused) | failed
--   outcome         the conversation log's outcome for the question
--   *_tokens        every model round added up; raw_pence our cost; charged_*_pence what the member paid (base, and as deducted)
--   capped          the answer was cut short at the question's ceiling
--   fact_proposal   "Want me to remember that?": the fact shown, saved only on the member's yes
--   log_seq         the answer's turn in si_conversation_turns (a reconnect gets the stored answer back, uncharged)
--   buttons         the answer's buttons (kinds and internal links only; src/lib/chat/actions.ts)
--   match_confidence the knowledge matcher's best score for the question (admin's examples either side of the threshold)
create table if not exists public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  payer_id uuid,
  client_turn_id uuid not null,
  surface text not null,
  status text not null default 'pending',
  outcome text,
  conversation_id uuid references public.si_conversations(id) on delete set null,
  question_id uuid,
  model text,
  rounds integer not null default 0,
  tools_used text[] not null default '{}',
  knowledge_slug text,
  match_confidence numeric(4,3),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  raw_pence numeric(14,6) not null default 0,
  charged_base_pence numeric(14,4) not null default 0,
  charged_face_pence numeric(14,4) not null default 0,
  capped boolean not null default false,
  fact_proposal jsonb,
  log_seq integer,
  buttons jsonb,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  anonymised_at timestamptz
);
-- Named and re-added on every run (Review R3, R3-83), so a change to a list applies to a database that has the table.
-- 'routed' (Review R3, R3-37): the quick box's "ask in the full view".
do $$ begin
  alter table public.chat_turns drop constraint if exists chat_turns_surface_check;
  alter table public.chat_turns add constraint chat_turns_surface_check check (surface in ('quick', 'full'));
  alter table public.chat_turns drop constraint if exists chat_turns_status_check;
  alter table public.chat_turns add constraint chat_turns_status_check check (status in ('pending', 'answered', 'no_answer', 'failed'));
  alter table public.chat_turns drop constraint if exists chat_turns_outcome_check;
  alter table public.chat_turns add constraint chat_turns_outcome_check check (outcome is null or outcome in ('answered', 'low_confidence', 'could_not_answer', 'member_unhappy', 'handed_off', 'routed'));
end $$;
create unique index if not exists chat_turns_client_uidx on public.chat_turns (user_id, client_turn_id);
create unique index if not exists chat_turns_pending_uidx on public.chat_turns (user_id) where status = 'pending';
create index if not exists chat_turns_user_idx on public.chat_turns (user_id, created_at desc);
create index if not exists chat_turns_created_idx on public.chat_turns (created_at);
alter table public.chat_turns enable row level security;  -- no policies: service role only
revoke all on public.chat_turns from anon, authenticated;

-- Settings (defaults and bounds in src/lib/chat/settings.ts; a missing or bad
-- row takes the default). Edited on /admin/intelligence/chat. Prices in base
-- pence, like every other price. The confidence thresholds are Batch 24's
-- si_kb_* rows and the 90 days are Batch 23's si_transcript_retention_days.
--   si_chat_enabled                  false hides the box (SI_CHAT_ENABLED=true is also needed)
--   si_chat_markup                   what a question costs: actual tokens × this
--   si_chat_quick_ceiling_pence      the most one quick answer can cost; it is cut short before
--   si_chat_full_ceiling_pence       the same for a full-view answer
--   si_chat_quick_floor_pence        below this balance the quick box says "Top up to ask me more"
--   si_chat_full_floor_pence         the same for the full view
--   si_chat_quick_hint_pence         the price hint by the quick box ("about 1p")
--   si_chat_full_hint_pence          the price hint by the full view's box ("about 8p")
--   si_chat_quick_max_output_tokens  a quick answer's longest reply
--   si_chat_full_max_words           a full-view answer's longest text
--   si_chat_full_max_tool_rounds     the most times one full-view answer may look something up
--   si_chat_history_turns            earlier questions in the same conversation sent back with a new one
--   si_chat_session_idle_minutes     a full-view conversation ends after this long without a question
--   si_chat_min_seconds              the shortest gap between two questions from one member
--   si_chat_max_uncharged_per_day    unanswered questions (not charged) a member may ask in a UK day; answered ones are never capped
insert into public.billing_settings (key, value) values
  ('si_chat_enabled', 'true'::jsonb),
  ('si_chat_markup', '5'::jsonb),
  ('si_chat_quick_ceiling_pence', '3'::jsonb),
  ('si_chat_full_ceiling_pence', '25'::jsonb),
  ('si_chat_quick_floor_pence', '2'::jsonb),
  ('si_chat_full_floor_pence', '10'::jsonb),
  ('si_chat_quick_hint_pence', '1'::jsonb),
  ('si_chat_full_hint_pence', '8'::jsonb),
  ('si_chat_quick_max_output_tokens', '200'::jsonb),
  ('si_chat_full_max_words', '80'::jsonb),
  ('si_chat_full_max_tool_rounds', '4'::jsonb),
  ('si_chat_history_turns', '6'::jsonb),
  ('si_chat_session_idle_minutes', '30'::jsonb),
  ('si_chat_min_seconds', '3'::jsonb),
  ('si_chat_max_uncharged_per_day', '30'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 26b: the chat's voice
-- =========================
-- Members can speak a question to the chat and hear the answer in the Stayful
-- Intelligence voice. Listening is ElevenLabs speech-to-text, metered per
-- second of audio (this row); the spoken answer is the existing per-character
-- row (/api/speak). Both are charged as "AI voice" through the credit system,
-- like the narrator. si_chat_voice_enabled switches the microphone and the
-- spoken answers off without a redeploy (typing carries on). Additive.
insert into public.unit_costs (provider, unit, label, unit_cost_pence, markup, notes) values
  ('elevenlabs', 'stt_second', 'ElevenLabs speech-to-text (per second of audio)', 0.005925, 5, 'Scribe v2 batch ≈ $0.27 per hour of audio at 79p a dollar (Oct 2026); reconcile')
on conflict (provider, unit) do nothing;

insert into public.billing_settings (key, value) values
  ('si_chat_voice_enabled', 'true'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 27: Stayful Intelligence actions
-- =========================
-- In the full Stayful Intelligence view the member can tell the eye what to
-- do ("analyse my top 3 kept deals", "pass everything that's gone off the
-- market", "only 2-beds under £180k", a pasted listing link) and it does it,
-- through the same code the buttons use (src/lib/si-actions). Each action
-- keeps its button's price and its ledger line; the question is Batch 26's
-- own charge. Keep / Pass, stage moves and profile changes can be undone for
-- si_action_undo_hours; a charge never is. Additive; nothing is added to
-- ACCESS_COLUMNS. Service role only, like every table since Batch 3.

-- ── si_instructions: one row per question that asked the eye to do something ──
--   id                    the question's chat_turns.id (also the ledger action_id of the question's own charge)
--   user_id / payer_id    who asked, and whose credit pays (a team member's owner)
--   status                proposed | cancelled | done | ready | awaiting_confirm | running | stopped | declined | blocked | expired
--                         (src/lib/si-actions/config.ts says what each means)
--   decision              what the priced plan came to (src/lib/si-actions/spend.ts): free | run | confirm | insufficient
--   confirm_kind          low_balance | over_cap (the rest past si_action_instruction_cap_pence) | null
--   confirm_answer        yes | no, once the member answered
--   quoted_*_pence        the charged steps' quotes, added up (base, and face: what comes off the balance)
--   spend_line            the one line shown before anything charged ran ("Running 3 full analyses — £12")
--   conversation_id       the chat conversation, where the spend line and what happened are logged as turns
--   starts_after          the Stop countdown's end; charged_started_at the moment the first charged step was claimed
--                         (Stop is refused from then on; "Stop the rest" still stops what hasn't started)
--   report_ref / report_kind  a bug report or feature request the eye filed for the member (Batch 18's #ref)
--   report_only           the question only filed a report (no steps): not an instruction, so not counted in the rate limits
create table if not exists public.si_instructions (
  id uuid primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  payer_id uuid,
  status text not null default 'proposed',
  decision text not null default 'free',
  confirm_kind text,
  confirm_answer text,
  confirmed_at timestamptz,
  quoted_base_pence numeric(14,4) not null default 0,
  quoted_face_pence numeric(14,4) not null default 0,
  later_face_pence numeric(14,4) not null default 0,
  balance_before_pence numeric(14,4),
  spend_line text,
  conversation_id uuid,
  starts_after timestamptz,
  charged_started_at timestamptz,
  stopped_at timestamptz,
  report_ref integer,
  report_kind text,
  report_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.si_instructions add column if not exists report_only boolean not null default false;
do $$ begin
  alter table public.si_instructions drop constraint if exists si_instructions_status_check;
  alter table public.si_instructions add constraint si_instructions_status_check check (status in ('proposed', 'cancelled', 'done', 'ready', 'awaiting_confirm', 'running', 'stopped', 'declined', 'blocked', 'expired'));
  alter table public.si_instructions drop constraint if exists si_instructions_decision_check;
  alter table public.si_instructions add constraint si_instructions_decision_check check (decision in ('free', 'run', 'confirm', 'insufficient'));
  alter table public.si_instructions drop constraint if exists si_instructions_confirm_check;
  alter table public.si_instructions add constraint si_instructions_confirm_check check ((confirm_kind is null or confirm_kind in ('low_balance', 'over_cap')) and (confirm_answer is null or confirm_answer in ('yes', 'no')));
  alter table public.si_instructions drop constraint if exists si_instructions_report_check;
  alter table public.si_instructions add constraint si_instructions_report_check check (report_kind is null or report_kind in ('bug', 'feature'));
end $$;
-- One instruction at a time per member: only one may be counting down or running.
create unique index if not exists si_instructions_live_uidx on public.si_instructions (user_id) where status in ('ready', 'running');
create index if not exists si_instructions_user_idx on public.si_instructions (user_id, created_at desc);
create index if not exists si_instructions_created_idx on public.si_instructions (created_at);
create index if not exists si_instructions_open_idx on public.si_instructions (status, updated_at) where status in ('proposed', 'ready', 'awaiting_confirm', 'running');
alter table public.si_instructions enable row level security;  -- no policies: service role only
revoke all on public.si_instructions from anon, authenticated;

-- ── si_action_steps: one row per thing the eye did (or was asked to and didn't) ──
--   id                 also the step's idempotency key: a step is claimed (queued → running) once, so a retry never runs it twice
--   seq                its place in the instruction (the order charged steps run and are capped in)
--   action             keep | pass | stage_move | full_analysis | deep_report | deep_search | check_link | change_criteria | btl_report (Batch 28)
--   deal_id            the marketplace deal (never another member's: only deals the member's own look-ups returned)
--   target_label       how the eye names it: area and type, never an address
--   params             the stage, the profile question and value, or the link (its canonical URL)
--   part               now | later (past the cap: waits for the member's yes)
--   quote_*_pence      what its button would charge this member (charged by the button's own code, never here)
--   before / after     what it changed, for Undo (a stage and Keep / Pass, or a profile answer)
--   profile_id         the active profile a profile change was saved to (Undo refuses once another one is active)
--   payload            a checked listing's parsed snapshot and quick view, held only until Keep or the Undo window (the nightly job clears it)
--   ledger_ref         what its own code charged under: the analysis purchase, the deep search, the report
--   status             queued | deferred | running | handed_out | done | failed | dropped | stopped | declined | skipped
--   report_ref         Batch 18's #ref when a failure was reported to the team automatically
create table if not exists public.si_action_steps (
  id uuid primary key default gen_random_uuid(),
  instruction_id uuid not null references public.si_instructions(id) on delete cascade,
  user_id uuid,
  seq integer not null,
  action text not null,
  deal_id uuid,
  target_label text,
  params jsonb not null default '{}'::jsonb,
  part text not null default 'now',
  quote_base_pence numeric(14,4) not null default 0,
  quote_face_pence numeric(14,4) not null default 0,
  before jsonb,
  after jsonb,
  profile_id uuid,
  payload jsonb,
  ledger_ref text,
  status text not null default 'queued',
  drop_reason text,
  error_code text,
  report_ref integer,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  undone_at timestamptz,
  undo_note text
);
do $$ begin
  alter table public.si_action_steps drop constraint if exists si_action_steps_action_check;
  alter table public.si_action_steps add constraint si_action_steps_action_check check (action in ('keep', 'pass', 'stage_move', 'full_analysis', 'deep_report', 'deep_search', 'check_link', 'change_criteria', 'btl_report'));
  alter table public.si_action_steps drop constraint if exists si_action_steps_status_check;
  alter table public.si_action_steps add constraint si_action_steps_status_check check (status in ('queued', 'deferred', 'running', 'handed_out', 'done', 'failed', 'dropped', 'stopped', 'declined', 'skipped'));
  alter table public.si_action_steps drop constraint if exists si_action_steps_part_check;
  alter table public.si_action_steps add constraint si_action_steps_part_check check (part in ('now', 'later'));
end $$;
create unique index if not exists si_action_steps_seq_uidx on public.si_action_steps (instruction_id, seq);
create index if not exists si_action_steps_user_idx on public.si_action_steps (user_id, finished_at desc);
create index if not exists si_action_steps_created_idx on public.si_action_steps (created_at);
create index if not exists si_action_steps_payload_idx on public.si_action_steps (created_at) where payload is not null;
alter table public.si_action_steps enable row level security;  -- no policies: service role only
revoke all on public.si_action_steps from anon, authenticated;

-- Settings (defaults and bounds in src/lib/si-actions/settings.ts; a missing or
-- bad row takes the default). Edited on /admin/intelligence/actions. The
-- low-credit line is Batch 20's low_credit_pence (Zac, 11 Oct: one line).
--   si_action_enabled                false: the eye answers but does nothing (its buttons only)
--   si_action_instruction_cap_pence  one instruction's action charges past this (face pence) wait for the member's yes (Zac: £20)
--   si_action_undo_hours             how long Keep/Pass, stage moves and profile changes can be undone (Zac: 24)
--   si_action_stop_grace_seconds     the Stop countdown before the first charged step starts
--   si_action_rate_per_hour          instructions a member may give in an hour
--   si_action_rate_per_day           and in a UK day
--   si_action_max_targets            the most deals one instruction may touch
--   si_action_confirm_minutes        a countdown or confirm nobody answers expires after this
insert into public.billing_settings (key, value) values
  ('si_action_enabled', 'true'::jsonb),
  ('si_action_instruction_cap_pence', '2000'::jsonb),
  ('si_action_undo_hours', '24'::jsonb),
  ('si_action_stop_grace_seconds', '5'::jsonb),
  ('si_action_rate_per_hour', '20'::jsonb),
  ('si_action_rate_per_day', '60'::jsonb),
  ('si_action_max_targets', '50'::jsonb),
  ('si_action_confirm_minutes', '10'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 28: buy-to-let
-- =========================
-- A standard long let to tenants, judged on rent: a sale listing bought with
-- a 75% interest-only mortgage at the live 2–3-year fixed rate (src/lib/btl).
-- A deal's buy-to-let lens lives on its marketplace_deals row beside the
-- short-let one, so it keeps one id, one open, one Keep / Pass and one share.
-- band = 'qualified' still means a short-let deal; btl_pass means a
-- buy-to-let deal; a row can be both. The nightly btl-screen job writes the
-- lens, lets in sales that pass only as buy-to-let, and stores the
-- benchmarks. Additive; nothing is added to ACCESS_COLUMNS, and nothing in
-- DEAL_COLUMNS / CARD_COLUMNS reads these columns (they are read tolerantly,
-- so the site keeps working before this section is run).

-- ── marketplace_deals: the buy-to-let lens ──
--   btl              the stored lens (src/lib/btl/card.ts BtlCard): rent range and confidence, every
--                    figure as a range, the lender test, growth, flags. Never an address, link or coordinates.
--   btl_pass         the hard rules pass: the lender rent test on the middle rent, and low-end cashflow ≥ £0,
--                    on a whole home a lender would lend on. Only a passing row is ever a buy-to-let deal.
--   btl_screened_at  when the lens was last worked out
alter table public.marketplace_deals add column if not exists btl jsonb;
alter table public.marketplace_deals add column if not exists btl_pass boolean not null default false;
alter table public.marketplace_deals add column if not exists btl_screened_at timestamptz;
create index if not exists marketplace_deals_live_btl_idx on public.marketplace_deals (postcode_area) where status = 'live' and btl_pass;

-- ── btl_apply_screen: the nightly job's writes, in one statement ──
--   rows  [{canonical_url, btl, pass}]  -> the number of rows written
create or replace function public.btl_apply_screen(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.marketplace_deals d
     set btl = x.btl,
         btl_pass = coalesce(x.pass, false),
         btl_screened_at = now()
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(canonical_url text, btl jsonb, pass boolean)
   where d.canonical_url = x.canonical_url;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.btl_apply_screen(jsonb) from public, anon, authenticated;
grant execute on function public.btl_apply_screen(jsonb) to service_role;

-- ── btl_benchmarks: "the typical deal in their budget", per area and cash band ──
--   area_code      a postcode area (the member's chosen area); the search widens out from its centre
--   band           under_25k | 25k_50k | 50k_100k | 100k_plus
--   step           10mi | 25mi | 50mi | region | national: the step that held enough deals
--   deal_count     deals in the band at that step; thin: under the minimum even nationally;
--   no_compare     under the floor: nothing to compare with (the hard rules alone decide)
--   steps          every step tried, with its count
--   *_median / *_p40  ROI and annual growth, % (growth null when no deal has a figure)
-- Rebuilt by every btl-screen run; read by Today, the deal page and the standout calls, never per page view.
create table if not exists public.btl_benchmarks (
  area_code text not null,
  band text not null,
  step text not null,
  radius_miles numeric,
  deal_count integer not null default 0,
  roi_median numeric,
  roi_p40 numeric,
  growth_median numeric,
  growth_p40 numeric,
  thin boolean not null default false,
  no_compare boolean not null default false,
  steps jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (area_code, band)
);
do $$ begin
  alter table public.btl_benchmarks drop constraint if exists btl_benchmarks_band_check;
  alter table public.btl_benchmarks add constraint btl_benchmarks_band_check check (band in ('under_25k', '25k_50k', '50k_100k', '100k_plus'));
end $$;
alter table public.btl_benchmarks enable row level security;  -- no policies: service role only
revoke all on public.btl_benchmarks from anon, authenticated;

-- ── btl_reports: the £2 BTL report (Part G) ──
--   purchase_id  the analysis_purchases row (kind btl_report) it was charged under; charged once, never on failure
--   deal_id      the marketplace deal, when it was run on one; canonical_url the listing either way
--   result       src/lib/btl/report.ts BtlReport
create table if not exists public.btl_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  purchase_id uuid unique references public.analysis_purchases(id) on delete set null,
  deal_id uuid,
  canonical_url text,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists btl_reports_user_idx on public.btl_reports (user_id, created_at desc);
alter table public.btl_reports enable row level security;  -- no policies: service role only
revoke all on public.btl_reports from anon, authenticated;
-- One welcome-priced BTL report per member (Q17); a failed purchase frees it.
create unique index if not exists analysis_purchases_welcome_btl_uidx on public.analysis_purchases (buyer_id)
  where offer = 'welcome_btl' and status <> 'failed';
create unique index if not exists analysis_purchases_btl_running_uidx on public.analysis_purchases (user_id, canonical_url)
  where kind = 'btl_report' and status = 'pending';

-- ── The launch (Part I): the one line in the next daily email, sent once ──
--   btl_launch_line_at  when this member's daily email carried the launch line (null: not yet). Never read by
--                       the access checks; the daily email sets it as it sends.
alter table public.profiles add column if not exists btl_launch_line_at timestamptz;
-- The announcement's button words ("Add Buy to let"); null keeps "Take a look". Only with a link.
alter table public.announcements add column if not exists link_label text;
do $$ begin
  alter table public.announcements drop constraint if exists announcements_link_label_check;
  alter table public.announcements add constraint announcements_link_label_check check (
    link_label is null or (char_length(link_label) between 1 and 24 and link_path is not null)
  );
end $$;

-- The ledger label for the report (its price comes from btl_report_pence).
insert into public.unit_costs (provider, unit, label, unit_cost_pence, markup, notes) values
  ('marketplace', 'btl_report', 'BTL report (£2, priced by billing_settings.btl_report_pence)', 0, 5, 'labels the ledger only; the base pence come from btl_report_pence')
on conflict (provider, unit) do nothing;

-- ── Settings (defaults and bounds in src/lib/btl/config.ts; a missing or bad row takes the default) ──
--   btl_report_pence  the £2 BTL report
--   btl_finance       75% LTV; the lender test: 125% cover at the higher of the live rate + 2% or 5.5%; the rate used when none is cached
--   btl_costs         letting agent 12% incl. VAT and repairs 8% of the rent collected, one empty month, insurance £25 a month, safety certificates £300 a year
--   btl_rent          the rent range: the district rent read as a 2-bed; comparables in the same area, size and type within 5 km (5+ to count, 8+ for high confidence), seen in 45 days; widths 10–25%, 20% when rough
--   btl_flats         a flat's service charge (£1,500 a year, London £2,500) and ground rent (£150) when the listing does not say, ±40%
--   btl_epc           the upgrade allowance on the high end of cash in: D £5,000, E–G £10,000, not checked £5,000
--   btl_bands         "How much cash can you put in?": the band tops (under £25k, £25–50k, £50–100k, £100k+)
--   btl_benchmark     10, 25, 50 miles, the region, the country, until 30 deals; under 10 nationally compares with nothing; "a bit of both" at the 40th percentile
--   btl_standout      the low end beats 125% of the median; an income standout also needs 6% at the low end
--   btl_listing       a lease under 70 years is refused, under 85 flagged
--   btl_launch_from   when the launch email line starts (null: not yet)
-- The paid shortlist's line (rent valuations and EPCs) sits in Batch 16's deal_checks row as
-- btlValuations (20 a day) and btlCapPence (100p a day), beside its cap on /admin/deals.
insert into public.billing_settings (key, value) values
  ('btl_report_pence', '200'::jsonb),
  ('btl_finance', '{"ltvPct":75,"icrPct":125,"stressAddPct":2,"stressFloorPct":5.5,"fallbackRatePct":5.5}'::jsonb),
  ('btl_costs', '{"agentPct":12,"repairsPct":8,"emptyMonths":1,"insurancePcm":25,"safetyPerYear":300}'::jsonb),
  ('btl_rent', '{"ladderBaseBedrooms":2,"compsMin":5,"compsHigh":8,"compsRadiusKm":5,"compsMaxAgeDays":45,"minWidthPct":10,"maxWidthPct":25,"lowWidthPct":20,"agreeHighPct":15,"disagreePct":25,"valuationMinWidthPct":10}'::jsonb),
  ('btl_flats', '{"serviceChargeYear":1500,"serviceChargeLondonYear":2500,"groundRentYear":150,"spreadPct":40}'::jsonb),
  ('btl_epc', '{"allowanceD":5000,"allowanceEtoG":10000,"unknownAllowance":5000}'::jsonb),
  ('btl_bands', '[25000,50000,100000]'::jsonb),
  ('btl_benchmark', '{"stepsMiles":[10,25,50],"region":true,"national":true,"minDeals":30,"floorDeals":10,"balancedPercentile":40}'::jsonb),
  ('btl_standout', '{"lowOverMedianPct":125,"minLowRoiPct":6}'::jsonb),
  ('btl_listing', '{"minLeaseYears":70,"shortLeaseYears":85}'::jsonb),
  ('btl_launch_from', 'null'::jsonb)
on conflict (key) do nothing;

-- Today's mix with four types (Part E, decided: 2 short-let, 1 buy-to-let, 1 BRRR,
-- 1 rent-to-rent). The three-type mix a profile chose "All of them" on before
-- buy-to-let existed is kept as `three`, so their day does not change until they
-- tap. Once only: a row that already names btl is never touched again, so an
-- admin's edit survives every re-run.
update public.billing_settings
   set value = jsonb_set(jsonb_set(value, '{three}', coalesce(value->'three', value->'all')), '{all}', '{"buy_str":2,"btl":1,"brrr":1,"r2r":1}'::jsonb),
       updated_at = now()
 where key = 'today_mix'
   and jsonb_typeof(value->'all') = 'object'
   and not (value->'all' ? 'btl');

notify pgrst, 'reload schema';

-- =========================
-- Batch 29: starter pack guardrails and the pay-again measure
-- =========================
-- What a £10 starter pack buyer who never pays again can cost us in data.
-- The rule, the cap and the pack-only definition are written up once, for
-- Batches 25 and 27 and anyone after, in src/lib/credit/pack-rules.ts.
--   * The pack's £20 bonus (credit_grants.scope 'pack_bonus', marked by
--     credit_grant_pack_bonus) pays only for deal opens, saved analyses and
--     daily picks (credit_bonus_pays_for, in the credit section, where
--     credit_reserve / credit_debit / credit_debit_face / credit_refund /
--     credit_expire_due were edited in place) and expires pack_bonus_expiry_days
--     after it is granted. The £10 the member paid never expires and buys anything.
--   * A further payment (member_payments: topup, auto_topup, subscription)
--     lifts both, at once (the trigger below) or at the expiry sweep.
--   * A pack-only member may run pack_fresh_report_cap fresh analyses
--     (pack_fresh_reports, claimed under the profile lock).
-- Settings (edited on /admin/lifecycle; src/lib/lifecycle/settings.ts):
--   pack_bonus_expiry_days       the bonus expires this many days after it is granted
--   pack_fresh_report_cap        fresh full analyses a pack-only member may run
--   pack_early_offer_pence       the one-off "start Starter or top up" offer at this total balance
--   pack_picks_pause_days        a pack-only member's picks pause after this many days without a visit
--   places_cache_days            Google Places nearby results are reused this long (about 100m grid)
--   places_cache_empty_days      an EMPTY Places answer is reused only this long (Review R4, R4-20)
--   pack_paying_headline_floor_pct / _target_pct         paid again within 60 days (/admin/weekly-active)
--   pack_paying_rundown_paid_floor_pct / _target_pct     paid again within 14 days of running down
--   pack_cost_target_pence / pack_cost_ceiling_pence     data cost per pack-only member
insert into public.billing_settings (key, value) values
  ('pack_bonus_expiry_days', '30'),
  ('pack_fresh_report_cap', '3'),
  ('pack_early_offer_pence', '1500'),
  ('pack_picks_pause_days', '7'),
  ('places_cache_days', '90'),
  ('places_cache_empty_days', '3'),
  ('pack_paying_headline_floor_pct', '10'),
  ('pack_paying_headline_target_pct', '22'),
  ('pack_paying_rundown_paid_floor_pct', '35'),
  ('pack_paying_rundown_paid_target_pct', '50'),
  ('pack_cost_target_pence', '190'),
  ('pack_cost_ceiling_pence', '250')
on conflict (key) do nothing;

-- Review R4 (R4-14, Zac 19 Nov 2026): a further payment that was refunded in
-- full or charged back no longer counts as paying again.
--   member_payments.disputed_at  the charge is under a dispute that has not
--                                closed in our favour (member_payment_dispute)
--   member_payment_void(pi, amount, disputed_at)  true for a disputed payment,
--                                or one whose charge's refunds (member_refunds,
--                                matched on the PaymentIntent) reach what was paid
alter table public.member_payments add column if not exists disputed_at timestamptz;

create or replace function public.member_payment_void(p_pi text, p_amount integer, p_disputed_at timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select p_disputed_at is not null
      or (p_pi is not null and p_amount > 0
          and coalesce((select sum(r.amount_refunded_pence) from member_refunds r where r.payment_intent_id = p_pi), 0) >= p_amount);
$$;
revoke all on function public.member_payment_void(text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.member_payment_void(text, integer, timestamptz) to service_role;

-- member_paid_again_at(user): when the member first paid for anything other
-- than the starter pack, ever (null: never). A top-up, an automatic top-up or a
-- subscription invoice (member_payments rows exist only for amounts above 0,
-- so a free trial is never a payment), or, should that row never have been
-- written, a top-up grant whose PaymentIntent is not a starter pack's. A
-- repeat pack charged anyway is the pack's kind, so it is not one.
-- Review R4 (R4-14): a payment refunded in full or charged back is not one
-- (member_payment_void). A top-up grant counts only when its payment row is
-- missing, and not once its credit has been taken back in full (refunded or
-- disputed, less any dispute won).
create or replace function public.member_paid_again_at(p_user uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select least(
    (select min(m.paid_at) from member_payments m
      where m.user_id = p_user and m.kind in ('topup', 'auto_topup', 'subscription')
        and not member_payment_void(m.payment_intent_id, m.amount_pence, m.disputed_at)),
    (select min(g.created_at) from credit_grants g
      where g.user_id = p_user and g.kind = 'topup' and left(g.source_ref, 3) = 'pi:'
        and not exists (select 1 from starter_pack_purchases s where 'pi:' || s.payment_intent_id = g.source_ref)
        and not exists (select 1 from member_payments m where m.id = g.source_ref)
        and coalesce((select sum(a.amount_pence)
                        from credit_grants a
                       where a.user_id = g.user_id and a.kind = 'adjustment'
                         and (a.source_ref in (g.source_ref || ':refunded', g.source_ref || ':disputed', g.source_ref || ':dispute_won')
                              or a.source_ref like g.source_ref || ':refunded:%')), 0) > -g.amount_pence)
  );
$$;
revoke all on function public.member_paid_again_at(uuid) from public, anon, authenticated;
grant execute on function public.member_paid_again_at(uuid) to service_role;

-- credit_grant_pack_bonus(p): {user, amount, source_ref, description}. The
-- pack's bonus as a welcome-kind grant marked scope 'pack_bonus', expiring
-- pack_bonus_expiry_days from now, in one transaction under the member's row
-- lock. Idempotent on source_ref: a replay returns the grant and changes
-- nothing. A member who has already paid for something else gets it lifted
-- (no restriction, no expiry) from the start: they are not pack-only.
create or replace function public.credit_grant_pack_bonus(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_amount numeric := coalesce(safe_numeric(p->>'amount'), 0);
  v_ref text := nullif(p->>'source_ref', '');
  v_days int := greatest(1, round(credit_setting_num('pack_bonus_expiry_days', 30))::int);
  v_paid timestamptz;
  v_id uuid;
begin
  if v_user is null or v_ref is null or v_amount <= 0 then
    raise exception 'credit_grant_pack_bonus needs user, source_ref and a positive amount';
  end if;
  perform 1 from profiles where id = v_user for update;
  select id into v_id from credit_grants where source_ref = v_ref;
  if v_id is not null then return v_id; end if;
  v_paid := member_paid_again_at(v_user);
  v_id := credit_grant(v_user, 'welcome', v_amount,
    case when v_paid is null then now() + make_interval(days => v_days) end,
    v_ref, nullif(p->>'description', ''));
  update credit_grants set scope = 'pack_bonus', scope_lifted_at = case when v_paid is not null then now() end
   where id = v_id and scope is null;
  return v_id;
end $$;
revoke all on function public.credit_grant_pack_bonus(jsonb) from public, anon, authenticated;
grant execute on function public.credit_grant_pack_bonus(jsonb) to service_role;

-- pack_bonus_unlock(user): a further payment lifts the restriction and the
-- expiry of every unexpired pack bonus the member holds. Returns how many.
create or replace function public.pack_bonus_unlock(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform 1 from profiles where id = p_user for update;
  update credit_grants set scope_lifted_at = now(), expires_at = null
   where user_id = p_user and scope = 'pack_bonus' and scope_lifted_at is null
     and (expires_at is null or expires_at > now());
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pack_bonus_unlock(uuid) from public, anon, authenticated;
grant execute on function public.pack_bonus_unlock(uuid) to service_role;

-- Every writer of member_payments (the one-click routes, the webhook, a
-- redelivery) goes through this: a top-up, automatic top-up or plan payment
-- lifts the bonus in the same transaction as the payment's row.
-- Review R4 (R4-14): a payment already refunded in full or disputed when its
-- row lands (an event out of order) lifts nothing. Review R4 (R4-18): paid_at
-- is Stripe's payment time, so a payment made before the bonus expired but
-- recorded just after it also lifts it at once, as long as the expiry sweep
-- has not yet written it off.
create or replace function private.member_payments_pack_unlock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('topup', 'auto_topup', 'subscription') and new.amount_pence > 0
     and not public.member_payment_void(new.payment_intent_id, new.amount_pence, new.disputed_at) then
    perform public.pack_bonus_unlock(new.user_id);
    update public.credit_grants set scope_lifted_at = now(), expires_at = null
     where user_id = new.user_id and scope = 'pack_bonus' and scope_lifted_at is null
       and remaining_pence > 0 and expires_at is not null and expires_at <= now() and expires_at > new.paid_at;
  end if;
  return new;
end $$;
revoke execute on function private.member_payments_pack_unlock() from public;
drop trigger if exists member_payments_pack_unlock on public.member_payments;
create trigger member_payments_pack_unlock
  after insert on public.member_payments
  for each row execute function private.member_payments_pack_unlock();

-- pack_bonus_restrict(user): Review R4 (R4-14, Zac 19 Nov 2026). When the
-- member no longer counts as having paid again (their further payments were
-- all refunded in full or charged back), every lifted pack bonus is
-- restricted again with its original expiry (granted + pack_bonus_expiry_days;
-- the lift cleared it). One whose date has passed is no longer spendable and
-- the next credit_expire_due writes it off. They are pack-only again. Returns
-- how many grants it restricted.
create or replace function public.pack_bonus_restrict(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_days int := greatest(1, round(credit_setting_num('pack_bonus_expiry_days', 30))::int);
  n integer := 0;
begin
  if p_user is null then return 0; end if;
  perform 1 from profiles where id = p_user for update;
  if member_paid_again_at(p_user) is not null then return 0; end if;
  update credit_grants set scope_lifted_at = null, expires_at = created_at + make_interval(days => v_days)
   where user_id = p_user and scope = 'pack_bonus' and scope_lifted_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.pack_bonus_restrict(uuid) from public, anon, authenticated;
grant execute on function public.pack_bonus_restrict(uuid) to service_role;

-- A refund written (member_refund_set, from charge.refunded) re-restricts the
-- bonus when it leaves the member with no further payment that counts.
create or replace function private.member_refunds_pack_restrict()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.pack_bonus_restrict(new.user_id);
  return new;
end $$;
revoke execute on function private.member_refunds_pack_restrict() from public;
drop trigger if exists member_refunds_pack_restrict on public.member_refunds;
create trigger member_refunds_pack_restrict
  after insert or update on public.member_refunds
  for each row execute function private.member_refunds_pack_restrict();

-- member_payment_dispute(p): {pi, open}. A dispute opened on a charge
-- (charge.dispute.created) marks its payment row disputed and re-restricts the
-- bonus (pack_bonus_restrict); one closed in our favour (won, or an inquiry
-- closed with nothing taken) clears the mark and, if the payment counts again
-- and the bonus has not expired, lifts it again. A lost dispute changes
-- nothing. Returns how many payment rows changed.
create or replace function public.member_payment_dispute(p jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_pi text := nullif(p->>'pi', '');
  v_open boolean := coalesce((p->>'open')::boolean, true);
  v_user uuid;
  n integer := 0;
begin
  if v_pi is null then return 0; end if;
  for v_user in
    update member_payments set disputed_at = case when v_open then now() end
     where payment_intent_id = v_pi and (disputed_at is null) = v_open
    returning user_id
  loop
    n := n + 1;
    if v_open then
      perform pack_bonus_restrict(v_user);
    elsif member_paid_again_at(v_user) is not null then
      perform pack_bonus_unlock(v_user);
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.member_payment_dispute(jsonb) from public, anon, authenticated;
grant execute on function public.member_payment_dispute(jsonb) to service_role;

-- ── pack_fresh_reports: the fresh full analyses a pack-only member has run ──
-- One row per fresh analysis (the purchase id of a deal's Full analysis, or
-- the action id of an analyser / API report), claimed before anything is
-- charged and released when it ends with nothing charged or turns out to be
-- a saved analysis. pack_fresh_report_claim counts and inserts under the
-- member's row lock, so two tabs can never both take the last one.
create table if not exists public.pack_fresh_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action_id uuid not null,
  kind text not null,
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index if not exists pack_fresh_reports_action_uidx on public.pack_fresh_reports (action_id);
create index if not exists pack_fresh_reports_user_idx on public.pack_fresh_reports (user_id, created_at) where released_at is null;
do $$
begin
  alter table public.pack_fresh_reports drop constraint if exists pack_fresh_reports_kind_check;
  alter table public.pack_fresh_reports add constraint pack_fresh_reports_kind_check check (kind in ('full_analysis', 'report'));
end $$;
alter table public.pack_fresh_reports enable row level security;  -- no policies: service role only
revoke all on public.pack_fresh_reports from anon, authenticated;

-- pack_fresh_report_claim(p): {user, action_id, kind, cap, since}. Returns
-- {ok, used, cap}: ok is false when the member has used the cap (counted since
-- `since`, the pack). The same action_id again is the same claim.
create or replace function public.pack_fresh_report_claim(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p->>'user', '')::uuid;
  v_action uuid := nullif(p->>'action_id', '')::uuid;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'full_analysis');
  v_cap integer := greatest(0, coalesce(public.safe_numeric(p->>'cap'), 3)::integer);
  v_since timestamptz := nullif(p->>'since', '')::timestamptz;
  v_row public.pack_fresh_reports%rowtype;
  v_used integer;
begin
  if v_user is null or v_action is null then raise exception 'pack_fresh_report_claim needs user and action_id'; end if;
  perform 1 from public.profiles where id = v_user for update;
  select count(*) into v_used from public.pack_fresh_reports r
   where r.user_id = v_user and r.released_at is null and (v_since is null or r.created_at >= v_since);
  select * into v_row from public.pack_fresh_reports where action_id = v_action;
  if found and v_row.released_at is null then
    return jsonb_build_object('ok', true, 'used', v_used, 'cap', v_cap);
  end if;
  if v_used >= v_cap then
    return jsonb_build_object('ok', false, 'used', v_used, 'cap', v_cap);
  end if;
  if found then
    update public.pack_fresh_reports set released_at = null, created_at = now() where id = v_row.id;
  else
    insert into public.pack_fresh_reports (user_id, action_id, kind) values (v_user, v_action, v_kind);
  end if;
  return jsonb_build_object('ok', true, 'used', v_used + 1, 'cap', v_cap);
end $$;
revoke all on function public.pack_fresh_report_claim(jsonb) from public, anon, authenticated;
grant execute on function public.pack_fresh_report_claim(jsonb) to service_role;

create or replace function public.pack_fresh_report_release(p_action uuid)
returns boolean language sql security definer set search_path = '' as $$
  with u as (
    update public.pack_fresh_reports set released_at = now() where action_id = p_action and released_at is null returning 1
  )
  select exists (select 1 from u);
$$;
revoke all on function public.pack_fresh_report_release(uuid) from public, anon, authenticated;
grant execute on function public.pack_fresh_report_release(uuid) to service_role;

-- pack_member_state(p): {user}. What src/lib/credit/pack-server.ts needs in one
-- read: when the pack was granted, when the member first paid for anything
-- else, the restricted bonus left and when it expires, and fresh analyses used.
create or replace function public.pack_member_state(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  with u as (
    select nullif(p->>'user', '')::uuid as id
  ), pk as (
    select coalesce(
      (select min(coalesce(s.granted_at, s.created_at)) from starter_pack_purchases s, u where s.user_id = u.id and s.status = 'granted'),
      (select pr.starter_pack_bought_at from profiles pr, u where pr.id = u.id)
    ) as at
  ), b as (
    select coalesce(sum(g.remaining_pence), 0) as pence, min(g.expires_at) as expires_at
      from credit_grants g, u
     where g.user_id = u.id and g.scope = 'pack_bonus' and g.scope_lifted_at is null
       and g.remaining_pence > 0 and (g.expires_at is null or g.expires_at > now())
  ), f as (
    select count(*) as n from pack_fresh_reports r, u, pk
     where r.user_id = u.id and r.released_at is null and (pk.at is null or r.created_at >= pk.at)
  )
  select jsonb_build_object(
    'pack_at', pk.at,
    'paid_again_at', member_paid_again_at(u.id),
    'bonus_pence', round(b.pence, 4),
    'bonus_expires_at', b.expires_at,
    'fresh_used', f.n
  )
  from u, pk, b, f;
$$;
revoke all on function public.pack_member_state(jsonb) from public, anon, authenticated;
grant execute on function public.pack_member_state(jsonb) to service_role;

-- ── profiles: the early offer and the picks pause ──
--   pack_offer_home_at      the £15 offer card was first shown on Home (it shows that UK day only)
--   pack_offer_emailed_at   the offer's section went in a daily email (once)
--   pack_offer_dismissed_at the member closed the card
--   picks_paused_reason     why picks_paused_inactive_at is set: 'inactive' (Batch 20's rule) or
--                           'pack' (a pack-only member with no visit for pack_picks_pause_days)
--   pack_picks_back_at      a 'pack' pause ended because they came back (Home says so once)
--   pack_picks_note_at      Home showed that note
alter table public.profiles add column if not exists pack_offer_home_at timestamptz;
alter table public.profiles add column if not exists pack_offer_emailed_at timestamptz;
alter table public.profiles add column if not exists pack_offer_dismissed_at timestamptz;
alter table public.profiles add column if not exists picks_paused_reason text;
alter table public.profiles add column if not exists pack_picks_back_at timestamptz;
alter table public.profiles add column if not exists pack_picks_note_at timestamptz;
do $$
begin
  alter table public.profiles drop constraint if exists profiles_picks_paused_reason_check;
  alter table public.profiles add constraint profiles_picks_paused_reason_check check (picks_paused_reason is null or picks_paused_reason in ('inactive', 'pack'));
end $$;

-- pack_bonus_backfill(): once. The pack bonuses granted before this batch are
-- marked scope 'pack_bonus' (found by their source_ref, the only mark they
-- had). A member who has paid for something else since has theirs lifted; for
-- everyone else the expiry runs pack_bonus_expiry_days from RELEASE (this run),
-- not from purchase. Never touches an ordinary welcome grant (welcome:<user>).
-- Stamped in billing_settings, so a later run of this file changes nothing.
create or replace function public.pack_bonus_backfill()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_days integer := greatest(1, round(public.credit_setting_num('pack_bonus_expiry_days', 30))::integer);
  v_marked integer := 0;
  v_lifted integer := 0;
  v_dated integer := 0;
begin
  if exists (select 1 from public.billing_settings s where s.key = 'batch29_pack_bonus_marked_at') then
    return jsonb_build_object('done', false, 'reason', 'already');
  end if;
  update public.credit_grants set scope = 'pack_bonus'
   where left(source_ref, 11) = 'pack_bonus:' and kind = 'welcome' and scope is null;
  get diagnostics v_marked = row_count;
  update public.credit_grants set scope_lifted_at = now(), expires_at = null
   where scope = 'pack_bonus' and scope_lifted_at is null and public.member_paid_again_at(user_id) is not null;
  get diagnostics v_lifted = row_count;
  update public.credit_grants set expires_at = now() + make_interval(days => v_days)
   where scope = 'pack_bonus' and scope_lifted_at is null and expires_at is null and remaining_pence > 0;
  get diagnostics v_dated = row_count;
  insert into public.billing_settings (key, value)
    values ('batch29_pack_bonus_marked_at', jsonb_build_object('at', now(), 'marked', v_marked, 'lifted', v_lifted, 'dated', v_dated))
    on conflict (key) do nothing;
  return jsonb_build_object('done', true, 'marked', v_marked, 'lifted', v_lifted, 'dated', v_dated);
end $$;
revoke all on function public.pack_bonus_backfill() from public, anon, authenticated;
grant execute on function public.pack_bonus_backfill() to service_role;
do $$ begin perform public.pack_bonus_backfill(); end $$;

-- pack_paying_facts(p): {low_credit_pence}. One row per member whose starter
-- pack was granted, for /admin/weekly-active's "Pack → paying" (the maths is
-- src/lib/admin/pack-paying.ts; admin e-mails are left out there, excluded
-- accounts are flagged here). Read-only.
--   ran_down_at   the first moment, within 45 days of the pack, that the running
--                 ledger total (every grant, debit, refund, expiry and adjustment)
--                 was at or below low_credit_pence
--   paid          further payments after the pack (top-up, automatic top-up, plan);
--                 one refunded in full or charged back is left out (Review R4, R4-14)
--   raw_cost      what their own debits cost us (raw_cost_pence; a face debit's is in its metadata)
create or replace function public.pack_paying_facts(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  with buyers as (
    select s.user_id, min(s.granted_at) as pack_at
      from starter_pack_purchases s
     where s.status = 'granted' and s.user_id is not null and s.granted_at is not null
     group by s.user_id
  ), b as (
    select bu.user_id, bu.pack_at, pr.created_at as signed_up_at, pr.email,
           a.utm_campaign, a.utm_content,
           exists (select 1 from activity_excluded_accounts x where x.user_id = bu.user_id) as excluded,
           date_trunc('week', (pr.created_at at time zone 'Europe/London'))::date as week_start,
           (pr.created_at at time zone 'Europe/London')::date as signup_day
      from buyers bu
      join profiles pr on pr.id = bu.user_id
      left join member_attribution a on a.user_id = bu.user_id
  ), running as (
    select ct.user_id, ct.at,
           sum(ct.amount_pence) over (partition by ct.user_id order by ct.at, ct.id) as total
      from credit_transactions ct
     where ct.user_id in (select user_id from b)
  ), ran as (
    select r.user_id, min(r.at) as ran_down_at
      from running r join b on b.user_id = r.user_id
     where r.at >= b.pack_at and r.at <= b.pack_at + interval '45 days'
       and r.total <= coalesce(safe_numeric(p->>'low_credit_pence'), 500)
     group by r.user_id
  ), staged as (
    select e.user_id, min(e.occurred_at) as contacted_at
      from activity_events e join b on b.user_id = e.user_id
     where e.kind = 'stage_move' and not (e.extras ? 'env')
       and e.extras->>'to' in ('contacted', 'viewing', 'offer', 'secured')
       and e.occurred_at >= b.pack_at and e.occurred_at <= b.pack_at + interval '30 days'
     group by e.user_id
  ), pay as (
    select m.user_id, array_agg(m.paid_at order by m.paid_at) as paid
      from member_payments m join b on b.user_id = m.user_id
     where m.kind in ('topup', 'auto_topup', 'subscription') and m.paid_at > b.pack_at
       and not member_payment_void(m.payment_intent_id, m.amount_pence, m.disputed_at)
     group by m.user_id
  ), cost as (
    select ct.user_id, sum(coalesce(ct.raw_cost_pence, safe_numeric(ct.metadata->>'raw_cost_pence'), 0)) as raw_cost
      from credit_transactions ct
     where ct.kind = 'debit' and ct.user_id in (select user_id from b)
     group by ct.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'u', b.user_id,
    'email', b.email,
    'excluded', b.excluded,
    'signed_up_at', b.signed_up_at,
    'week_start', b.week_start,
    'pack_at', b.pack_at,
    'campaign', b.utm_campaign,
    'content', b.utm_content,
    -- Their first 7 UK days from sign-up (a Sunday sign-up still gets a whole week).
    'first_week_active', exists (select 1 from member_active_days d where d.user_id = b.user_id and d.day between b.signup_day and b.signup_day + 6),
    'contacted_at', staged.contacted_at,
    'ran_down_at', ran.ran_down_at,
    'paid', coalesce(to_jsonb(pay.paid), '[]'::jsonb),
    'raw_cost', round(coalesce(cost.raw_cost, 0), 4)
  ) order by b.pack_at), '[]'::jsonb)
  from b
  left join ran on ran.user_id = b.user_id
  left join staged on staged.user_id = b.user_id
  left join pay on pay.user_id = b.user_id
  left join cost on cost.user_id = b.user_id;
$$;
revoke all on function public.pack_paying_facts(jsonb) from public, anon, authenticated;
grant execute on function public.pack_paying_facts(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 30: shorter signup questions
-- =========================
-- The signup quiz asks 9–15 questions, not 13–33 (src/lib/profile/questions.ts).
-- Every older question id is kept, so no stored answer or mark changes. This
-- section adds: the Home "What's holding you back?" card's dismissal, two
-- settings, and the one function that keeps "today's average" mortgage rate
-- current on every profile that has not chosen its own rate. Additive and
-- re-runnable; nothing is added to ACCESS_COLUMNS.
--   home_blocker_card_day   the Home card shows from this day since sign-up (default 3; 0 to test)
--   quiz_shorter_from       when the shorter quiz went live: the first run's date, never moved by a later run
--                           (/admin/profile compares members before and after it)
--   standout_min_checked_rent  the standout rule's minimum checked answers for a rent-to-rent deal (3): the shorter
--                           quiz leaves a new rent-to-rent member at most four checks; standout_min_checked (5) stays for sales

alter table public.profile_quiz add column if not exists blocker_card_dismissed_at timestamptz;

insert into public.billing_settings (key, value) values
  ('home_blocker_card_day', '3'::jsonb),
  ('quiz_shorter_from', to_jsonb(now())),
  ('standout_min_checked_rent', '3'::jsonb)
on conflict (key) do nothing;

-- Once a day (market-warm, after the rates are bought) the live average is written into the finance of every
-- profile whose member has not typed their own rate (finance.rateSet is not true): the member's live
-- profiles.market_goals and every saved search_profiles.criteria. Every page then reads the same figure with no
-- reader changes. Returns how many rows were changed. A profile already on this rate and date is left alone,
-- so a second call changes nothing; market_goals_updated_at is not touched (it means "the member changed it").
create or replace function public.sync_live_mortgage_rate(p_rate numeric, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profiles integer := 0;
  v_saved integer := 0;
  v_day text := to_char(p_as_of, 'YYYY-MM-DD');
begin
  if p_rate is null or p_as_of is null or p_rate < 0 or p_rate > 25 then
    return jsonb_build_object('profiles', 0, 'search_profiles', 0, 'skipped', true);
  end if;

  update public.profiles
     set market_goals = jsonb_set(
           market_goals, '{finance}',
           coalesce(market_goals->'finance', '{}'::jsonb) || jsonb_build_object('mortgageRatePct', p_rate, 'rateAsOf', v_day))
   where market_goals is not null
     and jsonb_typeof(market_goals) = 'object'
     and coalesce(market_goals->'finance'->>'rateSet', 'false') <> 'true'
     and (market_goals->'finance'->'mortgageRatePct' is distinct from to_jsonb(p_rate)
          or market_goals->'finance'->>'rateAsOf' is distinct from v_day);
  get diagnostics v_profiles = row_count;

  update public.search_profiles
     set criteria = jsonb_set(
           criteria, '{finance}',
           coalesce(criteria->'finance', '{}'::jsonb) || jsonb_build_object('mortgageRatePct', p_rate, 'rateAsOf', v_day))
   where criteria is not null
     and jsonb_typeof(criteria) = 'object'
     and deleted_at is null
     and coalesce(criteria->'finance'->>'rateSet', 'false') <> 'true'
     and (criteria->'finance'->'mortgageRatePct' is distinct from to_jsonb(p_rate)
          or criteria->'finance'->>'rateAsOf' is distinct from v_day);
  get diagnostics v_saved = row_count;

  return jsonb_build_object('profiles', v_profiles, 'search_profiles', v_saved, 'skipped', false);
end;
$$;
revoke all on function public.sync_live_mortgage_rate(numeric, date) from public, anon, authenticated;
grant execute on function public.sync_live_mortgage_rate(numeric, date) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Review R4 (R4-33): the quiz v2 backfill's "done" stamp
-- =========================
-- The daily rate sync (market-warm, 04:45 UK) writes today's average into every profile that has not chosen its
-- own rate. The Batch 30 backfill marks a rate a member chose as theirs only while no average has been synced
-- yet, so the sync now waits for this stamp, which a real backfill run writes when it leaves nothing behind
-- (src/lib/profile/quiz-v2-backfill-run.ts). Live's backfill finished on 14-15 Nov 2026 (checked 19 Nov: no old
-- setup bands left, no member's chosen rate unprotected), so the stamp is seeded as done. Additive and
-- re-runnable: a second run changes nothing. Nothing is added to ACCESS_COLUMNS.
--   quiz_v2_backfill_done_at   when the quiz v2 backfill last finished with nothing left (an ISO time); absent: the sync waits

insert into public.billing_settings (key, value) values
  ('quiz_v2_backfill_done_at', to_jsonb(now()))
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- =========================
-- Batch 31a: academy_purchases
-- =========================
-- One row per Stayful Academy purchase (a one-off Stripe payment). Buying the
-- Academy gives 3 months of Intelligence Pro free on the card the buyer paid
-- with, starting when the purchase is linked to an account (automatically when
-- the sign-in email matches and is confirmed, or by admin by hand); then the
-- Pro price monthly unless they cancel. The rules live in
-- src/lib/academy/rules.ts. One purchase gives one trial, ever.
--   email                     the checkout email, stored lower-case (the key auto-linking matches on)
--   stripe_customer_id        the customer the buyer paid as; the saved card lives on it, so the trial runs on it
--   stripe_payment_intent_id  the payment: the row's idempotency key (a replayed webhook finds the row)
--   stripe_payment_method_id  the card saved for off-session use at checkout
--   terms_accepted_at         when the checkout terms box was ticked (the saved-card consent; no consent, no trial)
--   user_id, linked_at/by     the account it is linked to, when, and how ('auto' | 'admin')
--   trial_subscription_id     the Pro trial subscription, once started (unique: one purchase per trial)
--   trial_started_at/ends_at  the trial's 90 days, from linking
--   previous_customer_id      the profile's old Stripe customer, when linking moved the profile onto this one
--   flag_reason               why it was not linked or needs a look in admin (live plan, team member, repeat, …)
--   reminder_sent_at          the "free months end on…" email, sent once
--   refunded_at               a refund (a full refund while trialing cancels the trial)
--   trial_cancelled_at        when the trial was cancelled (refund, admin unlink)
-- Service role only. Additive and re-runnable; nothing is added to ACCESS_COLUMNS.
create table if not exists public.academy_purchases (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  stripe_customer_id text,
  stripe_payment_intent_id text not null,
  stripe_payment_method_id text,
  amount_pence integer,
  paid_at timestamptz,
  user_id uuid references public.profiles(id) on delete set null,
  linked_at timestamptz,
  linked_by text,
  trial_subscription_id text,
  refunded_at timestamptz,
  stripe_checkout_session_id text,
  terms_accepted_at timestamptz,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  previous_customer_id text,
  flag_reason text,
  reminder_sent_at timestamptz,
  trial_cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists academy_purchases_payment_intent_uidx on public.academy_purchases (stripe_payment_intent_id);
create unique index if not exists academy_purchases_checkout_session_uidx on public.academy_purchases (stripe_checkout_session_id);
create unique index if not exists academy_purchases_trial_sub_uidx on public.academy_purchases (trial_subscription_id) where trial_subscription_id is not null;
create index if not exists academy_purchases_unlinked_email_idx on public.academy_purchases (email) where user_id is null;
create index if not exists academy_purchases_user_idx on public.academy_purchases (user_id) where user_id is not null;
do $$ begin
  alter table public.academy_purchases drop constraint if exists academy_purchases_email_check;
  alter table public.academy_purchases add constraint academy_purchases_email_check check (email = lower(email));
  alter table public.academy_purchases drop constraint if exists academy_purchases_linked_by_check;
  alter table public.academy_purchases add constraint academy_purchases_linked_by_check check (linked_by is null or linked_by in ('auto', 'admin'));
end $$;
alter table public.academy_purchases enable row level security;  -- no policies: service role only
revoke all on public.academy_purchases from anon, authenticated;
-- =========================
-- Batch 34: plan credit rollover
-- =========================
-- Unused plan credit rolls over with no cap (PLAN.md, Batch 34a). A renewal no
-- longer wipes it (credit_plan_cycle, edited in place above, and the
-- credit_grants.plan_cycle flag next to the table). Plan credit can lapse
-- only after 12 months with no spend at all, and never the newest month's;
-- the reminders and the live expiry come in Batch 34b. Here: the settings, the
-- one-off that stops existing plan credit lapsing, a read-only report of idle
-- members, and the targeted removal used for refunded plan payments and
-- cancelled Academy trials. Checked by supabase/tests/rollover-smoke.sql.

-- Settings (edited on /admin/billing):
--   plan_credit_idle_months            months with no spend before plan credit can lapse
--   plan_credit_idle_reminder_months   no-spend reminders, in months (the last is the final warning)
--   plan_credit_final_notice_days      days from the final warning actually sent to the expiry
--   plan_credit_rollover_from          the launch date; the no-spend clock never starts
--                                      earlier (written once by the one-off below)
insert into public.billing_settings (key, value) values
  ('plan_credit_idle_months', '12'),
  ('plan_credit_idle_reminder_months', '[3,6,12]'),
  ('plan_credit_final_notice_days', '30')
on conflict (key) do nothing;

-- credit_batch34_cycle_candidate(kind, plan_cycle, description): whether the
-- one-off below marks an existing grant as a cycle grant: a plan grant not yet
-- marked, except an upgrade's top-up (grantUpgradeDifference in
-- src/lib/stripe/grants.ts, described 'Upgrade to <plan>: extra plan
-- credit'). A top-up marked as a cycle start would make the newest renewal's
-- credit look like an older month's (expirable) and over-grant a later
-- upgrade's top-up. Its own function so rollover-smoke.sql can check it.
create or replace function public.credit_batch34_cycle_candidate(p_kind text, p_plan_cycle boolean, p_description text)
returns boolean language sql immutable set search_path = public as $$
  select p_kind = 'plan' and not coalesce(p_plan_cycle, false)
     and coalesce(p_description, '') not like 'Upgrade to %: extra plan credit';
$$;
revoke all on function public.credit_batch34_cycle_candidate(text, boolean, text) from public, anon, authenticated;
grant execute on function public.credit_batch34_cycle_candidate(text, boolean, text) to service_role;

-- One-off, marked by billing_settings 'batch34_rollover_from' (it also holds
-- the counts): stamps the launch date, stops every open plan grant lapsing at
-- its period end, and marks the existing plan grants (not upgrade top-ups:
-- credit_batch34_cycle_candidate) as cycle grants. Credit
-- that lapsed before launch is not restored. Rollback: re-set expires_at to
-- the period end on the grants the 'unexpired' count names.
do $$
declare
  v_now timestamptz := now();
  v_unexpired int;
  v_flagged int;
begin
  if not exists (select 1 from public.billing_settings where key = 'batch34_rollover_from') then
    insert into public.billing_settings (key, value) values ('plan_credit_rollover_from', to_jsonb(v_now))
    on conflict (key) do nothing;
    update public.credit_grants set expires_at = null
     where kind = 'plan' and remaining_pence > 0 and expires_at > v_now;
    get diagnostics v_unexpired = row_count;
    update public.credit_grants set plan_cycle = true
     where public.credit_batch34_cycle_candidate(kind, plan_cycle, description);
    get diagnostics v_flagged = row_count;
    insert into public.billing_settings (key, value)
    values ('batch34_rollover_from', jsonb_build_object('at', v_now, 'unexpired', v_unexpired, 'flagged', v_flagged));
  end if;
end $$;

-- The no-spend clock, one definition shared by credit_idle_plan_report and
-- credit_expire_idle_plan (Batch 34b), so the report and the expiry can never
-- disagree on who is idle or since when:
--   credit_plan_idle_after()  plan_credit_idle_months as an interval (at least a month)
--   credit_plan_idle_since(last_spent_at, first_plan_at)
--                             the later of the last debit and plan_credit_rollover_from;
--                             with neither, the first plan grant still held
create or replace function public.credit_plan_idle_after()
returns interval language sql stable security definer set search_path = public as $$
  select make_interval(months => greatest(1, round(credit_setting_num('plan_credit_idle_months', 12)))::int);
$$;
revoke all on function public.credit_plan_idle_after() from public, anon, authenticated;
grant execute on function public.credit_plan_idle_after() to service_role;

create or replace function public.credit_plan_idle_since(p_last_spent_at timestamptz, p_first_plan_at timestamptz)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(greatest(p_last_spent_at,
           (select (b.value #>> '{}')::timestamptz from billing_settings b
             where b.key = 'plan_credit_rollover_from' and jsonb_typeof(b.value) = 'string')),
         p_first_plan_at);
$$;
revoke all on function public.credit_plan_idle_since(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.credit_plan_idle_since(timestamptz, timestamptz) to service_role;

-- credit_idle_plan_report(p_now): read only. One row per member holding plan
-- credit who has spent nothing for at least plan_credit_idle_months:
--   last_spent_at         their latest debit (any debit that moved credit:
--                         automatic deal charges and team seats' spending
--                         included, as seats spend the owner's balance)
--   idle_since            the later of last_spent_at and plan_credit_rollover_from
--                         (with neither, their first plan grant)
--   plan_remaining_pence  all their unexpired plan credit
--   expirable_pence       the part of it in grants created BEFORE their newest
--                         plan_cycle grant: the newest month never lapses
-- Batch 34b's reminders and expiry read it; nothing here changes credit.
-- p_min_months (Batch 34b, Phase 12): list members idle at least this many
-- months instead (the reminder cron passes its smallest stage, 3); null keeps
-- plan_credit_idle_months, exactly as before. The old one-argument version is
-- dropped first so a one-argument call is never ambiguous.
drop function if exists public.credit_idle_plan_report(timestamptz);
create or replace function public.credit_idle_plan_report(p_now timestamptz default now(), p_min_months int default null)
returns table (user_id uuid, last_spent_at timestamptz, idle_since timestamptz, plan_remaining_pence numeric, expirable_pence numeric)
language sql stable security definer set search_path = public as $$
  with s as (
    select case when p_min_months is null then credit_plan_idle_after()
                else make_interval(months => greatest(1, p_min_months)) end as idle_after
  ), newest as (
    select g.user_id as uid, max(g.created_at) as newest_cycle_at
      from credit_grants g
     where g.kind = 'plan' and g.plan_cycle and g.created_at <= p_now
     group by g.user_id
  ), held as (
    select g.user_id as uid,
           sum(g.remaining_pence) as plan_remaining,
           coalesce(sum(g.remaining_pence) filter (where g.created_at < coalesce(n.newest_cycle_at, '-infinity'::timestamptz)), 0) as expirable,  -- no cycle grant known: nothing is expirable (the newest month is unknown, so protect it)
           min(g.created_at) as first_plan_at
      from credit_grants g
      left join newest n on n.uid = g.user_id
     where g.kind = 'plan' and g.remaining_pence > 0 and (g.expires_at is null or g.expires_at > p_now)
     group by g.user_id
  ), spent as (
    select h.*,
           (select max(t.at) from credit_transactions t
             where t.user_id = h.uid and t.kind = 'debit' and t.amount_pence < 0 and t.at <= p_now) as last_at
      from held h
  ), idle as (
    select sp.*, credit_plan_idle_since(sp.last_at, sp.first_plan_at) as since, s.idle_after
      from spent sp cross join s
  )
  select i.uid, i.last_at, i.since, i.plan_remaining, i.expirable
    from idle i
   where i.since <= p_now - i.idle_after
   order by i.since, i.uid;
$$;
revoke all on function public.credit_idle_plan_report(timestamptz, int) from public, anon, authenticated;
grant execute on function public.credit_idle_plan_report(timestamptz, int) to service_role;

-- credit_expire_plan_source(p_user, p_source_like, p_max_pence, p_reason,
--   p_total, p_created_from, p_created_to):
-- removes up to p_max_pence (null = all) of the member's unexpired plan credit
-- in grants whose source_ref is LIKE p_source_like (and, when given, created
-- in [p_created_from, p_created_to)), oldest first, under the member's row
-- lock. With p_total, p_max_pence is the TOTAL to have removed for p_reason
-- from those grants: what 'expire' rows with that reason already removed from
-- them (read after the lock is taken) comes off first, so two cumulative
-- refunds racing each other, or a redelivery, never remove more than the
-- latest total. Each grant touched gets an 'expire' ledger row (as
-- credit_expire_plan_grants writes them) with the reason in its metadata. A
-- grant never goes below zero and no other credit is touched. Used for a
-- refunded or charged-back plan payment ('inv:<invoice>', or an annual
-- plan's 'annual:<sub>:%' slots created in that invoice's year) and a
-- cancelled Academy trial ('trial:<sub>:%'). Note '_' is a LIKE wildcard:
-- escape it (as '\_') to match it literally. Returns {expired_pence, grants}.
drop function if exists public.credit_expire_plan_source(uuid, text, numeric, text);
create or replace function public.credit_expire_plan_source(
  p_user uuid, p_source_like text, p_max_pence numeric, p_reason text,
  p_total boolean default false, p_created_from timestamptz default null, p_created_to timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_reason text := coalesce(nullif(p_reason, ''), 'removed');
  v_left numeric := case when p_max_pence is null then null else round(p_max_pence, 4) end;
  v_done numeric;
  v_take numeric;
  v_total numeric := 0;
  n int := 0;
begin
  if p_user is null or coalesce(p_source_like, '') = '' then raise exception 'credit_expire_plan_source_bad_input'; end if;
  if v_left is not null and v_left <= 0 then
    return jsonb_build_object('expired_pence', 0, 'grants', 0);
  end if;
  perform 1 from profiles where id = p_user for update;
  if coalesce(p_total, false) and v_left is not null then
    select coalesce(sum(-t.amount_pence), 0) into v_done
      from credit_transactions t
      join credit_grants cg on cg.id = t.grant_id
     where t.user_id = p_user and t.kind = 'expire' and t.amount_pence < 0
       and t.metadata->>'reason' = v_reason
       and cg.user_id = p_user and cg.kind = 'plan' and cg.source_ref like p_source_like
       and (p_created_from is null or cg.created_at >= p_created_from)
       and (p_created_to is null or cg.created_at < p_created_to);
    v_left := greatest(0, v_left - v_done);
    if v_left <= 0 then return jsonb_build_object('expired_pence', 0, 'grants', 0); end if;
  end if;
  for g in
    select id, remaining_pence from credit_grants
     where user_id = p_user and kind = 'plan' and source_ref like p_source_like
       and remaining_pence > 0 and (expires_at is null or expires_at > now())
       and (p_created_from is null or created_at >= p_created_from)
       and (p_created_to is null or created_at < p_created_to)
     order by created_at, id
     for update
  loop
    exit when v_left is not null and v_left <= 0;
    v_take := case when v_left is null then g.remaining_pence else least(v_left, g.remaining_pence) end;
    if v_take <= 0 then continue; end if;
    insert into credit_transactions (user_id, kind, amount_pence, grant_id, description, metadata)
    values (p_user, 'expire', -v_take, g.id, 'Plan credit expired',
      jsonb_build_object('reason', v_reason, 'source_like', p_source_like));
    update credit_grants set remaining_pence = remaining_pence - v_take where id = g.id;
    v_total := v_total + v_take;
    if v_left is not null then v_left := v_left - v_take; end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('expired_pence', v_total, 'grants', n);
end;
$$;
revoke all on function public.credit_expire_plan_source(uuid, text, numeric, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.credit_expire_plan_source(uuid, text, numeric, text, boolean, timestamptz, timestamptz) to service_role;

-- ── Batch 34b: no-spend reminders and the live expiry ──
-- credit_idle_notices: one row per reminder stage (the months in
-- plan_credit_idle_reminder_months: 3, 6, 12) per idle run. idle_since is the
-- run's start as credit_plan_idle_since computes it; any spend moves it, so a
-- new run gets fresh rows. 'sent' = actually emailed (sent_at set); 'skipped'
-- = a missed lower stage recorded without sending. The final stage (the one
-- equal to plan_credit_idle_months) sent at least plan_credit_final_notice_days
-- ago is what credit_expire_idle_plan requires. Service role only.
create table if not exists public.credit_idle_notices (
  user_id uuid not null references public.profiles(id) on delete cascade,
  idle_since timestamptz not null,
  stage int not null check (stage > 0),
  status text not null check (status in ('sent', 'skipped')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, idle_since, stage),
  check (status <> 'sent' or sent_at is not null)
);
alter table public.credit_idle_notices enable row level security;  -- no policies: service role only
revoke all on public.credit_idle_notices from anon, authenticated;

-- credit_expire_idle_plan(p_user, p_now): the live no-spend expiry for one
-- member. Under the member's profile row lock it re-checks that they are
-- still idle (credit_plan_idle_since / credit_plan_idle_after, as
-- credit_idle_plan_report), that the final-stage notice for THIS idle run was
-- sent at least plan_credit_final_notice_days before p_now (a 'skipped' row
-- never counts), then expires the unexpired plan credit in grants created
-- before that notice was sent AND before the newest plan_cycle grant created
-- at or before that notice (the month that was newest when the warning went
-- out never lapses, nor does anything created after it; no cycle grant at the
-- notice = nothing expires). Each
-- grant touched gets an 'expire' row with reason 'no_spend'. Top-up, welcome,
-- bonus and adjustment credit is never touched; a grant never goes below
-- zero; a second call expires nothing. Returns {expired_pence, grants} and,
-- when nothing expired, reason: no_plan_credit | not_idle | no_final_notice |
-- notice_too_recent | no_cycle_grant | none_expirable.
create or replace function public.credit_expire_idle_plan(p_user uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_now timestamptz := coalesce(p_now, now());
  v_final int := greatest(1, round(credit_setting_num('plan_credit_idle_months', 12)))::int;
  v_wait interval := make_interval(days => greatest(1, round(credit_setting_num('plan_credit_final_notice_days', 30)))::int);
  v_first timestamptz;
  v_last timestamptz;
  v_since timestamptz;
  v_sent timestamptz;
  v_newest timestamptz;
  v_total numeric := 0;
  n int := 0;
begin
  if p_user is null then raise exception 'credit_expire_idle_plan_bad_input'; end if;
  perform 1 from profiles where id = p_user for update;

  -- Still idle? The same figures credit_idle_plan_report reads.
  select min(created_at) into v_first from credit_grants
   where user_id = p_user and kind = 'plan' and remaining_pence > 0 and (expires_at is null or expires_at > v_now);
  if v_first is null then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'no_plan_credit');
  end if;
  select max(at) into v_last from credit_transactions
   where user_id = p_user and kind = 'debit' and amount_pence < 0 and at <= v_now;
  v_since := credit_plan_idle_since(v_last, v_first);
  if v_since is null or v_since > v_now - credit_plan_idle_after() then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'not_idle');
  end if;

  -- The final warning for this idle run, actually sent, long enough ago.
  select sent_at into v_sent from credit_idle_notices
   where user_id = p_user and idle_since = v_since and stage = v_final and status = 'sent' and sent_at is not null;
  if v_sent is null then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'no_final_notice');
  end if;
  if v_sent > v_now - v_wait then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'notice_too_recent');
  end if;

  -- The month protected is the one that was newest WHEN THE WARNING WAS SENT
  -- (the email quoted that figure and said that month never expires); a cycle
  -- grant created since is after v_sent and so is safe too.
  select max(created_at) into v_newest from credit_grants
   where user_id = p_user and kind = 'plan' and plan_cycle and created_at <= v_sent;
  if v_newest is null then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'no_cycle_grant');
  end if;

  for g in
    select id, remaining_pence from credit_grants
     where user_id = p_user and kind = 'plan'
       and remaining_pence > 0 and (expires_at is null or expires_at > v_now)
       and created_at < v_sent and created_at < v_newest
     order by created_at, id
     for update
  loop
    if g.remaining_pence <= 0 then continue; end if;
    insert into credit_transactions (user_id, kind, amount_pence, grant_id, description, metadata)
    values (p_user, 'expire', -g.remaining_pence, g.id, 'Plan credit expired',
      jsonb_build_object('reason', 'no_spend', 'idle_since', v_since, 'notice_sent_at', v_sent));
    update credit_grants set remaining_pence = 0 where id = g.id;
    v_total := v_total + g.remaining_pence;
    n := n + 1;
  end loop;
  if n = 0 then
    return jsonb_build_object('expired_pence', 0, 'grants', 0, 'reason', 'none_expirable');
  end if;
  return jsonb_build_object('expired_pence', v_total, 'grants', n);
end;
$$;
revoke all on function public.credit_expire_idle_plan(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.credit_expire_idle_plan(uuid, timestamptz) to service_role;

-- =========================
-- Batch 38: Ads A1 (the ad pack: three landlord ads in an operator's own brand)
-- =========================
-- An Academy operator whose website is live on its own domain gets a pack of
-- three landlord ads (angles 5b, 3a, 17) to upload to their own Meta account.
-- Every ad carries a pack code in its ad name and link, so each website lead is
-- recorded against the ad that brought it (ad_pack_lead_links). See
-- PLAN-batch-38.md. Checked by supabase/tests/adpacks-smoke.sql.
--
--   ad_packs            one per owner (owner_id unique). version is the pack
--                       version n in the codes; operator_code is the first 6
--                       hex of the owner id, upper case (more on a collision).
--   ad_pack_ads         one row per ad per pack version; code is unique
--                       (SI-<operator code>-<angle>-<n>); an older version is
--                       kept with superseded_at set so its leads still match.
--   ad_pack_runs        one row per generation attempt (cost, by whom, dry run).
--   ad_pack_lead_links  one row per website lead: which ad brought it.
--
-- website_id is a plain uuid (no foreign key): this section sits before the
-- websites table (Batch 31) in this file. All four tables are reached by the
-- service role only (RLS on, no policy); nothing here is added to ACCESS_COLUMNS,
-- and leads.status / leads.crm_pushed_at are never written by this.
--
-- Settings (billing_settings, edited by the admin):
--   ad_packs_enabled            master switch for the whole feature (off)
--   ad_pack_free_regens         free regenerations of a pack per owner
--   ad_pack_voice_changes       voice (tone) changes per owner
--   ad_pack_max_raw_pence       most one generation may cost in raw spend
--   ad_pack_monthly_cap_pence   most all generations may cost in a UK month
--   ad_pack_min_area_samples    fewest reports an area figure may rest on

create table if not exists public.ad_packs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  website_id uuid,
  status text not null default 'draft',
  operator_code text not null,
  version integer not null default 1,
  voice_key text,
  voice_changes integer not null default 0,
  regen_count integer not null default 0,
  brand_hash text,
  area_key text,
  area_label text,
  bedrooms integer,
  figures jsonb,
  photos jsonb,
  checks jsonb,
  error_code text,
  cost_pence integer not null default 0,
  generated_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_packs_owner_id_key' and conrelid = 'public.ad_packs'::regclass) then
    alter table public.ad_packs add constraint ad_packs_owner_id_key unique (owner_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_packs_operator_code_key' and conrelid = 'public.ad_packs'::regclass) then
    alter table public.ad_packs add constraint ad_packs_operator_code_key unique (operator_code);
  end if;
end $$;
alter table public.ad_packs drop constraint if exists ad_packs_status_check;
alter table public.ad_packs add constraint ad_packs_status_check
  check (status in ('draft', 'generating', 'checks_failed', 'preview', 'approved', 'failed'));
alter table public.ad_packs drop constraint if exists ad_packs_counts_check;
alter table public.ad_packs add constraint ad_packs_counts_check
  check (version >= 1 and voice_changes >= 0 and regen_count >= 0 and cost_pence >= 0);
create index if not exists ad_packs_website_idx on public.ad_packs (website_id);
alter table public.ad_packs enable row level security;
revoke all on public.ad_packs from anon, authenticated;

create table if not exists public.ad_pack_ads (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.ad_packs(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  version integer not null,
  angle text not null,
  n integer not null,
  code varchar(40) not null,
  ad_name text,
  link text,
  texts jsonb,
  lead_form jsonb,
  files jsonb,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_pack_ads_code_key' and conrelid = 'public.ad_pack_ads'::regclass) then
    alter table public.ad_pack_ads add constraint ad_pack_ads_code_key unique (code);
  end if;
end $$;
alter table public.ad_pack_ads drop constraint if exists ad_pack_ads_angle_check;
alter table public.ad_pack_ads add constraint ad_pack_ads_angle_check check (angle in ('5b', '3a', '17'));
create index if not exists ad_pack_ads_pack_idx on public.ad_pack_ads (pack_id, version);
create index if not exists ad_pack_ads_owner_idx on public.ad_pack_ads (owner_id);
alter table public.ad_pack_ads enable row level security;
revoke all on public.ad_pack_ads from anon, authenticated;

create table if not exists public.ad_pack_runs (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.ad_packs(id) on delete cascade,
  version integer not null,
  by text not null,
  dry boolean not null default false,
  cost_pence integer not null default 0,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table public.ad_pack_runs drop constraint if exists ad_pack_runs_by_check;
alter table public.ad_pack_runs add constraint ad_pack_runs_by_check check (by in ('operator', 'admin'));
create index if not exists ad_pack_runs_pack_idx on public.ad_pack_runs (pack_id, created_at desc);
create index if not exists ad_pack_runs_month_idx on public.ad_pack_runs (created_at) where not dry;
alter table public.ad_pack_runs enable row level security;
revoke all on public.ad_pack_runs from anon, authenticated;

create table if not exists public.ad_pack_lead_links (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  pack_ad_id uuid references public.ad_pack_ads(id) on delete set null,
  match text not null,
  ad_code_seen varchar(40),
  meta_ad_id_seen varchar(30),
  linked_at timestamptz not null default now()
);
alter table public.ad_pack_lead_links drop constraint if exists ad_pack_lead_links_match_check;
alter table public.ad_pack_lead_links add constraint ad_pack_lead_links_match_check
  check (match in ('code', 'ad_id', 'none', 'foreign_code'));
create index if not exists ad_pack_lead_links_owner_idx on public.ad_pack_lead_links (owner_id, linked_at desc);
create index if not exists ad_pack_lead_links_ad_idx on public.ad_pack_lead_links (pack_ad_id);
create index if not exists ad_pack_lead_links_meta_idx on public.ad_pack_lead_links (owner_id, meta_ad_id_seen) where meta_ad_id_seen is not null;
alter table public.ad_pack_lead_links enable row level security;
revoke all on public.ad_pack_lead_links from anon, authenticated;

-- The private bucket for the pack's image and video files. Private, with no
-- storage.objects policy, so only the service role reads or writes it; an
-- operator downloads through a short signed link. Same pattern as
-- feedback-screenshots (above): "on conflict" puts it back to private, and an
-- old storage schema raises a notice instead of stopping the run (create the
-- bucket by hand, private).
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ad-packs', 'ad-packs', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise notice 'The ad-packs bucket was not created (%): create it by hand, private.', sqlerrm;
end $$;

insert into public.billing_settings (key, value) values
  ('ad_packs_enabled', 'false'::jsonb),
  ('ad_pack_free_regens', '1'::jsonb),
  ('ad_pack_voice_changes', '1'::jsonb),
  ('ad_pack_max_raw_pence', '500'::jsonb),
  ('ad_pack_monthly_cap_pence', '5000'::jsonb),
  ('ad_pack_min_area_samples', '5'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- Batch 38b: notice video renders
-- =========================
-- The notice ad (angle 5b) becomes a real 9:16 video in the operator's brand
-- (an ElevenLabs voiceover, burned-in captions, plus 4:5 and 1:1 crops). It is
-- rendered in a Vercel Sandbox (Python + ffmpeg) by a cron worker, never in a
-- request. See PLAN-batch-38.md. Checked by supabase/tests/adpacks-render-smoke.sql.
--
--   ad_pack_renders  one row per render of a pack version: the queue the worker
--                    drains, its lease, attempts, cost and the files it made.
--                    (pack_id, version) is unique, so a version is rendered once.
--                    A voice change is a NEW version (version + 1, made by the
--                    generator), never a reused row.
--
-- Service role only (RLS on, no policy); not in ACCESS_COLUMNS; never writes
-- leads.status or leads.crm_pushed_at.
--
-- Settings (billing_settings, edited by the admin):
--   ad_pack_render_max_seconds   hard time limit for one render (sandbox timeout)
--   ad_pack_render_max_attempts  tries before a render is left failed
--   ad_pack_sandbox_vcpus        vCPUs asked for per sandbox
-- The sandbox price is the unit_costs row ('vercel', 'sandbox_cpu_second'):
-- cost = seconds x vcpus x that row. It is the one source of the price.

create table if not exists public.ad_pack_renders (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.ad_packs(id) on delete cascade,
  version integer not null,
  voice_key text not null,
  state text not null default 'queued',
  sandbox_id text,
  attempts integer not null default 0,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  cost_pence integer not null default 0,
  error_code text,
  files jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_pack_renders_pack_version_key' and conrelid = 'public.ad_pack_renders'::regclass) then
    alter table public.ad_pack_renders add constraint ad_pack_renders_pack_version_key unique (pack_id, version);
  end if;
end $$;
alter table public.ad_pack_renders drop constraint if exists ad_pack_renders_state_check;
alter table public.ad_pack_renders add constraint ad_pack_renders_state_check
  check (state in ('queued', 'running', 'done', 'failed'));
alter table public.ad_pack_renders drop constraint if exists ad_pack_renders_counts_check;
alter table public.ad_pack_renders add constraint ad_pack_renders_counts_check
  check (attempts >= 0 and cost_pence >= 0);
alter table public.ad_pack_renders drop constraint if exists ad_pack_renders_error_code_check;
alter table public.ad_pack_renders add constraint ad_pack_renders_error_code_check
  check (error_code is null or char_length(error_code) <= 60);
create index if not exists ad_pack_renders_state_idx on public.ad_pack_renders (state, created_at);
create index if not exists ad_pack_renders_pack_idx on public.ad_pack_renders (pack_id);
alter table public.ad_pack_renders enable row level security;
revoke all on public.ad_pack_renders from anon, authenticated;

insert into public.billing_settings (key, value) values
  ('ad_pack_render_max_seconds', '300'::jsonb),
  ('ad_pack_render_max_attempts', '3'::jsonb),
  ('ad_pack_sandbox_vcpus', '2'::jsonb)
on conflict (key) do nothing;

-- The sandbox's Active CPU time. $0.128 per CPU-hour at 79p a dollar is
-- 10.112p an hour, 0.00280889p a second (8 places is what the column keeps).
insert into public.unit_costs (provider, unit, label, unit_cost_pence, markup, notes) values
  ('vercel', 'sandbox_cpu_second', 'Vercel Sandbox Active CPU (per CPU-second)', 0.00280889, 5, 'Estimate: $0.128 per CPU-hour at 79p a dollar (Nov 2026); re-check against the Vercel invoice. House spend, not charged to the operator')
on conflict (provider, unit) do nothing;

notify pgrst, 'reload schema';

-- Batch 31: customer websites (Phase 1: schema and settings)
-- =========================
-- A member who is invited gets a small white-label website at /s/<slug> whose
-- two-step lead form runs the income report for the landlord who submits it.
-- This section is the whole database side:
--
--   funnels.kind              'form' (today's funnels) | 'website'. A website's
--                             funnel row is kind='website', active=false for
--                             ever: it exists only so leads, the lead cap and
--                             the activity log have a funnel to hang on. Live /
--                             paused lives on websites.status.
--   websites                  one per member (user_id unique), one funnel row
--                             each (on delete restrict: a funnel with a site
--                             is never deleted from under it). settings,
--                             pages, checks are the setup flow's jsonb.
--                             domain is the Batch 33 seam; null for now.
--   lead_sources              where a website lead came from (utm_*, fbclid,
--                             the ad code, the landing PATH only, never a
--                             query string or an address). Generic, so later
--                             lead sources can reuse it. Cascades with the lead.
--   website_reports           one row per website lead: where its income report
--                             is (state), the billing mode and price FROZEN at
--                             step 2, the lease a running report holds, the
--                             attempts, the quality flag and the self-submit
--                             flag. Cascades with the lead; expires after 14 days.
--   website_report_slots      one row per free report claimed, per UK day: the
--                             daily limit counts these. No foreign keys, so a
--                             purged lead still counts against its day.
--   website_report_charges    one row per charged report (the guard and the
--                             record): charged, or unpaid when the balance was
--                             short. lead_id is deliberately not a foreign key
--                             (leads are purged; what was charged stays).
--
--   website_uk_day()                    today's date in Europe/London.
--   website_free_report_claim(...)      claim one of today's free report slots:
--                                       'claimed' | 'already' | 'site_full' | 'day_full'.
--   website_report_charge(p)            charge one report, once, face pence.
--
-- Settings (billing_settings; src/lib/websites/settings.ts parses them):
--   website_report_charge_on               false: free reports, house-paid
--   website_report_pence                   the price when charging is on
--   website_plan_gate_on                   false: no plan needed for a site
--   website_free_reports_per_day           all sites together, per UK day
--   website_free_reports_per_site_per_day  one site, per UK day (inside the above)
--
-- Everything is additive, idempotent and service role only (the one member
-- read is "select your own website"). Nothing here is in ACCESS_COLUMNS
-- (src/lib/access.ts): the access gate's column list is untouched.

-- ── funnels.kind ──
alter table public.funnels add column if not exists kind text not null default 'form';
alter table public.funnels drop constraint if exists funnels_kind_check;
alter table public.funnels add constraint funnels_kind_check check (kind in ('form', 'website'));

-- ── websites ──
create table if not exists public.websites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  funnel_id uuid not null unique references public.funnels(id) on delete restrict,
  slug text not null unique,
  status text not null default 'invited',
  settings jsonb not null default '{}'::jsonb,
  pages jsonb not null default '{}'::jsonb,
  regen_count integer not null default 0,
  checks jsonb not null default '{}'::jsonb,
  invited_by uuid references public.profiles(id) on delete set null,
  invited_at timestamptz not null default now(),
  approved_at timestamptz,
  live_at timestamptz,
  paused_at timestamptz,
  -- Batch 33: a customer's own domain. Null until then.
  domain text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.websites drop constraint if exists websites_slug_check;
alter table public.websites add constraint websites_slug_check check (slug ~ '^[a-z0-9-]{3,40}$');
alter table public.websites drop constraint if exists websites_status_check;
alter table public.websites add constraint websites_status_check check (status in ('invited', 'setup', 'preview', 'live', 'paused'));
alter table public.websites drop constraint if exists websites_regen_count_check;
alter table public.websites add constraint websites_regen_count_check check (regen_count >= 0);
create index if not exists websites_status_idx on public.websites (status);
alter table public.websites enable row level security;
revoke all on public.websites from anon, authenticated;
grant select on public.websites to authenticated;
drop policy if exists "Users can read own website" on public.websites;
create policy "Users can read own website"
  on public.websites for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── lead_sources ──
create table if not exists public.lead_sources (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  -- A path only: no query string, no address.
  landing_page text,
  ad_code varchar(40),
  captured_at timestamptz not null default now()
);
alter table public.lead_sources enable row level security;  -- no policies: service role only
revoke all on public.lead_sources from anon, authenticated;

-- ── website_reports ──
create table if not exists public.website_reports (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  state text not null default 'awaiting_address',
  -- Frozen at step 2, so flipping the setting mid-run changes nothing for this report.
  billing_mode text,
  price_pence integer,
  -- A held report runs on or after this UK day.
  due_day date,
  -- A running report holds this lease; the cron takes it over once it is past.
  lease_until timestamptz,
  attempts integer not null default 0,
  quality_ok boolean,
  self_submit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  -- An abandoned step 2 stays a New lead; its report row goes after 14 days.
  expires_at timestamptz not null default (now() + interval '14 days')
);
alter table public.website_reports drop constraint if exists website_reports_state_check;
alter table public.website_reports add constraint website_reports_state_check
  check (state in ('awaiting_address', 'held_cap', 'held_credit', 'held_self', 'running', 'done', 'failed', 'expired'));
alter table public.website_reports drop constraint if exists website_reports_billing_mode_check;
alter table public.website_reports add constraint website_reports_billing_mode_check
  check (billing_mode is null or billing_mode in ('free', 'charged'));
alter table public.website_reports drop constraint if exists website_reports_price_check;
alter table public.website_reports add constraint website_reports_price_check
  check (price_pence is null or price_pence >= 0);
alter table public.website_reports drop constraint if exists website_reports_attempts_check;
alter table public.website_reports add constraint website_reports_attempts_check check (attempts >= 0);
create index if not exists website_reports_site_idx on public.website_reports (website_id, created_at desc);
create index if not exists website_reports_held_idx on public.website_reports (due_day) where state in ('held_cap', 'held_credit');
create index if not exists website_reports_running_idx on public.website_reports (lease_until) where state = 'running';
create index if not exists website_reports_expires_idx on public.website_reports (expires_at) where state in ('awaiting_address', 'held_cap', 'held_credit', 'held_self');
alter table public.website_reports enable row level security;  -- no policies: service role only
revoke all on public.website_reports from anon, authenticated;

-- ── website_report_slots: the free reports claimed per UK day ──
create table if not exists public.website_report_slots (
  lead_id uuid primary key,
  website_id uuid not null,
  day date not null,
  created_at timestamptz not null default now()
);
create index if not exists website_report_slots_day_idx on public.website_report_slots (day, website_id);
alter table public.website_report_slots enable row level security;  -- no policies: service role only
revoke all on public.website_report_slots from anon, authenticated;

-- ── website_report_charges: one row per charged report (the guard and the record) ──
create table if not exists public.website_report_charges (
  lead_id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  website_id uuid,
  pence numeric not null,
  txn_id bigint,
  status text not null default 'unpaid',
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.website_report_charges drop constraint if exists website_report_charges_status_check;
alter table public.website_report_charges add constraint website_report_charges_status_check check (status in ('charged', 'unpaid'));
create index if not exists website_report_charges_owner_idx on public.website_report_charges (owner_id, created_at desc);
alter table public.website_report_charges enable row level security;  -- no policies: service role only
revoke all on public.website_report_charges from anon, authenticated;

-- ── billing_settings: the five switches and limits ──
insert into public.billing_settings (key, value) values
  ('website_report_charge_on', 'false'),
  ('website_report_pence', '300'),
  ('website_plan_gate_on', 'false'),
  ('website_free_reports_per_day', '20'),
  ('website_free_reports_per_site_per_day', '5')
on conflict (key) do nothing;

-- ── Functions ──

-- Today in the UK. The daily limit's day is computed here, never by the app.
create or replace function public.website_uk_day()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/London')::date;
$$;
revoke all on function public.website_uk_day() from public, anon, authenticated;
grant execute on function public.website_uk_day() to service_role;

-- A whole-number setting, or the default when the row is missing or not a
-- whole number (a bad value must never raise inside a claim).
create or replace function public.website_setting_int(p_key text, p_default integer)
returns integer language sql security definer set search_path = public stable as $$
  select coalesce(
    (select case when (value #>> '{}') ~ '^[0-9]{1,9}$' then (value #>> '{}')::integer end
       from public.billing_settings where key = p_key),
    p_default);
$$;
revoke all on function public.website_setting_int(text, integer) from public, anon, authenticated;
grant execute on function public.website_setting_int(text, integer) to service_role;

-- website_free_report_claim(p_lead, p_website, p_held): claim one of today's
-- free report slots for a lead.
--   'claimed'    a slot is now this lead's
--   'already'    this lead already holds a slot (any day): run, do not claim again
--   'site_full'  this site is at its per-site limit for the UK day
--   'day_full'   all sites together are at the daily limit
-- Two limits, both read from billing_settings: the daily total
-- (website_free_reports_per_day) and the per-site share inside it
-- (website_free_reports_per_site_per_day). A held report (p_held = true, the
-- cron running yesterday's overflow) needs used < limit. A live one needs
-- used + the held reports now due < limit, so held reports always fit first
-- and a busy day cannot push the backlog out for ever. The UK day is taken
-- here; claims for one day queue on an advisory lock, so two claims at the
-- limit cannot both win.
create or replace function public.website_free_report_claim(p_lead uuid, p_website uuid, p_held boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_day date := public.website_uk_day();
  v_cap integer := public.website_setting_int('website_free_reports_per_day', 20);
  v_site_cap integer := public.website_setting_int('website_free_reports_per_site_per_day', 5);
  v_used integer;
  v_site_used integer;
  v_due integer := 0;
  v_site_due integer := 0;
begin
  if p_lead is null or p_website is null then raise exception 'website_free_report_claim_bad_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('website_free_report_claim:' || v_day::text, 0));

  if exists (select 1 from public.website_report_slots where lead_id = p_lead) then return 'already'; end if;

  select count(*), count(*) filter (where website_id = p_website)
    into v_used, v_site_used
    from public.website_report_slots where day = v_day;

  if not p_held then
    -- Held reports that are due and have not yet taken a slot.
    select count(*), count(*) filter (where r.website_id = p_website)
      into v_due, v_site_due
      from public.website_reports r
     where r.state = 'held_cap' and r.due_day <= v_day
       and not exists (select 1 from public.website_report_slots s where s.lead_id = r.lead_id);
  end if;

  if v_site_used + v_site_due >= v_site_cap then return 'site_full'; end if;
  if v_used + v_due >= v_cap then return 'day_full'; end if;

  insert into public.website_report_slots (lead_id, website_id, day) values (p_lead, p_website, v_day)
  on conflict (lead_id) do nothing;
  return 'claimed';
end;
$$;
revoke all on function public.website_free_report_claim(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.website_free_report_claim(uuid, uuid, boolean) to service_role;

-- website_report_charge(p): charge one website report, once, when charging is
-- on and the report was good enough to charge for (the app decides that).
--   p: {owner, lead, website, pence, meta}; pence missing falls back to the
--   price frozen on the report row.
-- Returns {result, already, pence, tx, status}:
--   result 'charged'          the guard row went in and the face debit worked
--          'unpaid'           the balance was short (P0402): recorded, not raised
--          'already_charged'  this lead has a row already (charged OR unpaid): nothing happens
-- Once per lead: the guard row goes in first, under the owner's profile lock
-- (as funnel_lead_charge does), so a retry, the cron and the live route can
-- never charge the same lead twice. A short balance leaves a status='unpaid'
-- row and returns normally, so the landlord's summary is never lost to a
-- billing problem. The debit is credit_debit_face's (exactly p pence of the
-- displayed balance); it never uses the run's action_id.
create or replace function public.website_report_charge(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := nullif(p->>'owner', '')::uuid;
  v_lead uuid := nullif(p->>'lead', '')::uuid;
  v_site uuid := nullif(p->>'website', '')::uuid;
  v_meta jsonb := case when jsonb_typeof(p->'meta') = 'object' then p->'meta' else '{}'::jsonb end;
  v_pence numeric;
  v_tx bigint;
  v_row public.website_report_charges;
begin
  if v_owner is null or v_lead is null then raise exception 'website_report_charge_bad_input'; end if;
  v_pence := coalesce(nullif(p->>'pence', '')::numeric, (select price_pence from public.website_reports where lead_id = v_lead));
  if v_pence is null or v_pence <= 0 then raise exception 'website_report_charge_bad_input'; end if;

  perform 1 from public.profiles where id = v_owner for update;

  insert into public.website_report_charges (lead_id, owner_id, website_id, pence, status)
  values (v_lead, v_owner, v_site, v_pence, 'unpaid')
  on conflict (lead_id) do nothing;
  if not found then
    select * into v_row from public.website_report_charges where lead_id = v_lead;
    return jsonb_build_object('result', 'already_charged', 'already', true, 'pence', v_row.pence, 'tx', v_row.txn_id, 'status', v_row.status);
  end if;

  begin
    v_tx := public.credit_debit_face(v_owner, v_pence,
      v_meta || jsonb_build_object('action', 'website_report', 'description', 'Website income report', 'website_id', v_site, 'lead_id', v_lead, 'quantity', 1));
  exception when sqlstate 'P0402' then
    return jsonb_build_object('result', 'unpaid', 'already', false, 'pence', v_pence, 'tx', null, 'status', 'unpaid');
  end;

  update public.website_report_charges set txn_id = v_tx, status = 'charged' where lead_id = v_lead;
  return jsonb_build_object('result', 'charged', 'already', false, 'pence', v_pence, 'tx', v_tx, 'status', 'charged');
end;
$$;
revoke all on function public.website_report_charge(jsonb) from public, anon, authenticated;
grant execute on function public.website_report_charge(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 32: website leads go into the operator's lead database account.
--
-- A landlord who fills in an operator's website form is also pushed, signed,
-- to the operator's own lead database account (never charged, never given or
-- sold on there; see PLAN-batch-32.md). The lead database's state lives in
-- THESE tables: leads.status and leads.crm_pushed_at keep meaning "went to your
-- CRM" and are never written by this.
--
-- Both tables are reached by the service role only: RLS on with no policy, and
-- nothing here is added to ACCESS_COLUMNS. The member id sent to the lead
-- database is the owner's profile id; the link code itself is never stored here
-- (the lead database emails and checks it).
-- =========================

-- leaddb_links: one row per owner: the confirmed (or pending) link to their lead database account.
create table if not exists public.leaddb_links (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  link_id uuid,
  -- The login email they gave the lead database. Never shown to a team member.
  email text not null,
  lead_type text,
  status text not null default 'code_sent',
  connected_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.leaddb_links drop constraint if exists leaddb_links_status_check;
alter table public.leaddb_links add constraint leaddb_links_status_check
  check (status in ('code_sent', 'active', 'revoked', 'error'));
alter table public.leaddb_links drop constraint if exists leaddb_links_lead_type_check;
alter table public.leaddb_links add constraint leaddb_links_lead_type_check
  check (lead_type is null or lead_type in ('management', 'guaranteed_rent'));
alter table public.leaddb_links enable row level security;
revoke all on public.leaddb_links from anon, authenticated;

-- leaddb_deliveries: the retry queue behind every push of a website lead to the lead database.
-- One row per lead. The lead is sent first (step 1, "report coming"); the report follows when it is done.
create table if not exists public.leaddb_deliveries (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- A running push holds this lease; the sweep takes it over once it is past.
  lease_until timestamptz,
  lead_sent_at timestamptz,
  report_sent_at timestamptz,
  -- The lead database's own id for the lead, kept so a retry never makes a second one.
  leaddb_lead_id uuid,
  outcome text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.leaddb_deliveries drop constraint if exists leaddb_deliveries_status_check;
alter table public.leaddb_deliveries add constraint leaddb_deliveries_status_check
  check (status in ('pending', 'sent', 'failed'));
alter table public.leaddb_deliveries drop constraint if exists leaddb_deliveries_attempts_check;
alter table public.leaddb_deliveries add constraint leaddb_deliveries_attempts_check check (attempts >= 0);
create index if not exists leaddb_deliveries_due_idx
  on public.leaddb_deliveries (next_attempt_at) where status = 'pending';
create index if not exists leaddb_deliveries_owner_idx on public.leaddb_deliveries (owner_id, updated_at desc);
alter table public.leaddb_deliveries enable row level security;
revoke all on public.leaddb_deliveries from anon, authenticated;

notify pgrst, 'reload schema';

-- =========================
-- Batch 33: customer website domains (Phase 1: schema and settings)
-- =========================
-- When a member approves their website, Stayful buys <company>management.co.uk
-- through Openprovider (Stayful holds it), connects it to the Vercel project
-- with HTTPS, moves the site onto it and redirects the old /s/<slug> address.
-- The first year is free. A yearly charge equal to the domain's cost is built
-- but OFF (domain_charge_on). This section is the whole database side:
--
--   website_domain_offers    the names we offered a site (server-side, 24h): a
--                            member can only choose a name from this list.
--   website_domains          one live domain row per website (and per name), a
--                            status that says where the purchase is, a
--                            timestamp for each connect step, the renewal
--                            decision and the last error (a code, 200 chars).
--                            website_id is on delete restrict: a site with a
--                            domain row is never deleted from under it.
--   website_domain_spend     one row per spend claim (key unique: register:<id>,
--                            renew:<id>:<expiry>). The daily cap counts claimed
--                            plus bought pence for the UK day; void gives the
--                            money back to the day.
--   website_domain_charges   one row per charged year (domain + period). No
--                            foreign keys: what was charged stays.
--
--   website_domain_spend_claim(...)   claimed | already | over_cap, under an
--                                     advisory lock on the UK day, the cap read
--                                     here from billing_settings.
--   website_domain_spend_settle(...)  claimed -> bought | void.
--   website_domain_charge(p)          charge one year, once, face pence.
--                                     Reachable from the app only through one
--                                     function that returns early when
--                                     domain_charge_on is false.
--
-- Settings (billing_settings; src/lib/domains/settings.ts parses them):
--   domain_charge_on                false: the yearly charge never runs
--   domain_daily_spend_cap_pence    5000: most Stayful spends on domains per UK day
--   domain_auto_buy                 true: buy as soon as a member chooses
--
-- Everything is additive, idempotent and service role only (the member reads
-- are "your own offer" and "your own domain", listed columns only). Nothing
-- here is in ACCESS_COLUMNS (src/lib/access.ts).

-- ── websites.domain: one site per domain ──
create unique index if not exists websites_domain_unique_idx on public.websites (lower(domain)) where domain is not null;

-- ── website_domain_offers ──
create table if not exists public.website_domain_offers (
  website_id uuid primary key references public.websites(id) on delete cascade,
  names text[] not null default '{}',
  -- name -> price in pence (a GBP price from the registrar at the time of the offer)
  prices jsonb not null default '{}'::jsonb,
  offered_at timestamptz not null default now()
);
alter table public.website_domain_offers drop constraint if exists website_domain_offers_names_check;
alter table public.website_domain_offers add constraint website_domain_offers_names_check check (coalesce(array_length(names, 1), 0) <= 6);
alter table public.website_domain_offers enable row level security;
revoke all on public.website_domain_offers from anon, authenticated;
grant select on public.website_domain_offers to authenticated;
drop policy if exists "Users can read own domain offer" on public.website_domain_offers;
create policy "Users can read own domain offer"
  on public.website_domain_offers for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.user_id = (select auth.uid())));

-- ── website_domains ──
create table if not exists public.website_domains (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  -- The account owner. No foreign key: the record of a bought domain outlives anything else.
  owner_id uuid not null,
  name text not null,
  status text not null default 'awaiting_admin',
  registrar text,
  registrar_ref text,
  cost_pence integer,
  bought_at timestamptz,
  expires_at timestamptz,
  -- Batch 36's switch: false stops a renewal (the plan's lapsed, the site is switched off).
  renew_allowed boolean not null default true,
  renew_decision text,
  renew_decided_by uuid,
  renew_decided_at timestamptz,
  dns_set_at timestamptz,
  vercel_added_at timestamptz,
  https_ok_at timestamptz,
  live_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  stuck_alerted_at timestamptz,
  -- The expiry (date) the admin was last emailed a renewal reminder for: one email per domain per period.
  renewal_alerted_for date,
  state_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.website_domains drop constraint if exists website_domains_name_check;
alter table public.website_domains add constraint website_domains_name_check
  check (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.co\.uk$' and name !~ '(^|\.)xn--');
alter table public.website_domains drop constraint if exists website_domains_status_check;
alter table public.website_domains add constraint website_domains_status_check
  check (status in ('awaiting_admin', 'held_cap', 'registering', 'connecting', 'live', 'needs_choice', 'failed', 'releasing', 'released'));
alter table public.website_domains drop constraint if exists website_domains_renew_decision_check;
alter table public.website_domains add constraint website_domains_renew_decision_check
  check (renew_decision is null or renew_decision in ('renew', 'dont_renew'));
alter table public.website_domains drop constraint if exists website_domains_last_error_check;
alter table public.website_domains add constraint website_domains_last_error_check check (last_error is null or char_length(last_error) <= 200);
alter table public.website_domains drop constraint if exists website_domains_attempts_check;
alter table public.website_domains add constraint website_domains_attempts_check check (attempts >= 0);
alter table public.website_domains drop constraint if exists website_domains_cost_check;
alter table public.website_domains add constraint website_domains_cost_check check (cost_pence is null or cost_pence >= 0);
-- The expiry (date) the admin was last emailed the 7-day auto-renew outcome for: one such email per domain per period.
alter table public.website_domains add column if not exists autorenew_alerted_for date;
-- One active domain per site, and one active owner per name; a released name can be used again.
create unique index if not exists website_domains_site_active_idx on public.website_domains (website_id) where status <> 'released';
create unique index if not exists website_domains_name_active_idx on public.website_domains (name) where status <> 'released';
create index if not exists website_domains_status_idx on public.website_domains (status, state_changed_at);
create index if not exists website_domains_expiry_idx on public.website_domains (expires_at) where status = 'live';
alter table public.website_domains enable row level security;
revoke all on public.website_domains from anon, authenticated;
-- A member reads their own domain: the name and where it is, never the registrar's reference, the cost or an error.
grant select (id, website_id, name, status, live_at, created_at) on public.website_domains to authenticated;
drop policy if exists "Users can read own domain" on public.website_domains;
create policy "Users can read own domain"
  on public.website_domains for select to authenticated
  using (owner_id = (select auth.uid()));

-- ── website_domain_spend ──
create table if not exists public.website_domain_spend (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references public.website_domains(id) on delete restrict,
  kind text not null,
  uk_day date not null,
  pence integer not null,
  status text not null default 'claimed',
  key text not null,
  registrar_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.website_domain_spend drop constraint if exists website_domain_spend_kind_check;
alter table public.website_domain_spend add constraint website_domain_spend_kind_check check (kind in ('register', 'renew'));
alter table public.website_domain_spend drop constraint if exists website_domain_spend_status_check;
alter table public.website_domain_spend add constraint website_domain_spend_status_check check (status in ('claimed', 'bought', 'void'));
alter table public.website_domain_spend drop constraint if exists website_domain_spend_pence_check;
alter table public.website_domain_spend add constraint website_domain_spend_pence_check check (pence > 0);
create unique index if not exists website_domain_spend_key_idx on public.website_domain_spend (key);
create index if not exists website_domain_spend_day_idx on public.website_domain_spend (uk_day) where status in ('claimed', 'bought');
create index if not exists website_domain_spend_domain_idx on public.website_domain_spend (domain_id);
alter table public.website_domain_spend enable row level security;  -- no policies: service role only
revoke all on public.website_domain_spend from anon, authenticated;

-- ── website_domain_charges: one row per charged year (the guard and the record) ──
create table if not exists public.website_domain_charges (
  domain_id uuid not null,
  period text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  pence numeric not null,
  txn_id bigint,
  status text not null default 'unpaid',
  created_at timestamptz not null default now(),
  primary key (domain_id, period)
);
alter table public.website_domain_charges drop constraint if exists website_domain_charges_status_check;
alter table public.website_domain_charges add constraint website_domain_charges_status_check check (status in ('charged', 'unpaid'));
create index if not exists website_domain_charges_owner_idx on public.website_domain_charges (owner_id, created_at desc);
alter table public.website_domain_charges enable row level security;  -- no policies: service role only
revoke all on public.website_domain_charges from anon, authenticated;

-- ── billing_settings: the three switches and limits ──
insert into public.billing_settings (key, value) values
  ('domain_charge_on', 'false'),
  ('domain_daily_spend_cap_pence', '5000'),
  ('domain_auto_buy', 'true')
on conflict (key) do nothing;

-- ── Functions ──

-- website_domain_spend_claim(p_domain, p_kind, p_pence, p_key): claim spend for
-- one registrar purchase or renewal.
--   'claimed'   this key now holds the money (it counts against today's cap)
--   'already'   this key holds it already (claimed or bought): never spend twice
--   'over_cap'  claimed + bought pence for the UK day, plus this, is over the cap
-- The UK day and the cap (domain_daily_spend_cap_pence) are taken here, never
-- from the app, and claims for one day queue on an advisory lock, so two
-- approvals arriving together cannot both fit under the last pound of cap. A
-- void claim does not count and can be claimed again under the same key.
create or replace function public.website_domain_spend_claim(p_domain uuid, p_kind text, p_pence integer, p_key text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_day date := public.website_uk_day();
  v_cap integer := public.website_setting_int('domain_daily_spend_cap_pence', 5000);
  v_used bigint;
  v_row public.website_domain_spend;
  v_exists boolean;
begin
  if p_domain is null or p_key is null or length(p_key) = 0 or p_kind not in ('register', 'renew') or p_pence is null or p_pence <= 0 then
    raise exception 'website_domain_spend_claim_bad_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('website_domain_spend_claim:' || v_day::text, 0));

  select * into v_row from public.website_domain_spend where key = p_key;
  -- FOUND is overwritten by the next select, so keep the answer.
  v_exists := found;
  if v_exists and v_row.status <> 'void' then return 'already'; end if;

  select coalesce(sum(pence), 0) into v_used
    from public.website_domain_spend where uk_day = v_day and status in ('claimed', 'bought');
  if v_used + p_pence > v_cap then return 'over_cap'; end if;

  if v_exists then
    update public.website_domain_spend
       set status = 'claimed', uk_day = v_day, pence = p_pence, domain_id = p_domain, kind = p_kind, updated_at = now()
     where key = p_key;
  else
    insert into public.website_domain_spend (domain_id, kind, uk_day, pence, status, key)
    values (p_domain, p_kind, v_day, p_pence, 'claimed', p_key);
  end if;
  return 'claimed';
end;
$$;
revoke all on function public.website_domain_spend_claim(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.website_domain_spend_claim(uuid, text, integer, text) to service_role;

-- website_domain_spend_settle(p_key, p_status, p_ref): a claim became a real
-- purchase ('bought', with the registrar's reference) or was given back
-- ('void'). Only a claimed row moves; a bought one stays bought. Returns
-- whether a row moved.
create or replace function public.website_domain_spend_settle(p_key text, p_status text, p_ref text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('bought', 'void') then raise exception 'website_domain_spend_settle_bad_input'; end if;
  update public.website_domain_spend
     set status = p_status, registrar_ref = coalesce(p_ref, registrar_ref), updated_at = now()
   where key = p_key and status = 'claimed';
  return found;
end;
$$;
revoke all on function public.website_domain_spend_settle(text, text, text) from public, anon, authenticated;
grant execute on function public.website_domain_spend_settle(text, text, text) to service_role;

-- website_domain_charge(p): charge one year of a domain, once, when charging is
-- on (the app decides; this is never called at registration: year 1 is free).
--   p: {owner, domain, period, pence, meta}
-- Returns {result, already, pence, tx, status}:
--   result 'charged'          the guard row went in and the face debit worked
--          'unpaid'           the balance was short (P0402): recorded, not raised
--          'already_charged'  this domain and period have a row already: nothing happens
-- Modelled on website_report_charge: the guard row goes in first, under the
-- owner's profile lock, so a retry or the cron can never charge a period twice.
create or replace function public.website_domain_charge(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := nullif(p->>'owner', '')::uuid;
  v_domain uuid := nullif(p->>'domain', '')::uuid;
  v_period text := nullif(p->>'period', '');
  v_meta jsonb := case when jsonb_typeof(p->'meta') = 'object' then p->'meta' else '{}'::jsonb end;
  v_pence numeric := nullif(p->>'pence', '')::numeric;
  v_tx bigint;
  v_row public.website_domain_charges;
begin
  if v_owner is null or v_domain is null or v_period is null or v_pence is null or v_pence <= 0 then raise exception 'website_domain_charge_bad_input'; end if;

  perform 1 from public.profiles where id = v_owner for update;

  insert into public.website_domain_charges (domain_id, period, owner_id, pence, status)
  values (v_domain, v_period, v_owner, v_pence, 'unpaid')
  on conflict (domain_id, period) do nothing;
  if not found then
    select * into v_row from public.website_domain_charges where domain_id = v_domain and period = v_period;
    return jsonb_build_object('result', 'already_charged', 'already', true, 'pence', v_row.pence, 'tx', v_row.txn_id, 'status', v_row.status);
  end if;

  begin
    v_tx := public.credit_debit_face(v_owner, v_pence,
      v_meta || jsonb_build_object('action', 'website_domain', 'description', 'Website domain, yearly', 'domain_id', v_domain, 'period', v_period, 'quantity', 1));
  exception when sqlstate 'P0402' then
    return jsonb_build_object('result', 'unpaid', 'already', false, 'pence', v_pence, 'tx', null, 'status', 'unpaid');
  end;

  update public.website_domain_charges set txn_id = v_tx, status = 'charged' where domain_id = v_domain and period = v_period;
  return jsonb_build_object('result', 'charged', 'already', false, 'pence', v_pence, 'tx', v_tx, 'status', 'charged');
end;
$$;
revoke all on function public.website_domain_charge(jsonb) from public, anon, authenticated;
grant execute on function public.website_domain_charge(jsonb) to service_role;

notify pgrst, 'reload schema';

-- =========================
-- Batch 36: customer websites, Phase 4 (self-edit, change requests, grace and switch-off)
-- =========================
-- A live site can now be edited by its owner, a member can ask Stayful for
-- other changes, and a site that is abandoned, unpaid or cancelled is warned,
-- switched off and finally has its data deleted. See PLAN-batch-36.md. This
-- section is the whole database side:
--
--   websites.edit_rewrites_month / edit_rewrites_used
--                            the owner's monthly allowance of page rewrites
--                            for edits (separate from setup's regen_count).
--   website_drafts           one working copy per site: settings, pages, the
--                            version it was opened from (base_version) and the
--                            pages rewritten and still awaiting approval.
--                            The live site changes only on Publish.
--   website_versions         the history: version 1 is the approved site
--                            (snapshotted on the first edit), then one per
--                            publish or restore. The newest 10 are kept.
--   website_change_requests  "please change this for me": text, an optional
--                            private screenshot path, a status and admin notes.
--   website_grace            one row per site: the current abandoned /
--                            cancelled / unpaid episode, its switch-off date,
--                            when it was switched off (status stays 'paused':
--                            there is no sixth status) and when its data was
--                            deleted (the websites row stays as a stub).
--   website_grace_notices    one row per warning stage per episode (sent or
--                            skipped), so a warning goes out once.
--
--   website_version_snapshot(p_website, p_by)   version 1 = the site as approved, once.
--   website_version_publish(...)                publish or restore one version
--                                               under the site's row lock:
--                                               'published' | 'stale'.
--
-- Settings (billing_settings; src/lib/websites/grace-settings.ts parses them):
--   website_abandon_days        90: days with no login and no lead before warnings start
--   website_warning_days        "30,14,3": days before switch-off a warning goes out
--   website_delete_after_days   90: days switched off before the data is deleted
--
-- No new websites.status value (the Batch 31 check keeps its five), no
-- foreign key changed: a websites row with a domain row is still never
-- deleted. Everything is additive, idempotent and service role only. Nothing
-- here is in ACCESS_COLUMNS (src/lib/access.ts).

-- ── websites: the monthly edit-rewrite allowance ──
alter table public.websites add column if not exists edit_rewrites_month text;
alter table public.websites add column if not exists edit_rewrites_used integer not null default 0;
alter table public.websites drop constraint if exists websites_edit_rewrites_used_check;
alter table public.websites add constraint websites_edit_rewrites_used_check check (edit_rewrites_used >= 0);

-- ── website_drafts ──
create table if not exists public.website_drafts (
  website_id uuid primary key references public.websites(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  pages jsonb not null default '{}'::jsonb,
  -- The version this draft was opened from; Publish only works while it is still the newest.
  base_version integer,
  -- Pages rewritten by the copy writer and not yet approved one by one.
  pending_pages text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.website_drafts enable row level security;  -- no policies: service role only
revoke all on public.website_drafts from anon, authenticated;

-- ── website_versions ──
create table if not exists public.website_versions (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  version_no integer not null,
  settings jsonb not null default '{}'::jsonb,
  pages jsonb not null default '{}'::jsonb,
  kind text not null default 'publish',
  restored_from integer,
  published_by uuid,
  published_at timestamptz not null default now()
);
alter table public.website_versions drop constraint if exists website_versions_kind_check;
alter table public.website_versions add constraint website_versions_kind_check check (kind in ('approved', 'publish', 'restore'));
alter table public.website_versions drop constraint if exists website_versions_version_no_check;
alter table public.website_versions add constraint website_versions_version_no_check check (version_no >= 1);
alter table public.website_versions drop constraint if exists website_versions_restored_from_check;
alter table public.website_versions add constraint website_versions_restored_from_check check (restored_from is null or restored_from >= 1);
create unique index if not exists website_versions_site_no_idx on public.website_versions (website_id, version_no);
alter table public.website_versions enable row level security;  -- no policies: service role only
revoke all on public.website_versions from anon, authenticated;

-- ── website_change_requests ──
create table if not exists public.website_change_requests (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  -- A path inside the private bucket website-requests: <owner>/<id>.<ext>.
  screenshot_path text,
  status text not null default 'new',
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  -- Claimed before the done/declined email is sent: that email goes once.
  closed_emailed_at timestamptz
);
alter table public.website_change_requests drop constraint if exists website_change_requests_body_check;
alter table public.website_change_requests add constraint website_change_requests_body_check check (char_length(body) between 1 and 2000);
alter table public.website_change_requests drop constraint if exists website_change_requests_status_check;
alter table public.website_change_requests add constraint website_change_requests_status_check check (status in ('new', 'in_progress', 'done', 'declined'));
alter table public.website_change_requests drop constraint if exists website_change_requests_admin_notes_check;
alter table public.website_change_requests add constraint website_change_requests_admin_notes_check check (admin_notes is null or char_length(admin_notes) <= 2000);
create index if not exists website_change_requests_site_idx on public.website_change_requests (website_id, created_at desc);
create index if not exists website_change_requests_open_idx on public.website_change_requests (created_at) where status in ('new', 'in_progress');
alter table public.website_change_requests enable row level security;  -- no policies: service role only
revoke all on public.website_change_requests from anon, authenticated;

-- ── website_grace ──
create table if not exists public.website_grace (
  website_id uuid primary key references public.websites(id) on delete cascade,
  reason text not null,
  episode_started_at timestamptz not null,
  switch_off_on date,
  cancelled_at timestamptz,
  switched_off_at timestamptz,
  switch_off_by text,
  off_emailed_at timestamptz,
  delete_on date,
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.website_grace drop constraint if exists website_grace_reason_check;
alter table public.website_grace add constraint website_grace_reason_check check (reason in ('abandoned', 'cancelled', 'unpaid'));
alter table public.website_grace drop constraint if exists website_grace_switch_off_by_check;
alter table public.website_grace add constraint website_grace_switch_off_by_check check (switch_off_by is null or switch_off_by in ('cron', 'admin'));
create index if not exists website_grace_switch_off_idx on public.website_grace (switch_off_on) where switched_off_at is null and cancelled_at is null;
create index if not exists website_grace_delete_idx on public.website_grace (delete_on) where switched_off_at is not null and deleted_at is null;
alter table public.website_grace enable row level security;  -- no policies: service role only
revoke all on public.website_grace from anon, authenticated;

-- ── website_grace_notices: one row per warning stage per episode ──
create table if not exists public.website_grace_notices (
  website_id uuid not null references public.websites(id) on delete cascade,
  episode_started_at timestamptz not null,
  -- The warning's day count (30, 14, 3: days before switch-off).
  stage integer not null,
  status text not null default 'sent',
  sent_at timestamptz not null default now(),
  primary key (website_id, episode_started_at, stage)
);
alter table public.website_grace_notices drop constraint if exists website_grace_notices_status_check;
alter table public.website_grace_notices add constraint website_grace_notices_status_check check (status in ('sent', 'skipped'));
alter table public.website_grace_notices drop constraint if exists website_grace_notices_stage_check;
alter table public.website_grace_notices add constraint website_grace_notices_stage_check check (stage between 1 and 365);
alter table public.website_grace_notices enable row level security;  -- no policies: service role only
revoke all on public.website_grace_notices from anon, authenticated;

-- ── billing_settings: the three grace settings ──
insert into public.billing_settings (key, value) values
  ('website_abandon_days', '90'),
  ('website_warning_days', '"30,14,3"'),
  ('website_delete_after_days', '90')
on conflict (key) do nothing;

-- ── Functions ──

-- website_version_snapshot(p_website, p_by): version 1 is the site as it was
-- approved. Taken on the first edit, once: a site that already has a version
-- is left alone. Returns the newest version number (1 after a first snapshot).
create or replace function public.website_version_snapshot(p_website uuid, p_by uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_max integer;
begin
  if p_website is null then raise exception 'website_version_snapshot_bad_input'; end if;
  perform 1 from public.websites where id = p_website for update;
  if not found then raise exception 'website_version_snapshot_no_site'; end if;
  select max(version_no) into v_max from public.website_versions where website_id = p_website;
  if v_max is not null then return v_max; end if;
  insert into public.website_versions (website_id, version_no, settings, pages, kind, published_by)
  select id, 1, settings, pages, 'approved', p_by from public.websites where id = p_website;
  return 1;
end;
$$;
revoke all on function public.website_version_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.website_version_snapshot(uuid, uuid) to service_role;

-- website_version_publish(...): publish one version of a site (an edit, or a
-- restore of an old version). Under the site's row lock it:
--   checks the newest version number is still p_base_version (a null base
--   means the site has no version yet), else returns 'stale' and changes nothing;
--   inserts the next version and copies its settings and pages onto websites;
--   deletes the site's draft;
--   keeps the newest 10 versions and returns the ids of the ones it pruned.
-- Returns {result: 'published' | 'stale', version_no, version_id (on published), pruned: [uuid]}. Status
-- is not read here: the app only calls it for a live site (or a rollback).
create or replace function public.website_version_publish(
  p_website uuid, p_base_version integer, p_settings jsonb, p_pages jsonb,
  p_kind text, p_restored_from integer, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_max integer;
  v_no integer;
  v_id uuid;
  v_pruned uuid[];
begin
  if p_website is null or p_settings is null or p_pages is null or p_kind is null or p_kind not in ('publish', 'restore') then
    raise exception 'website_version_publish_bad_input';
  end if;
  perform 1 from public.websites where id = p_website for update;
  if not found then raise exception 'website_version_publish_no_site'; end if;

  select max(version_no) into v_max from public.website_versions where website_id = p_website;
  if p_base_version is distinct from v_max then
    return jsonb_build_object('result', 'stale', 'version_no', v_max, 'pruned', '[]'::jsonb);
  end if;

  v_no := coalesce(v_max, 0) + 1;
  insert into public.website_versions (website_id, version_no, settings, pages, kind, restored_from, published_by)
  values (p_website, v_no, p_settings, p_pages, p_kind, p_restored_from, p_by)
  returning id into v_id;
  update public.websites set settings = p_settings, pages = p_pages, updated_at = now() where id = p_website;
  delete from public.website_drafts where website_id = p_website;

  with doomed as (
    delete from public.website_versions
     where id in (select id from public.website_versions where website_id = p_website order by version_no desc offset 10)
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_pruned from doomed;

  return jsonb_build_object('result', 'published', 'version_no', v_no, 'version_id', v_id, 'pruned', to_jsonb(v_pruned));
end;
$$;
revoke all on function public.website_version_publish(uuid, integer, jsonb, jsonb, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.website_version_publish(uuid, integer, jsonb, jsonb, text, integer, uuid) to service_role;

notify pgrst, 'reload schema';
