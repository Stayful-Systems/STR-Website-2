@AGENTS.md

## Code search: use Graphify first

This repo is indexed in the Graphify MCP. For any question about how the code works, where something lives, what calls what, or what a change would affect:
1. Use the graphify tools first (`mcp__graphify__graphify_find`, `mcp__graphify__query_graph`, `mcp__graphify__graphify_callers`, `mcp__graphify__graphify_callees`, `mcp__graphify__graphify_impact`, `mcp__graphify__graphify_file_neighbors`).
2. Only open a file with Read once the graph has told you which file and lines matter.
3. Don't grep or read whole folders to explore.
4. The graph is a snapshot of the last indexed commit. If code was just changed, check the files you edit directly.

If the repo isn't in the Graphify `list_repositories`, work as normal.

# Stayful Intelligence knowledge (Batch 24)

Any change to a feature, price, limit or rule must add or update the matching
Stayful Intelligence knowledge entries (as drafts for Zac to approve, in
`src/lib/knowledge/seed.ts`), and every figure must be a placeholder resolved
from settings (`src/lib/knowledge/placeholders.ts`), never typed into an
answer. If the change adds or moves something the nightly job drafts from,
update `src/lib/knowledge/service-facts.ts` too. See
`src/lib/knowledge/README.md`.

# Bug check before handing back

- Did this change a feature, price, limit or rule? Then the matching
  knowledge entries are added or updated in `src/lib/knowledge/seed.ts` as
  drafts (never approved in code), every figure in them is a `{placeholder}`
  resolved from settings, and `npm test` passes (the seed tests check every
  placeholder resolves against the schema's seeds and no answer types a
  figure).

# Batch 32: website leads go into the operator's lead database account

A landlord's website lead is also pushed, signed, to the operator's own lead
database account (never charged, never given, pooled or sold on). Plan and the
wire contract: `PLAN-batch-32.md`. Code: `src/lib/leaddb/`.

- **Contract.** Four signed POSTs to `LEADDB_API_URL` (`/api/internal/si/link/start|confirm|revoke`
  and `/api/internal/si/website-leads`), signed with `signatureHeader` (`src/lib/crm/signature.ts`) under
  `SI_LEAD_PUSH_SECRET` (32+ characters, set on both Vercel projects, never in code or the database).
  Unset or short on our side: the client returns `not_configured` (retryable) and the connect screen says
  "Lead database link not available yet". Responses are codes only; the retry rule is in `client.ts`.
