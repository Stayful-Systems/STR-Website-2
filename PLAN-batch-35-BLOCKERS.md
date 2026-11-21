# Batch 35 — things only Zac can do

Nothing here blocks the build. All of it is needed before the feature works for real.

1. **Run the new database section.** Run `supabase/schema.sql` on the live database (the "-- Batch 35" block is safe to run twice). Recommended: after the PR's CI is green, before turning the switch on.
2. **Create the Google service account** (Google Cloud → IAM → Service Accounts, enable the Google Sheets API, create a JSON key). Then set on Vercel (both projects): `GOOGLE_SHEETS_SA_EMAIL` and `GOOGLE_SHEETS_SA_PRIVATE_KEY` (paste the key with `\n` kept as the two characters backslash-n). Until then the connect screen says "Lead form link not available yet" and the hourly job does nothing.
3. **Supply the guide screenshots** `public/ad-packs/guide/sheet-<step>.png` (one per guide step). Placeholders show until you do. Admin shows a "due" reminder after 30 days.
4. **Turn the switch on** when ready: `ad_sheets_enabled` in billing settings (also needs A1's `ad_packs_enabled`). Recommended: test with one operator first (admins can preview before it is on).
5. **Optional:** if you can send a real header row from a connected Meta form, it replaces the fixture in `src/lib/ad-sheets/fixtures.ts`.
6. **Merge the PR** (merge and production deploy are yours). Recommended order: this PR after any other open batch PRs.
7. **Approve the knowledge drafts** (`adsheet_*`) in Stayful Intelligence when happy.
