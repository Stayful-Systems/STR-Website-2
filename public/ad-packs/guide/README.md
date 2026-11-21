# Ad pack guide screenshots

One PNG per step of the setup guide on `/leads/ads` (`src/lib/ad-packs/guide.ts`). Until a step's file
exists, the screen shows a plain "Screenshot to come" box for it, so nothing breaks. The release switch
(`ad_packs_enabled`) stays off until real screenshots are in.

Rules:

- One PNG per step, named `<step id>.png`, saved in this folder.
- 1200 px wide at most.
- Crop to the part of Meta's screen that matters for that step.
- No personal data visible: hide ad account names and ids, Page names that are not a sample, and any payment details.

Step ids, one file each:

- `open-ads-manager.png`
- `create-campaign.png`
- `choose-traffic.png`
- `set-budget.png`
- `set-audience.png`
- `choose-page.png`
- `upload-file.png`
- `paste-primary.png`
- `paste-headline.png`
- `paste-description.png`
- `paste-ad-name.png`
- `paste-link.png`
- `publish.png`

## Lead form (Google Sheets) guide, Batch 35

Six more screenshots for the "Switch to lead forms" card on `/leads/ads`, same rules as above:

- `sheet-1.png` (create the instant form)
- `sheet-2.png` (connect the form to a Google Sheet in Meta)
- `sheet-3.png` (share the sheet with the Stayful service account)
- `sheet-4.png` (paste the sheet link)
- `sheet-5.png` (send a test lead with Meta's testing tool)
- `sheet-6.png` (point each ad at the instant form)