- **Two names, never mixed.** The lead database stores these leads with `owner_source = 'si_website'`. That is
  not `LEAD_DB_SOURCE = 'lead_db'` (§71, the analyser's `analyser_reports.source`).
- **Tables.** `leaddb_links` (one row per owner: the confirmed link) and `leaddb_deliveries` (one row per lead:
  the retry queue and its state). `leads.status` and `leads.crm_pushed_at` keep meaning "went to your CRM" and
  are **never** written by this (a test pins it). Neither table is in `ACCESS_COLUMNS`.
- **Flow.** `enqueueLeadDbPush(leadId)` runs after the step-1 save (`/api/s/[slug]/lead`) and after the report is
  done (`report-server.ts`), as `void ….catch(() => {})`: it never throws and never waits. It acts only for a
  website lead, not held, whose owner has an ACTIVE link. `/api/internal/leaddb-deliveries` (`3-59/10 * * * *`,
  `?dry=1` lists and sends nothing) sweeps then drains. The lead goes first ("Report coming"); the report goes
  again under the same SI lead id when `website_reports.state = 'done'`. Occupancy is a percent 0–100.
- **Never log a lead.** Log lines carry a lead id and a code at most, never an address or a body.
- **Connect.** `src/app/leads/integrations/LeadDbPanel.tsx`: login email → code → connected. Owner only
  (`ownerIdOrNull`); logs the record-only kind `leaddb_connected`. A failure is shown in plain English
  (`messages.ts`).
- **Knowledge.** Four draft entries in `seed.ts` (`leaddb_*`) and a line in `service-facts.ts`.

# Batch 38: ad packs tag every website lead to the ad that brought it

An Academy operator whose website is live on its own domain gets a pack of three landlord Facebook ads in their own
brand (tenant-notice video, moving abroad, renting rules changed), made from their website and uploaded by them to
their own Meta account; Stayful runs nothing on Meta. Plan and defaults: `PLAN-batch-38.md`. Code:
`src/lib/ad-packs/`; screens `/leads/ads` (operator) and `/admin/ad-packs`.

- **Contract.** Pack code `SI-<op>-<angle>-<n>` in the ad name and the link
  (`?ad=<code>` plus `utm_content={{ad.id}}`). Tables `ad_packs`, `ad_pack_ads`, `ad_pack_runs`,
  `ad_pack_lead_links`; files in the private bucket `ad-packs`. `linkLeadToPackAd(leadId)` runs after the leaddb
  hook in the lead route and never throws. `leads.status` and `leads.crm_pushed_at` are **never** written by this.
- **Switch and caps.** `ad_packs_enabled` stays OFF until the screenshots and the video are done.
  `ad_pack_max_raw_pence` (one run) and `ad_pack_monthly_cap_pence` (the month) cap the house spend.
- **Regenerate.** One free regenerate (`ad_pack_free_regens`), only after a brand change (logo, colour, company,
  fee, photos, area); the video voice can change `ad_pack_voice_changes` time(s) before approving. Admin
  regenerate is always a dry run first and never counts.
- **Figures and words.** Take-home is net less the operator's own fee only while `NET_INCLUDES_MANAGEMENT_FEE`
  (`area.ts`) is false. No Stayful assets, words or example figures in any pack, script or template; the fee
  comes only from the operator's own setting.
- **Video (38b).** The notice ad (5b) is a 9:16 video plus 4:5 and 1:1 crops in the operator's brand, with an
  ElevenLabs voiceover (Jane, Olivia or Oliver: `voices.ts`; the operator plays the free sample first, picks before
  Generate) and burned-in captions. A cron worker (`/api/internal/ad-pack-renders`, `*/5 * * * *`, `?dry=1`) renders it
  in a Vercel Sandbox from `ad-render/` (Python + ffmpeg), never in a request. Table `ad_pack_renders` (one row per
  pack version: queued, running, done, failed); files `notice-9x16.mp4`, `-4x5`, `-1x1` and `notice-poster.png` in the
  `ad-packs` bucket. Env: `ELEVENLABS_API_KEY`, `CRON_SECRET`, sandbox access (OIDC is automatic on Vercel).
  The `ad-packs` bucket's `allowed_mime_types` (schema.sql) must list every type the code uploads (images, `video/mp4`,
  `audio/mpeg` for the cached voice, `application/json` for its script): `bucket.test.ts` fails if one is missing, and a
  failure to cache the voice never aborts a render. When a render ends done and approvable, or failed for good, the
  account owner gets ONE email (`notify-core.ts`, `src/lib/email/ad-pack-video.ts`: "Your video ad is ready" / "We couldn't
  finish your video"; claimed once via `ad_pack_renders.notified_at`/`notified_outcome`, reset by a voice change or retry,
  outside the one-email-a-day cap like the other replies to something the operator started).
  Code `src/lib/ad-packs/{voices,voice-*,captions,render-*}.ts`; no Stayful asset under `ad-render/` (a test pins it).
- **Screen.** Plain English, phone first, one thing per screen (no jargon is a tested rule: `plain-language.test.ts`).
  `/leads/ads` is staged by the pack's state: start (area, voice, Make my ads), making (the two picture ads at once, the
  video says it takes 5 to 10 minutes and that an email follows), review (the three ads as big pictures/video with
  Download; everything technical sits under "More options"), approved. `/leads/ads/guide` is the one-step-per-screen
  wizard for Facebook (the real screenshots in `public/ad-packs/guide/`, a big Copy button for the main text, headline,
  extra line, ad name and link, "Show me another wording", progress saved per ad on the device). Approve stays off until the
  video is ready (`PackView.approval`); one voice change before approving (`changeVoice`; free when the voice was
  unavailable) and `retryVideo`, both owner-only and pinned to the version on screen. While the video is made the screen
  asks `pollPackAction` every 8 s (read only, safe fields) and stops after 15 minutes. The video plays from one-hour
  signed links (`videoUrlAction`). `/admin/ad-packs` has a Video column. A dev-only preview of every state with fake data is
  at `src/app/dev/ads-preview/` (404 in production; `dev` is a reserved slug).
- **Knowledge.** Seven draft entries in `seed.ts` (`adpack_*`, incl. `adpack_video_voice` and `adpack_video_email`) and a block in `service-facts.ts`.

# Batch 35: Facebook lead forms through a Google Sheet, attribution, one-tap outcomes, "Your ads"

