# PLAN — Batch 31a: Stayful Academy checkout + 90-day Pro trial

Planned against origin/main a0fa9c2 (re-checked 19 Nov 2026: main has not moved).
Branch: batch-31a-academy-trial. Full detail for every phase is below the checklist.

## Progress
- [x] Phase 0 — Setup (npm ci, baseline tests + lint)
  Notes: main still a0fa9c2. Baseline: npm test 3343/3343 pass; lint 0 errors, 79 existing warnings. Schema-twice check script: /tmp/claude-0/-home-user-STR-Website-2/9f47ba7d-c597-516e-8b28-449ceff23206/scratchpad/schema-check.sh (passes on baseline).
- [x] Phase 1 — Pure rules + schema
  Notes: tests 3359 pass; schema-check OK. rules.ts exports: ACADEMY_FACTS, emailKey, maskEmail, academyTrialEnd(start),
  trialSlotKey(subId,'YYYY-MM'), trialSlots(start,end), trialMonthDue(start,end,now), linkDecision({purchase, profile,
  profileCustomerHasLivePlan, purchaseCustomerHasLivePlan, emailHadEarlierTrial, by}) → start{customer, customerId,
  previousCustomerId} | already{userId} | refuse_* (incl. extra refuse_no_card: no customer/saved card on the purchase),
  daysBeforeTrialEnd(end,now), reminderDecision(end,now,{slotFree,sentAt,trialing,cancelling,refunded}) →
  skip|not_yet|wait|send|send_anyway. annual.ts adds monthSlots/monthSlotAt (annual = count 12). Extra index on user_id.
- [x] Phase 2 — Linking + starting the trial
  Notes: tests 3380 pass, tsc 0 errors. deps.ts (server-only) exports linkAcademyPurchase(purchaseId,userId,by,{dry}),
  linkPendingForUser(userId), unlinkAcademyPurchase(purchaseId,{dry}), cancelTrialForRefund(piId,fullyRefunded),
  liveAcademyDeps(), academyCustomerFor(userId,email). link.ts = same core with (deps, ...) + HOLDS_A_PLAN,
  trialSubscriptionParams, trialIdempotencyKey, flagReasonFor. emails.ts has the refund email only (Phase 5 adds the
  reminder). Activity via recordActivity (awaitable). Unlink also restores the profile's previous customer and clears
  the buyer's card. customer.ts +6 lines, kinds.ts +2 lines.
- [x] Phase 3 — Webhook + monthly trial credit
  Notes: tests 3391 pass. deps.academy {recordPurchase, linkAfterPurchase(purchaseId,userId), cancelTrialForRefund};
  purchase upsert lives in src/lib/stripe/deps.ts. grants.ts: ensureAcademyTrialMonthlyGrant + pure academyTrialSlotDue.
  Sweep returns academyTrialGranted / dry academyTrialDue. Dispute path left unchanged (harmless for academy).
- [x] Phase 4 — Checkout + pages
  Notes: tests 3403 pass, build OK; proxy leaves /academy public, not in sitemap. src/lib/academy/cancel-link.ts exports
  academyCancelUrl(subId, trialEndsAt) (falls back to /account/billing without a signing key) and
  verifyAcademyCancelToken(token). Checkout params builder in checkout-params.ts; 503 if Pro price isn't monthly GBP.
  Welcome page has extra short messages for refunded / flagged / linked-elsewhere purchases (flag to Zac in the PR).
- [x] Phase 5 — Reminder email + daily cron
  Notes: tests 3408 pass. runAcademyReminders({dry, now?}) → {status, body} in src/lib/academy/reminders-run.ts.
  Cron 06:47 UTC (picks emails start 07:00). Email builders: academyReminderEmail, academyRefundEmail. cap.ts +4 lines;
  cap.test.ts +5 lines (its test required every kind to have an unsubscribe switch; academy_reminder must have none).
