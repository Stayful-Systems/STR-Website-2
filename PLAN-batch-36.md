# PLAN — Batch 36: customer websites, Phase 4 — self-edit, change requests, admin console, grace and switch-off

Planned against origin/main `0dd39a7` (re-checked 20 Nov 2026: main has not moved). Review R6 is NOT on main; Zac said build now.
Branch: `claude/awesome-dirac-e9ybuw` (the harness branch for this session; it replaces `claude/eager-archimedes-76jy4p` named in the brief, as Batch 33 did).
No spec file in the repo: Zac's brief and this checklist are the spec.
Baseline: `npm test` 3989 pass / 0 fail, `npm run lint` 0 errors (79 pre-existing warnings), `npm run build` passes.

## Rules for every phase
- Read CLAUDE.md and AGENTS.md. Graphify first. Read `node_modules/next/dist/docs/` before a route, page, layout or server action.
- Do not change the plan. If something breaks it, stop and report.
- Never touch: `src/lib/access.ts` (reading `accountStatus` is fine), `src/lib/leaddb/**`, `src/lib/funnels/charge-server.ts`, `tiers*.ts`, funnels pricing, Batch 35 ad sheets and outcomes, `src/lib/tracking/**`, `src/proxy.ts`, `src/app/f/**`, `src/lib/websites/report-server.ts`, the Batch 31/32/33 schema blocks (append after them only).
- Touch minimally (list every changed line): `copy-server.ts`, `domains/host-server.ts`, `domains/purchase-server.ts` (only `allowRenewal` beside `blockRenewal` if needed), `app/s/[slug]/layout.tsx`, `leads/setup/website/Notice.tsx`, `leads/website/LeadPanel.tsx`, `admin/management/WebsitesPanel.tsx`, `notify/cap.ts`, `activity/kinds.ts`, `domains/schema.test.ts`, `.github/workflows/ci.yml`, `vercel.json` (one line).
- Log lines carry ids and codes only: never an address, an email body or a change-request text.
- Every dry run writes nothing, sends nothing and claims no slot; a fake that counts writes pins this.
- Knowledge drafts: placeholders from settings, never typed figures, never approved in code (Phase 9).

## Progress
- [x] Phase 0 — Prep
  Notes: main still `0dd39a7`. Baseline test 3989/3989; lint 0 errors; build passes.
- [x] Phase 1 — Schema and settings
  Notes: block appended after Batch 33 (5 tables, 2 functions, 3 seeds, 2 websites columns). Local Postgres 16: shim + schema run 3 times, schema/data/index dumps identical; websites-p4-smoke.sql passes (stale base, 11th publish leaves 10, snapshot twice = one v1, notice pk no-op, delete-restrict still holds); older smokes still pass. Deviation: domains/schema.test.ts already bounds at the next header so is unchanged, but src/lib/websites/settings.test.ts read to end of file and would have matched the new website_* seeds: bounded it at the next header (2 lines). Warning-days seed is the JSON string "30,14,3" (not valid bare JSON). Stage in website_grace_notices = the warning's day count.
- [x] Phase 2 — Pure rules (edit-rules, grace-rules, kinds, cap)
  Notes: edit-rules (changedFields, pagesToRewrite(before, after) incremental: the edit run passes the draft before and after each patch so an approved page is not asked for again; filesInUse/filesToDelete; ukMonth/rewritesLeft/takeRewrite). grace-rules adds one state beyond the plan's list: `start` (begin an episode; the cron writes the row then asks again). Stage = the warning's day count; the most imminent due stage is sent, earlier ones skipped; a plan ending in <30 days still gets a 30-day first warning (switch-off = first warning + 30). Deletion reads the delete-days setting now, not the stored delete_on. kinds.ts +4 lines, cap.ts +5 lines (SendKind, SLOT_FOR, SWITCHES_BEHIND).
