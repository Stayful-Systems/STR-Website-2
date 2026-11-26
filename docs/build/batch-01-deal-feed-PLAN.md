# Deal Feed (queue Batch 1): build plan

Branch: this session's branch. No claim-issue system in this repo.

Most of Phase 1 of the spec is already live at `/deals` (rentals and sales in `marketplace_deals`, filters, sorts, address-hidden
cards, the paid ladder open, the £4 full report debited only after the report saves, the hourly recheck). This batch fills the gaps.

Decisions (Zac, 26 Nov): billing stays exactly as it is (ladder open plus optional full report). A stale deal credits back what the
buyer actually spent on it. The "Buy-to-let" tab shows all sale deals. Light duplicate matching. Photos stay on cards.
Below-market-value stays parked (no asking-price comparables data).

Files not to touch: `src/lib/credit/ledger.ts` and the credit SQL functions (call, never change), `deal_open_ladder` and
`full_analysis_pence` values, `src/lib/analysis/deal-analysis.ts`, `src/lib/stripe/**`, `leads.status`, `leads.crm_pushed_at`,
ad-packs, ad-sheets, leaddb, `/p/[token]`, `/deal/[token]`.

## Phase 0: handover files
- [x] This file and `batch-01-deal-feed-BLOCKERS.md`. Commit.
- Check: `git log -1 --stat` shows both files.
- Notes: done.

## Phase 1: schema and settings
- [x] Block "Deal feed" in `supabase/schema.sql` (safe to re-run): `marketplace_deals.dupe_of` (references `canonical_url`,
      on delete set null) and `uprn`, index on `dupe_of`; `deal_opens.stale_credit_at`, `stale_credit_pence`; seeds
      `deal_stale_credit_enabled=false`, `deal_stale_credit_days=7`, `deal_dedupe_enabled=false`, `deal_dedupe_price_pct=2`.
      No grants for anon or authenticated.
- [x] `src/lib/marketplace/deal-feed-settings.ts`: pure parser plus defaults (off, 7 days, 2%); a server reader.
- [x] Test pinning the defaults to the schema seeds (pattern: Batch 35).
- Check: `npm run typecheck && npm test`
- Notes: Block placed before Batch 37's section (its schema tests treat everything after their header as theirs). Reader is `deal-feed-settings-server.ts`; the parser is pure.

## Phase 2: category tabs on /deals
- [x] Tab row All / Rent-to-rent / Buy-to-let above the filters, links only, 44px targets, scrolls sideways on a phone.
- [x] `KIND_LABELS.sale` becomes "Buy-to-let"; the sale tab covers every sale type (Short-let, BRRR, Buy to let).
- [x] Test: each tab round-trips through `filtersToSearch`; labels.
- Check: `npm run typecheck && npm test && npm run lint`
- Notes: Tabs use `kind=rent`, `kind=sale`, `type=all`. An old `kind=sale` link now includes buy-to-let too, to match Zac's decision.

## Phase 3: duplicate hiding
- [x] `dedupe.ts` (`findDupe` pure) and tests; `uprn` written by `recordColumns`; set and clear `dupe_of` after absorbing and on retire.
- [x] Grid query adds `dupe_of is null` while `deal_dedupe_enabled` is on; opened deals and `/deals/[id]` ignore it.
- [x] `/admin/deals` shows "Hidden as duplicates: N".
- Check: `npm run typecheck && npm test`
- Rollback: switch `deal_dedupe_enabled` off.
- Notes: Postcode is read from `sourced_listings.snapshot` (marketplace_deals has no postcode column). Pointers are kept whether or not the switch is on, so the admin count works before turning it on; only the grid honours the switch. Same kind is required for a UPRN match.

## Phase 4: stale-deal credit
- [x] `stale-credit.ts` (`staleCreditDue` pure, amount from the actual debits) and tests.
- [x] Cron `/api/internal/deal-stale-credits` (`17 * * * *`, `CRON_SECRET`, `?dry=1`), `vercel.json`.
- [x] Admin "Grant stale credit" action (same function, ignores the window, `requireAdmin`).
- [x] `/deals/opened` shows "Gone within 7 days, £X credited back".
- Check: `npm run typecheck && npm test`
- Rollback: switch `deal_stale_credit_enabled` off; credits already given can be reversed by an admin adjustment.
- Notes: A free open is settled at 0. Reports bought after the deal went are not credited (review fix). The dry run lists even while the switch is off.

## Phase 5: admin weekly count and rent-to-rent notice
- [x] `weekly-sales.ts` (`weeklySales` pure, last 8 ISO weeks by category) and test; table on `/admin/deals` plus "reports this month vs 50 target".
- [x] Rent-to-rent permission notice on the deal sheet and the full report panel (kind `rent` only).
- Check: `npm run typecheck && npm test && npm run lint`
- Notes: Panel is `DealFeedPanel.tsx` on /admin/deals; it also holds the switches (there is no /admin/billing editor for these keys).

## Phase 6: knowledge
- [x] Draft entries `deal_feed_categories`, `deal_stale_credit`, `deal_r2r_permission`, `deal_duplicates`; placeholder `{deal_stale_credit_days}`; DEAL FEED line in `service-facts.ts`.
- Check: `npm test`
- Notes: The plan's `deal_open_price_range` placeholder does not exist; used `{open_cost_min}` and `{open_cost_max}`. Wording tuned so the existing match tests still pass.

## Phase 7: review and merge prep
- [x] One fresh subagent reviews the diff against this plan (150 words or fewer); real gaps fixed.
- [x] Merge `origin/main`, renumber if needed, short "Deal feed" section in `CLAUDE.md`.
- [x] `npm run typecheck && npm test && npm run lint && npm run build`; push; draft PR. Stop there.
- Notes: Review found two points: a report bought after the deal went (fixed), and a duplicate-hiding claim about reaction views (not a bug: the main grid uses the same filter). `origin/main` had nothing new, so no renumbering. Build, tests (5,047+), typecheck pass; lint has no errors.
