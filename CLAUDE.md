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
