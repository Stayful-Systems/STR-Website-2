# PLAN — Batch 37: customer websites, Phase 5 — transfer the site and domain to the operator

Planned against origin/main `839a004` (20 Nov 2026). Build started 21 Nov 2026 from origin/main `a3cae75`
(Batches 38a and 38b merged since; they only append to `schema.sql`, `ci.yml`, `vercel.json`, `activity/kinds.ts`
and changed `src/app/api/s/[slug]/lead/route.ts`, which this batch never touches). So the never-touch diff check
runs against `a3cae75`, not `839a004`.
Branch: `claude/quirky-hawking-l67xw6` (the harness branch for this session). Worktree: `/home/user/STR-Website-2`.
Claim issue: none (the repo has no build index or claim issues). Open PRs #1 and #18 are old and touch nothing here.
No spec file: Zac's brief plus this checklist are the spec. Blockers: `docs/build/batch-37-BLOCKERS.md`.

## Context
An operator who leaves can take their website and their .co.uk domain with them, free once paid up. They get the
site as plain files with a guide, the domain moves to the provider they choose, and our copy keeps serving for 30
days so nothing goes dark. Their exported form keeps sending leads into SI and their lead database for good. With a
paid plan, leads get a report as normal (when billing is on). Without a plan, enquiries are captured and pushed to
the lead database without a report and never charged.

## What recon found (the plan handles each)
- Nominet retires the IPS tag on 9 Feb 2027; after that `.uk` transfers use a Transfer Authorisation Code. Build both
  methods, switch on a date held in a setting (`website_transfer_code_from`).
- Openprovider has no .co.uk tag-change call (Batch 33 `changeIpsTag` always refuses). The engine calls it once; a
  refusal makes the tag step a manual admin step ("Tag changed" button). The fake registrar records the call.
- The current lead endpoint needs the site live, JSON, CORS and Turnstile. New endpoint `/api/t/<ref>/lead` takes a
  plain HTML form post, needs no JavaScript and does not care whether the site is live.
- Pages cannot be rendered in tests (no .tsx loading). Export by fetching our own rendered pages from a token-protected
  export page, then a pure, tested converter makes static files; the app's CSS, fonts and images go in the zip.
- The export must work for paused or switched-off sites: the export page renders in preview mode for any non-deleted site.
- Old check constraints are re-added on every schema run, so no old constraint changes; all state lives in the new
  `website_transfers` table.
- Batch 36's grace cron and Batch 33's domain cron skip sites with an open transfer.
- At overlap end only the pause step is reused (no grace episode, no grace email). `release()` gets `{registrar:false}`.
- No zip library: small zip writer on Node zlib. `sendEmail` gains an optional `attachments` field (Q-C).
- Spam on a form with no Turnstile: honeypot, per-IP limit (5 per 10 min), funnel daily cap, existing free-report caps,
  strict address validation before any report runs.
- One site per member: "coming back" reuses the same row via an admin-started new setup.

## Zac's answers (20 Nov 2026)
- Q-A Both methods. IPS tag before `website_transfer_code_from` (2027-02-09), transfer code from that date. Tag step manual in Openprovider.
- Q-B Providers: 123 Reg (123-REG), Namecheap (NAMECHEAP-INC), IONOS (1AND1), GoDaddy (GODADDY), plus "Other: type its tag". GoDaddy and IONOS tags to be confirmed before launch.
- Q-C Zip attached when under 15 MB, otherwise link only; plus a Download button in the app for the overlap. `email/send.ts` gains optional `attachments`.
- Q-D Day 30: hosting stops only once the domain has moved (or there is none), or when admin clicks "End overlap now".
  `overlapDue = overlap_ends_at <= now AND (domain_state in (none, moved) OR forced)`.

## Decisions (brief; do not change)
Free once paid up · provider list · tag change (and the transfer code) · static files + guide by email · 30 days of
overlap · after transfer: paid plan → reports as normal, no plan → captured and pushed to the lead database, no report,
never charged.

