/**
 * Batch 36 (Phase 9): the step-by-step guide for putting an approved ad pack on
 * the operator's OWN Meta Ads Manager. We have no Meta connection and run
 * nothing on Meta: the operator does every step, and this file only says what.
 *
 * The campaign uses Meta's Traffic objective (link clicks), because it needs no
 * tracking pixel set up per operator. The ad link carries the pack code, so
 * each enquiry is still recorded against the ad that brought it (Batch 35 later
 * moves to lead forms).
 *
 * Rules this file keeps (pinned by guide.test.ts):
 *   - every step asks for exactly ONE thing, in one sentence
 *   - every step has a plain-English "Stuck?" answer
 *   - ad name and link steps copy the pack's own name and link
 *   - no money figure, no promise about results, no product name, no em dash
 *   - UK English
 *
 * Pure: no network, no database, no filesystem, no server-only (the screen
 * checks which screenshots exist in guide-server.ts).
 */

/** What a step's Copy button copies from the ad being set up. */
export type GuideCopyKind = 'ad_name' | 'link' | 'primary' | 'headline' | 'description' | 'none';

export type GuideStep = {
  id: string;
  title: string;
  /** Exactly one thing to do, in one sentence. */
  action: string;
  /** Extra help for the step, a few sentences at most. */
  detail?: string;
  copy: { kind: GuideCopyKind };
  /** A plain-English answer for someone who is stuck, 1 to 3 sentences, no jargon. */
  stuck: string;
  /** The picture for the step. `file` is a path in the repo; the screen shows a plain box until the file exists. */
  screenshot: { file: string; alt: string };
};

/** Where the screenshots live, relative to the repo and to the site. */
export const GUIDE_DIR = 'public/ad-packs/guide';
export const GUIDE_URL_DIR = '/ad-packs/guide';

const shot = (id: string, alt: string): GuideStep['screenshot'] => ({ file: `${GUIDE_DIR}/${id}.png`, alt });

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'open-ads-manager',
    title: 'Open Ads Manager',
    action: 'Open adsmanager.facebook.com in your web browser.',
    detail: 'Log in with the Facebook account that looks after your business. You need a Facebook Page for your business and an ad account to go with it.',
    copy: { kind: 'none' },
    stuck:
      'If you do not have a Facebook Page yet, create one on Facebook from the Pages menu, using your company name and logo. If you have no ad account, Ads Manager offers to set one up the first time you start an ad, and it asks for a payment method; you only pay when your ads run.',
    screenshot: shot('open-ads-manager', 'Ads Manager open on the list of campaigns, with your ad account chosen at the top'),
  },
  {
    id: 'create-campaign',
    title: 'Start a new campaign',
    action: 'Click the green Create button.',
    detail: 'A campaign is the folder that holds your ads. You only need one for this pack.',
    copy: { kind: 'none' },
    stuck:
      'The Create button is at the top left of the list of campaigns. If you cannot see it, check that your ad account is chosen at the top of the page, and if Meta offers a choice of set-up styles, pick the one that lets you choose the objective yourself.',
    screenshot: shot('create-campaign', 'The green Create button above the list of campaigns'),
  },
  {
    id: 'choose-traffic',
    title: 'Choose Traffic',
    action: 'Choose Traffic as the objective for your campaign.',
    detail: 'Traffic sends people to your website, which is where your enquiry form is. If Meta asks where to send people, choose Website.',
    copy: { kind: 'none' },
    stuck:
      'Traffic is one of the choices in the list of objectives. If you cannot see it, scroll down the list or look for a "See more" link, and pick Traffic rather than Leads or Sales.',
    screenshot: shot('choose-traffic', 'The list of campaign objectives with Traffic highlighted'),
  },
  {
    id: 'set-budget',
    title: 'Set a daily budget',
    action: 'Set a daily budget that you are comfortable with.',
    detail:
      'Start small. You can raise it, lower it or switch the ad off at any time once you see how it is doing. Nobody can promise what an ad will bring in, so choose an amount you are comfortable with.',
    copy: { kind: 'none' },
    stuck:
      'Meta asks for the budget in the currency of your ad account, so type a plain number. Choose a daily budget rather than a total one, and treat any estimate of results Meta shows as a rough guess.',
    screenshot: shot('set-budget', 'The budget box set to a daily budget'),
  },
  {
    id: 'set-audience',
    title: 'Choose who sees it',
    action: 'Set the location to your area and the towns around it.',
    detail:
      'Set the age range from 30 to 65 and over, and leave the placements on Meta’s automatic choice so Meta can show the ad where it works best. Leave interests empty, as Meta finds the right people from the ad itself.',
    copy: { kind: 'none' },
    stuck:
      'Type your town into the Locations box and pick it from the list, then add the towns around it the same way. If Meta asks whether to include or exclude a place, choose include.',
    screenshot: shot('set-audience', 'The audience section with locations, age range and automatic placements'),
  },
  {
    id: 'choose-page',
    title: 'Choose your Facebook Page',
    action: 'Choose your business Facebook Page as the identity for the ad.',
    detail: 'People see your Page name on the ad, so use the Page for your company.',
    copy: { kind: 'none' },
    stuck:
      'If your Page is not in the list, it may belong to a different Facebook account, so log out and back in with the account that owns it. If you have no Page, create one on Facebook with your company name and logo, then refresh Ads Manager.',
    screenshot: shot('choose-page', 'The ad section with your Facebook Page chosen'),
  },
  {
    id: 'upload-file',
    title: 'Upload the ad file',
    action: 'Upload the image file for this ad from your pack.',
    detail:
      'Use the 4:5 portrait file for the Facebook and Instagram feed, the 9:16 file for stories and reels, and the 1:1 square file if Meta asks for a square one. Download them from your ads above, one set for each ad. The tenant notice ad is a video that arrives later, so for now follow the steps with its texts and add the video when it is ready.',
    copy: { kind: 'none' },
    stuck:
      'If Meta warns that the picture is cropped on some placements, put the 9:16 file in the stories and reels slot and the 4:5 file in the rest. If you only add one file, make it the 4:5 one; on a phone the files go to your downloads or photos.',
    screenshot: shot('upload-file', 'The media section after uploading the portrait 4:5 image'),
  },
  {
    id: 'paste-primary',
    title: 'Paste the primary text',
    action: 'Paste the primary text into the Primary text box.',
    detail: 'Your ad has a few versions of this text. Pick the one you like best and copy it; you can try the others another time.',
    copy: { kind: 'primary' },
    stuck:
      'Tap Copy under the text you want, click in the Primary text box in Meta, then paste with Ctrl and V on a computer, Command and V on a Mac, or by holding your finger on the box on a phone. Paste it exactly as it is; if nothing pastes, select the text by hand and copy it.',
    screenshot: shot('paste-primary', 'The Primary text box with the text pasted in'),
  },
  {
    id: 'paste-headline',
    title: 'Paste the headline',
    action: 'Paste the headline into the Headline box.',
    detail: 'Pick one of the headlines and copy it.',
    copy: { kind: 'headline' },
    stuck:
      'Tap Copy next to the headline you want and paste it into the Headline box under the primary text. Leave it exactly as it is, as the length has been checked for Meta.',
    screenshot: shot('paste-headline', 'The Headline box with the headline pasted in'),
  },
  {
    id: 'paste-description',
    title: 'Paste the description',
    action: 'Paste the description into the Description box.',
    detail: 'Meta does not show the description on every placement, so it may not always be seen, but it is still worth adding.',
    copy: { kind: 'description' },
    stuck:
      'If you cannot see a Description box, look for a link such as "Add more options" or "Show advanced options" just under the headline. If it is not there at all, you can leave this step out, as the ad still works without it.',
    screenshot: shot('paste-description', 'The Description box with the description pasted in'),
  },
  {
    id: 'paste-ad-name',
    title: 'Paste the ad name',
    action: 'Paste the ad name exactly as it is into the Ad name box.',
    detail: 'The name starts with your pack code, so we can tell which ad worked. Every enquiry from this ad is recorded against it.',
    copy: { kind: 'ad_name' },
    stuck:
      'The Ad name box is at the top of the ad section, and Meta fills it in with a name of its own. Click in it, select everything, and paste; if you change it by mistake, come back here, copy it again and paste it over.',
    screenshot: shot('paste-ad-name', 'The Ad name box at the top of the ad section with the pack name pasted in'),
  },
  {
    id: 'paste-link',
    title: 'Paste the link',
    action: 'Paste the link exactly as it is into the Website URL box.',
    detail:
      'This is so we can show you which ad works. The part that says {{ad.id}} must stay exactly as it is, because Meta fills it in with the ad’s own number. Do not edit, shorten or tidy the link.',
    copy: { kind: 'link' },
    stuck:
      'Choose Website as the destination, then paste into the Website URL box. If Meta shows a message about the link, check that nothing was added before or after it; the curly brackets are meant to be there, so do not delete them.',
    screenshot: shot('paste-link', 'The Website URL box with the full link pasted in'),
  },
  {
    id: 'publish',
    title: 'Review and publish',
    action: 'Click Publish once the preview looks right to you.',
    detail:
      'Meta looks at every ad before it goes live, which can take up to a day. Meta tells you when the ad is approved, or if it needs a change.',
    copy: { kind: 'none' },
    stuck:
      'If Meta turns an ad down, it says why next to the ad in Ads Manager, and you can ask for a second look from there. If you are still stuck, get in touch and we will help.',
    screenshot: shot('publish', 'The Publish button at the bottom right of Ads Manager'),
  },
];