- [x] Phase 6 — Admin panel
  Notes: tests 3408, build OK. academy-actions.ts (link/unlink/reminders, each requireAdmin + dry run first),
  AcademyPanel.tsx + AcademyPanelClient.tsx; page.tsx +2 lines. Unlink hidden for refunded/cancelled trials too.
- [ ] Phase 7 — Account line + sign-in linking
  Notes:
- [ ] Phase 8 — Stayful Intelligence knowledge drafts
  Notes:
- [ ] Phase 9 — Final checks + review
  Notes:

---


## Context
Zac sells the Stayful Academy as a one-off Stripe payment. Buyers get 3 months of Intelligence Pro free on the
card they paid with, then £39.99/month (`STRIPE_PRICE_PRO`) unless they cancel, with a reminder 7 days before
the first charge. Must merge before Batch 31 (customer websites ride on this plan).

Planned against origin/main **a0fa9c2** (the brief said 8bdbf9d; main has 7 newer R4 commits). In owned files
those touched: `webhook.ts` (dispute recording; the `charge.refunded` case also records disputes now),
`deps.ts` (recordDispute), `account/billing` + `account/usage` pages (bonusLineFor), `schema.sql` (+173 lines,
R4 blocks at the end). No conflict: academy code goes in new, labelled blocks. Before building, `git fetch` and
re-check the ownership files again if main has moved past a0fa9c2.

## Recon findings that change the brief
1. **Stripe cannot move a saved card to another customer** (a card saved on customer A can never be attached to
   B; detaching makes it unusable). Brief step D's "attach the card to the profile's customer" is impossible.
   → Q2: switch the profile to the academy customer when the old one holds no live plan.
2. `checkout.session.completed` writes the session's customer onto the profile for every one-off payment and gives
   up when there's no account. The academy branch must run first and return, or it would overwrite customers.
3. **£0 trial invoice bug confirmed**: today it grants Pro credit expiring at the trial end (day 90): one month's
   credit for three months. Fix: month 1 keyed `trial:<sub>:<YYYY-MM>` expiring after one month; the 03:00 credit
   sweep grants months 2 and 3 the same way annual plans get theirs.
4. `annualSlots` is hard-wired to 12 → generalised to `monthSlots(start, end, count)`; the last slot always ends at
   the trial end, so 3 slots cover exactly the 90 days whatever the month lengths.
5. Password sign-in never runs `runSignInHooks` (only email-link sign-ins do). New sign-ups are covered (their
   confirmation link runs it). Safety net: the daily academy cron also links unlinked purchases whose email now
   matches a confirmed account (shown in its dry run).
6. The existing checkout helper silently drops the terms tick box when Stripe has no Terms URL. The academy
   checkout fails closed instead: the tick box is the saved-card consent.
7. Custom tick-box wording: `consent_collection.terms_of_service: 'required'` +
   `custom_text.terms_of_service_acceptance.message` (needs a Terms URL in the Stripe dashboard).
8. Billing emails are never capped today (`src/lib/notify/cap.ts`). To count the reminder against the
   one-a-day cap it becomes a new capped kind `academy_reminder` with no unsubscribe switch.
9. Stripe portal links expire within minutes, so the email can't hold one. → Q4: signed one-tap link.
10. Access: a trial gets everything a paid member gets (picks/Today/deals skip the 48h delay via `hasEverPaid`;
    reports; digests). Only labels/weighting differ, none block: sourcing-demand weighting counts a trial as not
    paying; Monday "Monthly value" counts a trial at full price; weekly-active billing shows "Never paid";
    ManagePlan says "Renews on…" (fixed by H); a trial cancelled before paying keeps the no-delay (existing
    lapsed rule). Default: leave all as they are.
11. Day-91 card failure → `past_due` keeps Pro while Stripe retries, then free when Stripe gives up (existing).
    Click-through step 8 must move the test clock past the retry schedule.