An operator can switch their ad pack from website mode to Facebook instant forms. Meta saves each answer into a Google
Sheet the operator owns; the operator shares it with Stayful's service account and Stayful reads only that sheet. Plan,
decisions and phases: `PLAN-batch-35.md`. Code: `src/lib/ad-sheets/`; screens `/leads/ads` (operator: connect, Your ads)
and `/admin/ad-sheets`.

- **Contract.** Tables `ad_sheet_links` (one row per owner) and `ad_sheet_rows` (link id + row key unique, so a row is
  kept once); `leads.meeting_reached_at` (stamped once, the first time a stage goes to Meeting booked or Signed). Service
  account env `GOOGLE_SHEETS_SA_EMAIL` / `GOOGLE_SHEETS_SA_PRIVATE_KEY` (never in code or the database); unset: the connect
  screen says "Lead form link not available yet". Neither table is in `ACCESS_COLUMNS`. `leads.status` and
  `leads.crm_pushed_at` are **never** written by this.
- **Switch and settings.** `ad_sheets_enabled` stays OFF until Zac turns it on. The rest are `billing_settings` rows
  read by `settings.ts`: `ad_sheet_min_leads`, `ad_sheet_quiet_days`, `ad_sheet_outcome_pct`, `ad_sheet_outcome_age_days`,
  `ad_sheet_reminder_age_days`, `ad_sheet_dedupe_days` (and `ad_sheet_guide_checked_at`). Seeded in `supabase/schema.sql`'s
  Batch 35 block; a test pins the defaults to the seeds.
- **Flow.** `/api/internal/ad-sheets` (`21 * * * *`, `?dry=1` writes nothing) imports new rows, then runs the quiet check.
  A complete row (name, phone or email, postcode) becomes a lead (no report), linked to its ad in `ad_pack_lead_links`
  (pack code in the ad name, then Meta ad id, otherwise "Ad unknown"), pushed lead-only to the lead database
  (`enqueueLeadDbPush`) and announced under the same `funnels.notify_new_lead` setting as a website lead. The same landlord
  (owner + postcode + email or phone) inside `ad_sheet_dedupe_days` joins the existing lead. No new lead for
  `ad_sheet_quiet_days` sends one email through the daily cap (`ad_sheet_quiet`, opt-outs never block it).
- **Outcomes and Your ads.** Five one-tap stage buttons (`StageTaps.tsx`). Your ads (`ranking.ts`) ranks an ad at
  `ad_sheet_min_leads` leads by signed, then meetings, then leads; untagged leads are in totals only; no spend and no
  cost per lead. Record-only kinds `ad_sheet_connected` and `ad_ranking_viewed`.
- **Daily email line.** `buildDaily` carries one line, "N leads are over D days old and still at New, mark what
  happened", only when N > 0 and D is `ad_sheet_reminder_age_days` (`reminder.ts` counts the recipient's own
  non-archived New leads; `reminder-server.ts` reads them for `picks-run.ts`). It never adds a send or a `SendKind`; the
  daily cap is unchanged (a test pins it).
- **Never log a lead.** Log lines carry a lead id, link id, ad code or error code at most, never an address, name, email,
  phone or row. Admin screens show states and counts, never cell contents.
- **Knowledge.** Five draft entries in `seed.ts` (`adsheet_*`: what, connect, attribution, outcomes, your_ads), six
  placeholders in `placeholders.ts` (`{ad_sheet_*}`), and a FACEBOOK LEAD FORMS block in `service-facts.ts`.

# Batch 55 (Part A): lead database customers get ad packs through a branded calculator

A lead database customer with no website here gets Batch 38's three Facebook ads, linked to a calculator in their own brand
at a Stayful address (`/s/<slug>`) instead of a website. The lead database bills the leads (Phase 2, not built). Plan and
Zac's notes: `docs/build/batch-55-part-a-PLAN.md`; the wire contract for the lead database (Part B):
`docs/build/batch-55-part-a-CONTRACT.md`.

- **Contract.** Three signed POSTs under `/api/internal/si/ad-route/` (`provision`, `state`, `signin`), signed with
  `SI_LEAD_PUSH_SECRET` and read by `verifyInbound` (`src/lib/leaddb/inbound.ts`: 404 when the secret is unset or short,
  401 on a bad signature). Code `src/lib/leaddb/{ad-account,ad-account-server,provision-run,provision-server}.ts`. Table
  `leaddb_ad_accounts` (one row per lead database customer) holds the pushed state; `adRouteStopped` / `adRouteVerdict`
  read it and **fail closed** (no account or no state means stopped; a card off, lapsed, cancelled or past the cancel date
  stops it; **pause never stops it**). `allowed` is set only on `/admin/ad-packs`, never by a push. An older `stateAsOf`
  is ignored.
