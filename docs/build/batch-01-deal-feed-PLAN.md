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
- [ ] Block "Deal feed" in `supabase/schema.sql` (safe to re-run): `marketplace_deals.dupe_of` (references `canonical_url`,
      on delete set null) and `uprn`, index on `dupe_of`; `deal_opens.stale_credit_at`, `stale_credit_pence`; seeds
      `deal_stale_credit_enabled=false`, `deal_stale_credit_days=7`, `deal_dedupe_enabled=false`, `deal_dedupe_price_pct=2`.
      No grants for anon or authenticated.
- [ ] `src/lib/marketplace/deal-feed-settings.ts`: pure parser plus defaults (off, 7 days, 2%); a server reader.
- [ ] Test pinning the defaults to the schema seeds (pattern: Batch 35).
- Check: `npm run typecheck && npm test`
- Notes:

## Phase 2: category tabs on /deals
- [ ] Tab row All / Rent-to-rent / Buy-to-let above the filters, links only, 44px targets, scrolls sideways on a phone.
- [ ] `KIND_LABELS.sale` becomes "Buy-to-let"; the sale tab covers every sale type (Short-let, BRRR, Buy to let).
- [ ] Test: each tab round-trips through `filtersToSearch`; labels.
- Check: `npm run typecheck && npm test && npm run lint`
- Notes:

## Phase 3: duplicate hiding
- [ ] `dedupe.ts` (`findDupe` pure) and tests; `uprn` written by `recordColumns`; set and clear `dupe_of` after absorbing and on retire.
- [ ] Grid query adds `dupe_of is null` while `deal_dedupe_enabled` is on; opened deals and `/deals/[id]` ignore it.
- [ ] `/admin/deals` shows "Hidden as duplicates: N".
- Check: `npm run typecheck && npm test`
- Rollback: switch `deal_dedupe_enabled` off.
- Notes:

## Phase 4: stale-deal credit
- [ ] `stale-credit.ts` (`staleCreditDue` pure, amount from the actual debits) and tests.
- [ ] Cron `/api/internal/deal-stale-credits` (`17 * * * *`, `CRON_SECRET`, `?dry=1`), `vercel.json`.
- [ ] Admin "Grant stale credit" action (same function, ignores the window, `requireAdmin`).
- [ ] `/deals/opened` shows "Gone within 7 days, £X credited back".
- Check: `npm run typecheck && npm test`
- Rollback: switch `deal_stale_credit_enabled` off; credits already given can be reversed by an admin adjustment.
- Notes:

## Phase 5: admin weekly count and rent-to-rent notice
- [ ] `weekly-sales.ts` (`weeklySales` pure, last 8 ISO weeks by category) and test; table on `/admin/deals` plus "reports this month vs 50 target".
- [ ] Rent-to-rent permission notice on the deal sheet and the full report panel (kind `rent` only).
- Check: `npm run typecheck && npm test && npm run lint`
- Notes:

## Phase 6: knowledge
- [ ] Draft entries `deal_feed_categories`, `deal_stale_credit`, `deal_r2r_permission`, `deal_duplicates`; placeholder `{deal_stale_credit_days}`; DEAL FEED line in `service-facts.ts`.
- Check: `npm test`
- Notes:

## Phase 7: review and merge prep
- [ ] One fresh subagent reviews the diff against this plan (150 words or fewer); real gaps fixed.
- [ ] Merge `origin/main`, renumber if needed, short "Deal feed" section in `CLAUDE.md`.
- [ ] `npm run typecheck && npm test && npm run lint && npm run build`; push; draft PR. Stop there.
- Notes:
