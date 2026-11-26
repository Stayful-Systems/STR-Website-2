# Batch 55 Part A, Phase 1: things only Zac can do

Plain English. Nothing here has been done by the build; each item is yours.

1. **Apply the "Batch 55 (Part A)" block of `supabase/schema.sql` on live Supabase after merge.** It is safe to re-run.
   Recommended: right after merging, before Part B Phase 1.
2. **Check `SI_LEAD_PUSH_SECRET` (32+ characters) is set on both Vercel projects.** It already exists for Batch 32, so nothing new.
3. **Keep `ad_packs_enabled` OFF.** Set "Allowed" on `/admin/ad-packs` for the first customer only in Phase 3.
4. **Add guide screenshots for the new audience step** to `public/ad-packs/guide/` (list in its README). Recommended: take them from your own Ads Manager.
5. **Approve the knowledge drafts** (`adpack_ld_calculator`, `adpack_ld_rounds`, `adpack_audience`) in admin.
6. **Review and merge the draft PR.** The build stops there.
7. **Run Part B Phase 1 in the lead-database session.** It must call `provision`, `state` and `signin`; see `batch-55-part-a-CONTRACT.md`.
8. **Confirm the proposed campaign objective** in the audience step (Leads, website destination, "Maximise number of landing page views"). It is marked PROPOSED.