export function guideStep(id: string): GuideStep | null {
  return GUIDE_STEPS.find((s) => s.id === id) ?? null;
}

/** "Step 3 of 13" for the step at zero-based position `i`, clamped into range. */
export function stepNumberLabel(i: number, n: number): string {
  const total = Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));
  if (total === 0) return 'Step 0 of 0';
  return `Step ${clampStep(i, total) + 1} of ${total}`;
}

/** A step position forced into 0 .. n-1 (0 when there are no steps or the value is not a number). */
export function clampStep(i: number, n: number): number {
  const total = Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));
  if (total === 0) return 0;
  const v = Math.trunc(Number.isFinite(i) ? i : 0);
  return Math.min(total - 1, Math.max(0, v));
}

/** One step on from `i`, stopping at the last. */
export const nextStepIndex = (i: number, n: number): number => clampStep(clampStep(i, n) + 1, n);
/** One step back from `i`, stopping at the first. */
export const prevStepIndex = (i: number, n: number): number => clampStep(clampStep(i, n) - 1, n);

/** Steps that work on one particular ad (its texts, name, link or files), so the screen offers the pick of the three ads. */
export const needsAdPicker = (step: GuideStep): boolean => step.copy.kind !== 'none' || step.id === 'upload-file';

/** The site path of a step's screenshot. */
export const screenshotUrl = (id: string): string => `${GUIDE_URL_DIR}/${id}.png`;

/** Of the file names found in the guide folder, the step ids that have a screenshot. */
export function availableShots(fileNames: readonly string[]): string[] {
  const names = new Set(fileNames);
  return GUIDE_STEPS.filter((s) => names.has(`${s.id}.png`)).map((s) => s.id);
}

/** What the screen shows for a step's picture: the file if it exists, else a plain box with the alt text. */
export function screenshotView(step: GuideStep, available: readonly string[]): { kind: 'image'; src: string; alt: string } | { kind: 'placeholder'; text: string } {
  return available.includes(step.id)
    ? { kind: 'image', src: screenshotUrl(step.id), alt: step.screenshot.alt }
    : { kind: 'placeholder', text: `Screenshot to come: ${step.screenshot.alt}` };
}

/** The ad's texts that a step's Copy button offers (several for primary, headline, description; one for name and link; none otherwise). */
export function copyListFor<T>(kind: GuideCopyKind, copy: { name: T; link: T; primary: readonly T[]; headlines: readonly T[]; descriptions: readonly T[] }): T[] {
  switch (kind) {
    case 'ad_name':
      return [copy.name];
    case 'link':
      return [copy.link];
    case 'primary':
      return [...copy.primary];
    case 'headline':
      return [...copy.headlines];
    case 'description':
      return [...copy.descriptions];
    default:
      return [];
  }
}
