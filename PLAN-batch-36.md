# Batch 36 — Ads A1: three branded landlord Facebook ads per operator, tagged from day one

Academy operators whose website is live on its .co.uk domain get a pack of 3 landlord Facebook ads in their own
brand (angle 5b tenant-notice video, 3a moving abroad, 17 renting rules changed). They upload the pack to their own
Meta ad account by following a guide, copying every piece of text with one tap. Every ad carries a pack code in its
ad name and link, so each website lead is recorded against the ad that brought it. Stayful runs nothing on Meta and
has no Meta API.

Split: **36a** = everything but the video (switch `ad_packs_enabled` stays OFF). **36b** = video + voice + captions
(after 36a is merged and the schema is run). Batch 35 stays lead forms.

Branch: `claude/nice-galileo-qv5mt2` (the session's assigned branch; the plan named `claude/elegant-euler-r9fx0b`).

## Coordinator rules

One subagent per phase. Each reads CLAUDE.md + AGENTS.md (and the Next docs it needs in
`node_modules/next/dist/docs/`), replies in ≤150 words (files, checks, deviations). After each phase: `git diff
--stat`, re-run its check (failures only), tick it here, note anything the next phase needs, commit
`Phase N: <name>`. Stop and ask if anything breaks the plan. Never redo ticked phases.

"All checks" = `npm test`, `npm run lint` (0 errors), `npx tsc --noEmit`, `npm run build`, and the schema check
(fresh Postgres: shim + schema.sql twice, index/dump diff, every `supabase/tests/*-smoke.sql`).

## Defaults taken

- Voices (36b): Jane `RILOU7YmBhvwJGDGjNmP`, Olivia J `NbkKnEAZ7Bqw4EAkVEaz`, Oliver `lo1O1Dz1Tu4FWVEPaxuT`.
- Bedrooms: the most common bedroom count in the chosen area (`modalBedrooms`).
- Price: free with the Academy, one pack per operator. One free regenerate, only after a brand change (logo, colour,
  company, fee, photos, area). Before approving, the voice can be changed once (36b). Admin regenerate unlimited,
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

## Session 36a

- [x] **Phase 0 — Setup.** Fetch main, record hash; plan file; baseline checks; schema-check script.
  Notes: origin/main = `0dd39a7` (as expected). Branch `claude/nice-galileo-qv5mt2` already at 0dd39a7 (no work on it).
  Baseline: npm test 3989/3989 pass; lint 0 errors (79 warnings); tsc clean; build OK; schema check passes
  (8 smoke files, schema twice, no diff). Schema-check script: run
  `/tmp/claude-0/-home-user-STR-Website-2/40edeeda-a663-5737-9418-5656d9df67ae/scratchpad/schema-check.sh`
  (local Postgres 16 via `service postgresql start`; creates DB `schemacheck` each run; `npm ci` already done).
- [x] **Phase 1 — Database.** `-- Batch 36: Ads A1` block (ad_packs, ad_pack_ads, ad_pack_runs, ad_pack_lead_links,
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
- [ ] **Phase 6 — Generator and store.** `store-server.ts`, `generate-server.ts`.
  Notes:
- [ ] **Phase 7 — Attribution on arrival.** `attribution.ts`, `attribution-server.ts`, one line in the lead route,
  `PackAdLine` on lead detail.
  Notes:
- [ ] **Phase 8 — Operator screen.** `/leads/ads`, entry card, activity kinds.
  Notes:
- [ ] **Phase 9 — Setup guide.** `guide.ts` + `Guide.tsx`.
  Notes:
- [ ] **Phase 10 — Admin.** `/admin/ad-packs`.
  Notes:
- [ ] **Phase 11 — Knowledge and docs.** placeholders, seed drafts, service-facts, CLAUDE.md section.
  Notes:
- [ ] **Phase 12 — Final checks, review, PR.**
  Notes:

## Session 36b (after 36a merged and schema run)

- [ ] B0 Setup (Vercel Sandbox available; Zac adds the 3 library voices to ElevenLabs)
- [ ] B1 Database (`ad_pack_renders`, unit_costs row, smoke + CI)
- [ ] B2 Renderer copy (`ad-render/`, no Stayful assets)
- [ ] B3 Voice and captions (`voice-server.ts`, with-timestamps)
- [ ] B4 Sandbox runner + cron (`render-server.ts`, `/api/internal/ad-pack-renders`)
- [ ] B5 Screen + checks (voice step, video preview)
- [ ] B6 Final checks, review, PR

## Remaining risks

Video quality below Stayful's hand-tuned ads (operator previews; keep switch off). Vercel Sandbox not enabled
(fallback: GitHub Actions runner). Thin market data (lower min-sample setting, ≥3). Meta rule changes (constants in
`links.ts`, `limits.ts`).
