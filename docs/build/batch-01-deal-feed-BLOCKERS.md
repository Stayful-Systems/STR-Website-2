# Deal Feed (queue Batch 1): things only Zac can do

Plain English. Nothing here has been done by the build; each item is yours.

1. **Run `supabase/schema.sql` on the live database after merge.** It is safe to re-run. The new "Deal feed" block adds the
   duplicate and stale-credit columns and settings. Recommended: run it straight after merge, before turning any switch on.
2. **Turn on `deal_stale_credit_enabled` in /admin/billing** once a dry run (`/api/internal/deal-stale-credits?dry=1`) lists
   sensible rows. It is seeded off.
3. **Turn on `deal_dedupe_enabled`** after checking the "Hidden as duplicates" count on /admin/deals. It is seeded off.
4. **Approve the new knowledge drafts** (`deal_stale_credit`, `deal_feed_categories`, `deal_r2r_permission`, `deal_duplicates`) in admin.
5. **Merge the PR and deploy.** Both are yours; the build stops at a draft PR.
6. **Env vars: none new.** The new cron uses the existing `CRON_SECRET`.