## Defaults applied (Zac can override)
- Account owner only (`websiteActor()` → `ownerIdOrNull`).
- Exported form keeps posting to Stayful; the guide explains how to swap it.
- Coming back: admin clicks "Start a new setup" (dry run first); the row returns to setup; old exported form keeps working.
- "Paid up" = no unpaid row in `website_domain_charges` for the owner when `domain_charge_on` is on. Unpaid report charges do not block.
- A paused site can be transferred; a deleted site cannot. No domain yet → files only. Domain still being set up → refused:
  "Your domain is still being set up; try again once it is live."
- Cancel: admin only, only before the domain has moved. Cancelling allows renewal again.
- Exported pages are `.html` files with relative links. Static form fields: name, email, phone, property address,
  postcode, bedrooms, guests, consent, honeypot. No JavaScript. Thank-you page hosted by us, in the operator's name and colour.
- Weekly active: record-only kind `website_transfer_requested`.

## Rules for every phase
- Read CLAUDE.md and AGENTS.md. Graphify first. Read `node_modules/next/dist/docs/` before any route, page or server action.
- Do not change the plan. If something breaks it, stop and report.
- Never touch: `src/lib/access.ts` (reading `accountStatus` is fine), `ACCESS_COLUMNS`, `src/lib/funnels/**` pricing
  (`charge-server.ts`, `tiers*.ts`), ad packs and sheets (Batches 34/35/38), `src/lib/leaddb/**` (call `enqueueLeadDbPush` only),
  `src/lib/websites/report-server.ts` (call `runWebsiteReport` only), `src/app/api/s/[slug]/**`, `src/app/s/[slug]/**`,
  `src/proxy.ts`, `src/lib/websites/render.tsx`, `LeadForm.tsx`, `templates/**` (import only), `src/lib/tracking/**`,
  every earlier schema block (append only).
- Touch minimally (list every changed line in Notes): `domains/registrar/{types,openprovider,fake}.ts`,
  `domains/purchase-server.ts` (release option only), the domain cron's candidate query, the grace cron's candidate query,
  `activity/kinds.ts` (+1), `app/leads/website/page.tsx` (+1 link), `app/admin/websites/page.tsx` (+panel),
  `.github/workflows/ci.yml` (+1 smoke step), `vercel.json` (+1 cron), `email/send.ts` (attachments).
- Log lines carry ids and codes only: never an address, email, transfer code, form body or zip URL.
- Every dry run writes nothing, sends nothing and calls no registrar write; a fake that counts writes pins it.
- Knowledge drafts use placeholders read from settings, never typed figures, never approved in code.
- Env for builds: `NODE_OPTIONS=--max-old-space-size=6144`.

## Progress (phases)
- [x] Phase 0 — Prep (baseline npm test / lint / typecheck / build, record counts)
  Notes: main is a3cae75 (moved past 839a004 by Batches 38a/38b; all touch-minimally files only appended to). Baseline on a3cae75: npm test 4630 pass / 0 fail; lint 0 errors (79 warnings); typecheck clean; build passes. Never-touch diff checks use a3cae75 as the base.
