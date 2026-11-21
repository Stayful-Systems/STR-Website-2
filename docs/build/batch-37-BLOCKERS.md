# Batch 37 — things only Zac can do

Plain English. Nothing here has been done by the build; each item is yours.

1. **Run the new database block on the live database** (after the PR is merged).
   Run `supabase/schema.sql` in the Supabase SQL editor. It is safe to run more than once. Recommended: run it
   straight after merge, before anyone is offered "Take my website".
2. **Confirm the provider tags for GoDaddy and IONOS** before launch. They are guesses (`GODADDY`, `1AND1`).
   Recommended: check each with the provider's support, then tell me and I change one line in `transfer-providers.ts`.
3. **Check the Openprovider side of the tag change.** Openprovider has no way to change a .co.uk tag by API, so each
   transfer shows a "manual tag step" in admin: you change the tag in the Openprovider panel, then click "Tag changed".
   Recommended: do one test transfer on a throwaway domain to learn the steps.
4. **Transfer code from 9 Feb 2027.** Whether Openprovider hands back the code by API is unconfirmed until that date.
   If it refuses, admin types the code in and it is emailed. Recommended: nothing now; test it after 9 Feb 2027.
5. **Email attachments.** The export email attaches the zip when it is under 15 MB. Check your email provider's
   attachment limit allows 15 MB. Recommended: send one test export to yourself.
6. **Preview deployments** may block the site fetching its own pages for the export (Vercel deployment protection).
   It works on production. Recommended: test on production, not on a preview.
7. **Merge and deploy.** Merging the PR and the production deploy are yours; the build stops at a draft PR.
8. **Env vars:** none new are planned (the export reuses the existing signing key, `CRON_SECRET` and the email key).
   Recommended: confirm those three are set on the Vercel project.