12. Link only to accounts whose sign-in email is confirmed (stops someone claiming a trial with an unverified
    address). Academy checkout is card-only (a trial needs a card; no delayed payment methods).
13. `node_modules` isn't installed here: phase 0 runs `npm ci`.

## Zac's answers (19 Nov)
- Q1: keep all five brief defaults.
- Q2: different Stripe customer → switch the profile to the academy customer, only if the old customer holds no
  live plan (checked in Stripe); old customer untouched, its id saved in `previous_customer_id`. If the old one
  has a live plan → no trial, flagged (brief question 3).
- Q3: reminder first: the cron runs before the morning picks; the reminder takes the day's slot 7 days before
  the charge (the picks email moves to the next day). If the slot is already taken (e.g. an SI call), wait a day;
  on day 5 send anyway.
- Q4: one-tap signed link (HMAC via `src/lib/crypto/sign.ts`, expires at trial end) → Stripe portal
  `subscription_cancel` flow for that trial, no sign-in. Invalid/expired → `/account/billing`.

## Decisions (brief defaults + recon defaults)
- 90 days start at link; unlinked purchases older than 14 days flagged in admin.
- One purchase = one trial ever; a second purchase by the same email is flagged, no second trial.
- Buyer with a live plan (active/trialing/past_due/paused/unpaid/incomplete, checked in Stripe): no trial, flagged.
- Team members (billing owned by a team owner): no trial, flagged for admin.
- Full refund while trialing: cancel the trial now + refund email. Partial refund: recorded only, no cancel.
  Dispute: nothing automatic (visible in admin).
- Refund email: subject "Your Academy refund"; body "Your Stayful Academy purchase has been refunded, so your free
  months of Stayful Intelligence Pro have ended today. You won't be charged anything. Your account, deals and
  history stay as they are on the free plan."
- Admin Unlink (only while no invoice has been paid): cancels the trial subscription now and frees the purchase
  to be linked to another account (fresh 90 days).
- Academy money is not added to the member's Intelligence "Total paid", Monday row or Meta events.
- `/academy` is not in the nav, sitemap or search (noindex). No promo codes on the academy checkout.
- Amounts in the wording (£39.99) are read from the Stripe Pro price at send time, so the text stays exact if
  the price changes (same words today).
- Welcome page masks the purchase email (j•••@gmail.com) — never shown in full to whoever opens the URL.

## FINAL COMPLETE PLAN (phases; each ≤ ~5 files, one subagent each)

### Phase 0 — Setup (no deps)
1. Branch `batch-31a-academy-trial` from origin/main (a0fa9c2 or newer; report changes to owned files).
2. `npm ci`; baseline `npm test`, `npm run lint` pass. ✔ check: both green before any change.

### Phase 1 — Pure rules + schema (deps: 0)
Files: `src/lib/academy/rules.ts` (new), `src/lib/academy/rules.test.ts` (new), `src/lib/stripe/annual.ts`,
`src/lib/stripe/annual.test.ts`, `supabase/schema.sql`.
1. `rules.ts` (pure): `ACADEMY_FACTS` {trialDays 90, trialMonths 3, reminderDaysBefore 7, reminderLatestDaysBefore 5,
   chaseUnlinkedDays 14}; `emailKey`; `linkDecision(purchase, profile, facts)` → start | already | refuse_* (live
   plan, email mismatch, unconfirmed email, refunded, team member, no consent, repeat purchase);
   `reminderDecision(trialEnd, now, slotFree, sentAt, state)` → wait | send | send_anyway | skip;
   `trialSlotKey(subId, slot)`; masked email.
2. `annual.ts`: add `monthSlots(start, end, count)` + `monthSlotAt`; `annualSlots` becomes `monthSlots(…, 12)`
   (identical output; existing annual tests unchanged).
3. `schema.sql`: new block `academy_purchases` — `create table if not exists` + `add column if not exists` only:
   id, email (check lower-case), stripe_customer_id, stripe_payment_intent_id (unique), stripe_payment_method_id,
   amount_pence, paid_at, user_id (nullable → profiles), linked_at, linked_by ('auto'|'admin'),
   trial_subscription_id, refunded_at, **plus** stripe_checkout_session_id, terms_accepted_at, trial_started_at,
   trial_ends_at, previous_customer_id, flag_reason, reminder_sent_at, trial_cancelled_at, created_at, updated_at.
   Indexes `if not exists` (email where user_id is null; unique trial_subscription_id where not null).
   RLS on, no policies, `revoke all … from anon, authenticated` (as notification_sends). Nothing in ACCESS_COLUMNS.
4. Tests: link decisions (non-matching email doesn't link, live plan refused, repeat purchase flagged); trial slots
   for start days 1–31 in every month: exactly 3 slots, keys distinct, last ends at trial end; simulated sweep
   day 0→100 grants months 2 and 3 exactly once each; reminder decision (day 7 free slot → send; slot used →
   wait; day 5 → send anyway; sent → skip; cancelled/refunded → skip).
✔ Check: `npm test` green; locally on Postgres 16: shim.sql → schema.sql → dump → schema.sql again → no index
rebuilt, no diff (the CI "schema" job steps).

### Phase 2 — Linking + starting the trial (deps: 1)
Files: `src/lib/academy/link.ts` (new, core with injected deps), `src/lib/academy/link.test.ts` (new),
`src/lib/academy/deps.ts` (new, live Supabase/Stripe wiring, server-only), `src/lib/stripe/customer.ts`,
`src/lib/activity/kinds.ts`.
1. `linkAcademyPurchase(purchaseId, userId, by, { dry })` → returns a plan of exactly what will happen (used by
   admin Dry run) and, when not dry, does it:
   - refuses per `linkDecision`; Stripe is asked for live subscriptions on both customers (copy subscribe's
     HOLDS_A_PLAN check); returns `already` if `trial_subscription_id` is set.
   - customer: profile has none → set it to the purchase's customer. Profile has a different customer → if it holds no live plan, switch the profile to the purchase customer and save the old id in `previous_customer_id`; otherwise refuse and flag.
   - `savePaymentMethod`; `subscriptions.create` {Pro price, `trial_period_days: 90`, `default_payment_method`,
     `trial_settings.end_behavior.missing_payment_method: 'cancel'`, metadata {user_id, plan_code 'pro',
     source 'academy', academy_purchase_id}}, idempotency key `academy-trial:<purchaseId>`. Before creating, look
     for an existing subscription with that `academy_purchase_id` (idempotency keys expire after 24h).
   - conditional write (`trial_subscription_id is null`) of trial id/start/end, user_id, linked_at/by; stamp the
     profile's subscription id + 'trialing' (as subscribe does) so a second run sees a live plan.
   - `logActivity('academy_trial_started', dedupe academy_trial_started:<subId>)`.
2. `unlinkAcademyPurchase(purchaseId, { dry })`: only if no paid invoice on the trial; cancels it now.
3. `cancelTrialForRefund(paymentIntentId, fullyRefunded)`: sets refunded_at; full refund + still trialing →
   cancel now + refund email.
4. `customer.ts` `ensureStripeCustomer`: before creating a new customer, reuse the customer of an academy purchase
   linked to this user, or unlinked with the same email (≈5 lines; listed in the PR).
5. `kinds.ts`: `academy_trial_started: inApp('Academy trial started')` (1 line; counts for weekly active).
6. Tests (fake deps): linking twice starts one subscription; live plan refused, nothing created; non-matching
   email doesn't link; unconfirmed email refused; refunded purchase refused; different-customer case switches only when the old customer has no live plan.
✔ Check: `npm test` green; `git diff` on customer.ts ≤ ~8 lines.

### Phase 3 — Webhook + monthly trial credit (deps: 1, 2)
Files: `src/lib/stripe/webhook.ts`, `src/lib/stripe/webhook.test.ts`, `src/lib/stripe/deps.ts`,
`src/lib/stripe/grants.ts`, `src/app/api/internal/credit-sweep/route.ts`.
1. Webhook (new academy block, optional `deps.academy`):
   - `checkout.session.completed` with `metadata.kind = 'academy'`: handled first and returned. Record the
     purchase idempotently on the payment intent id (consent from `session.consent`), then try to link
     (client_reference_id, else the purchase email). Never touches the profile's customer itself.
   - `invoice.paid`: subscription `metadata.source = 'academy'`, `trialing`, `subscription_create` → grant month 1
     as `trial:<sub>:<YYYY-MM of trial start>`, expiring at min(start + 1 month, trial end). Day-91 invoice
     (`subscription_cycle`) is unchanged: normal Pro cycle, which also expires leftover trial credit.
   - `charge.refunded`: payment intent `metadata.kind = 'academy'` → `cancelTrialForRefund`; skip the member
     refund ledger for it. Disputes: no automatic action.
2. `grants.ts`: `ensureAcademyTrialMonthlyGrant(purchase)` — current slot via `monthSlotAt(trialStart, trialEnd,
   now, 3)`, only while the profile's subscription is that trial and `trialing` and not refunded;
   `grantPlanCycle(user, 'pro', 'trial:<sub>:<key>', slot.to, { notify: slot > 0, periodStart: trialStart })`.
3. Credit sweep: loop academy trials after the annual loop; dry run lists the trial months it would grant.
4. Tests: £0 trial invoice grants month 1 with the right key and expiry; a non-academy £0 invoice unchanged;
   academy checkout records + links and doesn't overwrite the profile's customer; checkout with no account
   records only; full refund cancels the trial; partial refund doesn't; replayed events change nothing.
✔ Check: `npm test` green; existing webhook tests untouched and passing.

### Phase 4 — Checkout + pages (deps: 1, 2)
Files: `src/app/api/billing/academy/checkout/route.ts`, `src/app/api/billing/academy/cancel/route.ts`,
`src/app/academy/page.tsx` (+ small client button), `src/app/academy/welcome/page.tsx`, `.env.example`.
1. Checkout: Stripe Checkout `mode: 'payment'`, card only, price `STRIPE_PRICE_ACADEMY`,
   `payment_intent_data.setup_future_usage: 'off_session'`, `metadata.kind = 'academy'` on session and payment
   intent, terms tick box required with the exact section-6 wording (amount from the Stripe Pro price). Signed in
   (not a team member): `customer` = their customer + `client_reference_id`; signed out: `customer_creation:
   'always'`. Refuses to open (503) if the price, Pro price or Terms URL is missing — never without the tick box.
2. `/academy`: one "Buy the Academy" button; public, noindex, not in nav/sitemap (check the proxy/middleware lets
   it through signed out).
3. `/academy/welcome?session_id=…`: signed in + linked → "Your 3 free months have started"; signed out, or emails
   differ → "Use the email you bought the Academy with, or contact us." (masked email, sign-up link).
4. Cancel link route: GET with a signed token (expires at trial end, `src/lib/crypto/sign.ts`) → fresh Stripe portal `subscription_cancel` flow for that trial, no sign-in; bad/expired token → `/account/billing`.
5. `.env.example`: `STRIPE_PRICE_ACADEMY=` with a comment (one-off GBP price Zac creates; Terms URL required).
✔ Check: `npm run build` green; `/academy` loads signed out; checkout route unit-checked for both signed-in and
signed-out parameter sets (no `customer` + `customer_creation` together).

### Phase 5 — Reminder email + daily cron (deps: 1, 2)
Files: `src/lib/academy/emails.ts` (+ `emails.test.ts`), `src/lib/academy/reminders-run.ts`,
`src/lib/notify/cap.ts`, `src/app/api/internal/academy-reminders/route.ts`, `vercel.json`.
1. `emails.ts`: reminder (exact subject/body from section 6; date, amount, last4, cancel link) and refund email.
2. `cap.ts`: new kind `academy_reminder` → daily slot, no unsubscribe switch (2 lines).
3. `runAcademyReminders({ dry })`: (a) link any unlinked purchase whose email matches a confirmed account;
   (b) per trialing, not-cancelling, not-refunded trial with no reminder sent: `reminderDecision`; claim the day's
   slot (`claimSlot`) or, on the last allowed day (5 days before), send anyway; send with Resend idempotency key
   `academy-trial-reminder:<subId>`; stamp `reminder_sent_at`. Ignores marketing unsubscribe. Dry run: who would
   get it today, who waits, full email preview, links it would make — sends and writes nothing.
4. Route: same shape as other internal crons (404 without secrets, 401 without auth, `?dry=1`).
5. `vercel.json`: one cron line, daily, scheduled before the morning picks email (check the picks cron time in vercel.json).
6. Tests: sends once (second run skips); waits when the day's slot is taken; sends anyway on day 5; never for a
   cancelled or refunded trial; email text matches section 6 exactly.
✔ Check: `npm test` green; `vercel.json` diff is one cron entry.

### Phase 6 — Admin panel (deps: 2, 5)
Files: `src/app/admin/billing/academy-actions.ts` (new), `src/app/admin/billing/AcademyPanel.tsx` (new),
`src/app/admin/billing/page.tsx` (import + render, 2 lines).
1. "Academy purchases": every purchase — email, paid date/amount, linked to whom (auto/admin), trial status, trial
   end, reminder sent, flags (unlinked > 14 days, repeat purchase, live plan, team member, refunded).
2. "Link to member": search by email → Dry run shows exactly what will happen (customer used, card, trial dates,
   any refusal) → Run enabled only after a clean dry run (TidyPanel pattern).
3. "Unlink": only while nothing has been charged; Dry run → Run.
4. Reminder cron Dry run / Run buttons (calls the runner directly, like other admin crons).
✔ Check: `npm run build` green; every action has a dry run; all actions call `requireAdmin`.

### Phase 7 — Account line + sign-in linking (deps: 2)
Files: `src/app/account/page.tsx`, `src/app/account/ManagePlan.tsx`, `src/lib/auth/sign-in-hooks.ts`.
1. Account plan card for an academy trial: "Academy: Pro free until <date>. Then £39.99/month on card ending
   <last4>. [Manage or cancel]" (amount from Stripe price; existing portal button).
2. `runSignInHooks`: if the email is confirmed, after the response, link any unlinked purchase with that email
   (≈6 lines).
✔ Check: `npm run build` green; diffs listed line by line in the PR.

### Phase 8 — Stayful Intelligence knowledge drafts (deps: 1)
Files: `src/lib/knowledge/placeholders.ts`, `src/lib/knowledge/seed.ts`, `src/lib/knowledge/service-facts.ts`.
1. Placeholders: `academy_trial_months`, `academy_reminder_days` (from `ACADEMY_FACTS`), `pro_plan_cost`
   (billing_plans 'pro').
2. Draft entries (never approved in code), every figure a placeholder: what the Academy includes; when the free
   months end and what's charged after; how to cancel; "I bought the Academy but have no free months" (same email
   or contact us). Appended in one labelled block (Batch 31 may also edit seed.ts).
