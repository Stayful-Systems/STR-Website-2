# Batch 55 Part A, Phase 1 (STR-Website-2): calculator, eligibility, handoff

Branch: this session's branch (`claude/ecstatic-wright-dyz4mh`). No claim-issue system in this repo.

Lead database customers (no Academy, no website, no domain) get Batch 38's three branded Facebook ads, linked to a branded
income calculator at a Stayful address (`/s/<slug>`). Every ad lead is later charged £3.50 by the lead database (Part B; that
billing comes in Phase 2, not here). This phase covers the calculator page, the new way in (eligibility), the signed handoff
from the lead database, the stop rule, the creative cap, the per-customer allowed flag and the audience step in the upload guide.

Decisions (Zac, 26 Nov): the lead database pushes a signed account state; this site stores it and checks it locally. The new
audience step replaces the old one for everyone. A customer who already has a website here is not offered this route. The batch
is called Batch 55 in this repo too.

Every phase's check: `npm test && npm run typecheck && npm run lint` (failures only), plus the named test files.

## Conflicts found between spec and code
- The guide already has an audience step (`guide.ts:93-103`: age 30 to 65+, no interests; `guide.test.ts:116-124` pins it). Replace it for everyone with the rule 31 recipe; update the test.
- Packs need a website row and a live domain (`ops.ts` generateOp, `admin-server.ts`). The lead database route uses the calculator site plus the Stayful host.
- A calculator lead would be pushed as `si_website` (free) by Batch 32's `enqueueLeadDbPush`. Phase 1 skips calculator sites; Phase 2 adds `si_ad`.
- Website reports charge this site's credit (`chargeReport`). Calculator reports skip the free claim, `held_cap`, `held_credit` and this site's credit charge; the lead database bills them.
- The pack monthly cap sums all runs. Add `ad_packs.route`; the Academy £50 cap sums only academy runs; the lead database route has its own £250 backstop.
- `loadLiveSite` returns null when a site has no pages. Calculator sites have no page copy: add `websites.mode`, skip the pages check for calculator.
- `websites.user_id` is unique, so the route is refused for an owner who already has a website.
- The spec lists no "state" endpoint, but the stop rule needs one. Part B must send it (contract doc).

## Must not be touched
`src/lib/academy/**`, `src/lib/domains/**`, `ACCESS_COLUMNS`, `chargeDecision`, `lead-panel.ts` (Phase 2), Batch 32 writes to
`leads.status` / `crm_pushed_at`, `ad_sheets_enabled` and `src/lib/ad-sheets/**` behaviour, the Stripe webhook, `/p/[token]`,
`/deal/[token]`, the lead-database repo (Part B).

## Phase A1: schema and settings (no dependencies)
- [x] `supabase/schema.sql` new "Batch 55 (Part A)" block at the end: `websites.mode` (`site`|`calculator`), `ad_packs.route` (`academy`|`leaddb`), table `leaddb_ad_accounts`, table `ad_pack_round_grants` (RLS on, anon/authenticated revoked), seeds `ad_calc_reports_per_day=50`, `ad_pack_ld_round_days=30`, `ad_pack_ld_monthly_cap_pence=25000`.
- [x] `src/lib/ad-packs/settings.ts` and `src/lib/websites/settings.ts` (+ tests pinning defaults to the seeds).
- [x] `supabase/tests/batch55-smoke.sql`.
- Check: settings tests.
- Notes: Block sits AFTER Batch 37's (the schema tests stop a section at the next Batch marker). The reports-per-day setting has its own key and parser in `websites/settings.ts` plus `calc-settings-server.ts` (`readAdCalcReportsPerDay()`), not in `WebsiteSettings`, because the admin save loop writes every `WEBSITE_KEYS` entry. CI step for the smoke script added to `.github/workflows/ci.yml`. Block ran twice on a throwaway Postgres 16 with no errors.

## Phase A2: account state and stop rule (depends on A1)
- [x] `src/lib/leaddb/ad-account.ts` (pure: `adRouteStopped`, `adRouteVerdict`, state parsing, stale rule) + test.
- [x] `src/lib/leaddb/ad-account-server.ts` (`applyState`, reads).
- Check: `ad-account.test.ts` covers active, pending cancel before/after the date, paused (works), lapsed, past due, no card, stale push ignored.
- Notes: Verdict order no_account, account_stopped, no_card, not_allowed. `past_due` with a card on file is NOT stopped by itself (assumption: the lead database must clear the card, lapse or cancel). Server: readAdAccount, readAdAccountByCustomerId, applyAdAccountState, createAdAccount, setAdAccountAllowed.

