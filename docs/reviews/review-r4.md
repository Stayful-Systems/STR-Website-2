# Review R4 — everything merged since Review R3

**Reviewed at:** `8bdbf9d3f1e9b6dfa507be20a83ba59d44d6a265` (origin/main, "Admin: Dry run / Run button for the Batch 30 backfill (#164)", merged 14 Nov 2026). Review R3 was at `42e68ea39da04f2cc1c5ba2c68ef27aab4f21b96`. Planned on 19 Nov 2026 against this hash, and re-fetched before writing: main had not moved. Readers and second readers ran on 19 Nov 2026. Read-only: no code, setting or database row was changed, and this file is the only thing on the `review-r4` branch.


## 1. One screen

**The short version.** There is no Critical finding and, after a second reader re-walked every Medium and above, no High. The R3 fixes and Batches 27–30 are built: 148 of R3's 154 fixes are in place and none is missing, no member is charged wrongly (where the new code misjudges what a member can spend, the database still refuses), nothing leaks an address or breaks the 48-hour delay, and every new cron's dry run writes nothing. What is wrong is fourteen Medium findings, mostly rules that changed meaning as one batch landed on another: which end of the profit range counts, whether R2R setup cash hides deals, the two minimum-profit figures, which cash ceiling buy-to-let uses, and Stayful Intelligence (SI) counting the starter-pack bonus as money it can spend. Six of the fourteen are buy-to-let (BTL) card and list bugs that stay asleep until `BTL_SCREEN_ENABLED=true`: on live, no deal carries a BTL lens yet. A local `npm run build` stops at a Next.js 16.4.1 security gate after compiling, and CI never runs the build. Vercel still builds and deploys this PR's preview on the same version, so deploys are not blocked (**R4-32**, Low). Finally, Facebook's Purchase event cannot fire today: Batch 29 made Purchase mean "bought the starter pack", and the pack is switched off on live.

**67 reader findings (8 readers and a mechanical pass), merged into 50; 49 stand after second reading: 0 Critical · 0 High · 14 Medium · 35 Low; 1 refuted (appendix D).**

### Medium, in the order a brand-new member from a Facebook ad would meet them

1. **R4-01** — The quiz, reveal and Home never load Meta's pixel, so day-one browser conversions wait for /today and Home page views are lost (sign-up).
2. **R4-02** — R2R "Under £10k" setup cash is a must-have that hides every rental with 2 or more bedrooms (quiz, reveal).
3. **R4-03** — Old "risk" answers now mean "which end of the range", and no answer moved from the low end to the middle; standout and "most you can pay" still use the low end (Today).
4. **R4-26** — BTL cards show "Value in 5 years" with no "history, not a forecast" and no "before tax" (Today; asleep until the BTL switch).
5. **R4-25** — BTL Today reads 400 deals sorted by short-let profit before the cash ceiling, so small-cash members see few or none (Today; asleep).
6. **R4-22** — BTL cash ceiling is the exact Buying cash on Today but one band lower for standout, what-if, benchmark and the £2 report (Today, standout; asleep).
7. **R4-23** — Browse judges BTL deals on the short-let cash and profit checks, so a deal on BTL Today "misses" on Browse (Browse; asleep).
8. **R4-07** — SI's "budget under £X" becomes a cash band that ignores how the member pays, often the opposite of what was asked (first full-view chat).
9. **R4-06** — SI's chat and action checks count the restricted starter-pack bonus as spendable: it promises, counts down, then says "not enough credit" (first chat after buying the pack).
10. **R4-05** — One save writes both minimum-profit figures and Undo cannot put them back (first chat, members from before Batch 30).
11. **R4-24** — "Buy to let instead?" in the analyser, Explorer and what-if uses built-in defaults and leaves out a flat's service charge (first Full analysis).
12. **R4-15** — The £5 "what next" decision is held day after day when no morning email is built (first month, pack members).
13. **R4-14** — A refunded or charged-back further payment lifts the starter-pack bonus for good (later).
14. **R4-27** — BTL standouts skip R3-52's "beats everything shown" bar (later).

### Low

