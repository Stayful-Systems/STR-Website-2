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
  Code `src/lib/ad-packs/{voices,voice-*,captions,render-*}.ts`; no Stayful asset under `ad-render/` (a test pins it).
- **Screen.** Approve stays off until the video is ready (`PackView.approval`). One voice change before approving
  (`changeVoice`; free when the voice was unavailable) and `retryVideo`, both owner-only and pinned to the version on
  screen. While the video is made the screen asks `pollPackAction` every 8 s (read only, safe fields) and stops after
  15 minutes. The video plays from one-hour signed links (`videoUrlAction`). `/admin/ad-packs` has a Video column.
- **Knowledge.** Six draft entries in `seed.ts` (`adpack_*`, incl. `adpack_video_voice`) and a block in `service-facts.ts`.

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