- [x] Phase 1 — Schema and settings (deps: 0)
  Files: `supabase/schema.sql` (new block at end, header exactly `-- =========================\n-- Batch 37: customer websites, Phase 5 (transfer to the operator)\n-- =========================`), `supabase/tests/website-transfers-smoke.sql`, `.github/workflows/ci.yml` (+1 step), `src/lib/websites/transfer-settings.ts` (+test), `src/lib/websites/transfer-schema.test.ts`.
  Table `website_transfers`: id, website_id (fk restrict), owner_id, ref (unique, random), provider_key, provider_name, ips_tag, method (tag|code|none), domain_id, domain_name, snapshot jsonb, export_state (pending|ready|failed), export_path, export_attempts, export_error (≤200), export_ready_at, export_emailed_at, domain_state (none|pending|manual|requested|moved), tag_claimed_at, domain_requested_at, code_sent_at, domain_moved_at, stuck_alerted_at, moved_emailed_at, overlap_ends_at, overlap_ended_at, cancelled_at, cancelled_by, created_at, updated_at. Partial unique index: one open transfer per website (cancelled_at is null and overlap_ended_at is null); index on (owner_id). RLS on, no policies, revoked from anon/authenticated. Private bucket `website-transfers` (on conflict do nothing). Seeds in `billing_settings`: `website_transfer_overlap_days=30`, `website_transfer_stuck_days=5`, `website_transfer_code_from='2027-02-09'`. Comment says "Nothing here is in ACCESS_COLUMNS". Ends with `notify pgrst, 'reload schema';`. `transfer-settings.ts` uses the closed KEYS + parse + check pattern of `grace-settings.ts`.
  Notes: block appended at the end (121 lines, nothing removed). Postgres 16: shim + schema 3 times, identical schema/data/index dumps; new smoke and all older smokes pass; npm test 4649/0, lint 0 errors, typecheck clean. Choices the plan left open: owner_id and cancelled_by have no FK; domain_id references website_domains (restrict); ref = 32 hex chars from gen_random_uuid(); overlap_ends_at nullable; bucket accepts application/zip up to 50 MB; extra check that ips_tag matches the tag pattern. No existing test needed bounding. ci.yml +2 lines (1 step).
  Check: fresh Postgres 16: shim, schema three times with identical schema/data/index dumps; new smoke passes (second open transfer refused, ref unique, checks enforced); older smokes pass; schema test pins table, columns, RLS, revoke, no policies, not in ACCESS_COLUMNS; Batch 36 schema test still passes; `npm test` green.
- [ ] Phase 2 — Pure core (deps: 1)
  Files: `transfer-providers.ts`, `transfer-rules.ts`, `transfer-zip.ts`, `transfer-token.ts` (each with a test), `src/lib/activity/kinds.ts` (+1 `website_transfer_requested: recordOnly(...)`).
  Providers: the four in Q-B, each {key, name, tag, helpUrl}; "Other" tag checked against `^[A-Z0-9][A-Z0-9-]{1,30}$`. Rules: `methodFor(now, codeFrom, hasDomain)`; `canStart` refusal codes not_owner, deleted, no_pages, open_transfer, domain_not_ready, unpaid_domain; `overlapEndsAt(start, days)`; `overlapDue(row, now)` per Q-D; `stuckDue(row, now, days)`. Zip: `zipFiles(files)` → Uint8Array (deflate + CRC32; test reads the central directory back). Token: HMAC over `transferId.exp`, valid 15 minutes, same key source as `step-token.ts`; no key means no token.
  Check: unit tests cover both methods either side of 9 Feb, every refusal, the overlap date, stuck exactly once; `npm test` green.
- [x] Phase 3 — Registrar and domain touches (deps: 0; parallel with 2)
  Files: `domains/registrar/{types,openprovider,fake}.ts` (+tests), `domains/purchase-server.ts`, the domain cron candidate loader.
  Interface gains `transferCode(name): Promise<string>`. Openprovider reads the domain's `auth_code`; absent → `RegistrarError('refused')` (manual step); mark UNCONFIRMED for .uk until 9 Feb 2027. Fake returns a fixed test code and counts it as a write; fake `changeIpsTag` records the tag. `release(id, { registrar: false })` skips `setAutoRenew`. Domain cron skips domain ids whose website has an open transfer.
  Notes: touch-minimally lines (added/removed): registrar/types.ts +3/-1, openprovider.ts +14/-0 (transferCode, UNCONFIRMED for .uk until 9 Feb 2027), fake.ts +14/-4, purchase-server.ts +6/-4 (release option), cron-run.ts +4/-1, store-server.ts +9/-0 (transferredDomainIds). Deviation: src/app/api/internal/domains/route.ts +2/-1 (passes the new optional skip dep to the cron; the only way to wire the filter). The filter skips any transfer row with cancelled_at null; if that read errors the cron stops rather than act. Tests added: registrar/fake.test.ts, openprovider transferCode, release {registrar:false}, transferred-domain cron test.
  Check: registrar tests pass; release test shows no registrar call with `{registrar:false}`; cron test shows a transferred domain is not flagged; existing domain tests unchanged and green.
- [ ] Phase 4 — Export page and static converter (deps: 2)
  Files: `src/app/t/export/[token]/[[...path]]/page.tsx`, `transfer-export.ts` (+test), `transfer-guide.ts` (+test).
  Export page: verify token, load site by id (any status except deleted), `sitePagesOf`, render `<SitePage>` in a `siteThemeVars` wrapper with our `renderForm` outputting `<div data-transfer-form="<form key>">`; force-dynamic, noindex; bad token 404. `buildStaticSite({pages, htmlByPath, css, assets, formAction, siteName})` (pure): one .html per page; no script/preload/comment/`__next`; CSS → `assets/site.css` (fonts under `assets/fonts/`, url()s rewritten); relative `.html` links; images → `images/…`; form marker → static form posting to formAction; hand-written `assets/form.css`; canonical tag only when the site has its own domain. Guide (`GUIDE.html` + email text): upload folder, point domain, form keeps working, how to swap it, provider-specific step.
  Check: fixture HTML for every page `buildSitePages` makes; every page in the file map; no `<script`, `/_next/`, `/s/<slug>`, app host (except form action), other slug, supabase or env names; every internal link resolves; every form page has exactly one form posting to `/api/t/<ref>/lead`; privacy has none; `npm test`, `npm run typecheck` green.
- [ ] Phase 5 — Transfer engine and live wiring (deps: 2, 3, 4)
  Files: `transfer-run.ts` (+test, injected deps), `transfer-server.ts`, `transfer-emails.ts` (+test), `src/lib/email/send.ts` (+attachments).
  `startTransfer(ownerId, {providerKey, tag?, dryRun})`; `buildExport(id)` (3 failures → failed + admin email); `emailExport(id)` (direct, outside cap, key `website-transfer-files:<id>`, zip attached under 15 MB else link); `requestDomain(id)` (tag: claim update, one `changeIpsTag` call, refused → manual + admin email; code: emailed to owner, never stored or logged, refused → manual); `pollDomain(id)` (`registrar.info(name) === null` → moved, one email); `alertStuck(id)` once; `endOverlap(id)` (claim update; pause if live; `release(domainId,{registrar:false})`; delete zip; no grace episode/email). Admin actions: retry export, mark tag changed, send code (admin types it; emailed, not stored), mark moved, cancel (refused once moved; allows renewal), end overlap now, start new setup — each with dry run and run.
  Check (counting fakes): tag change called exactly once across two concurrent runs and never on a dry run; overlap end exactly once at 30 days, only once moved/none/forced, pauses the site; unpaid owner blocked; member cannot start for another's site; no code or address in any log line; cancel after moved refused.
- [ ] Phase 6 — Exported-form endpoint and thank-you page (deps: 1, 2)
  Files: `src/app/api/t/[ref]/lead/route.ts`, `transfer-intake.ts` (+test, injected deps), `src/app/t/[ref]/thanks/page.tsx`.
  Route reads urlencoded body + IP, calls intake, answers 303 to `/t/<ref>/thanks?r=<outcome>`. Intake order: find transfer by ref + site stub row; honeypot (quiet thanks); `countAttempt(funnelId, ip, dailyCap)`; `validateStepOne`; one-hour email dedupe; `captureLead(status:'new')`; `lead_sources` (landing = exported-site); `website_reports` row (awaiting_address); `enqueueLeadDbPush`; `notifyOperatorOfWebsiteLead`; then if owner `accountStatus === 'paid'` and `parseAnalysisInput` passes: save `leads.input` and `runWebsiteReport(leadId)` in `after()`; otherwise no input saved, no report, no charge. Thanks page uses the snapshot; "Back" link only for http(s) Referer origin; plain error page.
  Check: form post creates a lead and pushes it; no-plan lead has input null, `runWebsiteReport` not called, no charge RPC; paid-plan lead runs the report once; honeypot saves nothing; 6th post in 10 minutes refused; works after the site is paused and overlap ended; no log line carries the body.
- [ ] Phase 7 — Cron and grace guard (deps: 5)
  Files: `src/app/api/internal/website-transfers/route.ts`, `vercel.json` (+`"6-59/10 * * * *"`), grace candidate loader in `grace-server.ts` (+filter).
  Same guard as website-grace; `?dry=1` lists ids and step names and does nothing. 40-second budget, in order: build one pending export, email ready exports, request pending domains, poll requested ones, alert stuck, end due overlaps. Grace cron skips websites with a transfer row that is not cancelled.
  Check: dry run makes no writes, sends nothing, no registrar call; grace-run test shows a transferred site gets no warning; vercel.json test passes.
- [ ] Phase 8 — Operator screen (deps: 5)
  Files: `src/app/leads/website/transfer/{page.tsx,TransferForm.tsx,transfer-actions.ts,transfer-actions.test.ts}`, `src/app/leads/website/page.tsx` (+1 "Take my website" link).
  Pre-start screen: what happens, provider picker with each tag (or "Other: type its tag"), code-method line; "Check" step then Confirm → `startTransfer`. After start: status, Download link valid 10 minutes, domain status, overlap end date, "Email me the code again". Every action starts with `websiteActor()`; form read for `providerKey` and `tag` only.
  Check: source-read test pins `websiteActor()` first in every action and the form fields read; team member refused; build lists `/leads/website/transfer`.
- [ ] Phase 9 — Admin transfers panel (deps: 5)
  Files: `src/app/admin/websites/TransfersPanel.tsx`, `transfer-admin-actions.ts` (+test), `src/app/admin/websites/page.tsx` (+panel).
  Columns: operator email, site, provider, tag or method, files state, domain state, overlap ends, last error; manual step in plain words. Domains-panel pattern (dry run then run); `requireAdmin()` first; audit line `[admin] transfers: <admin> <kind> <id8>: ok|refused <code>`.
  Check: test pins `requireAdmin` first, dry runs change nothing, cancel refused after moved; build lists `/admin/websites`.
- [ ] Phase 10 — Knowledge drafts (deps: 1; any time after)
  Files: `src/lib/knowledge/seed.ts`, `placeholders.ts`, `service-facts.ts`.
  New placeholder `website_transfer_overlap_days` (strict, from settings); reuse the report-price placeholder and `website_report_charge_on` condition. Drafts (≤600 chars, no typed figure): `website_transfer_how`, `website_transfer_domain`, `website_transfer_overlap`, `website_transfer_form_after`, `website_transfer_come_back`. A "CUSTOMER WEBSITES: TRANSFER" block in `service-facts.ts`.
  Check: knowledge tests pass (every placeholder resolves; no answer types a figure).
- [ ] Phase 11 — Final checks, review, push, draft PR (deps: all)
  Run `npm test`, lint, typecheck, build; schema three times plus every smoke; `git diff a3cae75` empty for every never-touch file. Independent review (member transferring another's domain; secrets or another operator's data in the export; leads lost after overlap; schema idempotence; ACCESS_COLUMNS; dry runs; log lines). Fix and commit "Phase 11: Review fixes". Push and open a draft PR with Zac's click-through and the known limits.

Order: 0 → 1 → (2 ∥ 3) → 4 → 5 → (6 ∥ 7 ∥ 8 ∥ 9) → 11. Phase 10 any time after 1. Phase 6 needs only 1 and 2.

## Remaining risks (with rollback)
- Openprovider `.uk` auth code unconfirmed until 9 Feb 2027 → manual admin step; admin pastes the code.
- After the tag change Openprovider may drop its DNS zone → guide says set DNS at the new provider first, admin alerted; rollback: admin Cancel (before moved) or operator points DNS back.
- Self-fetching the export page may be blocked on preview deployments → works on production; admin "Retry export".
- Spam through the open form can trigger reports for paid-plan owners → caps limit it; admin cancels the ref or lowers the daily cap.
- GoDaddy and IONOS tags need checking before launch → one-line change in `transfer-providers.ts`.

## Zac's click-through (after merge)
1. Run `supabase/schema.sql`; check the site loads.
2. As a test operator: Take my website → pick a provider → Check → Confirm. Email arrives with the files and guide.
3. Unzip, open `index.html` locally: pages and links work; submit the form: the lead lands in SI (and the lead database when linked).
4. Registrar sandbox: transfer shows "manual tag step" in admin; click Tag changed; status tracked; stuck alert after 5 days.
5. Test clock +30 days (set `overlap_ends_at` in the past, run the cron): our hosting stops; the exported form still creates leads.
