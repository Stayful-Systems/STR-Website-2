# PLAN — Batch 34: Plan credit rollover

Planned against origin/main cf6935e (Batch 31 merged). This plan was first numbered "Batch 32"; main then took 32 (the lead database push, PR #175, PLAN-batch-32.md) and 33 (customer website domains, PR #176), so on 20 Nov this batch was RENUMBERED to **Batch 34** (renumber script only touched lines this branch added; commit history and PR #174's earlier commits still say 32). Main was merged into this branch twice (60c2bfd, then 3b94ee0; merged, not rebased, because a rebase needs a force-push). The first merge's only conflict was .github/workflows/ci.yml (both batches add a smoke step; kept both); the second was clean. After the merges: schema twice + all smoke files incl. leaddb-smoke and rollover-smoke pass, build OK.
Branch: claude/dazzling-babbage-5j0m9x (the plan named claude/epic-ramanujan-rcv4gz; this session is bound to the former).

- **34a** = Zac's Phase 1: rollover, display, dry-run sweep, measure. One PR.
- **34b** = Zac's Phase 2: reminders and live expiry. Built ONLY after 34a is merged, `schema.sql` is run and Zac has checked it.

Coordinator rules: one subagent per phase, each replies in 150 words or fewer. After each phase: `git diff --stat`, re-run that phase's check, tick it below, commit "Phase N: <name>". Stop and ask if anything breaks the plan. Never redo ticked phases.

## Progress (34a)
- [x] Phase 0 — Setup
  Notes: main still cf6935e. Baseline: npm test 3661/3661 pass; lint 0 errors, 79 warnings; typecheck 0 errors; build OK, no warnings. Schema check: `bash /tmp/claude-0/-home-user-STR-Website-2/1a23043a-0f19-5f4a-8fe2-b4631334ee33/scratchpad/schema-check.sh` (fresh PG16 cluster as user pgcheck in /var/tmp/str-schema-check; schema twice + index/dump diff + every supabase/tests/*-smoke.sql, new ones picked up automatically; passes on baseline).
- [x] Phase 1 — Database
  Notes: schema-check passes (twice, no index rebuild, no dump diff, all smoke incl. rollover-smoke); npm test 3661 unchanged. Batch 34 section sits BEFORE the Batch 31 section (websites/schema.test.ts needs 31 last). credit_smoke.sql edited: renewal now expires 0 and 1800 rolls over. SQL: credit_plan_cycle ignores p_expires_at, sets plan_cycle; credit_idle_plan_report(p_now) -> user_id,last_spent_at,idle_since,plan_remaining_pence,expirable_pence (no cycle grant => nothing expirable); credit_expire_plan_source(p_user,p_source_like,p_max_pence,p_reason) -> {expired_pence,grants}; p_max_pence null = all; source_like is a LIKE pattern so '_' and '%' must be escaped by the caller ('\\_'); only plan-kind grants match. Phase 2 MUST: escape LIKE chars in the ledger.ts wrapper; flag annual + Academy-trial plan grants plan_cycle=true too (they are monthly plan credit, and the newest one must be protected) -- credit_plan_cycle sets it, plain credit_grant does not.
- [x] Phase 2 — Grant and Stripe paths
  Notes: npm test 3676 pass (15 new), tsc 0, lint 0 errors/79 warnings. ledger.ts: idlePlanReport, expirePlanSource(userId, {exact}|{prefix}, maxPence|null, reason) (wrapper escapes LIKE chars). New pure src/lib/stripe/plan-credit.ts (thisCycleGrants, upgradeTopUpPence, refundedShare, clawbackDue, trialEndedUnpaid, disputeWonRef). Monthly/annual/trial grants all go through credit_plan_cycle (plan_cycle=true, no expiry). Webhook reasons: plan_refunded, plan_disputed, academy_refunded, academy_trial_unpaid. KNOWN GAPS to put in the PR: (1) an upgrade's grant read selects plan_cycle, so an upgrade errors (Stripe retries) until schema.sql is run; (2) [FIXED in the Phase 9 review fix: an annual invoice's refund now removes that invoice's year of annual:<sub>: slot grants] (3) unpaid-trial check asks Stripe for paid invoices (member_payments has no subscription id).
- [x] Phase 3 — Pure rollover rules and summary
  Notes: npm test 3686 pass (10 new), tsc 0, lint 0 errors/79 warnings. src/lib/credit/rollover.ts (pure): currentCycleGrants (= thisCycleGrants, one definition), newestCycleGrant, rolledOverPence (credit left in grants older than the newest plan_cycle grant = same line as SQL expirable_pence; a dispute_won restore is neither this cycle nor rolled over), cycleAllowancePence, nextPlanCreditAt (stale period end ignored), idleSince, planCycleView. CreditSummary gains rolledOverPence; cycle.endsAt = next plan credit date; usedPence = allowance - ALL plan credit (low = plan credit < 20% of one month's). usage-server period starts at newest plan_cycle grant (old query as fallback before schema.sql). For Phases 4/5: BillingClient.tsx:128 "resets {cycle.endsAt}" is now the next-credit date; the % in UsageChip, CreditBanner, BillingClient and the Usage page now measures one month's credit only.
- [x] Phase 4 — Chip, banner and Usage page
  Notes: npm test 3692 pass (6 new), tsc 0, lint 0 errors/79 warnings, build OK. New pure src/lib/credit/balance-words.ts (rolledOverWords, daysWords, chipTitle, chipAria, lowBalanceText, planCreditLine). Chip: one branch for plan and pay-as-you-go (balance + about X days; phone keeps days in tooltip), tooltip + aria-label add rolled-over line; banner "Running low: £X of credit left"; Usage page "£X plan credit this month · £Y of your balance rolled over". CreditProvider untouched (snapshot spreads summary). Still showing the %: BillingClient.tsx:72,149 (Phase 5).
- [x] Phase 5 — Account and billing screens
  Notes: npm test 3693 pass, tsc 0, lint 0 errors/79 warnings, build OK (agent). BillingClient: "Plan credit · rolls over"; bar replaced by rolledOverBillingLine ("£Y rolled over from earlier months · next £X arrives {date}", renewal part only on an active/trialing, non-cancelling plan). ManagePlan cancel line + cancel dialog: "Your credit stays on your account if you cancel". upgrade: "of {plan} credit left". choose: "Unused plan credit rolls over." KNOWN LIMITATION for the PR: the billing page has no pause state, so a PAUSED plan can still show "next £X arrives" (the existing "Renews {date}" line has the same limitation). Stale wording left for Phase 6: terms/page.tsx:83, Pricing.tsx:67 and :124.
- [x] Phase 6 — Public wording
  Notes: npm test 3693 pass, tsc 0, lint 0 errors/79 warnings, build OK (agent). Terms s2 + s3 rewritten (rolls over, no cap, stays on pause/downgrade/cancel, 12-month no-spend rule with figures read from billing_settings via a local loader in terms/page.tsx, falls back to figure-free wording; refund/chargeback removes that payment's unspent credit); each block carries "Batch 34: wording for Zac to approve (legal OK needed)". Pricing 67/124, FAQ, renewal + payment-failed emails updated. FOR THE PR: (1) terms LAST_UPDATED (28 September 2026) NOT bumped - Zac/legal to decide; (2) the terms describe reminders/expiry that only go live in 34b: 34b must ship before the first possible 3-month reminder (about 20 Feb 2027) and nothing can expire before 12 months from launch; (3) service-facts.ts:38 still says "resets each month" (Phase 8).
- [x] Phase 7 — Dry-run sweep and success measure
  Notes: npm test 3701 pass (8 new), tsc 0, lint 0 errors/79 warnings, build OK. credit-sweep route: dry AND live runs return idlePlanCandidates (user id, dates, pence; no emails) + log a line; missing SQL function => null + idlePlanError, sweep carries on; report only, nothing expires in 34a. New pure src/lib/admin/rollover-measure.ts (cancellation rate = average of churn.ts monthlyTrend churnRatePct before vs after plan_credit_rollover_from; launch month/week counted in neither; "too early" below 50 live cycles (SMALL_NUMBERS); weekly-active guardrail from computeWeeklyActive, metrics.ts unchanged; banked + rolled-over via rolledOverPence), server loader rollover-measure-server.ts, RolloverMeasure.tsx rendered on /admin/weekly-active (existing admin gate covers it). Uncertain/for the PR: "monthly plan cancellation" reads as all plans incl. annual; the route itself has no test (helper tested, route read).
- [x] Phase 8 — Stayful Intelligence knowledge
  Notes: npm test 3701 pass, tsc 0, lint 0 errors/79 warnings. placeholders.ts: plan_credit_idle_months, plan_credit_final_notice_days, plan_credit_idle_reminder_months (prose "3, 6 and 12"), read strictly from billing_settings. seed.ts: draft entries plan_credit_rollover, plan_credit_cancel, credit_spend_order, credit_idle_expiry (all figures are placeholders; no existing entry contradicted the rule). service-facts.ts:38 now "unused plan credit rolls over every month, with no cap" + three bullets (cancel/refund, spend order, idle expiry). Minor: the placeholder lists every reminder month incl. the 12-month final warning, while the terms page lists only months below the idle months (both read from the same setting; wording differs slightly). Entries were reworded to avoid "credit" in variants so the paraphrase-match test still picks the right entry.
- [x] Phase 9 — Final checks and review, push, draft PR (draft PR #174 open; CI green on the final merge commit aa0b5ce: checks + schema)
  Review fixes (independent review, all verified in code, committed "Phase 9: Review fixes"): (1) the run-once migration no longer flags old upgrade top-ups as cycle grants (credit_batch34_cycle_candidate); (2) credit_expire_plan_source is now (p_user, p_source_like, p_max_pence, p_reason, p_total, p_created_from, p_created_to) and with p_total computes what is still due INSIDE the member lock, so concurrent cumulative refunds can't over-remove (old 4-arg overload dropped); (3) annual-invoice refunds/chargebacks remove that invoice's year of annual:<sub>: slots (window = invoice line period). npm test 3707, schema-check passes, tsc 0, lint 0 errors, build OK.

## Progress (34b) — NOT STARTED, waits for 34a to be merged + schema.sql run + Zac's check
- [x] Phase 10 — Database
  Notes: schema-check passes (twice, no index rebuild, no dump diff, all smoke), npm test 3956, tsc 0, lint 0 errors. credit_idle_notices(user_id, idle_since, stage, status sent|skipped, sent_at, created_at; PK user_id+idle_since+stage; check 'sent' needs sent_at; RLS on, no policies, revoked from anon/authenticated). credit_expire_idle_plan(p_user, p_now) -> {expired_pence, grants, reason?} reasons: no_plan_credit | not_idle | no_final_notice | notice_too_recent | no_cycle_grant | none_expirable; under the profile lock: still idle, FINAL-stage notice (stage = round(plan_credit_idle_months) = 12, the reminder list is not read) for THIS idle run, status sent, sent_at <= now - plan_credit_final_notice_days; expires only plan grants created before the notice AND before the newest plan_cycle grant, expire rows reason no_spend. Shared helpers credit_plan_idle_after() and credit_plan_idle_since(last, first_plan) now used by credit_idle_plan_report too (signature/columns/behaviour unchanged). Phase 11 must pass stage numbers from the reminder list; the final stage is the one equal to plan_credit_idle_months.
- [x] Phase 11 — Rules, cap, emails, activity
  Notes: npm test 3970 pass (14 new), tsc 0, lint 0 errors/79 warnings. rollover.ts: idleStages(reminderMonths, idleMonths) (clean sorted list always ending with the final stage), idleStageDue({idleSince, now, stages, existing:[{stage,status}]}) -> {due, skipped[]} (HIGHEST due stage with no row; lower unhandled due stages returned for recording as 'skipped'), reminderDecision({stage, finalStage, alertsOn, capUsedToday, planCreditPence, expirablePence}) -> {decision: send|wait|skip, reason: ok|cap_used|no_credit|nothing_expirable|alerts_off} (final stage ignores alertsOn; wait records NOTHING), expiryDue({finalNoticeSentAt, now, finalNoticeDays}). cap.ts: SendKind credit_idle (daily, behind credit_alerts) and credit_idle_final (daily, no switch, in the cap test's exemption beside academy_reminder). kinds.ts: record-only credit_idle_reminder, credit_idle_expired (metrics.ts untouched). src/lib/email/credit-idle.ts: pure copy builders creditIdleReminderCopy / creditIdleFinalWarningCopy + renderCreditIdleEmail + send wrappers creditIdleReminderEmail(to, {months, balancePence}, {idempotencyKey}) / creditIdleFinalWarningEmail(to, {balancePence, expiringPence, expiresOn, months?}, {idempotencyKey}); final warning is a billing notice (no Manage-notifications footer); layout mirrored from billing.ts (its helpers are private). Phase 12 note: the final stage is skipped when nothing would expire.
- [ ] Phase 12 — Reminder cron
- [ ] Phase 13 — Live expiry, admin, knowledge
- [ ] Phase 14 — Final checks

---

## Context

A monthly plan buys lead credit. Today, unused plan credit is lost. Zac wants it to roll over so members always get what they paid for. The aim is fewer plan cancellations. There are only 3 plan members today, so it is measured from day one.

### What recon confirmed
Plan credit lapses today, in four places:
1. `expires_at` is set to the period end on every plan grant (`src/lib/stripe/webhook.ts:669,706-716`; annual and trial grants in `src/lib/stripe/grants.ts:162-230`).
2. Every renewal wipes the old grant: `credit_plan_cycle` → `credit_expire_plan_grants` (`supabase/schema.sql:5815-5830, 1011-1029`).
3. Cancelling wipes it (`webhook.ts:786-811`).
4. The 03:00 sweep (`credit_expire_due`, `schema.sql:1034`).

Other credit already never expires: top-ups, the pack's £10 and welcome credit. The pack's £20 bonus keeps its 30-day rule.

How plan grants are made: the Stripe `invoice.paid` webhook (idempotent through `stripe_events` and the unique `source_ref`). Annual and Academy trial grants come from the 03:00 credit-sweep cron.

The spend order already matches Zac's rule: bonus (where allowed), then plan oldest-first once plan grants have no expiry, then welcome, then top-ups and adjustments (`schema.sql:883-888, 7666-7671`). `credit_debit` and `credit_debit_face` are NOT changed. Tests pin the order.

Nothing existing does rollover or no-spend expiry. "Last spent" is read from `credit_transactions` (kind debit, amount < 0, existing `(user_id, at desc)` index).

Refunds: a failed-action refund already goes back to its source grant (`credit_refund`). A refunded or charged-back plan payment claws nothing back today.

ACCESS_COLUMNS: no change. Nothing treats plan credit as proof of being on a plan.

### Rules (Zac's, plus the answers of 20 Nov)
- No cap on rollover.
- Spend order: expiring pack bonus, then oldest plan credit, then welcome (unchanged), then top-ups and adjustments.
- 12-month expiry (plan credit only).
- What counts as spend: any debit, including automatic daily-deal charges and team members' spending (they spend the owner's balance).
- The clock runs from the later of the last spend and the launch date (`plan_credit_rollover_from`).
- The newest month is protected: the most recent month's plan credit (the newest renewal grant and anything added after it) never expires this way.
- Not covered: top-ups, the pack's £10, welcome and promo credit are outside this rule; they keep their own rules (top-ups and the £10 never expire). This keeps the "top-up credit never expires" promise.
- Reminders at 3, 6 and 12 months of no spend.
  - All three go through the one-a-day cap. If the cap skips one, it waits for the next day.
  - The 3- and 6-month reminders respect the "credit alerts" switch. The 12-month final warning is a billing notice and ignores opt-outs.
- Credit expires 30 days after the final warning was actually sent, if there has still been no spend.
  - Only grants that existed when the warning was sent can expire, and never the newest month.
  - The final warning and the expiry never run in the same job: reminders run at 06:43, expiry at 03:00, with at least 30 days between them.
- Cancel, pause, downgrade: none of them forfeit credit. Re-subscribing adds new credit on top.
- Refunded or charged-back plan payment: that payment's unspent credit is removed (never below zero, other credit untouched). A won chargeback puts it back.
- Academy trials:
  - Refunded purchase: its trial credit is removed (today's behaviour, kept).
  - Trial cancelled before the first paid month: its trial credit is removed.
  - After one paid month: trial credit rolls over like any plan credit.
- Usage chip: shows the balance and "about X days of daily deals" (on a phone the days stay in the tooltip, as today), plus "£Y of your balance rolled over" when Y > 0. No % ring.

### Applied defaults (say if wrong)
- After cancelling, leftover plan credit is spent at the plan rate (1×), not the top-up rate.
- A £0.01 spend resets the clock (intended).
- A refunded action doesn't un-reset the clock.

### Problems found and fixed in the plan
| Problem | Fix |
|---|---|
| Upgrade top-up (`grantUpgradeDifference`) counts banked credit, so upgraders would get nothing. | Compare against this cycle's grants only. |
| Chip/Usage "allowance" sums every open plan grant (`summary.ts:63-76`), and the Usage period starts at the oldest grant (`usage-server.ts:37-55`). | New `credit_grants.plan_cycle` flag marks renewal grants; measure from the newest one. |
| The 80% rule and once-a-cycle emails use `cycle.endsAt` (`after-debit.ts:97`). Annual members would get an end date a year away, so the emails could repeat. | `endsAt` = when the next plan credit arrives. |
| Academy refund relied on "cancel wipes credit". | Targeted trial-credit removal. |
| Wording that promises credit resets. | Updated in Phases 5 and 6. |
| The code could deploy before `schema.sql` is run. | Code passes no expiry, the SQL ignores any expiry, and `schema.sql` is run the same day. |

---

# Batch 34a — Rollover and display

## Phase 0 — Setup (no dependencies)
- Re-check origin/main against cf6935e and rebase if it has moved.
- Write PLAN.md from this plan (replacing the merged 31a plan, which stays in git history) and commit it.
- Run `npm ci` and record the baseline for `npm test`, `npm run lint` and `npm run build`.
- Create a scratchpad script that loads `supabase/tests/shim.sql` and runs `schema.sql` twice plus every smoke file on a local Postgres 16, as CI does. If there is no local Postgres, CI is the check.

**Check:** the baseline numbers are recorded in the Notes line.

## Phase 1 — Database (depends on 0)
Files: `supabase/schema.sql`, new `supabase/tests/rollover-smoke.sql`, `.github/workflows/ci.yml` (one line to run the new smoke file).

- Settings (`insert … on conflict do nothing`): `plan_credit_idle_months` 12, `plan_credit_idle_reminder_months` [3,6,12], `plan_credit_final_notice_days` 30.
- Flag column: `alter table credit_grants add column if not exists plan_cycle boolean not null default false`.
- Run-once migration guarded by the `batch34_rollover_from` key in `billing_settings`. It:
  - stores `plan_credit_rollover_from = now()`;
  - sets `expires_at = null` on plan grants where `remaining_pence > 0 and expires_at > now()`;
  - sets `plan_cycle = true` on existing plan grants.
  - Credit that lapsed before launch is not restored.
- `credit_plan_cycle`: same signature. Remove the `credit_expire_plan_grants` call. The grant always has `expires_at = null` and `plan_cycle = true`. It still returns `expired 0`. A replay of the same `source_ref` still creates nothing. (The SQL ignores any expiry passed in, so code deployed before schema.sql is run is safe.)
- New, read-only, service-role only: `credit_idle_plan_report(p_now timestamptz default now())`. It returns, for members holding plan credit whose idle time (`p_now − greatest(last debit at, rollover_from)`) is at least `plan_credit_idle_months`:
  - `user_id, last_spent_at, idle_since, plan_remaining_pence`;
  - `expirable_pence`: plan credit in grants created before the newest `plan_cycle` grant.
- New, service-role only: `credit_expire_plan_source(p_user, p_source_like, p_max_pence, p_reason)`.
  - Locks the profile, then zeroes up to `p_max_pence` of matching plan grants.
  - Writes expire ledger rows with the reason. Never goes below zero.
  - Used for clawing back refunded invoices (`inv:<id>`) and trial credit (`trial:<sub>:%`).
- Left unchanged: `credit_debit`, `credit_debit_face`, `credit_reserve`, `credit_refund`, `credit_expire_due`, `funnel_lead_charge`, `website_report_charge`. `credit_expire_plan_grants` stays, but is no longer called by renewal or cancel.
- Smoke test (`rollover-smoke.sql`):
  - Grant £19, spend £6, next cycle: £13 + £19 = £32.
  - A replayed cycle adds nothing.
  - Spend order: bonus, then old plan, then new plan, then welcome, then top-up.
  - Refund goes back to the source grant.
  - The idle report includes a member idle 12 months and excludes one idle 11 months. It excludes the newest month from `expirable_pence`. A 1p debit removes the member from the report.
  - The clawback stops at zero and touches only matching grants.

**Check:** `schema.sql` runs twice cleanly; all smoke files pass; `npm test` is unchanged. Rollback: revert the commit. The migration only nulls expiry dates; to undo, re-set `expires_at` to the period end.

## Phase 2 — Grant and Stripe paths (depends on 1)
Files: `src/lib/stripe/grants.ts`, `src/lib/stripe/webhook.ts`, `src/lib/stripe/deps.ts`, `src/lib/credit/ledger.ts`, plus the existing webhook/grants test files.

- `ledger.ts`: wrappers for `idlePlanReport` and `expirePlanSource`. `planCycle` and `grant` pass no expiry for plan grants.
- `grants.ts`:
  - `grantPlanCycle`, the annual and the trial grants all use no expiry.
  - The fallback path (when the RPC is missing) no longer calls `expirePlanGrants` and marks `plan_cycle`.
  - `grantUpgradeDifference` = new plan credit − this cycle's plan grants (the newest `plan_cycle` grant onwards), not all open plan credit.
- `webhook.ts`:
  - Subscription ended: no longer wipes plan credit.
  - Academy refund: expire `trial:<sub>:%`.
  - Academy trial ending before any paid invoice: expire `trial:<sub>:%` (use the existing paid-payments record; check it before relying on it).
  - `charge.refunded` / `charge.dispute.created` on a plan invoice: `expirePlanSource('inv:<invoice>', the refunded share)`.
  - `charge.dispute.closed` won: put back what was removed, as a plan grant with `source_ref inv:<id>:dispute_won`. Idempotent through the unique `source_ref`.
- Tests:
  - Webhook redelivery: no double grant.
  - Cancel keeps credit.
  - Upgrade with banked credit still gets its top-up.
  - Refund and chargeback claw back only that invoice's leftover credit; a won dispute restores it once.
  - Academy refund and unpaid trial forfeit only trial credit.
  - Pause and downgrade keep credit.

**Check:** `npm test` passes, `tsc` reports 0 errors.

## Phase 3 — Pure rollover rules and summary (depends on 1)
Files: new `src/lib/credit/rollover.ts` and `rollover.test.ts` (pure); `src/lib/credit/summary.ts`; `src/lib/credit/usage-server.ts`; `src/components/credit/CreditProvider.tsx` (snapshot type).

- `rollover.ts`:
  - `currentCycleGrants(grants)` and `rolledOverPence(grants)` (plan credit left in older grants).
  - `nextPlanCreditAt(newestCycleGrant, currentPeriodEnd)`: the earlier of `addMonthsClamped(created, 1)` and the period end.
  - `idleSince(lastSpentAt, rolloverFrom)`.
- `summary.ts`: allowance = this cycle's grants; add `rolledOverPence`; `endsAt = nextPlanCreditAt(...)`. The low-balance rule then means "plan credit below 20% of one month's".
- `usage-server.ts`: the period starts at the newest cycle grant.
- Tests:
  - Rollover across a month end.
  - Rolled-over amount after spending (oldest is spent first).
  - An annual member's `endsAt` is about a month away, not a year.
  - Upgrade-cycle grouping.

**Check:** `npm test` passes.

## Phase 4 — Chip, banner and Usage page (depends on 3)
Files: `src/components/credit/UsageChip.tsx`, `src/components/credit/CreditBanner.tsx`, `src/app/account/usage/page.tsx`.

- Chip: the plan branch drops the ring and the %. It shows the balance + "about X days of daily deals left" (the same `dailyDealsDaysLeft` used for pay-as-you-go). The tooltip and aria-label add "£Y of your balance rolled over" when Y > 0.
- Banner: "Running low: £X of credit left" instead of a %.
- Usage page: replace "% of £X plan credit used" with "£X plan credit this month · £Y of your balance rolled over".

**Check:** `npm test` and `npm run build` pass. The text "plan credit used" no longer appears in the chip.

## Phase 5 — Account and billing screens (depends on 3)
Files: `src/app/account/billing/BillingClient.tsx`, `src/app/account/ManagePlan.tsx`, `src/app/upgrade/page.tsx`, `src/app/account/billing/choose/page.tsx`.

- Billing card: "Plan credit · rolls over" instead of "resets {date}". Replace the "used this month" bar with "£Y rolled over from earlier months · next £X arrives {date}".
- ManagePlan line 105: "Your credit stays on your account if you cancel."
- Upgrade page: "of credit left" instead of "this month's … credit left".
- Choose page: "Unused plan credit rolls over."

**Check:** `npm run build` passes; grep finds no "resets" or "this month's … credit" in these files.

## Phase 6 — Public wording (depends on 0; can run alongside 2–5)
Files: `src/app/(marketing)/terms/page.tsx`, `src/components/marketing-v3/Pricing.tsx`, `src/lib/faqs-data.ts`, `src/lib/email/billing.ts`.

- Terms 83 and 98: plan credit rolls over with no cap and stays if you pause, downgrade or cancel. After 12 months with no spending we email you; earlier months' plan credit still unspent 30 days later expires. Your latest month never expires this way. Top-up credit never expires. A refunded or charged-back plan payment's unspent credit is removed. Figures come from settings where the page already reads settings. The wording is flagged for Zac to approve.
- Pricing 67 and 124, and FAQ: "unused plan credit rolls over".
- Renewal email: drop "valid until" and "resets"; say it rolls over. Payment-failed email: "to keep getting your monthly credit".

**Check:** `npm test` passes. The words "resets", "does not roll over" and "valid until" are gone from these files.

## Phase 7 — Dry-run sweep and success measure (depends on 2, 3)
Files: `src/app/api/internal/credit-sweep/route.ts`, new `src/lib/admin/rollover-measure.ts` and its test, new `src/lib/admin/rollover-measure-server.ts`, new `src/app/admin/weekly-active/RolloverMeasure.tsx`, `src/app/admin/weekly-active/page.tsx` (+2 lines).

- Sweep: on both the dry run and the live run, report `idlePlanCandidates` (from `credit_idle_plan_report`) and log it. Nothing expires in 34a.
- Measure (pure + test):
  - Monthly plan cancellation rate before vs after `plan_credit_rollover_from`, with counts. Reuse `src/lib/billing/churn.ts` / `subscription_events`.
  - "Too early" while there are fewer than 50 plan members (the same pattern as `src/lib/admin/pack-paying.ts:98`).
  - Guardrail: weekly-active % of plan members before vs after, from the existing metrics, with its definition unchanged.
  - Total banked credit across members, and total rolled over.
- Admin: a section on `/admin/weekly-active`.

**Check:** `npm test` and the build pass. `?dry=1` returns `idlePlanCandidates` and a live run expires nothing.

## Phase 8 — Stayful Intelligence knowledge (depends on 1)
Files: `src/lib/knowledge/seed.ts`, `src/lib/knowledge/placeholders.ts`, `src/lib/knowledge/service-facts.ts`. Read `src/lib/knowledge/README.md` first.

- Placeholders resolved from settings: `plan_credit_idle_months`, `plan_credit_final_notice_days`, `plan_credit_idle_reminder_months`.
- Draft entries (never approved in code; no typed figures): `plan_credit_rollover` ("Does plan credit expire / roll over?"), `plan_credit_cancel`, `credit_spend_order`, `credit_idle_expiry`.
- `service-facts.ts:38`: "unused plan credit rolls over".

**Check:** `npm test` passes; the seed tests show every placeholder resolves and no figure is typed.

## Phase 9 — Final checks and review (depends on all)
- Run `npm test`, `npm run lint`, `npm run build`, and the schema-twice and smoke checks.
- An independent review of the diff for: credit charged wrongly; free/paid leaks and address leaks; missing dry runs; non-idempotent schema; ACCESS_COLUMNS changes. Fix what it finds.
- Push, then open a draft PR with the click-through checklist. The PR must say: **run schema.sql the same day, before 03:00 UTC.**

**Check:** everything is green and the PR is open.

---

# Batch 34b — Reminders and live expiry
Start only after 34a is merged, schema.sql is run and Zac has checked it.

## Phase 10 — Database (depends on 34a)
Files: `schema.sql`, `rollover-smoke.sql`.
- New table `credit_idle_notices(user_id, idle_since, stage, status sent|skipped, sent_at)`, primary key `(user_id, idle_since, stage)`. Service-role only. A spend changes `idle_since`, which starts a fresh run of reminders.
- New `credit_expire_idle_plan(p_user, p_now)`. Under the profile lock it re-checks that the member is still idle and that the stage-12 notice was sent at least `final_notice_days` ago. It then expires only plan grants created before that notice and not the newest cycle grant. It writes expire rows with reason `no_spend`.

**Check:** smoke passes. A recent notice expires nothing; the newest month is kept; a spend after the notice expires nothing.

## Phase 11 — Rules, cap, emails, activity (depends on 10)
Files: `rollover.ts` and its test, `src/lib/notify/cap.ts` and `cap.test.ts`, `src/lib/activity/kinds.ts`, new `src/lib/email/credit-idle.ts`.
- Pure rules: `idleStageDue` returns the highest stage due; lower missed stages are recorded as skipped. `reminderDecision` returns send / wait (cap used: retry tomorrow) / skip (switch off for 3 and 6, or no credit to lose). `expiryDue`.
- Cap kinds: `credit_idle` (behind the `credit_alerts` switch) and `credit_idle_final` (no switch; added to the cap test's exemption beside `academy_reminder`).
- Record-only activity kinds: `credit_idle_reminder`, `credit_idle_expired`.
- Emails state the balance and, in the final warning, the amount and date that would expire.

**Check:** `npm test` passes, including "each stage sends once", "a cap-skipped reminder sends next day", "a spend resets" and "the final warning ignores opt-outs".

## Phase 12 — Reminder cron (depends on 11)
Files: new `src/lib/credit/idle-reminders-run.ts` and its test (fake deps), new `src/app/api/internal/credit-idle-reminders/route.ts`, `vercel.json`.
- Copy the Academy reminder pattern: `claimSlot`, then send with idempotency key `credit-idle:<user>:<idle_since>:<stage>`, then stamp. A failure releases the claim.
- `?dry=1` lists wouldSend / waiting / skipped.
- Schedule: daily at 06:43 UTC.

**Check:** tests pass; the dry run writes nothing.

## Phase 13 — Live expiry, admin, knowledge (depends on 12)
Files: `credit-sweep/route.ts`, `RolloverMeasure.tsx`, `rollover-measure-server.ts`, `seed.ts` (only if the wording needs it).
- 03:00 sweep: expire for candidates whose final notice is at least 30 days old (`credit_expire_idle_plan`) and record `credit_idle_expired`. The dry run lists `wouldExpireIdle`.
- Admin: "due to expire" and "warned" lists.

**Check:** tests pass. The dry run and the live run agree on fixtures. Nothing expires without a notice 30 or more days old.

## Phase 14 — Final checks
Same as Phase 9. Open a new draft PR.

---

## Files that must not be touched
- ACCESS_COLUMNS (`src/lib/access.ts`).
- The draw order inside `credit_debit` / `credit_debit_face`.
- Pack-bonus and welcome rules (`credit_grant_pack_bonus`, `pack_bonus_*`, `welcome.ts`).
- `src/lib/tracking/**`.
- `src/lib/funnels/charge-server.ts`, `src/lib/funnels/tiers*.ts`, `src/lib/management/report.ts`.
- Academy files (`src/lib/academy/**`); only the academy branches inside `webhook.ts` change.
- Website files (`src/lib/websites/**`, `src/app/s/**`).
- The weekly-active definition (`src/lib/activity/metrics.ts`).
- Plan prices and plan credit amounts.

## Remaining risks (after the fixes above)
| Risk | Rollback |
|---|---|
| Code deploys before `schema.sql` is run: one renewal could still wipe credit. | Run `schema.sql` straight after merging. If a wipe happens, re-grant it as a plan adjustment. |
| The new terms wording needs Zac's legal OK. | Revert Phase 6 only. |
| Rolled-over credit makes cancelling members slightly cheaper to keep using the site (they spend leftover credit at 1×). | Change the rate in one place, the grant `spend_rate`. |
| The success measure is noise with 3 members. | It is labelled "too early" until there are 50. |
| 34b emails reach the wrong people. | Turn the cron off in `vercel.json`. The expiry path also refuses without a notice. |

## Click-through checklist (for Zac)
34a:
- Test plan member: grant £19, spend £6, advance a month: £13 + new £19.
- Spend: bonus first, then the oldest plan credit, then top-ups.
- Cancel: the balance stays.
- `/api/internal/credit-sweep?dry=1` lists only members with 12 months of no spend, and nothing expires.
- The chip shows the balance and days left, plus the rolled-over line.
- After merging, run `supabase/schema.sql` and check the site loads.

34b:
- Fake 3 / 6 / 12 months of no spend: one email each, once.
- Spend 1p: the clock resets.
- Expiry happens only 30 or more days after the final warning.