- [x] Phase 3 — Edit server (edit-run, edit-server, copy-server `only`)
  Notes: copy-server.ts: +28/-3 lines (kind 'edit'; `only` gains an optional `base` so the other pages stay as they were; only-mode skips the whole-site check, Publish runs it; the allowance is the caller's). website_version_publish now also returns version_id (for the website_version:<id> dedupe key; create or replace, smoke pins it). Pending pages in website_drafts.pending_pages carry a prefix: w:<page> = still to write, a:<page> = written, awaiting approval. A failed fetch reverts: live settings/copy back, the new version row removed, the draft re-inserted (a version pruned by that publish is not brought back). 23 run tests + 4 source pins.
- [ ] Phase 4 — Operator edit screen
  Notes:
- [x] Phase 5 — Change requests
  Notes: built by a forked helper, checked by me. Added edit-requests-store.ts (live Supabase wiring; outside the plan's file list so the engine stays injectable; Phase 8 reuses it via liveRequestsEngine(): adminList, adminSetStatus, adminScreenshotUrl, openCounts). Feedback status emails go OUTSIDE the daily cap (direct replies), so the done/declined email does too. Next caps a Server Action post at 1 MB including text and next.config.ts is off limits, so the form refuses screenshots of 900 KB or more (server rule stays under 1 MB). 30 tests.
- [ ] Phase 6 — Grace server, cron and emails
  Notes:
- [ ] Phase 7 — Switched-off public page
  Notes:
- [ ] Phase 8 — Admin website console
  Notes:
- [x] Phase 9 — Knowledge drafts
  Notes: 3 new placeholders (website_abandon_days, website_warning_days ("30, 14 and 3"), website_delete_after_days), strict like the others; 6 draft entries in seed.ts (edit yourself, change requests, switch-off, switch-off for plan/unpaid with the two existing conditions, deletion, switch back on) — one more than the plan's five because the 600-character answer limit forced the switch-off entry to split; a CUSTOMER WEBSITES: EDITING AND SWITCH-OFF block in service-facts.ts. No figure typed anywhere (the monthly rewrite limit and version count are deliberately not stated). 69 knowledge tests pass.
- [ ] Phase 10 — Final checks, push, PR
  Notes:

## Order
After Phase 2: Phases 3, 5 and 6 can run in parallel (different files). Phase 9 any time after Phase 1. Then Phases 4 and 7, then 8.

## Decisions (Zac, 20 Nov 2026)
- Q1–Q4 all defaults. Warnings count towards the daily cap; they wait a day, but on the day before switch-off they are sent anyway.
- Leads stay in SI under lead retention. No limit on change requests.
- Company name can change; the domain stays; a new domain is a change request.
- Edit rewrites: 10 per calendar month (`WEBSITE_EDIT_REWRITES_PER_MONTH`), separate from setup's 10.
- Cancelled: switch off on the plan end date when known 30+ days ahead; otherwise 30 days after the first warning.
- No new status: switch-off = `status='paused'` + `website_grace.switched_off_at`; deleted = `website_grace.deleted_at`.
- Edits go to `website_drafts`; the live site changes only on Publish (full `goLive` checks and page fetch); a failed fetch republishes the previous version.
- Edits never delete files on replace; a file is deleted only when no live/draft/last-10 version refers to it.
- Deletion keeps a stub `websites` row; leads, lead_sources, report rows, charges, domain records and the funnel row are never touched.

## Zac's click-through (after merge)
1. Run `supabase/schema.sql`; the site loads. Create the private bucket `website-requests`.
2. As a test operator: change logo and phone, preview, publish; live site updates. Restore the previous version.
3. Change the areas: the new area page is written and asks for approval before Publish.
4. Send a change request with a screenshot; see it in `/admin/websites`; mark it done; the operator gets an email.
5. Admin: set the test site's owner `last_seen_at` 61 days back and its last lead older too. Grace cron Dry run lists the 30-day warning. Run: one email. Run again: no second email.
6. Log in as that operator: `/leads/website` and the console show no pending switch-off.

## Review notes
(filled in Phase 10)