- **Calculator.** `websites.mode = 'calculator'` (default `site`), made by `ensureCalculatorSite`; no page copy, no pages
  check, funnel inactive. The stop rule is enforced at the page and at the lead, report and autocomplete APIs, but a
  report already running is never cut off. The report flow (`report-server.ts`) skips the free claim, `held_cap`,
  `held_credit` and this site's charge. `enqueueLeadDbPush` skips calculator sites until Phase 2 (`si_ad`). Daily limit:
  `ad_calc_reports_per_day` per owner per UK day (429, no lead row). A calculator owner sees only the brand screen
  (`CalculatorBrand.tsx`, `calculator-actions.ts`).
- **Route.** `ad_packs.route` is `academy` or `leaddb`, chosen by `chooseAdRoute`: leaddb only with an ad account and no
  site-mode website. The Academy eligibility output is pinned byte for byte (`eligibility-academy-pin.test.ts`).
- **Rounds and caps.** On the lead database route an operator may make one preview per `ad_pack_ld_round_days`
  (`round-limit.ts`; a failed run, an admin run and a hand edit never count). Extra rounds only by an admin grant
  (`ad_pack_round_grants`, reason required). `ad_pack_ld_monthly_cap_pence` is the route's own backstop; the Academy
  cap sums academy runs only. Admin: `LeadDbAccounts.tsx`, `leaddb-actions.ts`, `ld-admin-run.ts`.
- **Audience step.** Replaced for everyone (Academy and lead database) by `targeting-recipe.ts`; update `LAST_CHECKED`
  whenever it is re-checked against Meta's screen. No amount is typed in it.
- **Never log.** Log lines carry an id or code at most, never a lead, email, phone, body, signature, secret or sign-in
  link. Neither new table is in `ACCESS_COLUMNS`. `leads.status` and `leads.crm_pushed_at` are **never** written by this.
- **Knowledge.** Three draft entries in `seed.ts` (`adpack_ld_calculator`, `adpack_ld_rounds`, `adpack_audience`), two
  placeholders in `placeholders.ts` (`{ad_calc_reports_per_day}`, `{ad_pack_ld_round_days}`) and a LEAD DATABASE AD PACKS
  block in `service-facts.ts`.

# Deal feed (queue Batch 1): tabs, stale-deal credit, duplicates, weekly count

Fills the gaps in the `/deals` marketplace; billing is unchanged (the open ladder and the optional full report).
Plan and Zac's to-do list: `docs/build/batch-01-deal-feed-PLAN.md` and `-BLOCKERS.md`. Schema: the "Deal feed" block in
`supabase/schema.sql` (before Batch 37's). Code: `src/lib/marketplace/`.

- **Tabs.** All / Rent-to-rent / Buy-to-let on `/deals`: plain links built by `categorySearch` (`grid.ts`; `kind=rent`,
  `kind=sale`, `type=all`). The Buy-to-let tab is **every sale** (Short-let, BRRR and Buy to let), so `browseFilters` maps an
  old `kind=sale` link to all three sale types. `KIND_LABELS.sale` is "Buy-to-let".
- **Settings** (`billing_settings`, read by `deal-feed-settings.ts`; a test pins the defaults to the seeds): `deal_stale_credit_enabled`
  (off), `deal_stale_credit_days` (7), `deal_dedupe_enabled` (off), `deal_dedupe_price_pct` (2). Switched on the "Deal feed" panel
  on `/admin/deals`.
- **Stale-deal credit.** `/api/internal/deal-stale-credits` (`17 * * * *`, `?dry=1` lists and grants nothing, and lists even
  while the switch is off). An open is due when its deal went `sold | under_offer | let_agreed | removed` within the days of the
  open. The amount is read from the ledger's own debits (the open's transaction plus the debits of the user's completed
  `analysis_purchases` for that deal, less refunds), never the list price; nothing is credited when nothing was spent (the open
  is settled at 0). Granted as an `adjustment` with `source_ref = 'stale:<open id>'`, so once only. The admin "Grant stale credit"
  button uses the same function and ignores the window. `ledger.ts` and the credit SQL are called, never changed. Logs carry an
  open id and pence only.