## Phase A3: signed inbound endpoints (depends on A1, A2)
- [ ] `src/lib/leaddb/inbound.ts` (`verifyInbound`: 404 unset/short secret, 401 bad signature).
- [ ] Routes `src/app/api/internal/si/ad-route/{provision,state,signin}/route.ts`.
- [ ] `docs/build/batch-55-part-a-CONTRACT.md` for Part B.
- Check: route source-pin tests, `inbound.test.ts`.
- Notes:

## Phase A4: calculator site (depends on A1, A2)
- [ ] `ensureCalculatorSite` in `store-server.ts`; `src/lib/websites/calculator.ts` (pure) + test.
- [ ] `src/app/s/[slug]/site-data.ts`, `page.tsx`; `[page]` and `areas/[area]` 404 in calculator mode.
- Check: `calculator.test.ts`.
- Notes:

## Phase A5: brand editing for calculator sites (depends on A4)
- [ ] `src/app/leads/setup/website/page.tsx` and `actions.ts`: calculator mode shows only name, logo, colour, areas, fee, contact details.
- Check: existing tests plus a test that calculator mode exposes only those fields.
- Notes:

## Phase A6: report flow for calculator sites (depends on A4)
- [ ] Step 1 enforces `ad_calc_reports_per_day` per owner per UK day (neutral "try again tomorrow", no lead row).
- [ ] `report-server.ts` calculator mode skips free claim, `held_cap`, `decideStep2`/`held_credit`, `chargeReport`.
- [ ] `enqueueLeadDbPush` skips calculator sites.
- Check: tests for each; site-mode tests unchanged.
- Notes:

## Phase A7: eligibility, link and generation route (depends on A2, A4)
- [ ] `eligibility.ts` / `eligibility-server.ts`: `route: 'academy' | 'leaddb'`, facts and reasons; Academy byte-identical (pinned).
- [ ] `links.ts` `adLink` accepts `{sitePath: slug}`; `checks.ts`; `ops.ts` generateOp uses the calculator site and sets `ad_packs.route='leaddb'`.
- Check: eligibility matrix, adLink both shapes, checks link-shape test.
- Notes:

## Phase A8: creative cap, backstop, allowed flag, admin (depends on A1, A7)
- [ ] `generate-core.ts` cap section; `store-server.ts`.
- [ ] `/admin/ad-packs`: lead database accounts list with "Allowed" toggle; "Grant an extra round" (reason required); audit line ids only.
- Check: second round in 30 days refused, failed run not counted, grant allows one more, backstop refuses, Academy free-regen unchanged.
- Notes:

## Phase A9: targeting recipe in the guide (no dependencies)
- [x] `src/lib/ad-packs/targeting-recipe.ts` (values plus `LAST_CHECKED = '2026-11-23'`), `guide.ts`, `guide.test.ts`, `GuideWizard.tsx` comment, `public/ad-packs/guide/README`.
- Check: `guide.test.ts`, `plain-language.test.ts`.
- Notes: Campaign goal (Leads / landing page views) is recorded only as OBJECTIVE_PROPOSED, not shown: it clashes with the existing choose-traffic step (Traffic). Zac to decide. GuideWizard renders a new step.checklist as a numbered list.

## Phase A10: knowledge, CLAUDE.md, PR (depends on all)
- [ ] `seed.ts` drafts `adpack_ld_calculator`, `adpack_ld_rounds`, `adpack_audience`; `placeholders.ts` `{ad_calc_reports_per_day}`, `{ad_pack_ld_round_days}`; `service-facts.ts` block.
- [ ] `CLAUDE.md` "Batch 55 (Part A)" section.
- [ ] Merge `origin/main`, re-check overlap, push, open a draft PR `[Zac] Batch 55 Part A, Phase 1: calculator, eligibility, handoff`. Stop before Phase 2.
- Check: `npm test`, `npm run build`.
- Notes:

## Migration
One block in `supabase/schema.sql`, depending only on tables already live (websites, ad_packs, ad_pack_runs, profiles, billing_settings). Every statement is `add column if not exists` / `create table if not exists`, so re-running is safe. Undo: drop the two new tables and two columns; no Academy code reads them.

## Remaining risks
- Stale account state if a push fails: newer pushes win; a missing state means stopped (fail closed). Rollback: toggle "Allowed" off.
- Linking an existing account by email trusts the lead database's verified email; limited to owners with no other link. Rollback: delete the `leaddb_ad_accounts` row.
- The 50-a-day count can overshoot by one or two under a burst. Bot guard only; no billing impact in Phase 1.
