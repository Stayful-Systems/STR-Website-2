# Batch 38 (ads) — Ads A1: three branded landlord Facebook ads per operator, tagged from day one

Academy operators whose website is live on its .co.uk domain get a pack of 3 landlord Facebook ads in their own
brand (angle 5b tenant-notice video, 3a moving abroad, 17 renting rules changed). They upload the pack to their own
Meta ad account by following a guide, copying every piece of text with one tap. Every ad carries a pack code in its
ad name and link, so each website lead is recorded against the ad that brought it. Stayful runs nothing on Meta and
has no Meta API.

NUMBER: this was first called Batch 36. `main` already has a different Batch 36 (customer websites Phase 4, #178), and
35 is reserved for lead forms and 37 for moving a domain to a member's own registrar, so Zac moved the ads to **Batch 38**
(20 Nov). Code, schema and CI names say 38; commit messages from before that still say 36. Settings keys, tables and the
`ad_pack` / `adpack_` names are unchanged.

Split: **38a** = everything but the video (switch `ad_packs_enabled` stays OFF). **38b** = video + voice + captions
(after 38a is merged and the schema is run). Batch 35 stays lead forms.

Branch: `claude/nice-galileo-qv5mt2` (the session's assigned branch; the plan named `claude/elegant-euler-r9fx0b`).

## Coordinator rules

One subagent per phase. Each reads CLAUDE.md + AGENTS.md (and the Next docs it needs in
`node_modules/next/dist/docs/`), replies in ≤150 words (files, checks, deviations). After each phase: `git diff
--stat`, re-run its check (failures only), tick it here, note anything the next phase needs, commit
`Phase N: <name>`. Stop and ask if anything breaks the plan. Never redo ticked phases.

"All checks" = `npm test`, `npm run lint` (0 errors), `npx tsc --noEmit`, `npm run build`, and the schema check
(fresh Postgres: shim + schema.sql twice, index/dump diff, every `supabase/tests/*-smoke.sql`).

## Defaults taken

- Voices (38b): Jane `RILOU7YmBhvwJGDGjNmP`, Olivia J `NbkKnEAZ7Bqw4EAkVEaz`, Oliver `lo1O1Dz1Tu4FWVEPaxuT`.
- Bedrooms: the most common bedroom count in the chosen area (`modalBedrooms`).
- Price: free with the Academy, one pack per operator. One free regenerate, only after a brand change (logo, colour,
  company, fee, photos, area). Before approving, the voice can be changed once (38b). Admin regenerate unlimited,
  always Dry run first, never counts.
- Pack code: `SI-<6-char operator code>-<angle>-<n>` upper case, e.g. `SI-3F9A2C-5B-1`; operator code = first 6 hex
  of the owner id upper-cased, next 6 on collision (unique column); n = pack version.
- Ad name: `SI-3F9A2C-5B-1 · Tenant notice`.
- Link: `https://<domain>/?ad=<CODE>&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-<op>&utm_content={{ad.id}}`.
- Copy: 45 fixed templates (5 primary, 5 headlines, 5 descriptions x 3 angles). No AI writing.
- Limits: headline ≤ 27 (hard 40); primary text ≤ 300 chars, first sentence ≤ 125; description ≤ 90 chars with a
  "may be cut off on some placements past 30" note.
- Eligible: account owner + linked, not refunded `academy_purchases` row + site live + domain live + switch on.
- Activity kinds: `ad_pack_approved` (inApp, counts), `ad_text_copied` (recordOnly).
- Entry: "Your ad pack" card on /leads (eligible owners only) → /leads/ads. No new nav item.

## Do not touch

`src/lib/domains/**` (33), `src/lib/leaddb/**` (32), `src/lib/funnels` pricing, `src/lib/tracking/**`,
`ACCESS_COLUMNS`, `src/lib/academy/**`, `src/lib/websites/{LeadForm.tsx,sources.ts,report-server.ts}` (read only),
`src/lib/management/report.ts`, `leads.status` / `leads.crm_pushed_at`.

## Session 38a

- [x] **Phase 0 — Setup.** Fetch main, record hash; plan file; baseline checks; schema-check script.
  Notes: origin/main = `0dd39a7` (as expected). Branch `claude/nice-galileo-qv5mt2` already at 0dd39a7 (no work on it).
  Baseline: npm test 3989/3989 pass; lint 0 errors (79 warnings); tsc clean; build OK; schema check passes
  (8 smoke files, schema twice, no diff). Schema-check script: run
  `/tmp/claude-0/-home-user-STR-Website-2/40edeeda-a663-5737-9418-5656d9df67ae/scratchpad/schema-check.sh`
  (local Postgres 16 via `service postgresql start`; creates DB `schemacheck` each run; `npm ci` already done).
- [x] **Phase 1 — Database.** `-- Batch 38: Ads A1` block (ad_packs, ad_pack_ads, ad_pack_runs, ad_pack_lead_links,
  private bucket `ad-packs`, billing_settings seeds), `supabase/tests/adpacks-smoke.sql`, CI step.
  Notes: block at schema.sql ~9141 (before Batch 31). `ad_packs.website_id` is a plain uuid, no FK (websites is created
  later in the file). `ad_pack_runs.by` is a column name. billing_settings values are jsonb: `ad_packs_enabled` false,
  others numbers (1, 1, 500, 5000, 5). `ad_pack_lead_links` PK = lead_id. Schema check: 9 smoke files, twice, no diff.
- [x] **Phase 2 — Codes, links, limits.** `src/lib/ad-packs/{codes,links,limits}.ts` + tests.
  Notes: 21 tests pass, tsc clean. API: codes `ANGLES, Angle, isAngle, operatorCode(ownerId, taken?), packCode, normaliseCode,
  parseCode, PACK_CODE_MAX`; links `adLink({domain,code,operatorCode}), adName(code,angle), isAdIdPlaceholder, cleanMetaAdId,
  ANGLE_LABELS`; limits `AD_LIMITS, checkLength(kind,text) -> {length, level green|amber|red, notes}, firstSentence, wordCount`.
  operatorCode/packCode/adLink THROW on invalid input. Primary text: first sentence ≤125 (amber if over), total ≤300 (red if over);
  description green ≤90, red over, note past 30 chars; empty = red.
- [x] **Phase 3 — Angles, copy, figures.** `angles.ts` (45 templates, 5b script, card text, lead-form questions),
  `figures.ts`.
  Notes: 49 ad-packs tests pass, tsc/eslint clean. API: angles.ts `ANGLE_DEFS, angleDef, renderTexts({angle, brand:{company,
  area,bedrooms,feePct}, figure}) -> {primary,headlines,descriptions}, renderCards -> Card[]{id,headline,body[],cta,big,label,
  figure}, renderScript -> {lines,text,words}, feeSentence, SCRIPT_5B, leadFormQuestions`; figures.ts `buildFigure({area_label,
  agg,feePct,netIncludesFee,minSamples?}) -> Figure|null, figureUnavailableReason, FIGURE_LABEL_RE, figureIsLabelled`. Market
  figures are per YEAR; figures.ts divides by 12, rounds to £50. Templates use `{figure|fallback}`, `{fee|fallback}`,
  `{bedrooms}-bed`; fee then figure dropped first if a primary would pass 300 chars. Zac to review wording in the PR: "Between
  tenants, or thinking about it?", "Home empty while you're abroad?", "looks after the guests, the cleaning, the maintenance and
  the keys" (assumes operators do this), lead-form question wording.
- [x] **Phase 4 — Checks, area, eligibility.** `checks.ts`, `area-server.ts`, `eligibility-server.ts`.
  Notes: 80 ad-packs tests pass, tsc/eslint clean. Pure/server split: `area.ts`+`area-server.ts`, `eligibility.ts`+
  `eligibility-server.ts` (server-only files re-export the pure parts; tests can't import server-only). API: checks.ts
  `runChecks({brand:{company,logoUrl,brandColour,feePct,areaLabel,areaKey,typeOnly?}, ads:[{angle,code,adName,link,texts,
  script?,cardsText?,files?}], figures:[{areaKey,label?,sentence?}], operatorCode, domain}) -> {ok,failures,warnings,results},
  contrastRatio, pickTextColour, AD_IMAGE_SIZES, CHECK_IDS, CHECK_LABELS` (check id for the no-source-brand check is
  `source_brand`; `cardsText` = one string per card). area-server.ts `readMinAreaSamples, listDistricts() -> AreaOption[],
  areaFigureSource({areaKey,minSamples?}) -> {areaKey,areaLabel,level,fellBack,bedrooms,agg,longLetRent,samples} |
  {error:'not_enough_data',message}` — Phase 6 must store the RETURNED areaKey as `ad_packs.area_key` (after fall-back it is
  the postcode area; checks compare exactly). eligibility-server.ts `packEligibility(userId,{admin?}) -> {eligible,reasons,
  ownerId?,website?,domain?}, readAdPacksEnabled, evaluateEligibility, plainReason`. DECISION FOR ZAC: avg_net_revenue =
  gross x 0.52 (gross less 15% platform fees, 15% management, 18% cleaning; before bills/mortgage/tax; medium confidence, no
  code in this repo writes analyser_reports.net_revenue). `NET_INCLUDES_MANAGEMENT_FEE = false` (pinned by test): take-home =
  net minus the operator's own fee, which can only UNDERSTATE (by about 15% of gross if the stored column really includes a
  15% fee). Contrast check can never fail (best of white/near-black >= 4.35:1); below 4.5:1 is a warning only.
- [x] **Phase 5 — Image ads.** `images.tsx` (next/og, 1:1 / 4:5 / 9:16) + fonts.
  Notes: 99 ad-packs tests pass, tsc/eslint/build OK; coordinator viewed 3 sample PNGs (no clipping, label fully visible).
  API: `renderCardPng({card,brand:{company,brandColour,logoUrl},photoUrl,size,fetchImage?}) -> Buffer`;
  `renderAdImages({angle,cards,brand,photos:{pack:string[],site:string|null},fetchImage?,sizes?}) -> [{name,width,height,png}]`
  (names like `3a-card1-4x5.png`); also `deriveTints, paletteFor, layoutFor, planCard, photoCandidates, defaultFetchImage`.
  Fonts (Anton, Archivo Medium/SemiBold, OFL.txt) in src/lib/ad-packs/fonts/. next.config.ts: `outputFileTracingIncludes`
  `/leads/ads` -> fonts. ANY OTHER ROUTE THAT CALLS THE GENERATOR (e.g. an admin action page /admin/ad-packs, a cron) needs
  its own entry (Phase 10 must add `/admin/ad-packs`). Tests bundle images.tsx with esbuild (node can't load JSX). Figure
  cards never use a photo; WebP photos fall back to type-only.
- [x] **Phase 6 — Generator and store.** `store-server.ts`, `generate-server.ts`.
  Notes: 175 ad-packs tests pass (all phases), tsc/eslint clean. Files: settings, store-types, rows, month, download,
  generate-core, test-store, store-server, generate-server (+tests). API (generate-server.ts): `generatePack({ownerId,
  by:'operator'|'admin', dry?, input:{areaKey, bedrooms?, photos[<=4], brand:{company,logoUrl,brandColour,feePct,areas?,
  photoUrl}, domain, websiteId?, typeOnly?}})` -> `{ok:true,dry:false,status:'preview'|'checks_failed',packId,version,
  operatorCode,ads[{id,angle,code,adName,link}],checks,costPence,regenCount,regenerate}` | `{ok:true,dry:true,wouldBlock:
  {code,message}|null,plan}` | `{ok:false,code,message,packId?}`. Codes: invalid_input, in_progress, no_brand_change,
  regen_used, cost_cap, monthly_cap, spend_unknown, not_enough_data, store_failed, render_failed, upload_failed,
  generate_failed. `approvePack({ownerId}) -> {ok:true,activityKind:'ad_pack_approved',packId,version,operatorCode} |
  {ok:false,code:invalid_input|no_pack|not_preview|store_failed,message}`. `listPackForOwner(ownerId) -> PackView|null
  {pack,ads(current version),showAds,olderCodes,freeRegensLeft}`. Also `brandHash, regenerateBlock, estimateRawPence,
  generateMessage, GENERATE_CODES, MAX_PHOTOS`; store-server.ts `createLiveStore, readAdPackSettings, uploadFile,
  signedDownloadUrl(ownerId, packAdId, fileName)` (5-min link, null unless owner's ad with that file). Deviations: run row
  written only once the pack row exists (refusals and not_enough_data write nothing, since ad_pack_runs.pack_id is not
  null); `bedrooms` input accepted but IGNORED (modal bedrooms used, per plan default); `pack.version/brand_hash/regen_count`
  move only when a new version is stored; regen_count rises only when an operator regenerate reaches preview;
  ad_packs.cost_pence = running total; `script` and `cardsText` live inside ad_pack_ads.texts. Phase 10 needs
  `/admin/ad-packs` in next.config.ts outputFileTracingIncludes (fonts).
- [x] **Phase 7 — Attribution on arrival.** `attribution.ts`, `attribution-server.ts`, one line in the lead route,
  `PackAdLine` on lead detail.
  Notes: 24 new tests, tsc/eslint clean. API: attribution.ts `matchLeadToAd` (optional operatorCode so another operator's code
  is foreign even if not in packAds), `linkLead(store, leadId)`, `linkMissing(store, opts)`, `packAdLineView`;
  attribution-server.ts `linkLeadToPackAd(leadId)` (never throws), `linkMissingLeads({ownerId?, sinceApproved?, dry?}) ->
  {ok,dry,leadIds,count,linked,untagged,skipped,failed}` (max 500 per run; Phase 10 uses it), `packAdLine`. "Approved pack" =
  `ad_packs.approved_at is not null` (a regenerate doesn't stop linking). Writes nothing for a lead without a website_reports row.
  Lead page shows `Ad: <code> · <angle label>` (the ad name already ends in the label). Ad code only arrives at step 1:
  lead_sources is written once (ignoreDuplicates), so a repeat enquiry within the hour keeps the first row's code.
- [x] **Phase 8 — Operator screen.** `/leads/ads`, entry card, activity kinds.
  Notes: all checks green (npm test 4244/4244, lint 0 errors / 79 warnings = baseline, tsc clean, build OK). Files:
  src/app/leads/ads/{page,AdPackClient,AdSection,EntryCard,actions,ops,view,state}.ts(x) + 4 test files;
  src/lib/ad-packs/{photos,files-server,entry-server}.ts; leads/page.tsx entry card (Suspense, owners only); kinds.ts +
  kinds.test.ts (`ad_pack_approved` inApp, `ad_text_copied` recordOnly). generate-server.ts: one line passing
  `fetchImage: adPackFetchImage` (photos stored as bucket paths so brandHash stays stable); area-server.ts: `areaPreview()`
  (skips the paid long-let lookup). Browser shrinks photos over 800 KB (actions cap 1 MB, Vercel 4.5 MB). Bedrooms are shown
  read-only (modal size), as the generator ignores a requested value. Phase 9: replace `section#guide` in
  src/app/leads/ads/page.tsx. COORDINATOR FIX: brandHash now uses the area key the pack STORES (area resolved first, it is a
  free read), so after a district->area fall-back the regenerate button no longer shows spuriously (regression test added).
- [x] **Phase 9 — Setup guide.** `guide.ts` + `Guide.tsx`.
  Notes: npm test 4256/4256, tsc/eslint/build OK. Files: src/lib/ad-packs/{guide,guide-server}.ts + guide.test.ts (20 tests),
  src/app/leads/ads/Guide.tsx, public/ad-packs/guide/README.md; page.tsx `section#guide` holds `<Guide>`; AdPackClient `TextRow`
  exported (guide reuses copy button + `ad_text_copied` logging); next.config.ts `/leads/ads` trace also includes
  `public/ad-packs/guide/*.png`. 13 steps (page picked in its own step from the upload step: one action per screen); README
  lists the 13 PNG names Zac must supply. Missing screenshots show a plain-text placeholder (no broken images). Switch stays OFF
  until the screenshots are in. UPDATE 20 Nov: Zac supplied all 13 screenshots (checked: cropped, account/Page names blurred, no payment data); they are in `public/ad-packs/guide/`. The switch still waits for 38b.
- [x] **Phase 10 — Admin.** `/admin/ad-packs`.
  Notes: 27 admin tests (202 ad-packs tests pass), tsc/eslint clean. Files: src/app/admin/ad-packs/{page,actions,
  AdPacksPanel}, src/lib/ad-packs/{admin-view,admin-run,admin-server}.ts, next.config.ts one line. Regenerate Run needs the dry
  run's token and re-plans from the live website (refuses if brand/version moved); a dry run whose checks would fail offers no
  Run. Link-missing returns counts only (no lead ids); Run gated on a prior dry run in the panel (client state). BUG FOUND AND
  FIXED by coordinator: a new version used to clear `approved_at`, so leads from still-running ads stopped linking until
  re-approval. Now a regenerate keeps the first approval time, and approvePack keeps `approvedAt ?? now` (generate-core.ts).
- [x] **Phase 11 — Knowledge and docs.** placeholders, seed drafts, service-facts, CLAUDE.md section.
  Notes: npm test 4256/4256, tsc clean. placeholders.ts: `ad_pack_free_regens`, `ad_pack_voice_changes` (whole numbers, shown
  in words). seed.ts: five DRAFT entries `adpack_what/who/regenerate/tagging/not_included` (no typed figures). service-facts.ts:
  "LANDLORD AD PACK" block (a test needs every placeholder it uses in a seed entry). CLAUDE.md: Batch 38 section only.
  Zac to approve the drafts in Stayful Intelligence.
- [x] **Phase 12 — Final checks, review, PR.**
  Notes: independent read-only review found NO cross-operator access hole, NO Stayful leak, schema/RLS/bucket/ACCESS_COLUMNS/
  leads-writes clean. FIXED: (1) the generator's area read triggered the house-paid long-let lookup, also on refused requests
  and dry runs, ahead of the cost caps (now removed; nothing used it; test pins it); (2) the area step needed no eligibility
  check (added); (3) approve is now pinned to the version on screen (a regenerate meanwhile cannot be approved unseen).
  KNOWN, LEFT FOR A FOLLOW-UP (minor): an operator regenerate of an APPROVED pack that fails its checks hides the live
  version's downloads (the admin path guards this, the operator path does not); two concurrent generates can race on regen
  count (narrow); `adPackFetchImage` serves any well-formed upload ref and site `photoUrl` is unvalidated (UUIDs unguessable);
  PostgREST 1000-row default may undercount `monthSpendPence` / `knownMetaAdIds` / admin counts once 38b makes cost non-zero;
  the fire-and-forget linker has no automatic sweep (admin Link missing leads covers it); a visitor can bind a real Meta ad
  id to the wrong pack ad for the same operator via the public form; downloads/copy do not re-check eligibility after a
  refund. Zac's decision still open: take-home maths (see Phase 4), Phase 3 copy wording.

## Session 38b (after 38a merged and schema run)

- [x] B0 Setup (Vercel Sandbox available; Zac adds the 3 library voices to ElevenLabs). Notes 20 Nov: branch restarted from origin/main f20faeb (38a merged as #179); live DB caught up (website/domain/Academy tables). Vercel Sandbox API answers for team stayful-systems (project str-website-2 has no sandboxes yet) - a real render proves it in B4. Voices: Jane (RILOU7...) and Olivia J (NbkKn...) are ALREADY in the ElevenLabs account; Oliver (lo1O1...) is only in the public library and STILL has to be added (Zac, one click). ffmpeg/Pillow/numpy are available in this container for local test renders.
- [x] B1 Database (`ad_pack_renders`, unit_costs row, smoke + CI). Notes: schema check passes (11 smoke files, twice, no diff). `ad_pack_renders`: id, pack_id (fk ad_packs cascade), version, voice_key, state queued|running|done|failed (default queued), sandbox_id, attempts, lease_until, started_at, finished_at, cost_pence, error_code (<=60), files jsonb, created_at, updated_at; unique (pack_id, version); indexes (state, created_at), (pack_id). Settings: ad_pack_render_max_seconds=300, ad_pack_render_max_attempts=3, ad_pack_sandbox_vcpus=2. unit_costs: provider 'vercel', unit 'sandbox_cpu_second', 0.00280889p, markup 5 (price has one source; cost = seconds x vcpus x that row). src/lib/credit/costs.ts UNIT_COST_SEED has no matching entry: B4 adds one if it must mirror the schema.
- [x] B2 Renderer copy (`ad-render/`, no Stayful assets). Notes: coordinator re-ran the sample render (28 s, 3 MP4s at 1080x1920 / 1080x1350 / 1080x1080, aac present, 38.03 s) and viewed hook, figure, CTA and the 4:5 crop: brand colour, label fully visible, captions OK. Command `python3 ad-render/notice.py --brief <path>`; brief paths are relative to the brief's folder and may not leave it. Needs ffmpeg + ffprobe on PATH (tested 6.1, libx264, aac) and `pip install -r ad-render/requirements.txt` (Pillow only). No network at render time. Env: AD_RENDER_JOBS (worker count, default CPU count, max 4), AD_RENDER_DEBUG=1. Timing 28 s on 4 CPUs, 44 s pinned to 2. CTA reads 'Have a look at our website' (the brief has no URL). Test src/lib/ad-packs/render-assets.test.ts (no Stayful names/figures/assets under ad-render/).
- [x] B3 Voice and captions (`voice-server.ts`, with-timestamps). Notes: 28 tests, tsc/eslint clean. Files src/lib/ad-packs/{voices,captions,voice-core,voice-server,voice-test-support}.ts, fixtures/alignment-notice.json + 3 test files. API: voices.ts `VOICES, VoiceKey ('jane'|'olivia'|'oliver'), DEFAULT_VOICE_KEY ('jane'), isVoiceKey, voiceById, voiceByKey, previewUrlFor`; captions.ts `buildBriefScript(lines, alignment)` (the brief `script` block; throws AlignmentError), `validateBriefScript`, `captionChunks`, `joinScriptLines`, `cleanLines`; voice-core.ts `estimateVoicePence(lines, voiceKey)` (whole pence, rounded up), `synthesiseCore`, `VOICE_CODES`; voice-server.ts `synthesise({voiceKey, lines, packId?, fetchImpl?}) -> {ok:true, audio, mimeType, script, costPence, characters} | {ok:false, code}`. Codes: voice_unavailable, no_key, rate_limited, quota, timeout, bad_response, failed. Lines are sent joined by a blank line; duration = last word end + 0.4 s. Metered through meter() with a house context (userId null): the operator is never charged. B5 must wire estimateVoicePence into estimateRawPence.
- [x] B4 Sandbox runner + cron (`render-server.ts`, `/api/internal/ad-pack-renders`). Notes: render.test.ts 47/47, npm test 4539/4539 (builder), tsc/eslint/build OK. NO REAL SANDBOX RENDER YET (needs a deployment with the env below). Measured in a real sandbox by the coordinator: Ubuntu 26.04, Python 3.14.4, user ubuntu with sudo, no ffmpeg/Pillow; apt ffmpeg 8.0.1 (libx264+aac) ~28 s, venv+Pillow ~7 s; Pillow==12.3.0 has a cp314 manylinux wheel (checked). Files: src/lib/ad-packs/{render-core,render-server,render-store,render-store-server,render-test-store}.ts + render.test.ts; route src/app/api/internal/ad-pack-renders/route.ts (maxDuration 300, GET/POST, ?dry=1); @vercel/sandbox 3.9.1 (4.x < 2 weeks old); vercel.json cron `*/5 * * * *`; next.config.ts tracing include (ad-render/*.py, *.txt, fonts); costs.ts seed row. Sandbox timeout/command budget = min(max_seconds, 270). API for B5: `enqueuePackRender({packId, version, voiceKey}) -> {ok, inserted, renderId, state} | {ok:false, code}` (render-server.ts); states queued|running|done|failed; `RENDER_CODES`; voice_unavailable, monthly_cap, bad_brief are never retried. 5b ad `ad_pack_ads.files.video` = {status:'ready', videos:AdFileRef[], poster:AdFileRef, durationSeconds, voice}; names notice-9x16.mp4, notice-4x5.mp4, notice-1x1.mp4, notice-poster.png. Render cost is in monthSpendPence via one non-dry ad_pack_runs row per costed attempt (by 'admin', result.kind 'render') and added to ad_packs.cost_pence. B5 MUST: (1) rows.ts parseFiles + store-types AdFiles.video: use parseAdVideo from render-store.ts (they drop everything but {status:'coming'}); (2) download.ts downloadPath must also search videos and poster; (3) generate-core: call enqueue after storing ads, add estimateVoicePence to estimateRawPence. VERCEL CONFIG before a real render: ELEVENLABS_API_KEY, CRON_SECRET, sandbox access (OIDC automatic on Vercel; elsewhere VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID), the B1 schema block applied to the database, and Oliver added to ElevenLabs.
- [x] B5 Screen + checks (voice step, video preview). B5a DONE (back end): npm test 4583/4583, tsc clean. generate-server.ts: generatePack input.voiceKey ('jane'|'olivia'|'oliver', regenerate ignores it); result adds voiceKey + video {status queued|failed|coming, code?}. approvePack new codes video_pending, video_failed (VIDEO_MESSAGES). changeVoice({ownerId, voiceKey, expectedVersion?}) -> {ok, packId, version, voiceKey, free, changesLeft} | {ok:false, code, message}; codes invalid_input, no_pack, not_preview, after_approval, same_voice, voice_limit_used, video_running, cost_cap, monthly_cap, spend_unknown, store_failed; same version, codes unchanged, free when the voice was unavailable. retryVideo({ownerId, expectedVersion?}) same shape + not_retryable. PackView adds video {status coming|queued|making|ready|failed, code, message, poll, canRetry}, render {state, errorCode, attempts, voiceKey, retryable}|null, voice {key, changesLeft, canChange, free, blocked}, approval {ok:true}|{ok:false, code, message}; poll listPackForOwner every few seconds while video.poll. Video checks: 1080x1920/1350/1080, <=60 s, audio, captions>=1 (notice.py writes out/render-info.json; worker runs ffprobe). Deviations: no enqueue for checks_failed packs (slot 'coming'); a pack failing only its video checks has no operator retry (admin regenerates). B5b DONE: npm test 4618/4618, lint 0 errors, tsc clean, build clean (coordinator fixed a Turbopack dynamic-read warning in render-core.ts with turbopackIgnore), schema check 11 smoke files. New: src/app/leads/ads/{VoiceCards,VideoSection}.tsx; voice picker with free ElevenLabs sample clips before Generate; video preview via one-hour signed links (videoUrlAction); polling pollPackAction every 8 s, stops after 15 min (read-only, safe fields, no eligibility check); changeVoice/retryVideo actions (version required); approve disabled with a plain reason until the video is ready; 3 video downloads when approved; guide upload step names the right file per placement; admin Video column (voice, render state, attempts, error code, render cost); knowledge: six adpack_* drafts incl. adpack_video_voice; CLAUDE.md Batch 38 section updated. NOT built: optional admin re-queue action. NOT VERIFIED without a deployment: voice sample playback, signed video playback, the 8-second polling, the real sandbox render and the real ElevenLabs voice.
- [x] B6 Final checks, review, PR. Notes: independent read-only review of 38b found no cross-operator hole, no secrets or brief text in logs/rows/sandbox env, atomic claim, sandbox stopped in finally, dry run safe. FIXED: (1) voice calls that failed after ElevenLabs billed them are now cost-counted (`billedCalls`), and operator Try again no longer resets attempts (refused after 2x ad_pack_render_max_attempts); (2) approve fails closed: a `video` check that actually ran (`ran: true`) is required, and checks merge before the render is marked done; (3) the video's brand is pinned at generate time (`texts.brand` on the 5b ad), so a retry or voice change after a brand edit cannot mix old and new brand; (4) lease can never be shorter than a render in progress; (5) a render for a superseded/non-preview version is failed as `superseded` without spending anything; (6) docs now match the code (a voice change re-queues the same row and version). KNOWN FOLLOW-UPS (minor, not done): voice+sandbox can exceed the route's 300 s maxDuration if the function is killed (spend then unrecorded; the sandbox's own timeout stops it); one render per 5-minute cron tick (a backlog waits); polling continues in hidden tabs; superseded versions' files are never deleted from the bucket; pixel-dimension limits and SVG/GIF logos (dropped from the video); DNS-based SSRF in defaultFetchImage; PostgREST 1000-row default can undercount monthSpendPence/knownMetaAdIds/admin counts; approve-vs-changeVoice micro race; optional admin re-queue action not built. Final checks: npm test 4630/4630, lint 0 errors (79 warnings = baseline), tsc clean, build clean (0 warnings), schema check 11 smoke files twice no diff. DATABASE: the Batch 38b block (ad_pack_renders, 3 settings, unit_costs row) was applied to the live database on 20 Nov and checked against the local build (columns, constraints, indexes, RLS, settings and unit cost all identical). ENV: ELEVENLABS_API_KEY and CRON_SECRET already exist in the Vercel project (names checked, values never read); there is NO env var for Oliver (voice ids are in voices.ts; he only needs adding to the ElevenLabs account). Zac says the knowledge drafts are approved. NOT VERIFIED: a real end-to-end render on a deployment (needs ELEVENLABS_API_KEY, CRON_SECRET, sandbox access, Oliver added, B1 schema applied).

## Remaining risks

Video quality below Stayful's hand-tuned ads (operator previews; keep switch off). Vercel Sandbox not enabled
(fallback: GitHub Actions runner). Thin market data (lower min-sample setting, ≥3). Meta rule changes (constants in
`links.ts`, `limits.ts`).
