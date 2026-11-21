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