- **Duplicates.** `dedupe.ts` (`findDupe`, `planDupes`) sets `marketplace_deals.dupe_of` to the earliest-seen live twin (same UPRN
  and kind, or same kind, beds, type and full postcode within the price percent). `refreshDupes` runs at the end of the sweep
  and the hourly recheck and keeps the pointers whether or not the switch is on (so `/admin/deals` can show "Hidden as
  duplicates" before it is turned on); only the grid query honours `deal_dedupe_enabled`. `retireDeal` frees a retired
  original's twins at once. An opened deal and `/deals/[id]` ignore `dupe_of`. The full postcode is read from the stored
  listing (`sourced_listings.snapshot`), only for rows that have a possible twin.
- **Weekly count.** `weekly-sales.ts` (last 8 UK weeks, Rent-to-rent / Buy-to-let, opens and complete full reports) and
  "reports this month vs 50" on `/admin/deals`.
- **Rent-to-rent notice.** `r2r-notice.ts`, shown on a rental's deal sheet and in the full-analysis panel, never on a sale.
- **Not touched.** `/p/[token]` and `/deal/[token]` (member share links that show the address: a separate issue), leads, ad
  packs, ad sheets and the lead database.
- **Knowledge.** Four draft entries in `seed.ts` (`deal_feed_categories`, `deal_stale_credit`, `deal_r2r_permission`,
  `deal_duplicates`), the `{deal_stale_credit_days}` placeholder and a DEAL FEED block in `service-facts.ts`.

# Batch 55 step 2: calculator leads go to the lead database as ad leads

Every lead from a calculator site (`websites.mode = 'calculator'`, Batch 55 Part A) is pushed, signed, to the customer's own
lead database account as an `si_ad` lead. The wire contract is `docs/build/55-CONTRACT.md` in lead-database (sections 9 to
12); the rules are `docs/build/55-RULES.md` there (rules 9 to 14, 17 to 21). Code: `src/lib/leaddb/ad-*.ts`.

- **Push.** `enqueueAdLeadPush(leadId)` (`ad-deliver.ts`) runs after `linkLeadToPackAd` in the lead route, after the Batch 32
  hook in `report-server.ts` and when `giveUp` fails a report, always as `void ….catch(() => {})`. It acts only for a calculator
  lead whose owner has a `leaddb_ad_accounts` row. The Batch 32 push still skips calculator leads (`calculator_site`).
  `/api/internal/leaddb-deliveries` drains `leaddb_ad_deliveries` after the Batch 32 drain (`?dry=1` sends nothing): phase
  `lead` (details and the ad tag read from `ad_pack_lead_links` at send time), then `report` (figures, PDF, `low_data`) or
  `report_failed`. A 409 `no_lead` sends the lead again first. `repeat_of_si_lead_id` also goes on the report phase (the
  postcode is only known after step 2).
- **Billing.** Decided ONCE when the first report phase is built and frozen on the row: test (`self_submit`) → not billable;
  no figures → not billable; repeat landlord inside 30 days → `repeat`; low quality → `low_data`; else `report_ran`.
  `chargeDecision(…, source: 'si_ad')` charges a low-data report; without `source` it is byte-identical. Ad leads are never
  replaceable.
- **Back from the lead database.** `ad-route/unpaid-hold` (ordered by `holdAsOf`) and `unpaidHold` inside a state push: stop
  condition 8, verdict `unpaid_hold`, the same neutral page; a running report still finishes; never called "pause".
  `ad-route/stage` (ordered by `stageAt` against `leads.ld_stage_as_of`, calculator leads of that customer only, stamps
  `meeting_reached_at` once; decision in `ad-stage.ts`, own test file because it writes `leads`).
- **First pack.** A lead database pack reaching preview marks `pack_notice_pending`; the cron sends `ad-pack-generated` once
  (404 `unknown_customer` is final).
- **Provision.** A created or linked member is stamped management (`stampManagement`, so no /welcome quiz); a member provision
  created gets `welcome_checked_at` with reason `leaddb_ad_route` (no welcome credit).
- **Never.** `leads.status` and `leads.crm_pushed_at` are never written. Logs carry an id or code, never a lead, body or secret.
  The new table is not in `ACCESS_COLUMNS`. Lead panel wording for ad leads is in `lead-panel.ts` (site wording unchanged).
- **Knowledge.** Draft `adpack_ld_ad_leads` in `seed.ts` (no price typed: the price setting is step 3) and an "Ad leads" line in
  the LEAD DATABASE AD PACKS block of `service-facts.ts`.