- **R4-04** "Middle of the range used, as you asked" for members who never answered.
- **R4-08** SI's criteria tool lists retired fields and leaves out buy-to-let; SI cannot change Buying cash or setup cash.
- **R4-09** "Report ready" and SI's "already saved" go by deal; the purchase goes by listing inputs.
- **R4-10** A message that is only a link can show the model's own instructions.
- **R4-11** An SI analysis whose run request is lost is never asked for again.
- **R4-12** Batch 27's drafted offer amount and feature summary skip the figure and advice guard.
- **R4-13** The si-actions dry run caps each count at 1,000.
- **R4-16** The digest swaps the £5 decision for the £15 offer but records the £5 decision as sent.
- **R4-17** A failed analyser report that charged anything keeps its fresh-report slot.
- **R4-18** A payment made just before the bonus expires but recorded after it lets the bonus expire.
- **R4-19** A pack buyer on a plan trial keeps a restricted, expiring bonus with no explanation.
- **R4-20** The Places cache keeps an empty answer for 90 days.
- **R4-21** RepeatPurchase can be lost when two further payments land together.
- **R4-28** The BTL benchmark's "widened" or "thin" notice shows only after Open.
- **R4-29** The £2 BTL report can sell a second copy if the "already have one?" read fails.
- **R4-30** The £2 BTL report can overdraw when its hold silently fails.
- **R4-31** BTL settings and two cron previews have no admin control.
- **R4-32** A local `npm run build` stops at Next.js 16.4.1's security gate; CI never builds (Vercel builds fine).
- **R4-33** The rate sync could overwrite a member's chosen rate before the backfill (did not happen on live).
- **R4-34** Seven Critical/High and 24 Medium R3 fixes have no test.
- **R4-35** R3-111 deferred: a crash between the briefing's two meter calls leaves one part unpaid.
- **R4-36** Approving a knowledge entry closes gaps left open for a missing channel.
- **R4-37** One quick-answer path logs activity with no dedupe key.
- **R4-38** `npm audit` lists 4 high again.
- **R4-39** Two fix PRs and three code comments name the wrong R3 ids.
- **R4-40** Old R2R setup answers re-read as new bands; a failed mode write is never retried.
- **R4-41** Older R2R-only and BTL-only members get new unanswered questions.
- **R4-42** "Use today's average" with an empty rate cache keeps the member's rate but labels it the average.
- **R4-43** Older members' Buying cash row reads "Not answered yet"; never filled for BTL-only members.
- **R4-44** One Buying cash answer is costed three ways and adds two must-have checks.
- **R4-45** Several new rules and limits have no SI knowledge entry.
- **R4-46** service-facts.ts types two figures the nightly drafter can copy.
- **R4-47** One index is dropped and rebuilt on every schema run.
- **R4-48** Two new SQL functions have no database smoke test.
- **R4-49** A Stripe hiccup while looking up a customer creates a second customer (pre-existing; Batch 31a's file).

### Go / no-go for Facebook ads

**Verdict: GO once these four conditions are met.** Only the first needs a code change.

1. Fix branch **r4a** is merged: the pixel tidy so day-one browser conversions are not lost (**R4-01**). It also bumps `next` to 16.4.6 (**R4-32**).
2. **The Purchase event:** switch the starter pack on before ad spend, or point campaigns at another event (for example CompleteRegistration). No code change.
3. **Zac approves the `chat_voice` draft in admin.** R3-1 (R3's one Critical) is fixed in code, but members keep hearing the old answer until the draft is approved (appendix B, R3-1 row).
4. **Zac confirms Vercel accepts 45 crons.** R2 recorded the Pro limit as 40 (§8). Manual check.

| R3 bullet | | Reason |
|---|---|---|
| Weekly active tracking correct end to end | ✅ | Passes in code (R3l): `home_view` is record-only, the chat admin panel uses the one exclusion list, and every new Batch 27–30 activity kind is classified correctly (appendix C). |
| Meta consent and events firing once | ✅ | Holds: the server copy (CAPI) of each event goes once per member, with one shared event id. But browser copies are lost on day one (**R4-01**, fixed in r4a), and Purchase cannot fire while the pack is off (condition 2). |
| A brand-new member's first day works on a phone with correct charges | ⚠️ | Passes on charges, except three Medium rule problems a newcomer meets: **R4-01**, **R4-02**, **R4-03**. Still needs the click-through on a real phone (§11). |
| Every cron's `?dry=1` works | ✅ | Passes: no dry run writes anything (appendix A, table B). Only gap: the si-actions dry run caps its counts at 1,000 (**R4-13**, Low). |
| No open Critical or High finding | ✅ | None in scope. R3-1 is fixed in code and waits only for Zac's approval of the draft (condition 3). |


## 2. How this review was done

Read-only throughout: no code, setting or row was changed, no API was called with a real key, and the only file this branch adds is this report.

1. **Mechanical checks first** (appendix A). CI was replicated on a throwaway Postgres 16: `shim.sql`, `schema.sql` run twice with empty dump diffs, then `credit-smoke.sql`, `pack-smoke.sql` and `scan-days-smoke.sql`. Then `npm ci`, `lint`, `typecheck`, `npm test` (3,255 pass), `npm run build` (fails at the security gate, **R4-32**) and `npm audit`. Also a cron-by-cron dry-run check, a settings check and a TODO search.
2. **Live reads, SELECT only**, on the Supabase project "ZacStayful's Project": every Batch 27–30 object (129 of 129 present), every new setting's value (all at their defaults), the Batch 30 backfill's progress, starter-pack grants and negative balances. Counts only (appendix E).
3. **Vercel:** the production deploy of `8bdbf9d` is READY. The preview of this PR (`review-r4`, the same code plus this file) also built and deployed on Vercel on 19 Nov 2026, on the same Next.js 16.4.1: Vercel does not hit the security gate that stops a local build (**R4-32**).
4. **Eight readers in parallel:** R1 the R3 fixes (all 154 ids), R2 Batch 27, R3 Batch 28, R4 Batch 29, R5 Batch 30, R6 conflicts between batches, R7 standing checks and loose ends, R8 forward conflicts for Batch 31/31a, the Facebook-ad first day, and the go / no-go. Each read the code at `8bdbf9d`, using the Graphify code graph (at the same commit) to find files.
5. **Four second readers** (V-A to V-D) re-walked every Medium and above from its entry point (the route, page, cron or action), looking for a guard that stops it. They also re-checked the Lows.
6. **Verification counts.** Of 67 reader findings: merged into 50; 2 raised (R3x-4 and R6-10, each Low to Medium as part of a merged finding); 6 lowered (R5-1/R7-1 on live facts, R5-2, R1-1/R1-9, R4-1, R6-3, and M-1 after the Vercel preview built); 1 refuted outright (R6-9). Nineteen further sub-claims (an example, a figure, a fix or a severity) were corrected (appendix D).
7. **Coordinator.** One pass merged duplicates, set the final severities and ids, and put the business rules to Zac. His answers (19 Nov 2026) are written into each fix (§9).

What was refuted: R6-9 ("BTL and short-let use different snapshots of the live rate"). Both copies follow the same daily figure (V-D). Zac's rule anyway: BTL keeps the live rate for everyone.

What this review could not do: run the site on a phone, call Stripe, Meta or Anthropic, or run a Vercel build. Those are in §11.


## 3. Scope: what is on main since Review R3

Review R3 was taken at `42e68ea`. Between that and `8bdbf9d` there are **22 commits**, in this order, none missing and none twice:

| # | Commit | Date | What |
|---|---|---|---|
| 1 | 65f4462 | 15 Oct 2026 | Review R3 report (#144) |
| 2 | 4d2c199 | 15 Oct 2026 | R3a: a new member's first five minutes (#145) |
| 3 | 4bf68be | 15 Oct 2026 | R3b: the spoken answer's price, said and shown (#146) |
| 4 | cff353c | 15 Oct 2026 | R3c: the morning briefing never 500s, never charges twice, seeds off (#147) |
| 5 | 98530c2 | 15 Oct 2026 | R3d: a text is charged only when Twilio took it (#148) |
| 6 | c2ab838 | 15 Oct 2026 | R3e: one low-credit notice per credit; call re-tested at dial time (#149) |
| 7 | a21fb38 | 15 Oct 2026 | R3f: the policy says what the code does (#150) |
| 8 | 46c6eeb | 15 Oct 2026 | R3g: standout respects the member's own reasons (#151) |
| 9 | 7256e55 | 15 Oct 2026 | R3h: an inbound caller is a member only with consent (#152) |
| 10 | c6b8538 | 15 Oct 2026 | R3i: schema.sql safe to run again on live (#153) |
| 11 | 41eca05 | 15 Oct 2026 | R3j: the chat says only what is approved (#154) |
| 12 | bf58b2d | 16 Oct 2026 | R3k: what the chat says about money matches the ledger (#155) |
| 13 | 0064b39 | 16 Oct 2026 | R3l: one definition of the one number (#156) |
| 14 | 9322b76 | 16 Oct 2026 | R3m: the nightly knowledge job remembers its decisions (#157) |
| 15 | a30f780 | 16 Oct 2026 | R3n: code health (#158) |
| 16 | 93d6450 | 16 Oct 2026 | Batch 27: Stayful Intelligence acts for the member (#159) |
| 17 | 4c30705 | 16 Oct 2026 | Batch 28: buy-to-let (long-term tenants) deals (#160) |
| 18 | 11ccb79 | 03 Nov 2026 | Graphify code-search rule in CLAUDE.md |
| 19 | 09550fc | 03 Nov 2026 | Merge #161 (the Graphify rule) |
| 20 | 747991b | 14 Nov 2026 | Batch 29: starter pack guardrails, pay-again measure, RepeatPurchase (#162) |
| 21 | 0ea62ec | 14 Nov 2026 | Batch 30: shorter signup questions, same accuracy (#163) |
| 22 | 8bdbf9d | 14 Nov 2026 | Admin: Dry run / Run button for the Batch 30 backfill (#164) |

**The order seam.** Batch 30 was written before Batch 26 and merged after Batch 28 (and after Batch 29). So Batch 30's quiz changes landed on top of code it had not seen: Batch 27's SI criteria changes (**R4-05**, **R4-07**, **R4-08**), Batch 28's buy-to-let cash bands (**R4-22**, **R4-23**), and Batch 29's pack, which Batch 27 also had not seen (**R4-06**). Most of this review's Mediums sit on these seams.


## 4. Findings by area

Every finding below was traced in the code at `8bdbf9d`. "Code-only" means it was not checked against live data. "Asleep" means the code path runs only once `BTL_SCREEN_ENABLED=true` (live has no BTL deals yet).

### A. First day and ads

#### R4-01 · Medium · The quiz, reveal and Home never load Meta's pixel, so day-one browser conversions wait for /today and Home page views are lost

- **Where:** `src/lib/tracking/config.ts:171` (the tidy rule); config.ts PAGEVIEW_PATHS and BANNER_ONLY_PREFIXES (no `/home`, no `/welcome/reveal`); `src/lib/auth/landing.ts:25, 67-71`; `src/app/home/layout.tsx:17`; `src/lib/profile/server.ts:164`; `src/lib/tracking/surfaces.ts:91, 110`; `src/lib/tracking/runtime.ts:255`; `src/lib/tracking/surfaces.test.ts:45-48`; `src/app/api/billing/starter-pack/route.ts:177`.
- **What is wrong:** the rule that tidies the quiz address only removes `next` when it is `/today`:
  `{ path: '/welcome', param: 'next', when: '/today' }`
  Since R3a, a new member's first page is `/welcome?next=%2Fhome`. The `next` stays on the address, so the "clean page" test fails and the pixel never starts. `/welcome/reveal` and `/home` are on no tracking list at all, so nothing runs there either. A pack bought in the quiz returns to `/welcome?next=%2Fhome&pack=1`, and `pack` is not tidied on `/welcome`.
- **How a member or Zac hits it:** every new member from the ad. They accept cookies on /signup, confirm their email, do the quiz, see the reveal, land on Home and put the phone down. Meta's browser copies of CompleteRegistration, ProfileComplete, FirstReport (and Purchase, if they bought the pack in the quiz) are held for 24 hours waiting for a clean tracked page such as /today, then lost. The server copies (CAPI) still reach Meta once, so nothing is double-counted. Home page views are lost on every later login too, because Home is where each login lands.
- **Smallest fix:** Zac's rule (19 Nov): do **not** add a PageView on `/home` or `/welcome/reveal`; **do** count a member's first £2 BTL report as FirstReport. So: change the tidy rule to `when: HOME_PATH` (imported from `src/lib/auth/landing.ts`), add `{ path: '/welcome', param: 'pack' }`, and let held browser conversions fire on `/welcome`, `/welcome/reveal` and `/home` without sending a PageView there (runtime.ts, surfaces.ts). Record FirstReport when a member's first £2 BTL report finishes (`src/lib/btl/report-server.ts`).
- **Test that would have caught it:** in `src/lib/tracking/surfaces.test.ts`, "/welcome loses ?next when it is HOME_PATH" (`tidiedHref(SITE + quizPathFor(HOME_PATH)) === SITE + '/welcome'`), plus a wiring test that the tidy rule's `when` equals `HOME_PATH`. For the new part: "a held FirstReport fires on /home with no PageView" and "a first BTL report records FirstReport once".
- **Merged from:** R8-1.
- **Verification:** V-B, stands at Medium. A regression exposed by R3a removing the `/home → /` redirect; the mismatch was latent since Batch 22e (c3809a2) changed HOME_PATH but left config.ts alone. Medium, not High, because the optimised events still arrive server-side.
- **31a overlap:** `src/lib/tracking/config.ts` (31a must add `/academy` to the same lists, §8). Merge r4a first.

#### R4-02 · Medium · R2R "Under £10k" setup cash is a must-have that hides every rental with 2 or more bedrooms

- **Where:** `src/lib/tailoring/criteria.ts:88` (default mode) and `:485` (the check); `src/lib/listing/deal.ts:163-165` (setup cost); `src/lib/tailoring/config.ts:86` (`setupBudgetTop.u10k = 10_000`); `src/lib/profile/questions.ts:614-626` (the question).
- **What is wrong:** setup cash is a must-have by default (`setup … defaultMode: 'must'`) and is checked as `push('setup', atMost(fig.setupCost, w.setupTop))`. The setup estimate is `6000 + bedrooms*3500`: £9.5k for a 1-bed, £13k for a 2-bed (or unknown), £16.5k for a 3-bed. So "Under £10k", the first option, fails every rental with 2+ bedrooms.
- **How a member or Zac hits it:** from a Facebook ad, a member ticks Rent-to-rent, picks "Under £10k", then "House, 3 bed" on the next screen. Their reveal and Today show only studios and 1-beds, often none. Nothing on either screen warns that the two answers rule each other out.
- **Smallest fix:** Zac's rule (19 Nov): setup cash becomes a nice-to-have for everyone. It ranks deals and never hides them. Change the default mode at criteria.ts:88 to `'nice'`. Update the `r2r_setup_cash` knowledge draft (and service-facts.ts if it says "must").
- **Test that would have caught it:** in `src/lib/tailoring/criteria.test.ts`, "an R2R member with Under £10k setup and 3 bedrooms still has matches; setup only ranks".
- **Merged from:** R5-8.
- **Verification:** V-A, stands at Medium (met at quiz and reveal by new R2R members on a common budget).

#### R4-03 · Medium · Old "risk" answers now mean "which end of the range", and no answer moved from the low end to the middle; standout and "most you can pay" still use the low end

- **Where:** `src/lib/tailoring/criteria.ts:163-167, 213, 478`; `src/lib/profile/questions.ts:429-442` (new wording; old wording at `0ea62ec^` questions.ts:392-399); `src/lib/marketplace/most-you-can-pay.ts:73-77, 88`; `src/lib/standout/rules.ts:114, 130-132`; `src/lib/standout/run.ts:496`.
- **What is wrong:** before Batch 30 every profit check was `fig.range.lowPcm >= minProfit` (the low end). Now:
  `return risk === 'avoid' ? 'low' : risk === 'go' ? 'high' : 'mid';`
  The stored answers came from an old question about comfort with risk ("A deal could make £800 a month, but £300 in a slow year. Would you… Avoid it / Consider it / Go for it"). They are now read as "which end has to hit your minimum". No answer, or "Not sure", now means the middle. Meanwhile "Most you can pay" still sizes the price for the low end, and standout still needs `profitLow >= profitBar`.
- **How a member or Zac hits it:** an older member with a £500 minimum who once tapped "Go for it" now has a £150–£520 deal passed as meeting their minimum, and the card says "Top end used, as you asked". A member with no answer sees a £400–£600 deal pass on the middle while the same card's "Most you can pay" is below the asking price: "match" and "you can't pay this" at once. A member who chose the top end gets a £400–£900 deal on Today, but standout calls it `profit_short`.
- **Smallest fix:** Zac's rule (19 Nov): anyone who answered before Batch 30, or never answered, is judged on the **low** end until they answer the new question; new members default to the **middle**. Standout and "Most you can pay" go through the same one helper (`profitAt` + `profitEndFor`). `profitEndFor` needs the answer date (`profile_quiz.answered.risk.at`) and the sign-up date compared with `quiz_shorter_from`, because the answer alone carries no date. Update the `profit_end` knowledge draft.
- **Test that would have caught it:** in `criteria.test.ts`, "a risk answer stored before quiz_shorter_from judges the low end" and "no answer: low end if joined before Batch 30, middle if after"; in `most-you-can-pay.test.ts`, "a card that passes never shows Most you can pay below the asking price"; in `standout/rules.test.ts`, "standout profit uses the member's end".
- **Merged from:** R5-5, R6-6, R5-6.
- **Verification:** V-A, stands at Medium. Every existing member's check loosened overnight without being asked; `criteria.test.ts:170` pins `null → 'mid'`, so the middle default was deliberate in code, but no PR line says old answers keep their meaning.

#### R4-04 · Low · "Middle of the range used, as you asked" for members who never answered

- **Where:** `src/lib/marketplace/card-display.ts:42-47`; `src/lib/tailoring/criteria.ts:175-177`.
- **What:** `endSale: w.minProfit !== null ? end : null`, where the end note always ends "as you asked", even when `risk` is null.
- **Example:** a new member sets a £500 minimum and taps "Not sure" on the range question. Every card says "Middle of the range used, as you asked".
- **Fix:** when `about.risk` is null, drop "as you asked" (with R4-03's rule this also covers older members shown the low end by default).
- **Test:** `card-display.test.ts`, "no risk answer: the end note without 'as you asked'".
- **Merged from:** R5-7. **Verification:** V-A, stands.

### B. Profile and Stayful Intelligence

#### R4-05 · Medium · One save writes both minimum-profit figures, and Undo cannot put them back

- **Where:** `src/lib/si-actions/config.ts:56-57`; `src/lib/si-actions/steps-server.ts:235-240, 290-291`; `src/lib/si-actions/undo-server.ts:69-76`; `src/lib/profile/questions.ts:1142-1149`; `src/lib/intelligence/what-if.ts:277-285`.
- **What is wrong:** Batch 30 sends SI's rent-to-rent change through the single minimum (`r2r_min_profit: 'min_profit'`), and `min_profit` writes both fields:
  `const both = setR2r(a, { minMarginPcm: Math.round(n) }); … targetMarginPcm: Math.round(n)`
  Undo's "before" is only the rent-to-rent figure, replayed through `min_profit`, so it writes that one figure into both. The what-if does the same in reverse.
- **How a member or Zac hits it:** an older Buy + R2R member has a buying minimum of £800 and a rent-to-rent minimum of £300. They tell SI "drop my rent-to-rent minimum to £250". The card says "Rent-to-rent minimum profit: £250", but the buying minimum becomes £250 too, and weak short-let deals flood in. They tap Undo: both become £300, and the £800 is gone. Or they tap "Use this" on the what-if "set your minimum profit at £650": the rent-to-rent minimum goes **up** from £300 to £650.
- **Smallest fix:** Zac's rule (19 Nov): keep the two figures separate; each change writes only its own minimum; Undo restores exactly. Send SI's rent-to-rent change through `r2r_min_profit` (still `retired: 'editable'`) and a buying change only to `finance.targetMarginPcm` when the member's two figures differ; record both figures as Undo's "before" and restore each; make the what-if write only the figure it lowered.
- **Test that would have caught it:** in `src/lib/si-actions/undo.test.ts`, "undoing a rent-to-rent minimum change for a member with two minimums restores both"; in `src/lib/intelligence/what-if.test.ts`, "the profit what-if never raises the rent-to-rent minimum" (the existing case at line 148 uses equal figures, so it misses this).
- **Merged from:** R2-1, R5-3, R6-5.
- **Verification:** V-A, stands at Medium. Only members with two different stored minimums (from before Batch 30); a new member's single answer always writes both, so they are equal.

#### R4-06 · Medium · SI's chat and action checks count the restricted starter-pack bonus as spendable

- **Where:** `src/lib/si-actions/plan-server.ts:205, 219-227` (and the face walk at :98-109); `src/lib/si-actions/run-server.ts:57-60, 331-336, 461-463`; `src/lib/chat/turns-server.ts:136-144`; `src/lib/credit/ledger.ts:79-93` (what they use) against `:102` (what they should use).
- **What is wrong:** all three read the whole balance:
  `return (await getBalance(member.payerId)).spendableBasePence;`
  That figure is "unrestricted + bonus". Batch 29 limited the bonus to opens, daily picks and saved analyses, and added `spendableFor(user, action)` for exactly this check. Batch 27 (merged before Batch 29) never used it.
- **How a member or Zac hits it:** a pack buyer (£10 paid, £20 bonus) has spent £8 and asks the full view to "run a deep search". SI shows the spend line and the Stop countdown, then the step ends "not enough credit when its turn came" and the top-up box opens, with no reason given. The low-credit confirm was skipped because "balance after" counted the bonus. Nothing is charged wrongly: the database's reserve and debit enforce the bonus limits.
- **Smallest fix:** in plan-server and run-server, check each charged step with `spendableFor(payerId, stepAction, meta)` (a saved analysis uses `full_analysis_saved`), walking the steps cumulatively; use `faceAvailableFor` for the face "balance after"; in turns-server use `spendableFor(payerId, CHAT_ACTION[surface])`. Pass the bonus-only message through `startAnalysis` so the member is told why. No rule needed.
- **Test that would have caught it:** a static source test in `src/lib/credit/pack-rules.test.ts`, "affordability before a charge uses spendableFor, never getBalance().spendableBasePence"; a `src/lib/si-actions/spend.test.ts` case where `decideSpend` gets the scoped figure with bonus > 0; a `pack-smoke.sql` case where `credit_reserve(u,'si_chat_full',…)` is refused while `credit_available` shows enough.
- **Merged from:** R2-2, R6-7, R7-3, R8-2.
- **Verification:** V-C, stands at Medium (no money moves wrongly, but SI breaks its "offer first" promise for the pack cohort). Asleep on live while the pack is off: 0 pack-bonus grants.

#### R4-07 · Medium · SI's "budget under £X" becomes a cash band that ignores how the member pays

- **Where:** `src/lib/si-actions/steps-server.ts:216-227, 274-296`; `src/lib/profile/buying-power.ts:59-65, 94-101`; `src/lib/profile/questions.ts:1079-1086`.
- **What is wrong:** for a member with a real Buying cash answer, SI turns the price into a cash band and stops if it matches:
  `const band = cashBandFromBudget(v)` … `if (band === a.goals.buyer.cashAvailable) return { reason: 'already_there' };`
  `cashBandFromBudget` always prices a mortgage (`cashNeededFor(top, false)`), and the band then re-derives a budget at its top.
- **How a member or Zac hits it:** (a) a member on £30–60k says "only show me deals under £100k". SI says "already there", but they still see homes up to about £150k. (b) A cash buyer on £100–200k asks for "under £100k". SI sets Buying cash to £30–60k, which for a cash buyer is about a £45k purchase, so almost every deal disappears. (c) "Budget £100k–£200k" becomes £60–100k cash and no price ceiling at all, so homes up to about £260k appear.
- **Smallest fix:** Zac's rule (19 Nov): "budget under £X" sets a price ceiling of £X only and leaves Buying cash untouched. In steps-server, save the stated price as the budget ceiling, stop calling `cashBandFromBudget` on this path, and let Undo restore the previous ceiling. Leave `cashBandFromBudget` alone for its other caller (the quiz backfill). Update the SI action knowledge drafts.
- **Test that would have caught it:** a steps test (new `src/lib/si-actions/steps.test.ts` on a pure export), "under £100k for a £30–60k member sets a £100k ceiling and leaves Buying cash as it was".
- **Merged from:** R6-4, R5-11.
- **Verification:** V-D, stands at Medium. R5-11's "about £180k" is too high: it is about £150k.

#### R4-08 · Low · SI's criteria tool lists retired fields and leaves out buy-to-let; SI cannot change Buying cash or setup cash

- **Where:** `src/lib/chat/tools.ts:171-175` (the list at :174); `src/lib/si-actions/config.ts:43` (CRITERIA_QUESTIONS); `src/lib/si-actions/validate.ts:96-101, 145-148`; `src/lib/knowledge/service-facts.ts:49`; `src/lib/knowledge/placeholders.ts:399-407`.
- **What:** the tool text says `add_deal_type / remove_deal_type short-let, brrr or rent-to-rent` (no buy-to-let), still names old fields, and CRITERIA_QUESTIONS has no Buying cash or setup cash. service-facts.ts:49 still says "the cash they can put in ({btl_cash_bands})", the retired BTL bands.
- **Example:** "my R2R setup cash is now £8k" cannot be done; "add buy-to-let deals" is less likely to be tried; the nightly drafter can draft the old bands.
- **Fix:** Zac's rule (19 Nov): SI may change Buying cash and R2R setup cash (each with Undo) plus the BTL priority; retired fields are removed. Add `cash_available`, `setup_budget` and `btl_priority` to CRITERIA_QUESTIONS with Undo; rewrite the tool text (add buy-to-let, drop the retired field names; "budget under £X" stays, as R4-07's price ceiling); re-draft service-facts.ts:49 to "their Buying cash". Knowledge drafts for what SI may change.
- **Test:** `validate.test.ts`, "change_criteria tool text names every TYPE_WORDS type"; `placeholders.test.ts`, "no SERVICE_FACTS line uses a retired question's placeholder (btl_cash_bands)"; an Undo case for a Buying cash change.
- **Merged from:** R2-6, R3x-6. **Verification:** V-D, narrowed: seed.ts is already fixed (`btl_add` at seed.ts:564 says Buying cash); only service-facts.ts:49 and the tool text remain.

#### R4-09 · Low · "Report ready" and SI's "already saved" go by deal; the purchase goes by listing inputs

- **Where:** `src/lib/analysis/saved-server.ts:41-58` (against :23-31); `src/lib/si-actions/validate.ts:224-230`; `src/lib/si-actions/plan-server.ts:74, 91`; `src/lib/analysis/deal-input.ts:80-82`.
- **What:** `reportReadyDealIds` reads by `deal_id` only (and only the first 200 ids); the purchase adds `.eq('input_key', inputKey)`. The key is built from the listing (postcode, bedrooms, guests…), not the price or the member.
- **Example:** a listing's bedrooms are corrected after it was analysed. A pack-only member with one fresh report left asks SI for two analyses; SI promises both, then the second is refused at start (`pack_cap`). Nothing is charged.
- **Fix:** use the per-key check in the SI planner only (a few ids), and page the 200-id slice. The card badge stays deal-only, as documented (§9).
- **Test:** `validate.test.ts`, with `saved` false on one deal and one fresh report left, two analyses produce a `pack_cap` drop.
- **Merged from:** R2-3, R4-5. **Verification:** V-C, stands at Low; both readers' examples refuted (price and finance are not in the key).

#### R4-10 · Low · A message that is only a link can show the model's own instructions

- **Where:** `src/lib/si-actions/link-server.ts:55-57`; texts from `src/lib/si-actions/plan-server.ts:121, 298`.
- **What:** the reply uses `plan.not_enough_credit` or `plan.note`, which are written for the model in the third person.
- **Example:** a new member with no credit pastes a Rightmove link and reads "It needs £0.40 and they don't have enough credit… A top-up offer shows under your answer."
- **Fix:** member-facing copy for the not-enough-credit and rate-limit cases, ideally in a pure `linkReplyText(plan)` helper.
- **Test:** new `src/lib/si-actions/link.test.ts`, "no link reply contains 'they', 'your answer' or 'tell them'".
- **Merged from:** R2-4. **Verification:** V-D, stands; the "switched off" case cannot be reached (link-server.ts:35 falls back to the normal chat).

#### R4-11 · Low · An SI analysis whose run request is lost is never asked for again

- **Where:** `src/components/intelligence/chat/ActionCard.tsx:155-180`; `src/lib/si-actions/run-server.ts:186-192, 351-361`.
- **What:** the hand-out is returned only in one `next` reply; if that reply is lost, the retry claims the next step instead, and the first fails `expired` after 12 minutes.
- **Example:** "analyse my top 3" on a flaky phone signal: one deal says "didn't finish". Its open was charged (the deal is open), but there is no report.
- **Fix:** show pending hand-outs (handed out, no `run_started_at`) in the card view so the card or a reload can run them; `claimDealAnalysisRun` already allows a safe re-run (deal-analysis.ts:455-470).
- **Test:** `src/lib/si-actions/view.test.ts`, "a handed-out analysis step with no run start appears as resumable".
- **Merged from:** R2-5. **Verification:** V-C, stands.

#### R4-12 · Low · Batch 27's drafted offer amount and feature summary skip the figure and advice guard

- **Where:** `src/lib/chat/tools-server.ts:355-362` (draft_message), `:366-370` (feature-request summary); compare `:382` where choices are checked; `src/lib/si-actions/draft-server.ts:51`.
- **What:** `input.offerAmount` goes straight into the draft (only checked to be above 0), and the summary is shown with no `checkFigures` or `adviceIn`.
- **Example:** "write my offer for the Leeds flat": the model passes £140k, which the member never said, and the draft carries it as their offer.
- **Fix:** carry the raw offer text through and drop the amount unless `checkFigures` finds it in the question; run `checkFigures` + `adviceIn` on the summary.
- **Test:** `src/lib/chat/tools.test.ts`, "an offer amount not in the question is dropped".
- **Merged from:** R1-7. **Verification:** V-B, stands; the fix needs the raw amount text, because `offerAmount` is already a number (tools.ts:287).

#### R4-13 · Low · The si-actions dry run caps each count at 1,000

- **Where:** `src/lib/si-actions/run-server.ts:519-526`.
- **What:** the dry run counts with `.limit(1000)`; the real run updates every matching row.
- **Example:** after an outage Zac runs `?dry=1` and sees "1000" where the run will expire more.
- **Fix:** `select('id', { count: 'exact', head: true })`, as R3-130 did. While there, check whether the real run's `update(...).select('id')` is also capped at 1,000 rows (code-only).
- **Test:** a source wiring test that the dry run uses `count: 'exact'`.
- **Merged from:** R8-4. **Verification:** V-B, stands.

### C. Starter pack (asleep on live: the pack is off and there are 0 pack-bonus grants)

#### R4-14 · Medium · A refunded or charged-back further payment lifts the starter-pack bonus for good

- **Where:** `supabase/schema.sql:8204-8212` (`member_paid_again_at`), `:8256-8260` (the unlock), `:8270-8282` (the trigger), `:8484-8488` (`pack_paying_facts`); refund paths `src/lib/stripe/webhook.ts:773` (`refundTopup`) and `src/lib/stripe/deps.ts:137-139`; `src/lib/meta/conversions.ts:316-336`.
- **What is wrong:** any payment row of kind top-up, auto top-up or subscription above £0 lifts the bonus (`scope_lifted_at = now(), expires_at = null`). `member_paid_again_at` never reads `member_refunds`, and nothing undoes the lift on a refund or dispute. The refund claws back only the top-up's own credit.
- **How a member or Zac hits it:** a pack buyer tops up the smallest amount, then disputes the charge or asks for a refund. Their £20 bonus now pays for fresh reports, Deep reports, calls and anything else, and never expires. "Pack → paying" and RepeatPurchase count them as paying again.
- **Smallest fix:** Zac's rule (19 Nov): a refunded or charged-back payment no longer counts as paying again. The bonus is re-restricted (if not expired) and the member is pack-only again. In schema.sql, make `member_paid_again_at` (and so `pack_paying_facts`) ignore fully refunded or disputed payments, and on a refund or dispute with no other qualifying payment left, put `scope_lifted_at` back to null with the bonus's original expiry (worked out again from its start and `pack_bonus_expiry_days`, because the lift cleared it); if that date has passed, it expires. A RepeatPurchase already sent to Meta cannot be taken back. Update the `pack_bonus` knowledge draft.
- **Test that would have caught it:** a `pack-smoke.sql` case: buy the pack, top up, refund in full (`member_refund_set`), then the bonus is restricted again, `member_paid_again_at` is null, and Pack → paying does not count the member.
- **Merged from:** R4-4.
- **Verification:** V-C, stands at Medium (a deliberate small top-up plus chargeback turns £20 of "costs us nothing" credit into unrestricted credit).

#### R4-15 · Medium · The £5 "what next" decision is held day after day when no morning email is built

- **Where:** `src/lib/credit/pack-rules.ts:177-179, 196-201`; `src/lib/credit/pack-offer-server.ts:66, 79, 83`; `src/lib/credit/low-credit-server.ts:128-130`; `src/lib/credit/after-debit.ts:143-145`; `src/lib/notify/message.ts:505, 536`; `src/lib/notify/digest-run.ts:381-397`.
- **What is wrong:** whether a member "has a morning email" is guessed from settings (`return f.due && f.dailyEmails;`), not from whether one was built. `buildDaily` returns nothing on an empty day (`if (dealCount === 0 && !changes && saved.length === 0) return null;`), and the £15 offer is never sent on its own. So the £5 decision stays held, and the low-credit call and nudge return early too.
- **How a member or Zac hits it:** a pack-only member runs out of credit on the morning Today's 5 cannot be funded. With no picks, no email is built. They get no £15 offer, no £5 decision and no call, and the same happens every day until some email happens to go.
- **Smallest fix:** Zac's rule (19 Nov): when nothing else is going, the £15 offer goes as its own email; the £5 decision follows the next day as designed. In the digest's fallback (digest-run.ts:381-397), when no daily email is built and the offer is due, send the offer alone and stamp it emailed; the existing same-day rule then holds the £5 decision to the next day. Update the pack knowledge drafts (the offer may come on its own).
- **Test that would have caught it:** a `src/lib/credit/pack-rules.test.ts` or digest test: "no daily email built and the offer due: the offer goes alone; the next day the £5 decision goes".
- **Merged from:** R4-2.
- **Verification:** V-C, stands at Medium; worst on the morning credit runs out, because unfunded picks mean no email.

#### R4-16 · Low · The digest swaps the £5 decision for the £15 offer but records the £5 decision as sent

- **Where:** `src/lib/notify/digest-run.ts:365, 454-456`; `src/lib/notify/message.ts:513`; `src/lib/credit/pack-offer-server.ts:66`.
- **What:** `const creditNote = input.packOffer ?? input.lowCredit ?? null;` keeps one note, but both are stamped after the send (`if (lowNotices.has(p.id)) await markLowCreditTold(...)`).
- **Example:** a pack-only member whose picks were paused after 7 days away tracks one deal. The change email carries only "Keep your bonus"; the £5 decision is marked told, so no call or nudge goes that cycle.
- **Fix:** `if (lowNotices.has(p.id) && !packOffers.get(p.id)?.due) await markLowCreditTold(...)`, and correct the comment at :365.
- **Test:** `src/lib/notify/message.test.ts`, "buildDaily with both packOffer and lowCredit carries only the offer", plus a stamp test from the sections that went.
- **Merged from:** R4-1. **Verification:** V-C, lowered to Low (a narrow group on one day).

#### R4-17 · Low · A failed analyser report that charged anything keeps its fresh-report slot

- **Where:** `src/lib/analysis/run.ts:229-234`; the written rule at `src/lib/credit/pack-rules.ts:37-39`.
- **What:** `if (!(await actionAlreadyCharged(actionId).catch(() => true))) await releaseFreshReport(actionId);`, so a run that fails after some paid provider calls keeps the slot.
- **Example:** a pack-only member's analyser report times out partway. They have used 1 of 3 fresh reports with nothing to show.
- **Fix:** Zac's rule (19 Nov): a report that fails gives its fresh-report slot back, even if part was charged. Pass the outcome to `finish` and release when the run did not complete; update the pack-rules.ts:37-39 comment and the `pack_fresh_reports` knowledge draft.
- **Test:** `pack-smoke.sql`, "claim, a partial debit on that action id, release".
- **Merged from:** R4-7. **Verification:** V-C, stands; it matched the written rule, which Zac has now changed.

#### R4-18 · Low · A payment made just before the bonus expires but recorded after it lets the bonus expire

- **Where:** `src/lib/payments/server.ts:29-33`; `src/lib/payments/rules.ts:59`; `supabase/schema.sql:5386, 8258-8260, 1040-1043`.
- **What:** `paid_at` is the insert time (`default now()`), not Stripe's payment time.
- **Example:** a member pays through Checkout at 23:58 on the expiry day; the webhook lands at 00:03; the £20 bonus is written off.
- **Fix:** pass Stripe's time (`pi.created`, or the invoice's `status_transitions.paid_at`) as `paid_at`.
- **Test:** a `pack-smoke.sql` case with `paid_at` before expiry and the row inserted after; a payments rules test that `paymentFromIntent` carries the time.
- **Merged from:** R4-3. **Verification:** V-C, stands. Possible 31a overlap: `src/lib/stripe/webhook.ts`, non-academy lines only.

#### R4-19 · Low · A pack buyer on a plan trial keeps a restricted, expiring bonus with no explanation

- **Where:** `src/lib/credit/pack-rules.ts:93-96`; `src/app/account/billing/page.tsx:54`; `src/app/account/usage/page.tsx:61`; `src/lib/credit/low-credit-server.ts:85`; `src/lib/analysis/deal-analysis.ts:346`.
- **What:** every explanation is gated on `packOnly`, and a trial member is not pack-only, though their bonus stays restricted.
- **Example:** a member buys the pack and starts a Starter trial. Billing shows £30, a fresh report says "not enough credit" with no reason, and £20 disappears on day 30.
- **Fix:** show the bonus line and the bonus-only text whenever the restricted bonus is above £0 (`bonusPence > 0`); the knowledge `showWhen` may need a "has restricted bonus" condition (draft).
- **Test:** `pack-rules.test.ts`, a `bonusLineFor(state)` helper gives a trial member with a bonus a line.
- **Merged from:** R4-6. **Verification:** V-C, stands. **31a overlap:** `src/app/account/billing/page.tsx` and `src/app/account/usage/page.tsx` (31a minimal-touch). List every line changed, or leave the account-page wording to 31a.

#### R4-20 · Low · The Places cache keeps an empty answer for 90 days

- **Where:** `src/lib/apis/google-places.ts:106-112, 154-156`.
- **What:** `const places = data.places ?? []` is cached after any successful reply, empty or not, for every property in the ~100m grid cell.
- **Example:** one odd empty reply means "no stations nearby" for 90 days for everyone in that cell.
- **Fix:** give empty answers a short cache time. Do not stop caching them: a genuinely empty answer is common and saves paid calls.
- **Test:** `src/lib/apis/google-places.test.ts`, "an empty answer is cached with the short time".
- **Merged from:** R4-8. **Verification:** V-C, stands; the reader's "never cache empty" fix corrected.

#### R4-21 · Low · RepeatPurchase can be lost when two further payments land together

- **Where:** `src/lib/meta/conversions.ts:316-336`.
- **What:** each payment treats any other payment since the pack as "earlier", so two at once each see the other.
- **Example:** a chosen top-up and an auto top-up are processed together; neither sends RepeatPurchase; Meta loses one conversion.
- **Fix:** the earliest wins: compare `paid_at` / `created_at`, tie-break on id.
- **Test:** `src/lib/meta/events.test.ts`, "two payments 1s apart: only the first is a RepeatPurchase".
- **Merged from:** R4-9. **Verification:** V-C, stands.

### D. Buy-to-let (card, list and standout bugs asleep until `BTL_SCREEN_ENABLED=true`)

The worked member used here ("Member A"): new sign-up, ticks Buy to let, Buying cash "£30–60k", mortgage. The deal: a £175k 3-bed house. BTL cash in = 25% deposit £43,750 + stamp duty £9,750 + buying costs £2,500 = **£56,000**. Short-let cash for the same house adds furnishing (£16,500) = **£70,000**.

#### R4-22 · Medium · The BTL cash ceiling is the exact Buying cash on Today, but one band lower for standout, what-if, benchmark and the £2 report

- **Where:** `src/lib/btl/today.ts:175-177, 202, 204`; `src/lib/standout/rules.ts:141`; `src/lib/standout/run.ts:385-389`; `src/lib/intelligence/what-if.ts:240-248`; `src/lib/btl/report-server.ts:251`; `src/app/deals/[id]/page.tsx:288`; `src/lib/profile/buying-power.ts:68-84`; `src/lib/btl/config.ts:133`.
- **What is wrong:** the Buying cash answer writes the BTL band one step down (`case '30-60': return '25k_50k';`). Batch 30 changed only Today to use the exact top; standout still says `if (i.btl.cashBand && !inBudget(c.cashIn.mid, i.btl.cashBand, i.btl.bands)) return no('btl_over_budget', false);`, the what-if uses the band with built-in tops, and the benchmark and report read the lower band.
- **How a member or Zac hits it:** Member A's £56,000 deal is on BTL Today (≤ £60,000). It can never be a standout or a standout email (`btl_over_budget`), the what-if leaves it out, and it is compared with the typical £25k–£50k deal although it sits in the £50k–£100k band; the £2 report says the same.
- **Smallest fix:** Zac's rule (19 Nov): the exact Buying cash top everywhere; the benchmark compares with the band that contains that top. One helper, e.g. `btlCashTop(goals, bands)` in `src/lib/btl/deal.ts` (`buyingCashTop(goals) ?? the band's top`), used by today.ts, standout run.ts/rules.ts, what-if (with Zac's bands, not the built-in ones) and the report; the benchmark band is the one containing the top. Update the BTL knowledge drafts.
- **Test that would have caught it:** `src/lib/btl/standout.test.ts`, "Buying cash 30-60: cash in £56k is not over budget"; `what-if.test.ts`, "btlAdmissible keeps a £56k deal for 30-60"; `src/lib/btl/today.test.ts`, "Today and standout agree on the ceiling for every Buying cash answer".
- **Merged from:** R3x-4, R5-4, R6-1.
- **Verification:** V-D, stands at Medium (R3x-4 raised from Low). Two of the five Buying cash answers disagree, and £100–200k disagrees the other way.

#### R4-23 · Medium · Browse judges BTL deals on the short-let cash and profit checks

- **Where:** `src/lib/tailoring/browse.ts:100, 148-166`; `src/lib/tailoring/criteria.ts:79, 419-420, 474, 477`; `src/lib/listing/deal.ts:163-165`.
- **What is wrong:** Browse runs every row through `judgeDeal`, and `checksFor` has no BTL branch: `if (w.cashTop !== null) push('cash', atMost(fig.cashRequired, w.cashTop));`, where `fig.cashRequired` is the short-let purchase with furnishing. The short-let profit check runs too.
- **How a member or Zac hits it:** Member A's £175k 3-bed is on BTL Today at £56,000. On Browse its short-let cash is £70,000 > £60,000, so the card says "Misses: Cash available" and it drops out of "picked for you".
- **Smallest fix:** carry the BTL cash in on the deal facts (`factsFromRow` does not today); in `checksFor`, when the deal is judged as BTL, use it for `cash` and skip the short-let profit check. Use R4-22's helper so the ceiling matches Today. No rule needed.
- **Test that would have caught it:** `src/lib/tailoring/browse.test.ts`, "a row judged as BTL uses its BTL cash in (no 'Misses' on a £56k deal for 30-60)".
- **Merged from:** R6-2.
- **Verification:** V-D, stands at Medium.

#### R4-24 · Medium · "Buy to let instead?" in the analyser, Explorer and what-if uses built-in defaults and leaves out a flat's service charge

- **Where:** `src/lib/btl/analyser.ts:17, 51-52, 61`; `src/components/report/BuyToLetInstead.tsx:4, 21` (imported by the client page `src/app/estimate/page.tsx:1, 113`); `src/app/api/explorer/btl/route.ts:20`; `src/lib/btl/explorer.ts:33, 37`; `src/lib/intelligence/what-if.ts:246`.
- **What is wrong:** `const s = DEFAULT_BTL_SETTINGS; … buyingCosts: DEFAULT_PROJECT_COSTS.buyingCosts, flat: null, …` (and `kind: 'unknown'`). The deal cards read Zac's saved settings and add a flat's service charge and ground rent; the analyser does neither. The Explorer always uses a 75% loan.
- **How a member or Zac hits it:** a member opens a flat with no listed charges: the deal page shows £40–£180 a month (with the default £1,500 service charge and £150 ground rent a year). Their Full analysis of the same flat says "Buy to let instead?" about £137 a month higher. Or Zac sets the agent fee to 15%: cards change that night, the analyser stays on 12%. This path is worked out when the analysis runs, not by the nightly screen (code-only).
- **Smallest fix:** work out the BTL figure on the server where the analysis is built (`src/lib/analysis/run.ts`), with `readBtlSettingsCached` and `flatCharges(listingKind(...))`, and attach it to the result; BuyToLetInstead then only shows it. In the Explorer route, pass the saved finance to `btlDistrictRows` (one line). The what-if gets Zac's bands with R4-22.
- **Test that would have caught it:** `src/lib/btl/analyser.test.ts`, "a flat's analyser figure includes the service charge, as the screen does" and "it uses the settings it is given (15% agent fee changes cashflow)"; `src/lib/btl/explorer.test.ts`, "cash in follows a 70% loan setting".
- **Merged from:** R3x-1, R6-10.
- **Verification:** V-D, stands at Medium (R6-10 raised from Low). The reader's fix ("read settings in BuyToLetInstead") is wrong: it is a client component and the settings read is server-only.

#### R4-25 · Medium · BTL Today reads 400 deals sorted by short-let profit before the cash ceiling

- **Where:** `src/lib/btl/today.ts:43, 202-205, 212-213, 219`; `src/lib/today/choose-day.ts:55`; `src/lib/marketplace/queries.ts:163, 284`; `src/lib/btl/screen-server.ts:405-408`.
- **What is wrong:** `BTL_POOL_LIMIT = 400`, and the pool is forced to `sort: 'profit'`, i.e. `order('annual_profit', desc)` on the short-let profit. BTL-only deals have a weak short-let profit, so they sort last, and the cash and benchmark tests run only on the 400 that survive.
- **How a member or Zac hits it:** a BTL-only member searches "anywhere" (or London) with Buying cash "Under £30k". Once more than 400 sales pass the BTL screen, the 400 read are the best short-lets (usually dearer homes), most fail the £30k ceiling, and Today shows 0–2 BTL deals while cheaper passing deals sit further down (code-only: depends on volumes once the switch is on).
- **Smallest fix:** Zac's rule (19 Nov): apply the cash ceiling before the 400 cap; keep the current order otherwise. Filter the pool query on the stored BTL cash in at or below the member's ceiling (R4-22's helper), or on a maximum price worked back from it, so all 400 are affordable.
- **Test that would have caught it:** `today.test.ts`, "with 500 passing rows, an in-budget deal ranked 450th by short-let profit is still picked".
- **Merged from:** R3x-2.
- **Verification:** V-D, stands at Medium (code-only).

#### R4-26 · Medium · BTL cards show "Value in 5 years" with no "history, not a forecast" and no "before tax"

- **Where:** `src/lib/marketplace/card-view.ts:236`; `src/app/deals/_components/DealCard.tsx:108-112`; `src/app/deals/_components/BuyToLetSection.tsx:36-38`; `src/lib/btl/card.ts:193, 197-203, 223`.
- **What is wrong:** the help text is written ("…History, not a forecast.", "…before tax.") and then stripped before the card renders: `numbers: btl.numbers.map((n) => ({ ...n, help: null })),`. The deal page's top numbers drop it too.
- **How a member or Zac hits it:** a member who chose "Value going up" sees "Value in 5 years £212,000–£246,000" as the second number on every Today card and on the unopened deal page, with nothing saying it is past growth repeated. The spec says growth is history only, never a forecast, and every figure is before tax.
- **Smallest fix:** keep `help` for BTL numbers in the card view, and pass `sub={n.help}` to `Fig` in BuyToLetSection.
- **Test that would have caught it:** `src/lib/marketplace/card-view.test.ts`, "a BTL card's Value in 5 years carries 'History, not a forecast'".
- **Merged from:** R3x-3.
- **Verification:** V-D, stands at Medium; no comment marks the strip as deliberate.

#### R4-27 · Medium · BTL standouts skip R3-52's "beats everything shown" bar

- **Where:** `src/lib/standout/rules.ts:137, 206-207, 256-264`; `src/lib/standout/run.ts:494-495, 501, 513`; `src/lib/standout/rules.test.ts:244-248`.
- **What is wrong:** `bestAtLeast` skips every entry when the candidate has no match %:
  `if (k.profitLow === null || k.matchPct === null || matchPct === null || k.matchPct < matchPct) continue;`
  A BTL candidate always has `matchPct: null`, so there is never a bar to beat. Batch 28's comment "sets the buy-to-let bar" does nothing.
- **How a member or Zac hits it:** a BTL investor was shown and kept a £420-a-month deal on Monday. On Wednesday a £180-a-month deal passes the BTL standout test, is saved as a standout and gets the per-minute deal call or "Saved for you", though it is worse than one they already have.
- **Smallest fix:** Zac's rule (19 Nov): a BTL standout must beat the BTL deals already shown on low-end monthly cashflow; ignore entries with no deal type. In `bestAtLeast`, for a BTL candidate, compare only entries with `dealType === 'btl'` and ignore match %.
- **Test that would have caught it:** in `rules.test.ts`, `bestAtLeast([{matchPct:null, profitLow:420, dealType:'btl'}], null, 'btl') === 420`, and an entry with no type is ignored for 'btl'.
- **Merged from:** R1-2.
- **Verification:** V-B, stands at Medium; the reader's fix also had to skip entries with no type.

#### R4-28 · Low · The BTL benchmark's "widened" or "thin" notice shows only after Open

- **Where:** `src/lib/btl/sheet.ts:64-70`; `src/app/deals/[id]/page.tsx:287-294`; `src/lib/btl/today.ts:238-245`; `src/lib/btl/card.ts:245-255`.
- **What:** the benchmark words are built only when the deal is opened; cards, Today and email say nothing (Today's "widened" line is about the deal search).
- **Example:** in a thin area the "typical deal" is 12 deals across the UK; the member learns "treat it as a rough guide" only after paying to Open.
- **Fix:** a card flag from the benchmark Today already reads ("Compared across the UK" / "Few deals to compare"), and a matching Today/email line.
- **Test:** `src/lib/btl/card.test.ts`, "btlFlags names a national or thin benchmark".
- **Merged from:** R3x-5. **Verification:** V-D, stands.

#### R4-29 · Low · The £2 BTL report can sell a second copy if the "already have one?" read fails

- **Where:** `src/lib/btl/report-server.ts:152-154, 327-341`; `supabase/schema.sql:8096`.
- **What:** `reportIdsFor` returns null on a read error, but `const already = had?.values().next().value; if (already) …` treats null as "none", and the unique index covers only pending reports.
- **Example:** a member taps the button again from a stale tab during a database blip and pays £2 again for the same listing.
- **Fix:** `if (had === null) return fail('failed');` before the check.
- **Test:** `src/lib/btl/report.test.ts`, "runBtlReport refuses when reportIdsFor is null".
- **Merged from:** R7-4. **Verification:** V-C, stands.

#### R4-30 · Low · The £2 BTL report can overdraw when its hold silently fails

- **Where:** `src/lib/btl/report-server.ts:196-207, 286-290`; `supabase/schema.sql:863-868`.
- **What:** a reserve error other than "not enough credit" is only logged, the run goes on unheld, and the debit is always `allowNegative: true`.
- **Example:** the reserve call times out; the member's daily picks charge lands during the ~10-second run; the £2 debit overdraws by a few pence.
- **Fix:** when charges are enforced and the reserve threw anything, `finish('failed')` and `fail('failed')` before the run (no charge, no report). Not `allowNegative: !mustAfford`, which would give a free report instead.
- **Test:** `report.test.ts`, "after a reserve error, with charges enforced, the run stops before any provider call".
- **Merged from:** R7-5. **Verification:** V-C, stands; fix corrected.

#### R4-31 · Low · BTL settings and two cron previews have no admin control

- **Where:** `supabase/schema.sql` Batch 28 setting inserts; `src/lib/btl/config.ts`; `src/app/admin/deals/btl/page.tsx:150` (shows only `btl_launch_from`); README:1386-1387 (the SQL route); `vercel.json:214` and `src/app/admin/intelligence/actions/actions.ts:23` (the si-actions tidy has no Dry run or Run); `src/app/api/internal/credit-sweep/route.ts:33-40` (pack-expiry preview, no button).
- **What:** ten `btl_*` settings, including the £2 report price, can only be changed in SQL; the nightly si-actions tidy and the pack-expiry preview can only be run with `INTERNAL_API_SECRET`, which Zac cannot read.
- **Example:** Zac wants the BTL report at £3 or the lender stress rate at 6%: he needs a SQL edit.
- **Fix:** Zac's rule (19 Nov): an admin form for the £2 report price and the finance settings (loan-to-value, stress rate, rent cover); the rest stay SQL-only. Add Dry run / Run buttons (the #164 pattern) for the si-actions tidy on /admin/intelligence/actions, and the pack-expiry preview somewhere other than /admin/billing (31a owns it), e.g. /admin/weekly-active or /admin/profiles.
- **Test:** an admin action test like #164's for each button (Dry run calls with `apply: false`; the action requires an admin).
- **Merged from:** M-2, R7-8. **Verification:** V-B, stands.

### E. Build and code health

#### R4-32 · Low · A local `npm run build` stops at Next.js 16.4.1's security gate; CI never builds

- **Where:** `package.json:28` (`"next": "16.4.1"`, set in R3n) and `:45` (eslint-config-next); `.github/workflows/ci.yml` (no build step); build log line 287.
- **What is wrong:** after `✓ Compiled successfully` and `✓ Generating static pages (92/92)`, the build exits 1: `Error [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.` A retry fails the same way. CI runs lint, typecheck and tests but not the build, so CI stays green.
- **How a member or Zac hits it:** Zac or a Claude session runs `npm run build` before a release and it fails. Vercel is not affected: this PR's preview built and deployed on 19 Nov 2026 on the same version (deployment `5EWeNn7RsWBXyKvkw4a8utvyYVQ5`, "Build Completed"). No member meets it.
- **Smallest fix:** bump `next` and `eslint-config-next` to 16.4.6 (non-major) and add `npm run build` to the CI checks job. Rides in r4a.
- **Test that would have caught it:** the CI build step itself.
- **Merged from:** M-1.
- **Verification:** mechanical pass, re-run once with the same failure. Lowered from Medium to Low after the Vercel preview build of this PR succeeded.

#### R4-33 · Low · The rate sync could overwrite a member's chosen rate before the backfill (did not happen on live)

- **Where:** `src/app/api/internal/market-warm/route.ts:67`; `src/lib/listing/live-rate-sync-server.ts:11-22`; `supabase/schema.sql:8550-8590`; `src/lib/profile/quiz-v2-backfill.ts:99-107`; `src/app/admin/profiles/page.tsx` (the "Run it before 7am UK" text).
- **What:** the backfill keeps a member's rate only if no average was synced yet (`const keepRate = !f.rateSet && f.rateAsOf === null && chose;`), and the 04:45 sync checks nothing first.
- **Example:** in a future re-run, the sync lands before Run and a member's typed 6.2% becomes the average for good. On live it did not happen: the first sync was on 19 Nov 2026, after the backfill; one member had a real pre-Batch-30 rate answer, it is marked as theirs, and none was lost.
- **Fix:** a "backfill done" stamp in billing_settings that market-warm waits for; correct the admin text "before 7am UK" to "before 04:45".
- **Test:** `src/lib/listing/live-rate-sync.test.ts`, "no sync until the backfill stamp exists".
- **Merged from:** R5-1, R7-1. **Verification:** V-A said it stands as High if the live check found losses; the coordinator's SELECTs found none, so Low.

#### R4-34 · Low · Seven Critical/High and 24 Medium R3 fixes have no test

- **Where:** R3-3 `src/app/welcome/reveal/page.tsx:57-67` + view-server.ts:163; R3-4 `src/app/reports/[id]/page.tsx:48-49` + `src/lib/analysis/pmi-addon.ts:97`; R3-7 QuickChat.tsx:99 / FullChat.tsx:155; R3-11 `src/lib/briefing/runner.ts:127`; R3-14 `src/lib/voice/queue-server.ts:188`; R3-16 runner.ts:215-316; R3-18 `supabase/schema.sql:6762-6767`. The 24 Mediums are listed in §5.1.
- **What:** R3 §7 named a test for each; none was written. Batch 29 has already edited view-server.ts and the report page.
- **Example:** a later edit prices the PMI label from `quoter.pricing.pmiAddonPence` again; the member sees £2, taps, and is refused at £1 (R3-4 again), and CI stays green.
- **Fix:** one test each (V-B): a source-order test that `beforePricing` runs before `offerPricingFor`; a wiring case that the report page and pmi-addon.ts both price from `offeredPmiAddonFor`; `spokenFor(reply)` speaking only answers; the briefing probe giving `schemaMissing`; `lowCreditStillDue`'s decision made pure; `mayRelease({charged, reclaimed, dry})`; a credit-smoke case that a management profile stays off after the backfill.
- **Test:** the tests above are the fix.
- **Merged from:** R1-1, R1-9. **Verification:** V-B, lowered to Low (code health; nothing wrong for a member today).

#### R4-35 · Low · R3-111 deferred: a crash between the briefing's two meter calls leaves one part unpaid

- **Where:** `src/lib/briefing/runner.ts:214, 225-229, 355-356`.
- **What:** output and input are metered separately; a reclaim that sees any charge meters nothing more.
- **Example:** the route is killed after the output debit; the input tokens (about a third of the 3p) are never charged.
- **Fix:** meter only the missing unit under the action id, or accept it as a decision (§9).
- **Test:** `src/lib/briefing/once.test.ts`, "output already on the ledger: only input is charged".
- **Merged from:** R1-3. **Verification:** V-B, stands (also a decision to confirm).

#### R4-36 · Low · Approving a knowledge entry closes gaps left open for a missing channel

- **Where:** `src/lib/knowledge/store-server.ts:221-223`; `src/lib/knowledge/gap/run.ts:144-148`.
- **What:** approval marks every linked gap covered (`.eq('entry_id', o.id).neq('status','dismissed')`), whatever channels the entry has; rejected and failed gaps flip too.
- **Example:** "why did you call me" is grouped onto a chat-only entry; Zac fixes a typo and approves; the gap reads covered and the phone agent still doesn't know.
- **Fix:** close only gaps whose questions' channels pass `coversChannels`; leave rejected and failed gaps alone.
- **Test:** `src/lib/knowledge/gap/plan.test.ts`, a pure `gapsToClose(...)` case.
- **Merged from:** R1-4. **Verification:** V-B, stands.

#### R4-37 · Low · One quick-answer path logs activity with no dedupe key

- **Where:** `src/lib/chat/quick-server.ts:96` (compare :214).
- **What:** `logActivity(user.id, 'si_chat_quick', { extras: { outcome: 'answered' } })` has no `dedupeKey`.
- **Example:** two "doesn't apply to your account" answers within 60 seconds: the second is dropped by the identical-event rule (schema.sql:2892-2895).
- **Fix:** add `dedupeKey: \`si_chat_quick:${turn.id}\``.
- **Test:** a source wiring test that every `si_chat_quick` log in quick-server.ts carries a key.
- **Merged from:** R1-5. **Verification:** V-B, stands.

#### R4-38 · Low · `npm audit` lists 4 high again

- **Where:** `package.json:21, 28, 32`; package-lock.json.
- **What:** shadcn, @shadcn/registry, zod below 4.6.6 and body-parser 2.0–2.3 are high; next 16.4.1 is moderate (fixed in 16.4.6). All new advisories since R3n.
- **Example:** no member path is known; it is a dependency exposure.
- **Fix:** with R4-32, bump next to 16.4.6, then `npm audit fix` (no `--force`, non-major only).
- **Test:** optionally a CI `npm audit --omit=dev --audit-level=high` step.
- **Merged from:** R1-6. **Verification:** V-B, stands (re-run: 4 high, 9 moderate).

#### R4-39 · Low · Two fix PRs and three code comments name the wrong R3 ids

- **Where:** commit bodies 4d2c199 (says R3-61, means R3-73) and 4bf68be (says R3-28/R3-69, means R3-31/R3-84); `src/components/intelligence/chat/voice.ts:89, 340` ("R3-9" for R3-8); `src/app/api/chat/listen/route.ts:89` ("R3-69" for R3-84).
- **What:** anyone tracing an id lands on the wrong finding.
- **Example:** Zac checks "is R3-69 fixed?" and finds a listen-route comment, not the post-call secret fix.
- **Fix:** correct the three comments and note the right ids in README §26.
- **Test:** none needed.
- **Merged from:** R1-8. **Verification:** V-B, stands.

#### R4-40 · Low · Old R2R setup answers re-read as new bands; a failed mode write is never retried

- **Where:** `src/lib/tailoring/criteria.ts:87-88`; `src/lib/market/goals.ts:193, 444`; `src/lib/profile/quiz-v2-backfill.ts:85`; `src/lib/profile/quiz-v2-backfill-run.ts:95-98, 141`.
- **What:** old bands are re-read on every load (`'10k+'` becomes `'10-15k'`, top £15k); the backfill writes the goals before the mode, and a failed mode write only logs a warning, so the next run cannot find it.
- **Example:** an older "£10k+" member with no profile row kept setup as a must-have and lost every 3-bed+ rental. On live, 0 old bands are left, and R4-02's rule makes setup a nice-to-have for everyone.
- **Fix:** write the mode before (or with) the goals. Whether "£10k+" should map to "£20k+" was not asked separately; with setup only ranking, the fix does not need it.
- **Test:** `criteria.test.ts`, "an old £10k+ setup answer adds no must-have".
- **Merged from:** R5-2. **Verification:** V-A, lowered to Low.

#### R4-41 · Low · Older R2R-only and BTL-only members get new unanswered questions

- **Where:** `src/lib/profile/questions.ts:546-556, 872, 882-889`; `src/lib/profile/state.ts:136-150`; `src/lib/tailoring/criteria.ts:84, 197, 480`.
- **What:** `property` (and for BTL-only, `min_profit`) is now asked of everyone, so older complete members drop below 100%; for an R2R-only member the flat/house answer changes nothing (the type check is sale-only).
- **Example:** an R2R member who finished the old quiz sees "Profile 89%" again, is asked "What kind of property?", and the "Flat" they pick does nothing.
- **Fix:** count `property` as answered for older complete members; hide flat/house for R2R-only members, or say it only affects purchases.
- **Test:** `src/lib/profile/state.test.ts`, "an R2R-only member complete before Batch 30 stays complete".
- **Merged from:** R5-9. **Verification:** V-A, stands (correction: answering `property` does write the old mark).

#### R4-42 · Low · "Use today's average" with an empty rate cache keeps the member's rate but labels it the average

- **Where:** `src/lib/profile/server.ts:288-291`; `src/lib/profile/questions.ts:1137-1140`; `src/lib/marketplace/card-display.ts:33-38`.
- **What:** `mortgageRatePct: today?.ratePct ?? finance.mortgageRatePct, useAverage: true`, so with no cached rate the old figure stays under the "average" label.
- **Example:** the cache is empty; a member taps "Use today's average"; the line changes, the figures don't.
- **Fix:** if there is no cached rate, refuse with "Today's average isn't available yet" and change nothing.
- **Test:** a pure helper for the value, "no cached average: refuse".
- **Merged from:** R5-10. **Verification:** V-A, stands.

#### R4-43 · Low · Older members' Buying cash row reads "Not answered yet"; never filled for BTL-only members

- **Where:** `src/app/profile/page.tsx:176, 186`; `src/lib/profile/questions.ts:883, 1353-1354`; `src/lib/profile/state.ts:119-124`; `src/lib/profile/quiz-v2-backfill.ts:88-96`.
- **What:** progress counts the old answer, but the row reads the new field, which is empty; the backfill fills cash from a budget only, never from the BTL band.
- **Example:** an older BTL member opens their profile: Buying cash says "Not answered yet" while their BTL band still filters.
- **Fix:** in the backfill, map the BTL band to a worked-out Buying cash band.
- **Test:** `quiz-v2-backfill.test.ts`, "a BTL-only member with a BTL band gets a worked-out Buying cash".
- **Merged from:** R5-12. **Verification:** V-A, stands (it reads "Not answered yet", not blank).

#### R4-44 · Low · One Buying cash answer is costed three ways and adds two must-have checks

- **Where:** `src/lib/profile/buying-power.ts:27-30`; `src/lib/tailoring/criteria.ts:204, 208, 419, 472-474`; `src/lib/tailoring/behaviour.ts:184-194, 187, 238`; `src/lib/profile/questions.ts:1079-1086`.
- **What:** the "I've noticed" nudges cost a deal with a 2-bed's furnishing and a 25% deposit, while the filter uses the deal's bedrooms and the member's deposit; and the cash answer also writes a budget, so the member gets a budget must-have and a cash must-have from one answer.
- **Example:** three kept £150k 4-bed deals: the filter says each needs £65,500 (> £60k), the nudge counts £58,500, so the nudge never fires. A £0–30k member accepts "make Buying cash a nice-to-have", but deals over £100k stay hidden by the budget check.
- **Fix:** behaviour.ts uses the same `memberFigures(...).cashRequired` as the filter; `wantsFor` skips the budget check when the budget was written by the cash answer (an explicit price ceiling from R4-07 still applies). The missing `country` in `purchaseDeal` predates this scope: log it separately.
- **Test:** `behaviour.test.ts`, "the cash nudge counts the same cash as the filter"; `criteria.test.ts`, "a Buying cash answer adds one check, not two".
- **Merged from:** R6-3, R6-8. **Verification:** V-A (R6-3 lowered to Low; R6-8 stands).

#### R4-45 · Low · Several new rules and limits have no SI knowledge entry

- **Where:** `src/lib/knowledge/seed.ts` (Batch 27–29 blocks); `src/lib/knowledge/placeholders.ts:266`; `src/lib/knowledge/service-facts.ts:34, 55, 89`; `supabase/schema.sql:7979-7988`.
- **What:** no draft answers the £15 one-off offer, SI's hourly/daily/target limits, or the Explorer and analyser "Buy to let" views (the CLAUDE.md Batch 24 rule).
- **Example:** a pack member sees the Home offer and asks "what's this offer?": no approved answer, so it becomes a gap.
- **Fix:** draft entries `pack_early_offer`, `si_actions_limits`, `btl_explorer`, and placeholders for the four `si_action_*` limits.
- **Test:** `seed.test.ts`, "every service-facts placeholder is used by at least one seed entry".
- **Merged from:** R7-2. **Verification:** V-B, stands.

#### R4-46 · Low · service-facts.ts types two figures the nightly drafter can copy

- **Where:** `src/lib/knowledge/service-facts.ts:49` ("at the typical 2–3-year fixed rate"), `:86` ("a few pence").
- **What:** the facts the gap job drafts from break the "every figure is a placeholder" rule; approval's number check (figures.ts:22) stops a draft carrying digits from reaching members.
- **Example:** the job drafts a BTL rate answer saying "2–3-year"; Zac cannot approve it without editing.
- **Fix:** drop "2–3-year" (done in r4c with R4-08's rewrite of line 49); use a placeholder for "a few pence".
- **Test:** widen `seed.test.ts:73` to run the blocking number check over SERVICE_FACTS.
- **Merged from:** R7-6. **Verification:** V-B, stands.

#### R4-47 · Low · One index is dropped and rebuilt on every schema run

- **Where:** `supabase/schema.sql:7598-7599`.
- **What:** `drop index if exists public.si_calls_log_deal_uidx;` then `create unique index if not exists …`, the only unguarded drop in the file.
- **Example:** Zac re-runs schema.sql in the day; the 5-minute calls cron's inserts wait on the rebuild.
- **Fix:** guard it with a `pg_indexes` check on the new definition.
- **Test:** a schema re-run check that the index's oid is unchanged.
- **Merged from:** R7-7. **Verification:** V-B, stands.

#### R4-48 · Low · Two new SQL functions have no database smoke test

- **Where:** `supabase/tests/*.sql` (0 references to `btl_apply_screen` or `sync_live_mortgage_rate`); `.github/workflows/ci.yml`.
- **What:** the function that writes every deal's BTL lens and the one that writes members' rate each night are checked only as text in unit tests.
- **Example:** an edit breaks the `rateSet <> 'true'` guard; members' own rates are overwritten and CI stays green.
- **Fix:** a `btl-smoke.sql` (or credit-smoke.sql block) that calls each on seeded rows and checks the result.
- **Test:** the smoke file is the fix.
- **Merged from:** M-3. **Verification:** mechanical pass.

#### R4-49 · Low · A Stripe hiccup while looking up a customer creates a second customer

- **Where:** `src/lib/stripe/customer.ts:35-50`; `src/app/api/billing/topup/route.ts:70-77, 104-107`.
- **What:** `catch { /* fall through and create */ }` treats any error as "customer gone", then creates and stores a new one.
- **Example:** a member with a saved card taps Top up during a Stripe 5xx: a new empty customer is stored and the one-click card stops working (they fall back to Checkout).
- **Fix:** create only on `resource_missing` (or a deleted customer), rethrow other errors, and pass `idempotencyKey: customer:<id>` to create.
- **Test:** new `src/lib/stripe/customer.test.ts` with a fake Stripe: a 500 rethrows and creates nothing; `resource_missing` creates once.
- **Merged from:** R8-3. **Verification:** V-B, stands; seven callers (not five), and the reader's "only when null" guard was wrong. Pre-existing. **31a overlap:** customer.ts (31a minimal-touch): narrow fix in r4f, or leave to 31a.


## 5. Gap check: what was asked against what is on main

"Built" = there as asked. "Partly" = there, with a gap named in the row. "Missing" = not there. Line numbers are at `8bdbf9d`.

### 5.1 Review R3's fixes (all 154 ids)

| Result | Count | Ids |
|---|---|---|
| Fixed at HEAD and still in place | 148 | appendix B |
| Partly fixed | 5 | **R3-1** (fixed in code; members hear the old answer until Zac approves `chat_voice`), **R3-75** (minutes only, by choice), **R3-17** (narrowed by Q5, by design), **R3-111** (deferred in the PR, **R4-35**), **R3-91** (one path missed, **R4-37**) |
| Fixed but bypassed by a later batch | 1 | **R3-52**: Batch 28's BTL standouts skip the bar (**R4-27**) |
| Missing | 0 | — |
| Critical/High fixes with no test | 7 of 19 | R3-3, R3-4, R3-7, R3-11, R3-14, R3-16, R3-18 (**R4-34**) |
| Medium fixes with no test | 24 | R3-31, R3-68, R3-62, R3-70, R3-61, R3-59 (stamp part), R3-26, R3-44, R3-45, R3-49, R3-24, R3-22, R3-60, R3-51, R3-53, R3-55, R3-71, R3-19, R3-58, R3-69, R3-28, R3-29, R3-42, R3-39 (**R4-34**) |
| Commit bodies naming the wrong id | 2 | r3a (R3-61 for R3-73), r3b (R3-28/R3-69 for R3-31/R3-84) (**R4-39**) |

R3-72 (the dependency bump) was right when it merged, but new advisories have appeared since (**R4-32**, **R4-38**).

### 5.2 Batch 27: Stayful Intelligence acts for the member

16 rows: 15 built (two with a caveat), 1 partly, 0 missing.

| # | Asked | Status | Where |
|---|---|---|---|
| 1 | Full view only (Sonnet), not the quick box | Built | `chatTools(..., turn)` only from src/lib/chat/full-server.ts:160; quick box gets "Not available here" (tools-server.ts:347-348); FULL_MODEL in src/lib/chat/config.ts:16, 31 |
| 2a | Check a pasted link | Built | si-actions/validate.ts:299-329 (link must be in the member's own words, :134-142); link-server.ts:27-63; steps-server.ts:378-388 |
| 2b | Full analyses, Deep reports, deep search | Built | plan-server.ts:158-184; run-server.ts:340-342 → steps-server.ts:321-326, :342-344, :347-352 |
| 2c | Draft agent/landlord messages, sent by the member only | Built | draft-server.ts:38-81 (opened deals only; never shown to the model, :68-79); no send path |
| 2d | Bulk Keep/Pass and stage moves | Built | validate.ts:194-253; steps-server.ts:140-150; capped by si_action_max_targets (validate.ts:209) |
| 2e | Criteria change shows match count before and after | Built | steps-server.ts:274-293; plan-server.ts:279-281; view.ts:139-141 (Batch 30 seam: **R4-05**, **R4-07**) |
| 3a | Confirm only when the balance would end under £5 (not with auto top-up) | Built | spend.ts:233-235; plan-server.ts:206, 226 (pack seam: **R4-06**) |
| 3b | Over £20 in one instruction: do £20, then ask | Built, server-side | spend.ts:202-213; deferred steps (plan-server.ts:243-244); only queued steps run (run-server.ts:320) |
| 3c | Not enough credit: nothing runs, offer shown | **Partly** | spend.ts:229, 232; run-server.ts:143, 150 — the check counts the pack bonus (**R4-06**) |
| 4 | States the spend first; Stop until the first charged step | Built | spend.ts:277-292; countdown server-side (run-server.ts:304-307); Stop :403-425 |
| 5a | Price = tokens × markup + the normal action prices | Built | chat/budget.ts:4, 72-89; steps-server.ts:81-110; deal-analysis.ts:331 |
| 5b | Failed steps never charged | Built (relies on each step's own code) | run-server.ts:22-24, 364; deal-analysis.ts:337-348 |
| 5c | Balance never below zero | Built | run-server.ts:331-336, then each step's own reserve/debit |
| 6 | Free members can use it; the 48h delay still applies | Built | src/app/intelligence/page.tsx:43; `seenDeals` (tools-server.ts:209, 220, 235); marketplace/queries.ts:462-473; plan-server.ts:69 |
| 7 | Undo for 24h on Keep/Pass, stage moves, criteria | Built (one wrong restore) | undo.ts:126-135; undo-server.ts:29-93 (wrong restore: **R4-05**) |
| 8 | Never payments, plans, auto top-up, cancelling, deleting, sharing, notifications, third parties | Built, structurally | STEP_KINDS (si-actions/config.ts:22); unknown kinds dropped (validate.ts:188-192); closed enum (chat/tools.ts:168) |

### 5.3 Batch 28: buy-to-let, against Zac's spec

21 rows: 12 built, 8 partly, 1 built differently (a decision, §9), 0 missing. On the cash question, Batch 30's Buying cash won.

| # | Spec item | Status | Where |
|---|---|---|---|
| 1 | `btl` selectable; four deal types | Built | src/lib/market/goals.ts:156, 225; src/lib/profile/deal-types.ts:52-57; questions.ts:260-271 |
| 1b | Existing "All" profiles not switched to BTL | Built | deal-types.ts:12-13, 132; today/mix.ts; schema.sql:8151-8155 |
| 2 | "What are you after?" money / value / both | Built | questions.ts:231, 333-344; btl/rules.ts:33-37 |
| 2b | Yield and ROI both shown as income measures | Partly | card shows ROI only (btl/card.ts:192); yields only on the opened sheet (btl/sheet.ts:103-104) |
| 3 | Cash budget reuses Batch 30's Buying cash | Built (Batch 30 won) | questions.ts:456-469, 791, 856-861, 1080-1086; buying-power.ts:69-83; ceilings disagree (**R4-22**) |
| 3b | Bands Under £25k / £25–50k / £50–100k / £100k+ | Partly (decision) | member is asked Buying cash bands (questions.ts:466), mapped down (buying-power.ts:68-83); BTL bands kept for the benchmark (btl/config.ts:133) |
| 3c | Price from cash = 75% mortgage + stamp duty + £2,500 | Partly | deal filter right (btl/deal.ts:200-204; today.ts:202); the quiz's price line uses £13k furnishing (buying-power.ts:27-30) |
| 4 | 75% interest-only at the live 2–3-year fixed rate | Built | deal.ts:185-188; screen-server.ts:248-262; sheet.ts:135 |
| 4b | Rent test at max(live + 2%, 5.5%), 125% cover | Built | deal.ts:119-145; config.ts:52; tested on the middle rent (decision) |
| 5 | Costs 12% / 8% / 1 empty month / £25 pcm / £300 a year from settings | Partly | screen, report and deal page read settings (settings-server.ts:24-33); analyser, Explorer and what-if use defaults (**R4-24**) |
| 6 | Good deal = middle beats typical in budget, low cashflow ≥ £0, rent test | Built | btl/rules.ts:68-81; today.ts:198-205; standout judgeBtlStandout |
| 6b | Before tax; always ranges | Partly | ranges everywhere; card drops "before tax" / "history" (**R4-26**) |
| 7 | Card shows 3 numbers by priority | Built | card.ts:191-195, 230-240 |
| 8 | Growth history only; 1/3/5-year; 1-year shown | Partly | futureValueRange reused (growth.ts:29-30); 1-year only on the sheet (sheet.ts:113) and Explorer; 3-year unused; forecast-like card wording (**R4-26**) |
| 9 | Typical deal = regional median per band where ≥ 30, else national | Built differently (decision) | benchmark.ts:81-120: 10/25/50 miles → region → national; under 10 nationally = no comparison (config.ts:148) |
| 9b | Widening notice on card / Today / email | Partly | only on the opened deal page (sheet.ts:64-70) (**R4-28**) |
| 10 | £2 report is a setting | Built | config.ts:37, 250-252; schema.sql:8132 (no admin form: **R4-31**) |
| 10b | Charged once, never on failure, welcome price | Built | report-server.ts:151-154, 179-184, 208-212, 279-297; schema.sql:8094, 8096 (edge cases **R4-29**, **R4-30**) |
| 10c | Analyser shows the same btlDeal() at no extra charge | Partly | analyser.ts:52, no charge, but on defaults and without flat charges (**R4-24**) |
| 11 | Standout = low end ≥ 25% over typical, cashflow ≥ 0, rent test + Batch 25 rules | Built | btl/rules.ts:84-92; config.ts:157; extra 6% ROI floor = decision (bar skipped: **R4-27**) |
| 12 | Flags: service charge, EPC below C, distance | Built | card.ts:245-255 |

### 5.4 Batch 29 A–H: starter pack guardrails

B, D, F, G and H built; E built with caveats; A and C partly.

| Item | Status | Where |
|---|---|---|
| A. Bonus pays only for opens, saved analyses, daily picks | Built | schema.sql:762-766 (`credit_bonus_pays_for`), used at :816, :864-887, :7630-7650, :774-794; src/lib/credit/pack-rules.ts:57-64 |
| A. Expires after `pack_bonus_expiry_days` (30) | Built | schema.sql:8229-8241, 1034-1054, 8185 |
| A. Lifted by any further payment (trigger + sweep) | **Partly** | schema.sql:8252-8263, 8270-8282, 1040-1043; late webhook (**R4-18**); refunds keep it lifted (**R4-14**) |
| A. Bonus line on Billing, Usage, low-credit email | Built (pack-only only) | account/billing/page.tsx:54; account/usage/page.tsx:61; low-credit.ts:115 (trials: **R4-19**) |
| B. Fresh-report cap (3) claimed in SQL before any charge; 4th shows the offer, charges nothing | Built | schema.sql:8311-8339; deal-analysis.ts:392-401, 566-586; analysis/run.ts:195-236; si-actions/validate.ts (slot rule: **R4-17**) |
| C. £15 early offer: Home card + one email section, once; never the same UK day as the £5 decision | **Partly** | pack-rules.ts:155-201; pack-offer-server.ts:40-106; pack-home-server.ts:40-77; notify/message.ts:513; digest-run.ts:298, 366, 456 (**R4-16**, **R4-15**) |
| D. Picks pause for pack-only members away 7 days; resume with a Home note | Built | inactivity/server.ts; listing/picks-paused-run.ts; inactivity/came-back.ts:53-73; pack-home-server.ts:47-70 |
| E. Places cache 90 days, ~100m grid; "Report ready" badge | Built (caveats) | apis/google-places.ts:106-112, 154-156, 166 (**R4-20**); saved-server.ts:41-58; DealCard.tsx:185 (**R4-09**) |
| F. "Pack → paying" on /admin/weekly-active | Built | schema.sql:8450-8516; src/lib/admin/pack-paying.ts; PackToPaying.tsx:14-20; pack-export/route.ts |
| G. Deep welcome price only after paying again; pack-only asked to top up | Built | analysis/offers.ts; deal-analysis.ts:311-312; pmi-addon.ts; run.ts:206 |
| H. Purchase = pack only, once; RepeatPurchase once per member, server + browser same id | Built (edge **R4-21**) | meta/events.ts:64-67; meta/conversions.ts:244-275, 316-336; stripe/webhook.ts:371, 467, 507; starter-pack/route.ts:143; tracking/runtime.ts:223 |

### 5.5 Batch 30: shorter signup questions

A brand-new member who ticks Buy (short-let) + Rent-to-rent sees **exactly 13 screens**: deal types, where, R2R setup cash, Buying cash, funding, minimum profit, stage, time, range end, main goal, property, short-let rules, next deal. R2R only sees 9; "All of them" sees 15 (schema.sql:8526 says "9–15 questions").

| Bullet | Status | Where |
|---|---|---|
| About 13 questions for Buy + R2R | Built (13 exactly) | questions.ts:758-778 |
| Two cash questions that never read alike | Built | questions.ts:455-469, 614-627; Quiz.tsx label pill |
| Range end = which end hits the minimum; one helper everywhere | **Partly** | criteria.ts:163-177, 478; standout and "most you can pay" use the low end, old answers re-read (**R4-03**); "as you asked" (**R4-04**) |
| Live mortgage rate shown with change and reset | Built | card-display.ts; RateNote.tsx; profile/page.tsx; profile/server.ts (sync order: **R4-33**) |
| Cash → budget band keeps old readers working | **Partly** | questions.ts:1079-1099; BTL band readers disagree (**R4-22**); SI budget (**R4-07**) |
| Nobody re-answers anything | **Partly** | state.ts:142-159; new questions for older R2R-only / BTL-only members (**R4-41**) |
| Home blocker card from day 3 | Built | blocker-card.ts:46-51; home/page.tsx; schema seed |
| Backfill: dry run, idempotent, admin button, no data loss | **Partly** | quiz-v2-backfill(.ts / -run.ts); admin/profiles; mode-write order (**R4-40**); sync order (**R4-33**). On live it is complete |
| Admin question-count measure | **Partly** (decision) | admin/profile.ts cohortStats counts today's list for both cohorts, so it cannot show the shortening |
| standout_min_checked_rent = 3 for R2R | Decision | standout/rules.ts:127; settings.ts:65 |


## 6. Conflicts between batches, and the helpers they were told to reuse

The same question answered by two pieces of code. "Yes" means they give different answers for the same member.

| Thing | Implementation A | Implementation B | Disagree? |
|---|---|---|---|
| Cash → price line / budget | buying-power.ts:27 `cashNeededFor` (25%, 2-bed, England) | criteria.ts:419 `purchaseDeal` (member's deposit, deal's bedrooms, England) | **Yes** (£150k 4-bed: £58.5k vs £65.5k) — **R4-44** |
| Cash nudge vs cash filter | behaviour.ts:187, 238 | criteria.ts:474 | **Yes** — **R4-44** |
| BTL cash ceiling | btl/today.ts:202 exact top (£60k for £30–60k) | standout/rules.ts:141, what-if.ts:248, report-server.ts:251 stored band (£50k) | **Yes** — **R4-22** |
| BTL deal on Browse | btl/today.ts (BTL cash in, BTL rules) | browse.ts:160 → criteria.ts:474 short-let cash + profit | **Yes** — **R4-23** |
| BTL band tops | settings `s.bands` (today.ts:202, standout) | built-in bands (what-if.ts:248, analyser.ts) | Only if Zac edits the bands — **R4-22**, **R4-24** |
| Budget ↔ cash band | buying-power.ts:94 `cashBandFromBudget` (mortgage only) | questions.ts:1084 `budgetFromCash` (knows funding) | **Yes**, not inverses — **R4-07** |
| Profit range end | criteria.ts:478 `profitAt(range, profitEnd)` (default middle) | most-you-can-pay.ts:73 (low end); standout/rules.ts:130 (low end) | **Yes** — **R4-03** |
| BTL profit end | btl/rules.ts:66-80 (middle ROI/growth, low cashflow ≥ 0) | criteria `profitEnd` | Separate by design (Batch 28) |
| Minimum-profit fields | questions.ts:1142 `min_profit` writes both | si-actions/config.ts:57, what-if.ts:277 treat R2R as separate | **Yes** — **R4-05** |
| Affordability before a charge | btl/report-server.ts:165 `spendableFor(…,'btl_report')` | si-actions/plan-server.ts:204 `getBalance` (bonus included) | **Yes** — **R4-06** |
| Bonus scope list | pack-rules.ts:57 | schema.sql:762-766 | No (a test checks they match) |
| Fresh-report cap | deal-analysis.ts:394, 573; run.ts:206 | BTL report: no cap | Deliberate (docs/batch-29.md:63) |
| Full analysis charge | deal-analysis.ts:696 | SI steps-server.ts:321 calls the same `startDealAnalysis` | No (one path) |
| £2 BTL report charge | report-server.ts:289 | SI steps-server.ts:333 calls the same `runBtlReport` | No |
| Live mortgage rate | live-rate-sync.ts (daily into profiles) | BTL screen (into the card at 04:50 and 06:57) | No: same cache, read right after the 04:45 sync. R6-9 **refuted** by V-D; Zac's rule: BTL keeps the live rate for everyone |
| Stamp duty | listing/stamp-duty.ts:132 | deal.ts:168 (a wrapper) | No (one calculator); `memberFigures` never passes `country` (pre-existing, **R4-44**) |
| BTL inputs | settings-server.ts:32 saved settings | analyser.ts:51 defaults | **Yes** after an admin edit — **R4-24** |


## 7. Loose ends

- **TODOs:** none added in code in scope. The only matches are prose comments and null-state notes (appendix A, row 4a).
- **Settings with no admin control:** the ten `btl_*` settings (`btl_report_pence`, `btl_finance`, `btl_costs`, `btl_rent`, `btl_standout`, `btl_bands`, `btl_benchmark`, `btl_epc`, `btl_flats`, `btl_listing`) and the changed `today_mix`. Every other key added in scope has a form (appendix A, table C). Zac's rule: a form for the £2 price and the finance settings only (**R4-31**).
- **Crons with no admin Dry run:** the nightly si-actions tidy (02:55) and the credit sweep's new pack-expiry preview. Both can only be dry-run with `INTERNAL_API_SECRET` (**R4-31**). The Batch 30 backfill has its button (#164); the BTL screen has buttons on /admin/deals.
- **Environment flags the new code depends on:** `BTL_SCREEN_ENABLED` (new; in .env.example and the README; off); `STRIPE_PRICE_STARTER_PACK` (the pack is on only when set, stripe/prices.ts:20-25); `CREDIT_ENFORCE` (money is enforced only when `'true'`, credit/http.ts:22-24); `MARKET_WARM_ENABLED` (on by default; it also runs the daily rate sync); `INTERNAL_API_SECRET` (write-only on Vercel).
- **The dormant BTL switch:** the nightly BTL screen is off until `BTL_SCREEN_ENABLED=true`, `btl_launch_from` is null, and live has 0 deals with a BTL lens, 0 BTL reports and 0 benchmarks. So **R4-22, R4-23, R4-25, R4-26, R4-27, R4-28** cannot reach a member yet. They will reach every BTL member the night the switch goes on, so merge r4e before switching it on. The admin Run on /admin/deals runs a real, paid screen even while the switch is off (decision, §9).
- **README:** no Batch 30 deploy section (the rate-sync order is only in code comments and the admin text, which names the wrong time: **R4-33**).


## 8. Forward conflicts for Batches 31 and 31a

From R8, checked against what changed in scope.

| Area | Verdict | Why |
|---|---|---|
| src/lib/funnels (Batch 31) | **Safe** | Empty diff in scope. Inherited trap: `mc_signup`, `mc_pack_paid`, `funnel_live` are still refused by `meta_conversions_event_check`, so if Batch 31 needs them at Meta it must add them there. A management company's pack is now the per-member Purchase. |
| src/app/leads (stages, delivery, Monday push) | **Safe** | Empty diff; no schema change touches the lead tables. |
| src/lib/tracking/touch.ts | **Safe for white-label; unsafe for /academy as it stands** | `/f/` and `/r/` are skipped as intended (surfaces.ts:33-45). `/academy` is on no tracking list, so an ad landing there captures no utm/fbclid, shows no banner and loads no pixel. 31a must add its pages to config.ts, and any new Meta event in four places (`META_EVENTS`, `CUSTOM`, `EVENT_SOURCE_PATHS`, the schema check). |
| src/lib/stripe/customer.ts `ensureStripeCustomer` | **Unsafe to rely on "never a duplicate"** | Any lookup error creates a second customer (customer.ts:35-50, **R4-49**). |
| webhook.ts £0-invoice grant and annual pattern | **Does not generalise** | A £0 trial invoice grants one month that lasts the whole trial; the annual code is hard-wired to `pro_annual` and 12 slots. 31a needs its own trial grants (with a dry-run preview in the credit sweep). Its academy branch should sit before webhook.ts:527, or an unknown academy price records a payment that lifts a pack bonus. |
| `trialing` status | **Rule question for 31a, not R4** | A trial counts as a subscriber and lifts the 48h delay, but is not "paid" in sourcing-demand's "paying now" set (access.ts:192-194). |
| /api/billing/subscribe | **Copy the pattern, don't call it** | It refuses a second subscription (409) and would swap an academy subscription's price; 31a should use its own route. |
| logActivity kinds | **Safe** | One list (kinds.ts); the database does not check kinds. |
| vercel.json crons | **No name clash; count needs checking** | 45 entries on 31 paths; no `academy` path. R2 recorded Pro's limit as 40, so **Zac should check Vercel → Settings → Cron Jobs lists 45** before 31a makes it 46. |

### Batch 27–30 and R3 changes in files 31a owns or touches

| 31a file | In-scope changes a 31a fix must work around |
|---|---|
| src/lib/stripe/webhook.ts | Batch 29: pack Purchase line (:369-371), top-up RepeatPurchase lines (:463-465, :504-506), plan-invoice Subscribe/RepeatPurchase block (:577-588), `WebhookConversion` type (:125-128). The academy section should not edit these. |
| src/lib/stripe/grants.ts, annual.ts | none |
| src/app/admin/billing/** | R3c: briefing ceiling (`BriefingsSwitch`, actions.ts) |
| supabase/schema.sql | Batch 29 edited the credit section in place (reserve/debit walk the pack bonus; the unlock trigger). A new trial grant scope is not restricted unless it is `scope = 'pack_bonus'`. |
| vercel.json | Batch 27 si-actions; Batch 28 btl-screen ×2 |
| .env.example | R3c, R3h, Batch 28 (`BTL_SCREEN_ENABLED`) |
| src/lib/stripe/customer.ts, src/lib/auth/sign-in-hooks.ts | none |
| src/app/account/** | Batch 29 bonus line (billing/page.tsx, BillingClient.tsx, usage/page.tsx); R3a prefetch (account/page.tsx); R3d SmsSection |
| src/lib/tracking/config.ts | Batch 29 RepeatPurchase in `EVENT_SOURCE_PATHS` |

### Each R4 fix branch's 31a overlap

| Branch | 31a overlap | What to do |
|---|---|---|
| r4a | `src/lib/tracking/config.ts` (R4-01) | Merge r4a first; 31a adds `/academy` on top. |
| r4b | none | — |
| r4c | none | — |
| r4d | `src/app/account/billing/page.tsx`, `src/app/account/usage/page.tsx` (R4-19); possibly `src/lib/stripe/webhook.ts` non-academy lines (R4-18); `supabase/schema.sql` (R4-14, additive) | List every account-page line in the PR, or leave the account-page wording to 31a. Keep webhook edits out of the academy section. |
| r4e | `/admin/billing` must **not** get the pack-expiry button (R4-31) | Put it on /admin/weekly-active or /admin/profiles. |
| r4f | `src/lib/stripe/customer.ts` (R4-49) | Narrow fix only (create on `resource_missing`, idempotency key), or leave it to 31a. |


## 9. Decisions to confirm, and the business rules Zac answered

### 9.1 Decisions to confirm

Behaviour that differs from a brief but that the PR or docs call deliberate. **Zac's default: these are listed, not bugs, and nothing changes unless he says.** He was asked on 19 Nov 2026 and did not want to change any.

| # | Decision | Code | PR / doc says |
|---|---|---|---|
| D1 | A text's or email's charge guard is kept when its debit fails (the house absorbs it) | voice/charge-server.ts:134-137 | r3d: "a text's or email's guard stays: the thing went" |
| D2 | SI's own texts are outside the alert cap and daily slot | account/notifications/SmsSection.tsx:39-40 | r3d: "outside the alert cap (by design, now said)" |
| D3 | Callbacks keep working while outbound calls are off | voice/inbound-server.ts:90-91 | "Callbacks keep working while outbound calls are off, by design (Zac)." |
| D4 | "Top up to ask me more" appears below the 2p/10p floors, not at £0 | README §24 | r3k: "README §24 records the 2p/10p floors as the decision" |
| D5 | A crash between the briefing's two meter calls is not fixed (**R4-35**) | briefing/runner.ts:355-356 | r3c: "a crash between them is noted in the PR, not fixed here" |
| D6 | One build-time audit advisory waits; React Compiler lint rules are warnings | eslint.config.mjs | r3n: "it waits"; "they are warnings in eslint.config.mjs" |
| D7 | After a confirm "yes" there is no second Stop countdown | si-actions/run-server.ts:473 | "The yes is the go-ahead: no second countdown." |
| D8 | A deep search SI starts that finds nothing is still charged; the draft `si_actions_cost` and service-facts.ts:86 say "nothing that fails is charged" | run-server.ts:20-24 | "a deep search its cost, as the button: Zac, 11 Oct" |
| D9 | Charged SI steps run from the open page; a closed tab stops after the current step | si-actions/live.ts:1-11 | PR: "Tested on the preview: … closed tab" |
| D10 | The one-at-a-time lock is per member, not per paying account (two team seats can run at once) | schema `si_instructions_live_uidx on (user_id)` | Batch 27 schema |
| D11 | The `si_actions_stop` draft does not mention the auto top-up exception | knowledge/seed.ts | "I ask first when … leave you under {low_credit_mark}" |
| D12 | BTL benchmark widens 10 → 25 → 50 miles → region → national; under 10 nationally = no comparison | btl/config.ts:13-19, 148; benchmark.ts:1-13 | PR: "judged against the typical deal in the member's cash band, widening outward and saying so" |
| D13 | Buying cash bands replace the BTL bands and are mapped down to the band below | buying-power.ts:68 | "whose top is at or below the cash band's top (decided)" (Zac's R4-22 rule now uses the exact top for the ceiling) |
| D14 | The price line under Buying cash uses £13k furnishing, not £2,500 buying costs | buying-power.ts:26-30 | Batch 30's shared line |
| D15 | BTL rent test on the middle rent only; a low-end fail shows as "Tight" | btl/deal.ts:20-23; sheet.ts:56 | "(Q3)" |
| D16 | BTL standout extras: 6% low-end ROI floor; no standout when the median is ≤ 0% | btl/config.ts:18-19; rules.ts:15-20 | "decided … Q8" |
| D17 | EPC allowance added to the high end of cash in (D £5k, E–G £10k, unchecked = D) | btl/config.ts:123-130 | "Q10" |
| D18 | Unanswered BTL priority means "A bit of both" | btl/today.ts:39 | "decided" |
| D19 | The BTL lens on the deal page, and the £2 report button, for members who did not choose BTL; Browse "All types" lists BTL deals | deals/[id]/page.tsx:513, 520; deal-types.ts:186-189 | "the buy-to-let lens: first for a member who sees it as Buy to let, the other lens for one who sees it as a short-let"; guarded by leak.test.ts:11-15 (V-D: deliberate and tested) |
| D20 | Open price for a BTL-only deal = middle cashflow × 12 on the same ladder | btl/view.ts:97-108 | "Batch 28, Q15" |
| D21 | Four-type mix 2/1/1/1, legacy three-type mix kept | today/mix.ts; schema.sql:8145-8155 | "decided" |
| D22 | The £2 report can be bought before Open (no address shown or stored) | page.tsx:520; btl/report.ts:8-10 | Batch 28 |
| D23 | The admin "Run" for the BTL screen works while `BTL_SCREEN_ENABLED` is off (a real, paid run) | admin/deals/actions.ts:221-224; admin/deals/page.tsx:386 | "OFF (… the buttons work either way)"; PR: "The nightly btl-screen cron is off until BTL_SCREEN_ENABLED=true" |
| D24 | The morning briefing charge is not paid by the pack bonus | credit_bonus_pays_for (schema.sql:762-766) | docs/batch-29.md Q1: "the morning briefing charge (≤3p) is not covered" |
| D25 | BTL reports are outside the fresh-report cap, and the bonus cannot pay for them | analysis/run.ts:200; btl/report-server.ts:165 | docs/batch-29.md:63: "buy-to-let reports don't" |
| D26 | Pack-only excludes trial, paid and paused plan members, and anyone who paid before the pack | pack-rules.ts:30-32 | "has paid for nothing else ever … and has no live, trialling, past-due or paused plan" (side effect: **R4-19**) |
| D27 | "Report ready" badge read by deal only (**R4-09**) | analysis/saved-server.ts:35-38 | "Read by deal only (a deal's inputs … rarely change); the purchase itself checks the exact inputs" |
| D28 | A saved analysis bought with PMI is held as fresh for the price, but the debit carries `reused` | analysis/deal-analysis.ts (`analysisSteps`, `analysisHoldAction`) | Harmless today: pack-only members cannot buy PMI |
| D29 | Worst-case pack cost £3.45 accepted | docs/batch-29.md Q11 | "Decided (Zac, 14 Nov): accepted." |
| D30 | `mc_signup` / `mc_pack_paid` / `funnel_live` still refused by the Meta event check | schema.sql `meta_conversions_event_check` | docs/batch-29.md Q15: "Left as they are" |
| D31 | Old pack bonuses become restricted and expire 30 days after release, not purchase (live: 0 such grants) | schema.sql `pack_bonus_backfill` | "the expiry runs pack_bonus_expiry_days from RELEASE (this run), not from purchase" |
| D32 | standout_min_checked_rent = 3 for R2R deals | standout/rules.ts:127; settings.ts:65 | #163: "sales keep standout_min_checked (5)" |
| D33 | Cash → budget is a ceiling only; above about £200k there is no band, so untailored readers see no price cap | buying-power.ts:53-58; listing/sourcing.ts:144; sourcing-demand/demand.ts:226 | "a ceiling only (decided)" |
| D34 | A worked-out cash band never filters; the backfill writes no mark | buying-power.ts (`buyingCashTop`, `cashFromBudget`) | Batch 30 |
| D35 | Blocker card: sign-up day is day 0, so the default 3 shows on the 4th calendar day | home/blocker-card.ts:33-44 | Batch 30 |
| D36 | Admin before/after counts both cohorts on today's question list, so it cannot show 33 → 13 | app/admin/profile/page.tsx | "Questions are counted on today's list for everyone" |
| D37 | Break-even and payback no longer judge anyone, even members who answered them | tailoring/criteria.ts:219-221 | Batch 30 |
| D38 | The profile page hides the old budget and project budget rows (they still filter) | app/profile/page.tsx | Batch 30 |
| D39 | Trials (£0 first invoice) grant the full plan credit and send no Subscribe until the first paid invoice | stripe/webhook.ts:563-564 | "a promotion is a promotion (Batch 21 review, question 5)" |

### 9.2 Business rules, with Zac's answers (19 Nov 2026)

| Finding | Question | Zac's answer |
|---|---|---|
| R4-01 | Should /home and /welcome/reveal send a PageView? Should a first BTL report count as FirstReport? | No PageView on /home or /welcome/reveal. Yes: a first £2 BTL report counts as FirstReport. |
| R4-02 | R2R setup cash: must-have or nice-to-have? | Nice-to-have for everyone: it ranks, never hides. |
| R4-03 | Which profit end do older members and members with no answer get? Do standout and "most you can pay" follow it? | Anyone who answered before Batch 30, or never answered, is judged on the low end until they answer the new question; new members default to the middle. Standout and "most you can pay" use the same one helper. |
| R4-05 | Merge older members' two minimum-profit figures? | No. Keep them separate; each change writes only its own minimum; Undo restores exactly. |
| R4-07 | What does "budget under £X" from SI set? | A price ceiling of £X only; Buying cash is left untouched. |
| R4-08 | Which Batch 30 answers may SI change? | Buying cash and R2R setup cash (with Undo), plus the BTL priority. Retired fields are removed from the tool. |
| R4-14 | Does a refunded or charged-back further payment still count as paying again? | No. The bonus is re-restricted (if not expired) and the member is pack-only again. |
| R4-15 | How long may the £5 decision be held for an offer with no email to ride? | When nothing else is going, the £15 offer goes as its own email; the £5 decision follows the next day as designed. |
| R4-17 | Does a failed report give its fresh-report slot back if part was charged? | Yes, even if part was charged. |
| R4-22 | Which BTL cash ceiling, and which benchmark band? | The exact Buying cash top everywhere; the benchmark compares with the band containing that top. |
| R4-25 | Which order before the 400 cap? | Apply the cash ceiling before the cap; keep the current order otherwise. |
| R4-27 | What must a BTL standout beat? | The BTL deals already shown, on low-end monthly cashflow; ignore entries with no deal type. |
| R4-31 | Which BTL settings get an admin form? | The £2 report price and the finance settings (loan-to-value, stress rate, rent cover). The rest stay SQL-only. |
| R6-9 (refuted) | Should BTL follow a member's own typed rate? | No: BTL keeps the live rate for everyone. |
| R1 rule | The chat's "I don't know that one yet — I've passed it to the team" (chat/config.ts:84) | Keep it: the nightly gaps email counts as passing it to the team. |
| R2 rule | SI's £20 confirm and £5 line leave out the question's own AI charge; one "yes" covers everything past £20 | Keep as built. |
| R4-40 | Should the old "£10k+" setup band map to "£20k+"? | Not asked separately. With R4-02's rule the band only ranks, so the fix does not need it; it stays as it is unless Zac says. |

### 9.3 The ads event

The starter pack is **off** on live (`starter_pack_from` is null), and Batch 29 made Purchase mean "bought the pack" (once per member; top-ups no longer send it). So **no member can send Purchase today**, and a top-up sends nothing to Meta (RepeatPurchase needs a pack). A Purchase-optimised campaign would see zero purchases. Zac's answer: treat it as a condition for GO. Either switch the pack on before ad spend, or point the campaigns at another event (for example CompleteRegistration). No code change.


## 10. Fix plan: six branches, in the order a new member would need them

**r4a goes first** (the day-one pixel fix, before ad spend). After r4a, the order is r4b → r4c → r4d → r4e → r4f. r4b and r4e both edit `src/lib/tailoring/criteria.ts`, and r4d and r4e both edit `src/lib/analysis/run.ts`, so rebase the later branch on the earlier. Files marked "expected" are the likely place for the change but were not named in a finding's Where line.

**The bug check every branch runs before handing back:**
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` all pass.
- **Credit:** no new charge path; every charge still goes through the button's own code, once, never on failure; balances never go below zero.
- **Free/paid:** the 48h delay still holds on every surface touched.
- **Address:** no address, postcode or listing link before Open.
- **Dry runs:** every `?dry=1` touched still writes nothing.
- **Schema:** `supabase/schema.sql` runs twice with empty dump diffs, and the smoke files pass.
- **ACCESS_COLUMNS** in `src/lib/access.ts` unchanged.
- **Knowledge (CLAUDE.md):** any changed feature, price, limit or rule adds or updates **draft** entries in `src/lib/knowledge/seed.ts` (never approved in code), every figure a `{placeholder}` resolved from settings (`src/lib/knowledge/placeholders.ts`), and `src/lib/knowledge/service-facts.ts` updated where the nightly job drafts from it. The seed tests check every placeholder resolves and no answer types a figure.

### review-r4a-build-first-day

- **Fixes:** R4-32, R4-01, R4-38 (non-major bumps only), and FirstReport on the first BTL report (Zac's rule under R4-01).
- **Files:** `package.json`, `package-lock.json`, `.github/workflows/ci.yml` (add `npm run build`), `src/lib/tracking/config.ts`, `src/lib/tracking/surfaces.ts` (expected), `src/lib/tracking/runtime.ts` (expected: fire held conversions on /welcome, /welcome/reveal, /home without a PageView), `src/lib/tracking/surfaces.test.ts`, `src/lib/tracking/wiring.test.ts` (expected), `src/lib/btl/report-server.ts` (FirstReport), `src/lib/meta/conversions.ts` or `src/lib/meta/events.ts` (expected).
- **Tests to add:** "/welcome loses ?next when it is HOME_PATH"; the tidy rule's `when` equals `HOME_PATH`; "a held FirstReport fires on /home with no PageView"; "a first BTL report records FirstReport once, never twice".
- **Schema / settings / manual:** none in the schema. After merge: watch the Vercel deploy reach READY; run `npm audit --omit=dev` and note what is left.
- **31a overlap:** `src/lib/tracking/config.ts`.
- **Knowledge:** none expected (no member-facing rule or price changes).
- **Click-through:** confirm a new email, do the quiz on a phone, and check in Meta Events Manager that the browser copy of CompleteRegistration arrives on /welcome, with no PageView there.

### review-r4b-quiz-rules

- **Fixes:** R4-02, R4-03, R4-04, R4-05, R4-33, R4-40, R4-41, R4-42, R4-43, R4-44.
- **Files:** `src/lib/tailoring/criteria.ts`, `src/lib/standout/rules.ts`, `src/lib/standout/run.ts` (expected), `src/lib/marketplace/most-you-can-pay.ts`, `src/lib/marketplace/card-display.ts`, `src/lib/si-actions/config.ts`, `src/lib/si-actions/steps-server.ts`, `src/lib/si-actions/undo-server.ts`, `src/lib/intelligence/what-if.ts`, `src/lib/profile/questions.ts`, `src/app/api/internal/market-warm/route.ts`, `src/lib/listing/live-rate-sync-server.ts`, `src/lib/profile/quiz-v2-backfill.ts`, `src/lib/profile/quiz-v2-backfill-run.ts`, `src/app/admin/profiles/page.tsx`, `src/lib/market/goals.ts` (expected), `src/lib/profile/state.ts`, `src/app/profile/page.tsx`, `src/lib/profile/server.ts`, `src/lib/tailoring/behaviour.ts`, `supabase/schema.sql` (the backfill-done setting row).
- **Tests to add:** criteria.test.ts (Under £10k + 3 beds still matches; pre-Batch-30 and no-answer members judged on the low end, new members on the middle; one check per Buying cash answer; old £10k+ adds no must-have); most-you-can-pay.test.ts (never below the asking price on a pass); standout/rules.test.ts (standout uses the member's end); card-display.test.ts (no "as you asked" without an answer); undo.test.ts (two minimums restored); what-if.test.ts (never raises the R2R minimum); live-rate-sync.test.ts (no sync until the stamp); quiz-v2-backfill.test.ts (BTL-only member gets a worked-out Buying cash); state.test.ts (older R2R-only member stays complete); behaviour.test.ts (nudge and filter cost the same).
- **Schema / settings / manual:** a new `billing_settings` row for the "backfill done" stamp (`on conflict do nothing`); since live's backfill is complete, the branch (or Zac) should write the stamp once after merge so the daily sync keeps running.
- **31a overlap:** none.
- **Knowledge:** update the drafts for `r2r_setup_cash` (now a nice-to-have), `profit_end` (low end for older and unanswered members, middle for new), the minimum-profit entries (two figures stay separate), and service-facts.ts lines for these rules.
- **Click-through:** an older test member with a "Go for it" answer sees "Low end used" on cards; a new R2R member with Under £10k and 3 beds still has a reveal; SI "drop my rent-to-rent minimum to £250" then Undo restores both figures.

### review-r4c-si

- **Fixes:** R4-06, R4-07, R4-08, R4-09, R4-10, R4-11, R4-12, R4-13.
- **Files:** `src/lib/si-actions/plan-server.ts`, `src/lib/si-actions/run-server.ts`, `src/lib/chat/turns-server.ts`, `src/lib/si-actions/spend.ts` (expected), `src/lib/si-actions/steps-server.ts`, `src/lib/si-actions/undo-server.ts` (expected: Undo for Buying cash, setup cash and the price ceiling), `src/lib/si-actions/config.ts`, `src/lib/si-actions/validate.ts`, `src/lib/chat/tools.ts`, `src/lib/chat/tools-server.ts`, `src/lib/si-actions/link-server.ts`, `src/lib/si-actions/view.ts`, `src/components/intelligence/chat/ActionCard.tsx`, `src/lib/analysis/saved-server.ts` (expected), `src/lib/knowledge/service-facts.ts` (line 49).
- **Tests to add:** pack-rules.test.ts static source test (affordability uses `spendableFor`); spend.test.ts (`decideSpend` with the scoped figure); pack-smoke.sql (`credit_reserve` for `si_chat_full` refused while `credit_available` shows enough); steps.test.ts ("under £100k" sets a ceiling, Buying cash unchanged); validate.test.ts (tool text names every type; `pack_cap` drop for an unsaved deal); placeholders.test.ts (no retired placeholder in SERVICE_FACTS); link.test.ts; view.test.ts (resumable hand-out); tools.test.ts (offer amount not in the question is dropped); a wiring test for `count: 'exact'`.
- **Schema / settings / manual:** none.
- **31a overlap:** none.
- **Knowledge:** update the `si_actions_*` drafts: what SI may change (Buying cash, R2R setup cash, BTL priority, a price ceiling), with Undo; re-draft service-facts.ts:49 to "their Buying cash" and drop "2–3-year" (covers R4-46's first half).
- **Click-through:** with a pack test account (bonus only), ask the full view for a deep search: SI says up front there is not enough credit and offers a top-up, with no countdown. Ask "only show me deals under £100k": the card shows a £100k price ceiling and Buying cash unchanged; Undo puts it back.

### review-r4d-pack

- **Fixes:** R4-14, R4-15, R4-16, R4-17, R4-18, R4-19, R4-20, R4-21.
- **Files:** `supabase/schema.sql` (`member_paid_again_at`, the unlock trigger, a re-restrict on refund, `pack_paying_facts`), `src/lib/stripe/webhook.ts` refund path near :773 (expected; non-academy lines), `src/lib/stripe/deps.ts` (expected), `src/lib/credit/pack-rules.ts`, `src/lib/credit/pack-offer-server.ts`, `src/lib/notify/digest-run.ts`, `src/lib/notify/message.ts` (expected), `src/lib/analysis/run.ts`, `src/lib/payments/server.ts`, `src/lib/payments/rules.ts`, `src/app/account/billing/page.tsx`, `src/app/account/usage/page.tsx`, `src/lib/credit/low-credit-server.ts`, `src/lib/analysis/deal-analysis.ts`, `src/lib/apis/google-places.ts`, `src/lib/meta/conversions.ts`.
- **Tests to add:** pack-smoke.sql (full refund re-restricts the bonus and Pack → paying ignores it; a late-recorded payment with an earlier `paid_at` lifts the bonus; a partly charged failed report releases its slot); pack-rules.test.ts or a digest test (no email built: the offer goes alone, the £5 decision next day); message.test.ts (both notes: only the offer, and only the offer is stamped); a `bonusLineFor` test for a trial member; google-places.test.ts (empty answer, short cache); events.test.ts (earliest payment wins RepeatPurchase).
- **Schema / settings / manual:** run schema.sql on live after merge (changed functions). Possibly a short-cache setting for empty Places answers (if added, a `billing_settings` row and an admin field on /admin/lifecycle).
- **31a overlap:** `src/app/account/billing/page.tsx`, `src/app/account/usage/page.tsx` (list every line, or leave the wording to 31a); `src/lib/stripe/webhook.ts` non-academy lines.
- **Knowledge:** update the `pack_bonus` (refund rule), `pack_fresh_reports` (slot back on failure) and pack offer drafts (the offer can come on its own), with placeholders such as `{pack_offer_at}`.
- **Click-through:** on a test account with the pack: top up, refund the top-up in Stripe test mode, and check Billing shows the bonus as restricted again; run out of credit on a day with no picks and check the £15 offer email arrives alone, then the £5 email the next day.

### review-r4e-btl

- **Fixes:** R4-22, R4-23, R4-24, R4-25, R4-26, R4-27, R4-28, R4-29, R4-30, R4-31.
- **Files:** `src/lib/btl/deal.ts` (the shared ceiling helper), `src/lib/btl/today.ts`, `src/lib/standout/rules.ts`, `src/lib/standout/run.ts`, `src/lib/intelligence/what-if.ts`, `src/lib/btl/report-server.ts`, `src/app/deals/[id]/page.tsx`, `src/lib/tailoring/browse.ts`, `src/lib/tailoring/criteria.ts`, `src/lib/analysis/run.ts`, `src/components/report/BuyToLetInstead.tsx`, `src/lib/btl/analyser.ts`, `src/app/api/explorer/btl/route.ts`, `src/lib/marketplace/queries.ts` (expected: the pool filter), `src/lib/marketplace/card-view.ts`, `src/app/deals/_components/BuyToLetSection.tsx`, `src/lib/btl/card.ts`, `src/app/admin/deals/btl/page.tsx` and its actions (expected: the settings form), `src/app/admin/intelligence/actions/page.tsx` and `actions.ts` (si-actions Dry run / Run), a pack-expiry preview on `/admin/weekly-active` or `/admin/profiles` (expected; not /admin/billing).
- **Tests to add:** standout.test.ts (£56k not over budget for 30-60); what-if.test.ts (keeps the £56k deal); today.test.ts (Today and standout agree for every Buying cash answer; a deal ranked 450th by short-let profit is still picked); browse.test.ts (BTL cash in used on Browse); analyser.test.ts (flat service charge; settings used); explorer.test.ts (70% loan); card-view.test.ts ("History, not a forecast" kept); rules.test.ts (`bestAtLeast` for BTL, no-type entries ignored); card.test.ts (benchmark flag); report.test.ts (null read refuses; reserve error stops the run); admin action tests for each new button.
- **Schema / settings / manual:** no new setting (the form writes the existing `btl_report_pence` and `btl_finance`). Merge before switching `BTL_SCREEN_ENABLED` on.
- **31a overlap:** keep the pack-expiry button off /admin/billing.
- **Knowledge:** update the BTL drafts (the cash ceiling is the Buying cash; the benchmark band; "value in 5 years is history, not a forecast", using placeholders).
- **Click-through:** with the screen run once by admin on a test area, open a BTL card for a £30–60k member: the cash ceiling matches Today, Browse and the £2 report; "Value in 5 years" says it is history.

### review-r4f-code-health

- **Fixes:** R4-34, R4-35, R4-36, R4-37, R4-39, R4-45, R4-46 (second half), R4-47, R4-48, R4-49.
- **Files:** new tests for the seven R3 fixes (e.g. `src/lib/intelligence/reveal-order.test.ts`, cases in `src/lib/analysis/offers.test.ts`, `src/lib/chat/voice.ts` + a voice-rules test, `src/lib/briefing/briefing.test.ts`, `src/lib/voice/low-credit.ts` + `low-credit.test.ts`, `src/lib/briefing/once.ts` + `once.test.ts`, `supabase/tests/credit-smoke.sql`), `src/lib/briefing/runner.ts`, `src/lib/knowledge/store-server.ts`, `src/lib/knowledge/gap/plan.test.ts`, `src/lib/chat/quick-server.ts`, `src/components/intelligence/chat/voice.ts`, `src/app/api/chat/listen/route.ts`, README §26, `src/lib/knowledge/seed.ts`, `src/lib/knowledge/placeholders.ts`, `src/lib/knowledge/service-facts.ts` (line 86), `src/lib/knowledge/seed.test.ts`, `supabase/schema.sql` (index guard), `supabase/tests/btl-smoke.sql` (new) and `.github/workflows/ci.yml`, `src/lib/stripe/customer.ts` + new `customer.test.ts`.
- **Tests to add:** the seven R3 tests (§4, R4-34); once.test.ts per-unit charge; `gapsToClose` case; dedupe-key wiring; "every service-facts placeholder is used by a seed entry"; the blocking number check over SERVICE_FACTS; index oid unchanged on re-run; btl-smoke.sql for `btl_apply_screen` and `sync_live_mortgage_rate`; customer.test.ts.
- **Schema / settings / manual:** run schema.sql on live after merge (index guard). R4-35 needs Zac's choice: fix it or accept it (D5).
- **31a overlap:** `src/lib/stripe/customer.ts` (narrow fix, or leave to 31a).
- **Knowledge:** new drafts `pack_early_offer`, `si_actions_limits`, `btl_explorer`; placeholders for the four `si_action_*` limits.
- **Click-through:** in /admin/intelligence, approve a chat-only entry linked to a call gap: the gap stays open.


## 11. Click-through checklist for Zac after the fixes merge

The brief's six steps:

1. Run supabase/schema.sql in Supabase; check /, /welcome, /today, /home, /my-deals and an /admin page load.
2. Fresh test signup Buy + R2R: count the questions (about 13), finish, see the reveal.
3. Ask the full Stayful Intelligence view to "analyse my top kept deal": it states the price first, charges once, and Undo works on a Keep.
4. Open a BTL deal: ranges, rent test, flags show; no address before Open.
5. Starter pack test account: 4th fresh report shows the offer and charges nothing.
6. /admin/weekly-active shows Pack → paying.

Plus:

7. Approve the `chat_voice` draft in admin (clears R3-1 for members).
8. Confirm in Vercel → Settings → Cron Jobs that all 45 crons are listed and accepted.
9. Decide before any ad spend: switch the starter pack on, or set the campaigns to optimise on another event (§9.3).


## Appendix

### A. Mechanical checks

HEAD `8bdbf9d`, scope `42e68ea..8bdbf9d`. The repo was left clean (`git status` empty).

**Table A: checks**

| # | Check | Result | Detail |
|---|---|---|---|
| 1a | `npm ci --no-audit --no-fund` | Pass | 691 packages |
| 1b | `npm run lint` | Pass | 0 errors, 79 warnings (unused variables, `<img>`, set-state-in-effect) |
| 1c | `npm run typecheck` | Pass | exit 0 |
| 1d | `npm test` | Pass | 3,255 tests, 3,255 pass, 0 fail, 0 skipped |
| 1e | `npm run build` | **Fail (not env vars)** | Compiled in 28.7 s and generated 92/92 static pages, then Next.js 16.4.1 stops with `SecurityFatalError`. A retry fails the same way. CI does not run the build (**R4-32**). Vercel not tried. |
| 2a | Throwaway Postgres 16 | Done | stopped and deleted afterwards |
| 2b | `supabase/tests/shim.sql` | Pass | |
| 2c | `supabase/schema.sql`, run 1 | Pass | 0 errors |
| 2d | `supabase/schema.sql`, run 2 | Pass | 0 errors |
| 2e | Dump diff (CI's pg_dump recipe) | Pass | schema dump 11,721 lines, data dump 1,020 lines; both diffs empty |
| 2f | `credit-smoke.sql` | Pass | last notice `batch 27 actions ok` |
| 2g | `pack-smoke.sql` | Pass | `pre-pack member ok … cap ok … backfill ok … meta event ok … pack paying facts ok` |
| 2h | `scan-days-smoke.sql` | Pass | 4 notices ok |
| 2i | SQL coverage of new functions | Gap | `btl_apply_screen` and `sync_live_mortgage_rate` have no SQL smoke test (**R4-48**) |
| 3 | `npm audit --audit-level=high` | 4 high, 0 critical, 15 moderate | shadcn, @shadcn/registry, zod below 4.6.6, body-parser 2.0–2.3; next 16.4.1 moderate, fixed in 16.4.6 (**R4-38**) |
| 4a | TODO / FIXME / "later batch" added | None in code | only prose: standout/reasons.ts:96 and its test; "not yet" null-state comments (btl/launch.ts:5, schema.sql:8089, :8115, si-actions/run-server.ts:261, voice/agent/tool-header-server.ts:12, briefing/store.ts:145) |
| 4b | ACCESS_COLUMNS | Unchanged | `git diff 42e68ea..HEAD -- src/lib/access.ts` empty; defined at access.ts:232; btl/schema.test.ts asserts nothing Batch 28 is an access column |
| 5a | Live project | Found | "ZacStayful's Project" |
| 5b | Batch 27–30 objects on live | Pass, 129 of 129 | 5 tables, 14 functions, 89 columns, 21 indexes; the 12 new or changed check constraints match HEAD exactly |
| 5c | Live settings | All present | table C |
| 5d | Batch 30 backfill on live | Complete | appendix E |
| 5e | Pack grants and balances on live | 0 and 0 | appendix E |

**Table B: crons and dry runs**

All cron paths in vercel.json (45 entries on 31 paths): alerts, listing-recheck, deal-alerts ×2, sms-alerts, market-warm, briefings ×2, sourcing ×4, picks-paused, daily-digest, credit-sweep, planning-signals, funnel-queue, crm-deliveries, monday-funnel, lead-retention, team-seats, marketplace-sweep, member-searches, demand-sourcing, low-entry-search ×3, deal-checks ×5, project-checks ×2, **btl-screen ×2 (04:50, 06:57, new)**, marketplace-recheck, activity-retention, feedback-retention, si-knowledge, si-chat, **si-actions (02:55, new)**, si-calls, standout ×2. The quiz-v2-backfill route is one-off, with no cron and an admin button on /admin/profiles.

| Route (new or changed) | Dry run | Writes anything on a dry run? | Evidence |
|---|---|---|---|
| btl-screen (new) | `?dry=1`, works even when the switch is off | No | screen-server.ts:299 (paid calls only when not dry), returns at :453 before all writes; rates read cache-only (:251) |
| quiz-v2-backfill (new) | `?dry=1`; admin `?quizV2=dry` | No | writes only `if (outcome.status === 'map' && !opts.dry)` (quiz-v2-backfill-run.ts:155) |
| si-actions (new) | `?dry=1` | No | four `select` counts and return (run-server.ts:520-528); counts capped at 1,000 (**R4-13**) |
| credit-sweep (changed) | `?dry=1` added | No | `previewDueGrants` reads only; `member_paid_again_at` is `stable` (schema.sql:8204) |
| market-warm (changed) | `?dry=1` | No | rate sync only reported on a dry run (route.ts:40-52) |
| si-calls (changed) | `?dry=1` | No (R3-137 fixed) | `const phoneCheck = dry ? false : await runRequestedPhoneCheck();` |
| si-knowledge (changed) | `?dry=1` | Model spend only (pre-existing, documented) | R3-131: housekeeping runs when the switch is off |
| team-seats (changed) | none | n/a | summary adds `held` |

Note: the admin "Run" for the BTL screen (admin/deals/actions.ts:221-224) runs a real, paid screen while `BTL_SCREEN_ENABLED` is off; the cron route refuses (route.ts:30). Listed as decision D23.

**Table C: settings added in scope, live value, admin control**

| Key | Live value | Admin control |
|---|---|---|
| pack_bonus_expiry_days | 30 | yes, /admin/lifecycle |
| pack_fresh_report_cap | 3 | yes, /admin/lifecycle |
| pack_picks_pause_days | 7 | yes, /admin/lifecycle |
| pack_early_offer_pence | 1500 | yes, /admin/lifecycle |
| pack_cost_target_pence / pack_cost_ceiling_pence | 190 / 250 | yes, /admin/lifecycle |
| pack_paying_headline_floor_pct / _target_pct | 10 / 22 | yes, /admin/lifecycle |
| pack_paying_rundown_paid_floor_pct / _target_pct | 35 / 50 | yes, /admin/lifecycle |
| places_cache_days | 90 | yes, /admin/lifecycle |
| home_blocker_card_day | 3 | yes, /admin/lifecycle |
| quiz_shorter_from | 2026-11-14 14:04:52 UTC | yes, /admin/lifecycle, /admin/profile |
| standout_min_checked_rent | 3 | yes, /admin/standout |
| si_action_enabled | true | yes, /admin/intelligence/actions |
| si_action_instruction_cap_pence | 2000 | yes, same |
| si_action_undo_hours | 24 | yes, same |
| si_action_stop_grace_seconds | 5 | yes, same |
| si_action_rate_per_hour / _per_day | 20 / 60 | yes, same |
| si_action_max_targets | 50 | yes, same |
| si_action_confirm_minutes | 10 | yes, same |
| briefing_ceiling_pence | 3 | yes, /admin/billing |
| btl_launch_from | null | yes, launch button on /admin/deals/btl |
| **btl_report_pence** (a member price) | 200 | **no** (**R4-31**) |
| **btl_finance** | icr 125%, loan 75%, stress +2% with a 5.5% floor, fallback 5.5% | **no** (**R4-31**) |
| **btl_costs** | agent 12%, repairs 8%, 1 empty month, insurance £25 pcm, safety £300 a year | **no** |
| **btl_rent** | comps 5/8, widths 10–25%, radius 5 km, 45 days … | **no** |
| **btl_standout** | min low ROI 6%, low over median 125% | **no** |
| **btl_bands** | 25,000 / 50,000 / 100,000 | **no** |
| **btl_benchmark** | min 30 deals, floor 10, steps 10/25/50 miles … | **no** |
| **btl_epc** | D £5,000, E–G £10,000, unknown £5,000 | **no** |
| **btl_flats** | spread 40%, ground rent £150, service charge £1,500 (London £2,500) a year | **no** |
| **btl_listing** | min lease 70 years, short lease 85 | **no** |
| batch29_pack_bonus_marked_at | marked 0, dated 0, lifted 0 (14 Nov 2026) | n/a (one-off stamp) |
| today_mix (changed: adds btl and "three") | all: btl 1, r2r 1, brrr 1, buy_str 2 … | no (none before either) |
| briefings_enabled (fresh-install default flipped to false, R3) | false | yes, /admin/billing |
| BTL shortlist cap (inside `deal_checks`) | no BTL fields on live yet (defaults used) | yes, /admin/deals |

### B. Review R3's fixes: the full table

From reader R1. Key: ✔ fixed at HEAD · ◐ partly · "n/a" copy, comment or docs · "none" no test covers it. Test paths are under `src/lib/` unless shown. The 7 Critical/High and 24 Medium rows marked "none" are **R4-34**.

| R3 id | branch | fixed at HEAD? | test | still holds after B27–30? |
|---|---|---|---|---|
| R3-2 (H) | r3a | ✔ /home redirect gone (next.config.ts:54) | tracking/wiring.test.ts "no redirect in next.config.ts hides a page" | yes |
| R3-3 (H) | r3a | ✔ reveal recorded + stamped in `beforePricing` before `offerPricingFor` (welcome/reveal/page.tsx:57-67, view-server.ts:163→166) | **none** | yes (B29 added the pack read at :166, after the stamp) |
| R3-4 (H) | r3a | ✔ label and server both use `offeredPmiAddonFor` (reports/[id]/page.tsx:48-49, analysis/pmi-addon.ts:97) | **none** (R2-2's firstDeepPatch test only) | yes (B29 adds `pmiTopUp`, same price fn) |
| R3-73 (L) | r3a | ✔ addRevealShown deleted; schema comment schema.sql:5970 | n/a | yes |
| R3-1 (C) | r3b | ◐ code ✔: `{chat_speak_quick_cost}`/`{chat_speak_full_cost}` (placeholders.ts:350-351), seed chat_voice re-drafted (seed.ts:460), charge shown under answer (`voiceCharged`). **Live answer still the old one until Zac approves the draft** (README §26 step 3) — code-only | chat/voice-rules.test.ts "priced from the character row"; seed/placeholder suites | yes |
| R3-7 (H) | r3b | ✔ `spokenReply` only when `state === "answer"` (QuickChat.tsx:99, FullChat.tsx:155) | **none** | yes (B27's new reply fields don't speak) |
| R3-8 (H) | r3b | ✔ one follow-on per tap (voice.ts:199, 341; voice-rules.ts:22) | voice-rules.test.ts "listens again once per tap" | yes |
| R3-31 (M) | r3b | ✔ `maxBasePence` + `requireCredit` (api/speak/route.ts:54, api/chat/listen/route.ts:77) | none | yes |
| R3-84 (L) | r3b | ✔ heard seconds = last word's end, capped at the seconds declared (listen/route.ts:110) | voice-rules.test.ts "charged for what was heard" | yes |
| R3-11 (H) | r3c | ✔ code guard: member_briefings probe → 200 `schemaMissing` (briefing/runner.ts:127-129). Running schema on live: code-only, not verified | **none** | yes |
| R3-16 (H) | r3c | ✔ `charged` flag; claim released only when `!charged && !reclaimed`; finish retried once (runner.ts:215-216, 280, 315-316) | **none** | yes (runner untouched by B27–30) |
| R3-68 (M) | r3c | ✔ seeds `briefings_enabled` 'false' (schema.sql:6991) | none | yes |
| R3-62 (M) | r3c | ✔ `markBriefingEmailed` only when the email carried the briefing (picks-run.ts:1700, digest-run.ts:460); seen-mark needs `emailed_at` (marks-server.ts:24) | none | yes (B29's picks-run/digest edits kept it) |
| R3-70 (M) | r3c | ✔ `logHouseCall` at £0 (runner.ts:283, 360-365) | none | yes |
| R3-127 (L) | r3c | ✔ day counts on /admin/briefings (briefing/admin-server.ts:37) | briefing.test.ts "stored day counts join" | yes |
| R3-135 (L) | r3c | ✔ reclaim reads `actionSpend` and stores it (runner.ts:214, 227-233) | none | yes |
| R3-119 (L) | r3c | ✔ VAGUE_QUANTITY_WORDS + month dates (briefing/forms.ts:136) | briefing.test.ts "vague quantities and month-name dates" | yes |
| R3-120 (L) | r3c | ✔ at most four words (briefing/facts.ts:94) | none | yes |
| R3-154 (L) | r3c | ✔ .env.example:598-599 | n/a | yes |
| R3-121 (L) | r3c | ✔ hold set before the first await (runner.ts:194-201) | none | yes |
| R3-122 (L) | r3c | ✔ `cappedTokens` (runner.ts:353) | decide.test.ts "never past the ceiling" | yes |
| R3-111 (L) | r3c | ◐ **deferred**: "a crash between them is noted in the PR, not fixed here" | none | unchanged (R4-35) |
| R3-142 (L) | r3c | ✔ `briefing_ceiling_pence` row (schema.sql:6993) | decide.test.ts "the ceiling is a setting" | yes |
| R3-123 (L) | r3c | ✔ TIME_BUDGET_MS 25 s, writer timeout bounded (runner.ts:65, 270) | none | yes |
| R3-5 (H) | r3d | ✔ `textChargeStep` in all four callers (fallback-server.ts:70, tools-server.ts:174, nudge-server.ts:214, notify-server.ts:316) | voice/charge.test.ts "R3-5: a text is charged only when Twilio took it" | yes (B29 only changed which credit pays) |
| R3-61 (M) | r3d | ✔ copy (account/notifications/SmsSection.tsx:40) | none (copy) | yes |
| R3-59 (M) | r3d | ✔ stamp given back when nothing went; slot claimed only by a follow-up that went (fallback-server.ts:40-95) | partial: fallback.test.ts (followUpChannels) | yes |
| R3-26 (M) | r3d | ✔ `debitFor(guardId)` re-read (voice/charge-server.ts:128-133) | none | yes |
| R3-78 (L) | r3d | ✔ via sendMemberText (fallback-server.ts:69) | none | yes |
| R3-79 (L) | r3d | ✔ contact-card/auto-topup via sendMemberText (tools-server.ts:173) | none | yes |
| R3-103 (L) | r3d | ✔ by stating it: "outside the alert cap" (SmsSection.tsx:39-40) | n/a | yes |
| R3-75 (L) | r3d | ◐ minutes guard released on a lost debit (charge-server.ts:134-137); text/email guards kept on purpose | none | yes |
| R3-116 (L) | r3d | ✔ slot deleted (tools-server.ts:90) | none | yes |
| R3-152 (L) | r3d | ✔ provider_calls row for free/test calls, `bypass` (charge-server.ts:146-153) | none | yes |
| R3-81 (L) | r3d | ✔ kind 'call' (schema.sql:2763) | none | yes |
| R3-82 (L) | r3d | ✔ followUpChannels (voice/fallback.ts) | fallback.test.ts "R3-82" | yes |
| R3-12 (H) | r3e | ✔ `toldAt` → 'already' (standout/nudge.ts:40-52, nudge-server.ts:105) | nudge.test.ts "R3-12"; low-credit.test.ts "R3-12" | yes |
| R3-14 (H) | r3e | ✔ `lowCreditStillDue` at dial (voice/queue-server.ts:188; low-credit-recheck-server.ts) | **none** (server-only, no pure test) | yes |
| R3-15 (H) | r3e | ✔ LOW_CREDIT_NO_ROW (queue-server.ts:111, 147) | eligibility.test.ts "R3-15" | yes |
| R3-44 (M) | r3e | ✔ told stamp cleared (nudge-server.ts:236) | none | yes |
| R3-45 (M) | r3e | ✔ 'queued' in PLACED (nudge-server.ts:55); recheck 'nudged' | none | yes |
| R3-46 (M) | r3e | ✔ real balance (voice/templates.ts:191-194) | templates.test.ts "R3-46" | yes |
| R3-49 (M) | r3e | ✔ no slot claim before 08:30 UTC (voice/cap-server.ts:11-21) | none | yes (B29's picks-paused slot runs at 08:20 UTC, after the digest) |
| R3-24 (M) | r3e | ✔ same guard | none | yes |
| R3-25 (M) | r3e | ✔ row left ringing; `adoptableCallSid` (voice/run.ts:189) | adopt.test.ts (2 cases) | yes |
| R3-118 (L) | r3e | ✔ knowledge says pay-as-you-go (seed auto_topup_nudge) | generic seed tests | yes |
| R3-149 (L) | r3e | ✔ `claimEvent('nudge_send')` (nudge-server.ts:185) | none | yes |
| R3-6 (H) | r3f | ✔ `record_voice: false, delete_audio: true` (voice/agent/agent-config.ts:96) | agent.test.ts (record_voice off) | yes (sync needed, README §26) |
| R3-9 (H) | r3f | ✔ chat bullet + providers named (app/(marketing)/privacy/page.tsx:78, 127) | voice/privacy-page.test.ts "R3-9" | yes |
| R3-22 (M) | r3f | ✔ `user_id: null` on purge (voice/retention-server.ts:31) | none | yes |
| R3-47 (M) | r3f | ✔ fixed label (voice/sms-replies.ts) | sms-replies.test.ts "R3-47" | yes |
| R3-32 (M) | r3f | ✔ `asked: FACT_PROMPT` (chat/full-server.ts:366); checkFact on asked | knowledge/facts-rules.test.ts "R3-32" | yes |
| R3-129 (L) | r3f | ✔ force-dynamic, live settings (privacy/page.tsx:18, 50-51) | privacy-page.test.ts "R3-129" | yes |
| R3-100 (L) | r3f | ✔ deletes conversations and call rows (schema.sql si_question_retention, deletes at +37, +43) | partial: credit-smoke.sql calls it once | yes |
| R3-13 (H) | r3g | ✔ `passesMemberRules` (standout/run.ts:416; rules.ts:242) | standout/rules.test.ts "R3-13" | yes (B28 buy-to-let goes through the same line) |
| R3-60 (M) | r3g | ✔ 'waiting' / 'daily_limit' (run.ts:505-509) | none | yes |
| R3-51 (M) | r3g | ✔ reveal tops read without liveOnly (run.ts:367) | none | yes |
| R3-52 (M) | r3g | ✔ `bestAtLeast` per type (rules.ts:256-263) | rules.test.ts "R3-52" | **no for buy-to-let** (R4-27) |
| R3-53 (M) | r3g | ✔ null → wait (run.ts:365, 431, 483) | none | yes |
| R3-54 (M) | r3g | ✔ picks_off / quiet skip (rules.ts:161-162; server.ts:177) | rules.test.ts "R3-54, R3-64" | yes |
| R3-55 (M) | r3g | ✔ free opens count (today/checklist-server.ts:149-161) | none | yes |
| R3-20 (M) | r3g | ✔ unreadable member → wait | standout/notify.test.ts (R3-20) | yes |
| R3-64 (M) | r3g | ✔ quiet | rules.test.ts "R3-54, R3-64" | yes |
| R3-65 (M) | r3g | ✔ picks_off | rules.test.ts (same case) | yes |
| R3-71 (M) | r3g | ✔ switch off → wait (standout/calls-server.ts) | none | yes |
| R3-19 (M) | r3g | ✔ paid member judged on both windows (run.ts:324) | none | yes |
| R3-58 (M) | r3g | ✔ checked_listings by URL (standout/server.ts:256) | none | yes |
| R3-104 (L) | r3g | ✔ uidx excludes failed rows (schema.sql:7599) | none | yes |
| R3-138 (L) | r3g | ✔ 'gone' (run.ts:207, 463) | none | yes |
| R3-105 (L) | r3g | ✔ `deadlineMs` (notify-server.ts:119; nudge-server.ts:166) | none | yes |
| R3-108 (L) | r3g | ✔ null → no pool picks (listing/picks-run.ts:874-880) | none | yes (B29 kept it) |
| R3-140 (L) | r3g | ✔ dry run shows savedForYou + briefing (picks-run.ts:603-604) | none | yes |
| R3-109 (L) | r3g | ✔ `labelledSaves` (checklist-server.ts:187) | none | yes |
| R3-114 (L) | r3g | ✔ per-channel in order | notify.test.ts "R3-114" | yes |
| R3-115 (L) | r3g | ✔ retarget resets queued_at (notify-server.ts:232) | none | yes |
| R3-124 (L) | r3g | ✔ savedHead · phrase (notify/message.ts:569-570) | message.test.ts "R3-124" | yes |
| R3-150 (L) | r3g | ✔ per commit body (writeDealDecisions) | none | yes |
| R3-17 (H) | r3h | ◐ by design (Q5): consent, dry-run and call-sid checks (voice/inbound-server.ts:90-91, voice/inbound.ts); minutes need `si_calls` (charge-server.ts:177-181). Inbound still answers while SI_CALLS_ENABLED is off (Q5) | voice/inbound.test.ts "R3-17", "R3-50" | yes (B29 only changed the balance read) |
| R3-50 (M) | r3h | ✔ workspace secret, real call sid, no replay | agent.test.ts + inbound.test.ts "R3-50" | yes |
| R3-69 (M) | r3h | ✔ undecryptable secret logged/shown (post-call-webhook-server.ts:17-21) | none | yes |
| R3-136 (L) | r3h | ✔ `apiErrorText` | agent.test.ts "R3-136" | yes |
| R3-151 (L) | r3h | ✔ 404 → POST (voice/agent/sync-server.ts:199) | none | yes |
| R3-18 (H) | r3i | ✔ `and signup_path is null`, moved after the column (schema.sql:6762-6767) | **none** (§7 asked for a credit-smoke case) | yes (B30's backfill doesn't touch sourcing_alerts) |
| R3-83 (L) | r3i | ✔ named drop/add (schema.sql:6243-6246, 7772-7777) | credit-smoke.sql (R3-83 cases) | yes (B27–29 checks follow the drop/add pattern) |
| R3-125 (L) | r3i | ✔ schema.sql:7099 | credit-smoke.sql "R3-125" | yes |
| R3-126 (L) | r3i | ✔ credit-smoke Batches 24–26 block (credit-smoke.sql:375+) | itself | yes |
| R3-74 (L) | r3i | ✔ drop/add (schema.sql:6082-6084) | none | yes (B28 widened it inside the same block) |
| R3-96 (L) | r3i | ✔ `referred` on /admin/signups | tracking/report.test.ts | yes |
| R3-128 (L) | r3i | ✔ `listing_scan_days_backfill` stamped once (schema.sql:6702-6712) | supabase/tests/scan-days-smoke.sql | yes |
| R3-110 (L) | r3i | ✔ comment | n/a | yes |
| R3-153 (L) | r3i | ✔ one definition (schema.sql:7614) | credit-smoke calls it | yes |
| R3-10 (H) | r3j | ✔ verbatim hit (knowledge/match.ts:186) | match.test.ts "the seed's own questions … answered" | yes |
| R3-34 (M) | r3j | ✔ BANNED_GROUPS/phraseRe (chat/guard.ts:17) | guard.test.ts "banned advice …" | yes in the answer text; B27's new text under answers isn't checked (R4-12) |
| R3-35 (M) | r3j | ✔ worded units (guard.ts:31) | guard.test.ts "in words" | as R3-34 |
| R3-36 (M) | r3j | ✔ stream clear (full-server.ts:237, 274) | guard.test.ts "stream guard clears" | yes |
| R3-38 (M) | r3j | ✔ rounding only on spoken channels | persona.test.ts | yes |
| R3-33 (M) | r3j | ✔ falls through / "doesn't apply" (quick-server.ts:84-97) | chat/knowledge.test.ts (3 cases) | yes |
| R3-48 (M) | r3j | ✔ voice/agent/prompt.ts:25, 28 | agent.test.ts "why did you call me" | yes |
| R3-43 (M) | r3j | ✔ pronouns removed (knowledge/config.ts:134) | facts-rules.test.ts "pronoun" | yes |
| R3-21 (M) | r3j | ✔ "up to" | placeholders.test.ts "report_sections" | yes |
| R3-88 (L) | r3j | ✔ angle brackets stripped; quick box takes no figures from the question | guard.test.ts "angle brackets" | yes |
| R3-85 (L) | r3j | ✔ `isNonAnswer` (guard.ts:168; full-server.ts:311) | guard.test.ts "don't-know in the model's own words" | yes |
| R3-86 (L) | r3j | ✔ counts only | none | yes |
| R3-89 (L) | r3j | ✔ checkFact at proposal (chat/tools-server.ts:389) | none | yes |
| R3-97 (L) | r3j | ✔ documented as a template outside the knowledge base | n/a | yes |
| R3-76 (L) | r3j | ✔ phone line (persona/stayful-intelligence.ts:128) | agent/persona tests | yes. The chat's own line still says "passed it to the team" (Zac: keep it, §9.2) |
| R3-77 (L) | r3j | ✔ "say it's in the app" instruction | agent.test.ts "R3-77" | yes |
| R3-93 (L) | r3j | ✔ claim given back on cap or a passing failure | none | yes |
| R3-27 (M) | r3k | ✔ `lookUpFloorPence` (full-server.ts:98) | budget.test.ts "look-up floor" | yes |
| R3-28 (M) | r3k | ✔ "The solid chips are free; a dashed one is a question." (FullChat.tsx:297) | none (copy) | yes |
| R3-29 (M) | r3k | ✔ FullChat.tsx:161 | none (copy) | yes |
| R3-30 (M) | r3k | ✔ `faceHintPence` (chat/format.ts:12) | format.test.ts | yes |
| R3-40 (M) | r3k | ✔ `AbortSignal.timeout` (full-server.ts:209, 224) | budget.test.ts "what a round that threw means" | yes |
| R3-41 (M) | r3k | ✔ DEEP_SEARCH_ANCHOR + opens picks (FullChat.tsx:105) | chat/actions.test.ts | yes (B27 renamed the label to "Deep search", same anchor) |
| R3-56 (M) | r3k | ✔ si_text / si_email (credit/usage-label.ts:40-41) | usage-label.test.ts | yes |
| R3-87 (L) | r3k | ✔ gap measured from the last answer | none | yes |
| R3-101 (L) | r3k | ✔ today's rows keep user_id (chat/log-server.ts:194) | none | yes |
| R3-90 (L) | r3k | ✔ README §24 records the 2p/10p floors | n/a | yes |
| R3-106 (L) | r3k | ✔ queued_at within the day (tools-server.ts:308-317) | none | yes |
| R3-102 (L) | r3k | ✔ `for_profile` | none | yes |
| R3-117 (L) | r3k | ✔ About answers | none | yes |
| R3-98 (L) | r3k | ✔ CALL_TYPE_WORDS gone; member labels | standout/reasons.test.ts | yes |
| R3-112 (L) | r3k | ✔ stale filter (log-server.ts:191) | none | yes |
| R3-95 (L) | r3k | ✔ usage-label.ts:44-45 | usage-label.test.ts | yes |
| R3-67 (M) | r3l | ✔ `metricsExcludedIds` (chat/admin-server.ts:125) | chat/metrics.test.ts "excluded accounts" | yes |
| R3-63 (M) | r3l | ✔ `home_view: recordOnly` (activity/kinds.ts:40) | activity/kinds.test.ts "Home … never weekly active" | yes |
| R3-42 (M) | r3l | ✔ recorded in prepareFull (full-server.ts:107) | none | yes (B27's link-only path logs `listing_check` instead) |
| R3-91 (L) | r3l | ◐ ✔ for the main quick and full paths (quick-server.ts:214, full-server.ts:107), but r3j's "doesn't apply" path has no key (quick-server.ts:96) | none | R4-37 |
| R3-92 (L) | r3l | ✔ kinds.ts:238-240 | kinds.test.ts "chat's own actions" | yes |
| R3-107 (L) | r3l | ✔ reaction_clear on undo | kinds.test.ts (qualifying only) | yes |
| R3-66 (M) | r3m | ✔ `findDecidedGap` (knowledge/gap/run.ts:141) | gap/plan.test.ts "re-asked question" | yes |
| R3-37 (M) | r3m | ✔ 'routed' (quick-server.ts:188; voice/config.ts:88) | coverage.test.ts | yes |
| R3-57 (M) | r3m | ✔ in grouping (`coversChannels`) | plan.test.ts, prompts.test.ts | grouping yes; approving an entry still closes such gaps (R4-36, a path that predates B27) |
| R3-131 (L) | r3m | ✔ housekeepingOnly (api/internal/si-knowledge/route.ts:57) | none | yes |
| R3-132 (L) | r3m | ✔ comments | n/a | yes |
| R3-133 (L) | r3m | ✔ comment | n/a | yes |
| R3-143 (L) | r3m | ✔ VARIANT_MAX_CHARS (gap/run.ts:46) | none | yes |
| R3-144 (L) | r3m | ✔ `maxRetries: 0` (gap/models-server.ts:52) | none | yes |
| R3-145 (L) | r3m | ✔ afterDraftFailure | plan.test.ts "draft failure counts" | yes |
| R3-146 (L) | r3m | ✔ retired skipped (knowledge/seed-server.ts:29-33) | seed.test.ts "skips a retired entry" | yes |
| R3-147 (L) | r3m | ✔ reopen on retire (knowledge/store-server.ts:247) | none | yes |
| R3-148 (L) | r3m | ✔ 'no_price' (gap/run.ts:356) | plan.test.ts "missing unit row" | yes |
| R3-113 (L) | r3m | ✔ LIVE_CACHE_MS gone (no match in src) | n/a | yes |
| R3-72 (M) | r3n | ✔ at merge: next 16.4.1, @modelcontextprotocol/sdk 1.32.1 | n/a | **time has moved on** (R4-38) |
| R3-23 (M) | r3n | ✔ `delayMs: INTRO_DELAY_MS` (voice/triggers-server.ts:18) | config.test.ts / hours.test.ts "R3-23" | yes |
| R3-39 (M) | r3n | ✔ path-scoped flash (app/admin/intelligence/flash.ts:23-40) | none | yes |
| R3-130 (L) | r3n | ✔ exact counts (log-server.ts:230-231) | none | yes |
| R3-137 (L) | r3n | ✔ (api/internal/si-calls/route.ts:44; voice/agent/phone-check-server.ts:77) | none | yes |
| R3-99 (L) | r3n | ✔ voice/config.ts:23 | config.test.ts "outbound types" | yes |
| R3-139 (L) | r3n | ✔ 'held' (team/seats.ts:64) | team/rules.test.ts "seat is held" | yes |
| R3-134 (L) | r3n | ✔ per-turn lines on /admin/conversations | none | yes |
| R3-80 (L) | r3n | ✔ app/account/usage/page.tsx:43 | n/a | yes |
| R3-141 (L) | r3n | ✔ same as R3-113 (r3m) | n/a | yes |
| R3-94 (L) | r3n | ✔ chat/admin-server.ts:69 | none | yes |

**Zac's R3 §8 answers, checked:** Q1 (which ids) honoured: every id was built apart from one deferral (R3-111). Q3 (run the schema; r3c adds the guard): the guard is in (runner.ts:127), and every Batch 27–30 object is on live (appendix A, 5b). Q4 (voice price, option (a)): honoured; the price comes from `elevenlabs:character` × markup × each surface's word cap, as two placeholders, in a draft that clears for members only once Zac approves `chat_voice`. Q5 (callbacks while calls are off): honoured. Q7 (next bump): honoured at merge (16.4.1); new advisories since (**R4-32**, **R4-38**).

### C. Checked and found clean

One line each, merged from all readers and second readers.

**Credit and charging**
- One Full-analysis charge path for buttons and SI: si-actions/steps-server.ts:321 → `startDealAnalysis`, with a unique claim.
- One £2 BTL report path: steps-server.ts:333 → `runBtlReport`, charged once after the save (report-server.ts:282-296); no double charge on retry (already-done check :152-154; pending unique index schema.sql:8096); never charged on failure (:208-212); a debit failure leaves it free, never doubled (:285-297); welcome price once (schema.sql:8094).
- Nothing in si-actions calls debit or reserve itself; every SI charge is the button's own code (run-server.ts:22, 337-343).
- SI steps are claimed queued → running once (store-server.ts:241-245; run-server.ts:74, 322); a Stop between read and claim wins (:324-327); one plan per turn; a replayed question returns the stored card (full-server.ts:83, 103).
- SI's £20 limit is enforced server-side (spend.ts:202-213; deferred steps), not by the prompt.
- No SI step for anything on the never-list (si-actions/config.ts:22; validate.ts:188-192); deals must come from this answer's look-ups (validate.ts:161-165); links must be in the member's own message (validate.ts:313); removing a deal type needs removal words (validate.ts:115-132).
- A paused seat gets no charged step and no "yes" (api/si/actions/[id]/route.ts:72, 83).
- Undo of Keep/Pass involves no credit, restores only when unchanged since, and cannot run twice (undo.ts:145-158; undo-server.ts:48-49, 59-68).
- The pack bonus scope list matches in TypeScript and SQL (pack-rules.ts:57; schema.sql:762-766), with a test.
- Every debit caller was checked against the bonus list: only `deal_open` (marketplace/open.ts:201), `cron:sourcing` (picks-run.ts:1579-1580), `todays_5` (daily-deals-server.ts:95) and reused `full_analysis` (deal-analysis.ts:695-704) reach the bonus.
- Cron metered calls carry no member id, so they are never billed to a member (picks-run.ts:695, 761, 1233; credit/meter.ts:118).
- Fresh-report cap claimed under the profile lock before any hold (schema.sql:8323-8338); released on fail, abandon and reuse (deal-analysis.ts:185, 246, 710).
- The pack bonus grant is idempotent on its source under a row lock, so a webhook replay grants nothing twice.
- A refund into an expired bonus goes back to the same grant (schema.sql:952).
- The pack bonus cannot pay for the £2 report (`spendableFor(payer, 'btl_report')`, report-server.ts:165; pack-rules.test.ts:28).
- The bonus expiry and the offer / £5 same-day rule use Europe/London (pack-rules.ts:133-136, 227-231).
- Voice charges: lost-reply debits read back, minutes release their guard, texts and emails never re-send; every text charge (4 callers) survives Batch 29's balance change.
- Places cache hits are logged at 0p (google-places.ts:110; costs.ts:72).
- The briefing never charges twice under one action and is capped at its ceiling (runner.ts:186-320, 348-358); untouched by Batches 27–30.
- Every ledger action used in scope has a usage label (usage-label.ts:16-46).
- PMI add-on label and charge share `offeredPmiAddonFor` (reports/[id]/page.tsx:48; pmi-addon.ts:97; offers-server.ts:87-91).

**Free vs paid (48h) and addresses**
- SI: a step may only name a deal this answer's look-ups returned, and each look-up goes through `dealCardsByIds(ids, visibility)` (tools-server.ts:155, 209; plan-server.ts:69; steps-server.ts:168); `startDealAnalysis` re-checks visibility (deal-analysis.ts:299).
- BTL pools go through the visibility cutoff; new BTL-only rows get `live_since` from the trigger (schema.sql:1999-2010); the report checks `dealVisibleTo` (report-server.ts:128-130).
- Standout judges both windows and needs `visibleNow` for free members (standout/run.ts:313-324).
- The daily email filters by `live_since` and the profile's types (notify/daily-server.ts).
- Briefing counts use the member's visibility (briefing/sheet-server.ts:132-144).
- Explorer BTL shows district aggregates only (api/explorer/btl/route.ts).
- BTL card has no address, postcode or link (btl/card.ts:7-11), guarded by leak.test.ts; the report stores outcode and area only (btl/report.ts:8-10, 66-88).
- SI steps and cards name deals by type and outcode only (plan-server.ts:56-60); drafts need an opened deal and never go to the model (draft-server.ts:42, 68-79); chat deal facts carry town and outcode only (tools-server.ts:112-133).
- Public area counts and the teaser exclude BTL-only rows (queries.ts `countsByArea`).
- The pack offer and Home card carry no deal content.

**Dry runs, schema, access and security**
- Every dry run in scope writes nothing (appendix A, table B).
- Schema is idempotent: two runs, empty dump diffs; every new table is `create table if not exists`; every new check is drop-and-add (R3-83's pattern holds; R3-74's block widened in place, schema.sql:6081-6085); backfills are stamped and run once.
- Every Batch 27–30 table, column, function and index is on live (129 of 129), and the 12 changed checks match.
- New tables (si_instructions, si_action_steps, btl_benchmarks, btl_reports, pack_fresh_reports) have RLS on with no policies, plus revokes from anon and authenticated.
- All 15 new or replaced functions are revoked from public, anon and authenticated.
- New routes check the user (`getUser`) or admin (`isAdminEmail`); internal routes use `authoriseInternal`; the SI action route is scoped to the session's member with a same-origin check.
- ACCESS_COLUMNS unchanged (access.ts:232).
- `cookies()` inside `after()` in the full chat route is supported in Route Handlers (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:60-66).
- The BTL screen claims its spending cap before spending; an unreadable day reads as cap spent (screen-server.ts:211-213, 290-295).
- BTL maths guards bad input: no card on a bad price or rent (deal.ts:181-182); a missing rate uses the fallback and says so; damaged ranges rejected (card.ts:158-178); settings bounded with defaults (config.ts:208-378).

**R3 fixes surviving later batches**
- `/home` is not redirected (next.config.ts:47-68), and the wiring test fails on any redirect that hides a page.
- Reveal order survives Batch 29's pack read (view-server.ts:163 stamp before :166 pricing).
- R3-18's backfill guard sits after `signup_path` exists (schema.sql:6751, 6762-6767); Batch 30's backfill touches no `sourcing_alerts`.
- Batch 29's picks-paused email runs at 08:20 UTC, after the 08:10 digest, so R3-49 holds.
- R3-13's member rules apply to BTL standouts too (standout/run.ts:416).
- Stream guard and non-answer check untouched by Batch 27 (full-server.ts:237, 274, 311); `ask_which` choices are figure-checked (tools-server.ts:382).
- R3-42's activity line survives Batch 27's rewrite (full-server.ts:107).
- The privacy page still names the chat and reads live settings (privacy/page.tsx:18, 50-51, 78, 127).

**Activity and Meta**
- `home_view` stays record-only; every new kind is classified (explorer_btl_toggle, home_blocker_dismissed, pack_offer_shown/accepted, si_chat_unhappy, si_chat_history_deleted, si_fact_declined record-only); SI's Keep/Pass/stage moves log with `by: stayful_intelligence` and are known kinds (activity/kinds.ts).
- The Pack → paying cohort excludes excluded accounts, admin and test emails on both the page and the CSV (activity/admin-server.ts:68-83); cohort weeks are UK Monday weeks (schema.sql:8461).
- Purchase and RepeatPurchase go once per member; server and browser share the key and event id (events.ts:51-56; conversions.ts:250-306); a blocked repeat pack sends nothing (webhook.ts:369-371).
- £0 invoices send neither Subscribe nor RepeatPurchase and write no payment row (events.ts `invoiceValue`; payments/rules.ts:74).
- SI-run Full analyses hand off to the same run route, so FirstReport still fires once (analysis/run/route.ts:79).
- touch.ts never reads white-label, admin or token pages (surfaces.ts:33-45; touch.ts:135).

**Batch 30 quiz**
- The two cash questions read differently (Quiz.tsx label pill; questions.ts:455-469, 614-627); setup is asked first.
- Retired ids still parse and are still read (questions.ts:786-821; state.ts:62-74); the server refuses non-editable retired questions.
- Nobody re-answers a mandatory question: PREDECESSORS + `markFor` drive progress, the gate and reset (state.ts:142-159; profiles/reset.ts:157).
- Optional "Not sure" answers never throw or zero Today or the counts.
- An R2R member with no Buying cash has no cash ceiling anywhere (clean).
- Backfill: dry run writes nothing; writes guarded by updated-at; each rule idempotent; never overwrites an existing `cashAvailable`; time budget with "press Run again"; prints short ids only. Admin Run is behind `isAdminEmail`; the internal route returns 404 with no secret.
- Live rate SQL refuses a null, negative or > 25 rate, never touches `market_goals_updated_at`, is re-run safe and service-role only.
- Rate line and reset work ("change" → `/welcome?q=finance&next=…`; "Use today's average" when `rateSet`); BTL cards show no rate line (card-view.ts:174).
- The profit-end helper is used by Today, Browse, the email picks and must-have counts through `judgeDeal` → `checksFor` (criteria.ts:478); only standout differed (**R4-03**).
- The Home blocker card is due from `home_blocker_card_day`, hidden once answered or dismissed, behind the pack cards.
- Knowledge: 22 new entries in scope, all drafts, no typed figure in any new answer; service-facts.ts updated for Batches 27–30.

### D. Refuted findings and corrected sub-claims

| Id | What was claimed | What the second reader found |
|---|---|---|
| **R6-9** (refuted) | BTL and short-let figures use different snapshots of the live rate | Both read the same cache: the BTL screen runs at 04:50 and 06:57, right after the 04:45 sync, and rewrites every live row's lens. With the screen off there are no BTL cards to go stale. Zac's rule anyway: BTL keeps the live rate for everyone (V-D). |
| R4-5 / R2-3 (examples) | A price change, or different finance inputs, makes "Report ready" wrong | The input key holds listing attributes only ("The price is deliberately not in it", deal-input.ts:80-82). Only a listing-attribute edit or the 200-id slice triggers it (V-C). |
| R5-11 (figure) | "Under £100k" lets in about £180k purchases | About £150k (V-D). |
| R3x-6 (seed part) | `btl_add` still names the retired bands | seed.ts:564 already says Buying cash; only service-facts.ts:49 remains (V-D). |
| R2-6 (part) | The tool's retired fields all fail | Mostly wrong: `budget` is re-routed for cash members and `max_rent` gives a clear message; BTL works when sent (V-D). |
| R2-4 (part) | The "switched off" note can show | Cannot be reached: link-server.ts:35 falls back to the normal chat (V-D). |
| R3x-1 (fix) | Read settings in BuyToLetInstead | It is a client component; work the figure out in analysis/run.ts instead (V-D). |
| R4-8 (fix) | Never cache an empty Places answer | Empty answers are often genuine; use a short cache time (V-C). |
| R7-5 (fix) | `allowNegative: !mustAfford` | That would give a free report; fail before the run instead (V-C). |
| R8-3 (fix, count) | Guard the write with "only when null"; 5 callers | The guard is wrong for the hiccup case (the profile already holds an id); there are 7 callers (V-B). |
| R1-2 (fix) | Ignore match % for BTL | Also ignore entries with no deal type (V-B). |
| R1-7 (fix) | Check `offerAmount` with `checkFigures` | It is already a number; carry the raw text (V-B). |
| R6-2 (fix) | Use the BTL cash in in `checksFor` | Deal facts do not carry it yet; add it first (V-D). |
| R5-12 (detail) | The Buying cash row is blank | It reads "Not answered yet" (V-A). |
| R5-9 (detail) | Answering `property` writes no old mark | It does write `property_type`; the flat/house half still changes nothing for R2R-only members (V-A). |
| R7-6 (risk) | A typed figure can reach members | Approval's number check blocks a draft with digits (V-A/V-B). |
| R4-7 (status) | A bug | It matched the written rule (pack-rules.ts:37-39); Zac has now changed the rule (V-C). |
| R6-3 (scope) | Missing `country` is a Batch 30 bug | It predates R3's base (42e68ea:criteria.ts:361); log it separately (V-A). |
| R6-4 (fix) | Pass funding into `cashBandFromBudget` | It has another caller (the backfill); Zac's rule now avoids it on this path (V-D). |
| R5-1 / R7-1 (severity) | High: members lost their chosen rate | Did not happen on live: first sync on 19 Nov 2026, after the backfill; 0 lost (coordinator SELECTs). |
| R8-4 (extra) | — | The real run's `update(...).select('id')` may also be capped at 1,000 rows (code-only; check when fixing **R4-13**). |

### E. Live reads (SELECT only; counts only)

Project "ZacStayful's Project", read on 19 Nov 2026. No member's email, name, id or address was read into this report.

| What | Count or value |
|---|---|
| Batch 27–30 objects present | 129 of 129 (5 tables, 14 functions, 89 columns, 21 indexes); 12 changed checks match |
| New settings | all present, all at their defaults (appendix A, table C) |
| `quiz_shorter_from` | 2026-11-14 14:04 UTC |
| profiles | 60 total, 15 with goals |
| profiles on legacy R2R setup bands | 0 |
| profiles on the new setup bands | 6 |
| profiles with Buying cash worked out from a budget | 4 |
| profiles with `rateSet` | 1 |
| profiles with a synced rate | 14 (latest `rateAsOf` 2026-11-19) |
| unsynced custom rates left unprotected | 0 |
| search_profiles (not deleted) | 60 total, 16 with criteria; same 0 / 6 / 4 / 1 / 14 / 0 |
| First rate sync day | 2026-11-19 |
| Members with a real pre-Batch-30 rate answer | 1, of whom marked as their own (`rateSet`) 1, possibly lost 0 |
| `starter_pack_from` | null (pack off) |
| pack_bonus grants | 0 (lifted 0) |
| starter_pack_purchases | 0 |
| Batch 29 backfill stamp | marked 0, dated 0, lifted 0 |
| Members with a negative live balance | 0 (one member holds three negative adjustment rows but nets at or above £0) |
| si_instructions | 8 rows |
| btl_reports / btl_benchmarks | 0 / 0 |
| marketplace_deals with a BTL lens | 0 (the BTL screen has not written yet) |
| pack_fresh_reports | 0 |
| `listing_scan_days_backfill` | stamped 2026-10-16 (28 days, 1,572 rows) |
| Vercel production deploy of `8bdbf9d` | READY (built about five days before this review) |