3. service-facts: the academy trial fact the nightly job drafts from.
✔ Check: `npm test` green (seed tests: every placeholder resolves, no typed figure).

### Phase 9 — Final checks + review (deps: all)
1. `npm test`, `npm run lint`, `npm run build`, schema twice locally — failures only.
2. Review: no double/missing trial months; no trial without a purchase; no access gap for trials; no full email
   on public pages or logs; every cron/admin action has a dry run; schema additive only; `git diff` shows no
   `ACCESS_COLUMNS`, `src/lib/funnels/**`, pricing settings or plan price changes; no duplicate Stripe customers;
   no off-session charge without the tick-box consent.
3. Stripe test mode end to end needs Stripe test keys (the Stripe connector here needs signing in): done by Zac
   with the click-through list.
4. PR (draft) listing every line changed in customer.ts, sign-in-hooks.ts, account/**, cap.ts, kinds.ts,
   credit-sweep, admin billing page.

## Files
Create: `src/lib/academy/{rules,rules.test,link,link.test,deps,emails,emails.test,reminders-run}.ts`,
`src/app/academy/page.tsx` (+ button), `src/app/academy/welcome/page.tsx`,
`src/app/api/billing/academy/{checkout,cancel}/route.ts`, `src/app/api/internal/academy-reminders/route.ts`,
`src/app/admin/billing/{academy-actions.ts,AcademyPanel.tsx}`.
Change: `supabase/schema.sql`, `src/lib/stripe/{annual,annual.test,webhook,webhook.test,deps,grants}.ts`,
`src/app/api/internal/credit-sweep/route.ts`, `vercel.json`, `.env.example`, `src/app/admin/billing/page.tsx`.
Minimal (every line listed): `src/lib/stripe/customer.ts`, `src/lib/auth/sign-in-hooks.ts`,
`src/app/account/{page.tsx,ManagePlan.tsx}`, `src/lib/notify/cap.ts`, `src/lib/activity/kinds.ts`,
`src/lib/knowledge/{placeholders,seed,service-facts}.ts`.
Do not touch: `ACCESS_COLUMNS`, `src/lib/funnels/**`, pricing settings, plan prices, `src/app/(auth)/actions.ts`.

## Remaining risks (each with rollback)
- A typo'd email at checkout that matches someone else's confirmed account gives them the trial on the buyer's card
  (reminder goes to that account). Rollback: admin Unlink before day 91; refund.
- A bank asks for 3-D Secure on day 91 → invoice fails → past_due → free after retries (as today). Rollback: none
  needed; Stripe's "payment needs action" email if enabled.
- Stripe Terms URL not set → academy checkout refuses to open. Rollback: set it in the Stripe dashboard.
- seed.ts / admin billing page also edited by Batch 31 → merge conflict. Rollback: append-only blocks; rebase.
- Anything wrong after deploy: unset `STRIPE_PRICE_ACADEMY` (checkout closes), remove the cron line; the table
  stays (additive).

## Handover (after approval)
Save this plan as `PLAN.md` at the repo root as a checkbox list of phases with a blank "Notes:" line under each,
commit it on `batch-31a-academy-trial`, then build phase by phase as a coordinator (one subagent per phase,
≤150-word reports, tick + commit "Phase N: <name>" after each check passes; stop and ask on any blocker).

## Verification
Unit tests per phase; schema twice on local Postgres 16; `npm run build`; then Zac's test-mode click-through
(section 10 of the brief), with step 8 advancing the clock past Stripe's retry schedule.

## Exact wording (Zac's section 6 — use exactly; £39.99 rendered from the Stripe Pro price, 3 months / 7 days from ACADEMY_FACTS)
- Checkout terms: "Includes 3 months of Stayful Intelligence Pro free, starting when you create your Intelligence
  account with this email. After that it's £39.99/month on this card until you cancel. Cancel any time in
  Account → Billing."
- Reminder email subject: "Your free Academy months end on <date>"
- Reminder email body: "Your 3 free months of Stayful Intelligence Pro end on <date>. From then it's £39.99/month
  on your card ending <last4>. Nothing to do if you'd like to keep it. To cancel, tap here: <portal link>."
- No-match message: "Use the email you bought the Academy with, or contact us."
- Account line: "Academy: Pro free until <date>. Then £39.99/month on card ending <last4>. [Manage or cancel]"
- Refund email: subject "Your Academy refund"; body as in Decisions above.
