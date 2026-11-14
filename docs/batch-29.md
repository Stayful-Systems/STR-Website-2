# Batch 29: starter pack guardrails, the pay-again measure, Meta's RepeatPurchase

What a £10 starter pack buyer who never pays again can cost in data, from about
£7.75 (worst case) to about £2.50, how many pack buyers go on to pay, and Meta's
Purchase meaning the pack only.

The rules are written down once, for Batches 25 and 27 and anyone after, in
`src/lib/credit/pack-rules.ts`. The database does the allocation itself
(`credit_bonus_pays_for` in `supabase/schema.sql`), and a test checks that the
TypeScript list and the SQL list are the same.

## What changed

| Section | What members see | Where |
|---|---|---|
| A. Bonus restricted, expiring | The £20 bonus (credit beyond the price) pays only for opening deals, saved (reused) analyses and daily picks, and expires 30 days after the pack. The £10 paid never expires and buys anything. A further payment (top-up, auto top-up, plan) lifts both straight away. Billing, Usage and the low-credit email say "£X of your balance is bonus credit for opening deals, saved reports and daily picks. It expires on <date>." | `schema.sql` (credit section, edited in place; Batch 29 section), `credit/pack-rules.ts`, `pack-server.ts`, `ledger.ts`, `deal-pricing.ts`, `quote-server.ts`, `low-credit.ts`, `account/billing`, `account/usage` |
| B. Fresh-report cap | A pack-only member runs at most 3 fresh reports (welcome-price ones included; saved ones don't count). The 4th shows the offer (`/account/billing/choose`); nothing is charged and refunded. Claimed in SQL under the profile lock before any charge. | `pack_fresh_reports`, `analysis/deal-analysis.ts`, `analysis/run.ts`, Batch 27's `si-actions/validate.ts` |
| C. Early offer at £15 | Once: a Home card (the UK day it's first seen) and one section in the next daily email (never an email of its own). Never on the same day as the £5 decision: the offer goes first, the £5 notice (or Batch 25's nudge) the next day. Record-only `pack_offer_shown` / `pack_offer_accepted`. | `credit/pack-offer-server.ts`, `pack-home-server.ts`, `notify/message.ts`, `listing/picks-run.ts`, `notify/digest-run.ts`, `low-credit-server.ts`, `after-debit.ts`, `payments/server.ts` |
| D. Picks pause | A pack-only member not in the app for 7 days gets no picks (and so no standouts, deal calls or briefings: Batch 20's flag). No email. Any visit restarts them, and Home says "I paused your daily picks while you were away so your credit wasn't used. They're back on." Runs even while `inactivity_from` is empty. | `inactivity/server.ts`, `came-back.ts`, `components/AppShell.tsx`, `listing/picks-paused-run.ts` |
| E. Cheaper reports | Google Places answers are kept for 90 days on a ~100m grid and the distances are worked out from the property each time, so the report is identical. A hit is logged at 0p (`places_nearby_cached`). "Report ready, opens instantly" on reveal cards, Today and the deal sheet; price and order unchanged, nothing shown before Open. | `apis/google-places.ts`, `analysis/saved-server.ts`, `DealCard.tsx`, `RevealAnalyses.tsx`, `deals/[id]` |
| F. Pack → paying | A section on `/admin/weekly-active`: cohorts by UK sign-up week, the 8 columns, "too early" until a window closes, green / amber / red from settings, "small numbers" under 50 buyers, a filter by `utm_campaign` / `utm_content` ("none" for untagged) and a CSV. | `admin/pack-paying.ts`, `pack-paying-server.ts`, `app/admin/weekly-active/PackToPaying.tsx`, `pack-export/route.ts`, SQL `pack_paying_facts` |
| G. Deep welcome price | Only for members who have paid again since the pack; its 7-day window restarts from that payment. Pack-only members see "Top up to add the second opinion". Pre-pack members are unchanged. | `analysis/offers.ts`, `offers-server.ts`, `pmi-addon.ts`, `PmiAddonCard.tsx` |
| H. Meta | Purchase is the pack only (£10 ex-VAT, once per member; a blocked repeat sends nothing). New custom RepeatPurchase is a pack buyer's first payment after the pack (chosen top-up, auto top-up, or a plan's first paid invoice), once per member, ex-VAT, server side through CAPI and the browser with the same id. Chosen top-ups no longer send Purchase. The first plan invoice sends Subscribe + RepeatPurchase. Same consent, tracking-start and dedupe rules. `/admin/signups` lists 30-day counts per event. | `meta/events.ts`, `meta/conversions.ts`, `stripe/webhook.ts`, `api/billing/topup`, `api/billing/starter-pack`, `tracking/config.ts`, `tracking/runtime.ts`, `tracking/report-server.ts` |

## Deploy

1. Run `supabase/schema.sql` in the Supabase SQL editor (the whole file; it re-runs safely, and CI runs it twice and diffs schema and data). It adds:
   - `credit_grants.scope` and `credit_grants.scope_lifted_at`;
   - the table `pack_fresh_reports`;
   - six `profiles` columns: `pack_offer_home_at`, `pack_offer_emailed_at`, `pack_offer_dismissed_at`, `picks_paused_reason`, `pack_picks_back_at`, `pack_picks_note_at`;
   - the functions `credit_bonus_pays_for`, `credit_spendable_for`, `credit_face_available_for`, `member_paid_again_at`, `credit_grant_pack_bonus`, `pack_bonus_unlock`, `pack_fresh_report_claim` / `_release`, `pack_member_state`, `pack_bonus_backfill` (once only) and `pack_paying_facts`;
   - the trigger `member_payments_pack_unlock`;
   - `RepeatPurchase` in the `meta_conversions` event check;
   - and the settings below.
2. Deploy the code. Before the schema is run, every new read fails softly: nobody is treated as pack-only, nothing is capped or paused, and the facts section says it can't read.
3. Check `/api/internal/credit-sweep?dry=1` (with the internal secret): it lists the grants that would expire or be lifted, and writes nothing.

**`ACCESS_COLUMNS` is not changed.** No new environment variables. `DEAL_CHECKS_ENABLED`, `LOW_ENTRY_SEARCH_ENABLED` and `starter_pack_from` are untouched.

## Settings (billing_settings; edited on /admin/lifecycle)

| Key | Default | What |
|---|---|---|
| `pack_bonus_expiry_days` | 30 | Bonus lifetime |
| `pack_fresh_report_cap` | 3 | Fresh reports for a pack-only member |
| `pack_early_offer_pence` | 1500 | The early offer's balance (0: off) |
| `pack_picks_pause_days` | 7 | Days away before picks pause |
| `places_cache_days` | 90 | Google Places cache (0: off) |
| `pack_paying_headline_floor_pct` / `_target_pct` | 10 / 22 | Paid again within 60 days: amber / green |
| `pack_paying_rundown_paid_floor_pct` / `_target_pct` | 35 / 50 | Step 5: amber / green |
| `pack_cost_target_pence` / `pack_cost_ceiling_pence` | 190 / 250 | Data cost per pack-only member: green / amber |

## Manual steps for Zac

1. **Meta Events Manager:** create a custom conversion from the custom event `RepeatPurchase` (Events Manager → Custom conversions → Create → event `RepeatPurchase`, value from the event). Campaigns keep optimising on Purchase. Test with a test event code (`META_TEST_EVENT_CODE`) first; see the checklist.
2. **Stayful Intelligence knowledge:** approve the drafts on `/admin/intelligence/knowledge` after the seed run (`?dry=1` first). Updated: `pack`, `analysis`. New: `pack_bonus`, `pack_fresh_reports`, `report_ready`, `picks_paused_away`. Every figure is a placeholder (new: `pack_bonus`, `pack_bonus_days`, `pack_fresh_reports`, `pack_offer_at`, `pack_pause_days`, and the member's own `bonus_balance`, `bonus_expires`, `fresh_reports_left`; conditions `pack_only`, `pack_bonus_dated`).

## Questions, with the defaults built

1. The bonus pays for deal opens, saved analyses and daily picks (`todays_5` counts as picks); the morning briefing charge (≤3p) is not covered.
2. The bonus expires 30 days after purchase; the paid £10 never expires.
3. The Deep welcome window restarts from the first further payment (own reveal's deals, the Deep price only).
4. The cap is 3, welcome-price reports included. Address-analyser, API and MCP reports count; buy-to-let reports don't. Management-company funnel reports are never capped.
5. The early offer is at £15, once. The Home card lasts the UK day it's first seen; the email section goes in the next morning email that's going anyway. On a clash it goes first and the £5 notice or Batch 25's nudge goes the next day. A member with no morning email (daily picks off, or paused) is never held: their £5 notice goes as always, and the offer stays on Home.
6. Picks pause after 7 days without an app visit (`profiles.last_seen_at`, because Home views stopped counting as activity in R3l). Any visit, or any engaging action, resumes them. No email. Because it uses Batch 20's flag, standouts, deal calls and briefings pause too.
7. The Places cache is 90 days on the 3-decimal grid.
8. Existing pack buyers are restricted, with expiry 30 days from release. There are none live today (0 purchases).
9. The wording is as built (first person, plain English).
10. Meta: a pack buyer's first plan invoice sends Subscribe and RepeatPurchase; top-ups by members who joined before the pack send nothing.
11. Worst case is £3.45 including calls and picks, against the £2.50 target; £2.51 on reports alone. Accept as is?
12. First-week checklist and profile-complete rewards are welcome-kind but not pack bonus, so they stay unrestricted.
13. The brief's £2.50 / £3.50 are £2.00 / £3.00 live. No price change was made.
14. The cap line says a saved report "still opens with your bonus credit", not "free" (a saved analysis costs the normal Full analysis price, from the bonus).
15. A management company is a pack buyer, so H's Purchase / RepeatPurchase rules apply to it. **Finding:** `mc_signup`, `mc_pack_paid` and `funnel_live` have never been recorded or sent. The `meta_conversions` event check refuses them, so there are 0 rows live. Their pack sends Purchase £10 like anyone's. Left as they are (the brief says not to change them); fixing the check is a one-line change if wanted.

## Raw cost per pack-only member after this batch

Figures use live averages from the last 60 days: a fresh report 83.7p, Places 6 × 2.87p, picks 2p raw each, call minutes 13p raw.

- **The £10 paid:** 3 welcome-price fresh reports, all missing the cache, cost 251p. The rest on call minutes, about 34p. PMI 0p (blocked until they pay again).
- **The £20 bonus (30 days):** deal opens and saved reports about 0p; picks up to 60p per profile if active daily, and they stop after 7 days away.

| Case | Raw cost | What's in it |
|---|---|---|
| Worst case, reports + PMI (how the brief's £7.75 counted) | **£2.51** | |
| Worst case, everything | **£3.45** | Plus 35p card fee |
| Typical | **≈ £1.80** | 2 fresh reports, one with cached places; about 15 picks; plus 35p card fee |

## Known, not fixed (out of scope; reported)

- `credit_refund` has no cumulative guard (only `refundAction` checks for an earlier refund, and not atomically).
- R3-122: a reserved `credit_debit` doesn't check the reservation's maximum in SQL.
- R2-11 (the PMI ledger line has no offer suffix), R2-95 and R2-147 are still open.
- Calls, standout texts and nudges can still go after 08:30 when the daily slot is used (`claimCallSlot`). This batch adds no message outside the daily slot.
- R3's go / no-go was not updated after R3a–R3n.

## Click-through checklist (staging, a test account)

Welcome prices live are £2.00 (full) and £3.00 (Deep). On a test database: set `starter_pack_from` to now on `/admin/lifecycle`, sign up a new account and buy the pack (Stripe test card 4242…).

1. **Billing:** £30 balance, and the line "£20 of your balance is bonus credit for opening deals, saved reports and daily picks. It expires on <30 days from today>." Usage shows the same line.
2. **Open a deal:** it's paid from the bonus (Billing → history: the bonus goes down, the top-up doesn't).
3. **Fresh Full analysis:** paid from the £10 (the top-up goes down at its rate). Run three; the 4th shows "You've used your 3 fresh reports…" with the offer, and nothing is charged.
4. **A deal with "Report ready, opens instantly"** (one analysed in the last 30 days): opening it isn't counted against the 3, and is paid from the bonus.
5. **Deep report / PMI tick box:** says "Top up to add the second opinion" and links to the top-up.
6. **Spend down to £15 or less:** Home shows the "Keep your bonus" card that day (gone the next day, or on Not now). The next morning's email has the section once. The £5 notice never comes the same day.
7. **Top up £10:** the bonus line disappears (lifted, never expires). A fresh report works again and the Deep price shows. `/admin/weekly-active` → Pack → paying shows the buyer (columns "too early" until their windows close); the CSV downloads.
8. **Picks pause:** set `pack_picks_pause_days` to 1 on a pack-only test account and leave it a day. The nightly (`/api/internal/monday-funnel?dry=1`) lists `why: "pack"`. After the real run there are no picks and no "while you're away" email. Sign in: picks are back and Home shows "I paused your daily picks…" once.
9. **Meta (Events Manager → Test events, with `META_TEST_EVENT_CODE` set and cookies accepted):**
   - the pack sends **Purchase £10** (once, even if you reload);
   - the first top-up after it sends **RepeatPurchase** at the top-up's value (server and browser, de-duplicated);
   - a second top-up sends nothing;
   - a plan's first invoice instead of a top-up sends **Subscribe + RepeatPurchase**;
   - a top-up from an account made before the pack sends nothing;
   - `/admin/signups` shows the 30-day counts per event.
10. **Credit sweep dry run** after moving a test bonus's expiry into the past: `/api/internal/credit-sweep?dry=1` lists it under `wouldExpire` (or `wouldLift` if that member had paid again).
