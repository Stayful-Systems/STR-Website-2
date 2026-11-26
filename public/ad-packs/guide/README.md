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
- `set-audience.png` (the audience step, see below)
- `choose-page.png`
- `upload-file.png`
- `paste-primary.png`
- `paste-headline.png`
- `paste-description.png`
- `paste-ad-name.png`
- `paste-link.png`
- `publish.png`

## The audience step picture

The audience step lists seven settings (`src/lib/ad-packs/targeting-recipe.ts`, last checked 2026-11-23). It keeps
one file, named after its step id, so the folder and the guide stay in step. Take it as three crops of Meta's
audience section and join them top to bottom into one tall picture, still 1200 px wide at most:

1. Location, age and gender, and Advantage+ audience.
2. Interests (Real property, Landlord, Airbnb) and Placements.
3. Campaign budget (switched on, no amount typed) and the empty exclusion and lookalike boxes.

Use a sample ad account, so no personal data shows.
