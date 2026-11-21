# PLAN — Batch 35: Ads A2 (Facebook lead forms via Google Sheets, attribution, one-tap outcomes, "Your ads")

Branch: `claude/dazzling-babbage-rkv4e1` (the harness allows pushes only here; the brief said `batch-35-ads-a2`).
Worktree: `/home/user/STR-Website-2`. Claim issue: none (repo has no claim issues).
Planned against origin/main `a3cae75` (A1 = #179 + #180 are merged). Review R6 is NOT on main; Zac said build now (as Batch 36 did).
Blockers for Zac: `PLAN-batch-35-BLOCKERS.md`.

## Decisions (Zac, 20 Nov)
- Rank an ad at 5 leads. Untagged leads count in totals, not in rankings.
- Outcomes note when <50% of leads older than 14 days are past New.
- One reminder line in the daily email for leads >7 days at New (within the cap, never a new send).
- A complete lead = name + (phone or email) + postcode.
- Sheet leads: instant new-lead email (same on/off setting as website leads), no report, pushed to the lead database lead-only.
- Same landlord = same owner + same postcode + (same email or same phone), within 30 days: the row joins the existing lead. Website-after-sheet still makes a second lead (accepted risk).
- Add `leads.meeting_reached_at`, stamped the first time a stage goes to meeting_booked or signed.

## Reused, do not duplicate / edit
A1: `normaliseCode`, `parseCode` (`src/lib/ad-packs/codes.ts`); `matchLeadToAd`, `LinkRow`, `packAdLineView` (`attribution.ts`); `cleanMetaAdId` (`links.ts`); tables `ad_pack_ads`, `ad_pack_lead_links`; `Guide.tsx` screenshot mechanism; `billing_settings` pattern. Leads: `stage.ts`, `setLeadStageAction`, `captureLead`, `leadScope`/`ownerIdOrNull`. Lead DB: `enqueueLeadDbPush`. Cron/auth: `leaddb-deliveries/route.ts` + `authoriseInternal`. Email: `sendEmail`, `notify/cap.ts`, `sends.ts`, `sendThroughCap` pattern, `buildDaily`, `recordOnly()`.

## Must not touch
Batch 36 website self-edit/grace files, `src/lib/domains`, `src/lib/funnels` pricing, `ACCESS_COLUMNS` (`src/lib/access.ts`), A1's `codes.ts` / `attribution.ts` (reused, not edited), the website lead route `src/app/api/s/[slug]/lead/route.ts`.

## Build rules
One coordinator, one subagent per phase, replies <=150 words, tick + commit "Phase N: <name>" after each phase, stop and ask on any blocker. Never log a lead (ids, link id, code at most). Never write `leads.status` / `leads.crm_pushed_at` from this. Every figure in knowledge entries is a `{placeholder}`. Drafts only, never approved in code.

---

## Phases

- [x] **Phase 0 — Setup** (needs A1 on main). Merge main, baseline `npm test`, `npm run lint`, `npm run typecheck` (baseline: 4630 tests pass, 0 lint errors / 79 warnings, typecheck clean). Write this file, commit.
  Notes: Done. main = a3cae75, branch level with it. Baseline green (4630 tests, 0 lint errors, typecheck clean). No numbered migrations: schema.sql is one idempotent file.

- [x] **Phase 1 — Database** (needs 0). Files: `supabase/schema.sql` ("-- Batch 35" block), `supabase/tests/adsheets-smoke.sql` (new), `.github/workflows/ci.yml` (one step).
  - `ad_sheet_links`: id, owner_id unique → profiles cascade, spreadsheet_id unique, tab_gid, tab_title, state check (waiting_test_row, active, error, disconnected), header_hash, header_map jsonb, columns_changed_at, last_row_read int, rows_imported int, untagged_count int, last_row_at, last_import_at, last_error_code, quiet_email_sent_at, connected_at, activated_at, created_at, updated_at; unique(id, owner_id).
  - `ad_sheet_rows`: id, link_id, owner_id, FK (link_id, owner_id) → ad_sheet_links(id, owner_id) cascade, row_key varchar(80), row_number, state check (imported, merged, incomplete, test, foreign), lead_id → leads set null, missing text[], answers jsonb (incomplete + unknown columns only), created_at; unique(link_id,row_key); index (owner_id, state).
  - `leads.meeting_reached_at timestamptz` if not exists; idempotent backfill = stage_changed_at where stage in (meeting_booked, signed) and it is null.
  - `billing_settings` seeds (on conflict do nothing): ad_sheets_enabled false, ad_sheet_min_leads 5, ad_sheet_quiet_days 7, ad_sheet_outcome_pct 50, ad_sheet_outcome_age_days 14, ad_sheet_reminder_age_days 7, ad_sheet_dedupe_days 30, ad_sheet_guide_checked_at null.
  - Both tables: RLS on, no policies, revoke all from anon, authenticated. Not in ACCESS_COLUMNS.
  - Check: schema.sql runs twice with empty diffs (CI schema job); smoke test asserts RLS, no policies, no anon/auth privilege, both unique constraints, composite FK rejects owner mismatch. Local check: `npm run typecheck` + schema lint tests if any; SQL smoke runs in CI (Postgres).
  Notes:

- [x] **Phase 2 — Google client** (needs 0). Files: `src/lib/ad-sheets/google.ts`, `sheet-link.ts`, `google.test.ts`, `.env.example` ("Batch 35" block: `GOOGLE_SHEETS_SA_EMAIL`, `GOOGLE_SHEETS_SA_PRIVATE_KEY` with escaped \n, scope `spreadsheets.readonly`; comments: never in code or DB; Zac creates the service account).
  - No new dependency: RS256 JWT via `node:crypto` createSign, token exchange with in-run cache; `sheetMeta(id)` (tabs); `readRange(id, tab, fromRow, toRow)`; errors become codes only: not_configured, not_shared (403), not_found (404), rate_limited, error; fetch injectable. `sheet-link.ts`: parse a pasted Sheets URL → {spreadsheetId, gid}, reject anything else.
  - Check: `npm test` (fake fetch): JWT shape, 403 → not_shared, unconfigured → not_configured, URL parsing variants.
  Notes:

- [x] **Phase 3 — Mapping rows** (needs 0). Files: `src/lib/ad-sheets/headers.ts`, `rows.ts`, `rows.test.ts`, `fixtures.ts`.
  - headers.ts: variants for name (full_name / first+last / name), email, phone, postcode (post_code, postal_code, zip, "property postcode"), ad_id, ad_name, lead id, created_time, form_id, campaign_name, is_organic; `mapHeaders` → {map, hash, missingRequired}; `headersChanged(oldHash, new)`. Tolerant (lower-case, strip punctuation/underscores).
  - rows.ts: `toCandidate(row, map)` → {name,email,phone,postcode,adName,adId,metaLeadId,answers} (trim, normalise UK postcode and phone); `isComplete` (name + (phone|email) + postcode, with missing[]); `isTestLead` ("test lead", "dummy data"); `rowKey` (Meta lead id or sha256 of cells); `findCodeInText(adName)` unanchored finder run through A1's `normaliseCode`.
  - Check: `npm test`: header variants, incomplete flagged with right missing, test rows, stable row key, code found inside "SI-3F9A2C-5B-1 · Tenant notice".
  Notes:

- [ ] **Phase 4 — Attribution and same-landlord match** (needs 3). Files: `src/lib/ad-sheets/attribute.ts` (+test), `src/lib/leads/dedupe.ts` (+test), `src/lib/leads/store.ts` (minimal).
  - `attributeRow`: matchLeadToAd with code found in ad name; if none, re-run with no code so Meta ad id fallback applies; foreign_code stays foreign; returns LinkRow and learns adId → packAdId into in-run map.
  - dedupe.ts: pure `sameLandlord(a, b, windowDays)`, `sameLandlordSince(now, days)`; store.ts: `findSameLandlordLead(ownerId, cand, days)` (owner-scoped, not archived); allow `captureLead` with null funnel and null email if needed. Existing website dedupe unchanged.
  - Check: `npm test`: renamed ad attributes via earlier id; unknown → untagged; foreign code → untagged + row foreign; 10-day-old website lead matches, >30 days not, different owner never.
  Notes:

- [ ] **Phase 5 — Import engine** (needs 1, 2, 4). Files: `src/lib/ad-sheets/import.ts` (injectable store), `import-server.ts`, `notify-server.ts`, `import.test.ts`, `src/lib/leaddb/` (one eligibility line + test).
  - `runImport({dry, linkId?})`. Only links in state active / waiting_test_row. Read header, detect change (stamp columns_changed_at, keep saving; ad columns gone → untagged). Reads start at last_row_read − 50; if sheet shrank, rescan whole sheet. For each row: insert ad_sheet_rows first (on conflict do nothing → skip); then by kind: test → state test (waiting_test_row link → active, activated_at); foreign → foreign; incomplete → incomplete (answers kept); same landlord → merged (attribution written only if lead has no pack-ad link); otherwise `captureLead` (status new, operator's website funnel or null) → upsert `ad_pack_lead_links` → `void enqueueLeadDbPush` → `void notifySheetLead` (same `funnels.notify_new_lead` setting + `owner_notified_at` claim as website leads). Lead created only by the row insert's winner. Update last_row_read, counts, last_row_at, last_import_at, error code. Dry run writes nothing.
  - leaddb: a lead with an `ad_sheet_rows` row is eligible without a report (lead-only); website-lead behaviour unchanged (test pins it).
  - Check: `npm test`: two runs + retry after mid-run failure → each row once; incomplete saved; same landlord form + sheet → one lead; never another owner's id; dry run no writes; leaddb unchanged for website leads, accepts sheet leads.
  Notes:

- [ ] **Phase 6 — Cron and monitoring** (needs 5). Files: `src/app/api/internal/ad-sheets/route.ts`, `vercel.json` (one line `21 * * * *`), `src/lib/ad-sheets/quiet.ts` (+test), `src/lib/notify/cap.ts` (one SendKind `ad_sheet_quiet`).
  - Route follows leaddb-deliveries (secrets → 404, auth → 401, service role → 503, `?dry=1`); runs import, then quiet check; `not_configured` when service account unset. quiet.ts: active link with no row for `ad_sheet_quiet_days` and `quiet_email_sent_at` null → one email through the cap, then stamp; new row clears the stamp; taken slot → no stamp, retry next day.
  - Check: `npm test`: quiet email once across many runs; not re-sent until a new row + 7 more quiet days; taken slot no stamp; dry run sends nothing.
  Notes:

- [ ] **Phase 7 — Connect flow in the ad pack screen** (needs 2, 5). Files: `src/lib/ad-sheets/settings.ts` (+test), `connect.ts` (ops + test), `src/app/leads/ads/sheet-actions.ts`, `ConnectSheet.tsx`, `src/app/leads/ads/page.tsx` (one insert), `src/lib/activity/kinds.ts` (+test).
  - "Switch to lead forms" card in approved state, owner only (`ownerIdOrNull`), when `ad_packs_enabled` and `ad_sheets_enabled` are on (or viewer is admin). Six guided steps, one action per screen, screenshot slot `public/ad-packs/guide/sheet-<step>.png`, "Stuck?" help line: (1) create instant form with the pack's lead_form questions (copy buttons); (2) connect form to a Google Sheet in Meta; (3) share sheet with service account email (copy button); (4) paste link → shared? headers found?; (5) send a test lead → test row read; (6) change each ad's destination to the instant form. Green tick only when Intelligence confirms. Errors in plain English (`messages.ts`). Unconfigured → "Lead form link not available yet".
  - Mode stays website until link active (connected AND a row read). "Disconnect" returns to website mode. Record-only kind `ad_sheet_connected` logged when a link becomes active.
  - Check: `npm test` ops tests: non-owner refused; sheet linked to another owner refused; not shared → right message; mode stays website until a row read; activity kind pinned record-only.
  Notes:

- [ ] **Phase 8 — One-tap outcomes** (needs 1; can run alongside 5–7). Files: `src/app/leads/StageTaps.tsx` (new), `LeadList.tsx` (minimal), `src/app/leads/[id]/LeadDetailActions.tsx` (minimal), `src/app/leads/lead-actions.ts` (stamp), test.
  - Five buttons (New, Contacted, Meeting booked, Signed, Lost), current highlighted; one tap calls `setLeadStageAction` (already logs `lead_action`); replaces the select on lead cards and lead page. `setLeadStageAction` stamps `meeting_reached_at` once when null and stage is meeting_booked or signed.
  - Check: `npm test`: tap records lead_action {action:'stage'}; stamp set once and survives later Lost; paused seat / capability without access refused.
  Notes:

- [ ] **Phase 9 — "Your ads"** (needs 1, 5, 8; after 7 because both insert into page.tsx). Files: `src/lib/ad-sheets/ranking.ts` (+test), `ranking-server.ts`, `src/app/leads/ads/YourAds.tsx`, `page.tsx` (one insert), `src/lib/activity/kinds.ts` (+test).
  - ranking-server reads only `ad_pack_lead_links` and `leads` with owner_id = scope.ownerId. Per ad: leads, meetings (meeting_reached_at not null), signed. Untagged shown separately, in totals only. Ads with >= `ad_sheet_min_leads` ranked by signed, then meetings, then leads; others "Not enough data yet". Note "Outcomes aren't being marked" when under 50% of leads older than 14 days are past New. No spend, no cost per lead, no benchmarks. Opening logs new record-only kind `ad_ranking_viewed`.
  - Check: `npm test`: ranking hidden below minimum; untagged in totals not ranking; note threshold; never another operator's data (fake store, two owners).
  Notes:

- [ ] **Phase 10 — Admin** (needs 5, 6). Files: `src/app/admin/ad-sheets/page.tsx`, `actions.ts`, `AdSheetsPanel.tsx`, `src/app/admin/ad-packs/page.tsx` (one link line).
  - Lists sheets: owner, state, last row read, last import, error code, untagged count, columns changed. Import Dry run / Run (Run confirms), Disconnect with its own Dry run. "Guide screenshots last checked: <date>, due" when >30 days, with "Mark checked". Never shows cell contents.
  - Check: `npm test` action test: admin-only; dry runs write nothing; no row contents in output.
  Notes:

- [ ] **Phase 11 — Daily email line and knowledge** (needs 8, 9). Files: `src/lib/notify/message.ts` (one line in the leads section) + its input builder, `src/lib/knowledge/seed.ts`, `placeholders.ts`, `service-facts.ts`, `CLAUDE.md`.
  - Daily email line: "N leads are over 7 days old and still at New, mark what happened" only when N > 0; never adds a send; cap unchanged. Knowledge drafts `adsheet_what`, `adsheet_connect`, `adsheet_attribution`, `adsheet_outcomes`, `adsheet_your_ads` (never approved in code); placeholders `{ad_sheet_min_leads}`, `{ad_sheet_quiet_days}`, `{ad_sheet_outcome_pct}`, `{ad_sheet_outcome_age_days}`, `{ad_sheet_reminder_age_days}`, `{ad_sheet_dedupe_days}`. "FACEBOOK LEAD FORMS" line in `service-facts.ts`; "Batch 35" section in `CLAUDE.md`.
  - Check: `npm test`: seed tests (placeholders resolve, no typed figure); daily email test line at N>0, absent at 0.
  Notes:

- [ ] **Phase 12 — Final checks and review** (needs all). `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` (failures only). Review checklist: [ ] service account never reads an unlinked sheet / rows never land with another owner; [ ] no address/PII in logs; [ ] idempotent "-- Batch 35" schema; [ ] ACCESS_COLUMNS untouched; [ ] dry runs on cron and every admin action; [ ] daily cap unchanged. Then push, open draft PR, watch CI.
  Notes:

## Remaining risks (one-line rollback)
- Website-after-sheet makes a second lead (accepted). Rollback: none; a later batch can add the check to the website route.
- Meta's real header names may differ. Leads saved, missing fields flagged incomplete, admin shows "columns changed". Rollback: add the variant to `headers.ts`; next hourly run re-reads kept rows.
- Renamed ad before any lead carried its code stays untagged. Rollback: none; reported as untagged, lead never blocked.
- Google quota/outage: run records rate_limited/error, next hour retries from last_row_read. Rollback: `ad_sheets_enabled` off.
- Whole feature: `ad_sheets_enabled` off. Ads stay in website mode; tables are additive.

## Verification (Zac's click-through)
Run schema.sql; as a test operator follow the guide with a test sheet; add a row → admin Dry run (1) then Run → lead appears with the right ad; renamed ad with same ad id → attributed; nothing matching → "Ad unknown"; same landlord as earlier website lead → no duplicate; tap "Meeting booked" → Your ads updates; leave sheet quiet 7 days → one email.
