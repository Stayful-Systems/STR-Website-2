/**
 * Batch 38 (Phase 9, redesigned in 38c): the step-by-step guide for putting an
 * approved set of ads on the operator's OWN Facebook Ads Manager. We have no
 * Facebook connection and run nothing there: the operator does every step, and
 * this file only says what.
 *
 * The campaign uses Facebook's Traffic goal (link clicks), because it needs no
 * tracking set up per operator. The ad link carries a short ad code, so each
 * enquiry is still recorded against the ad that brought it.
 *
 * Rules this file keeps (pinned by guide.test.ts):
 *   - every step asks for exactly ONE thing, in one short sentence
 *   - every step has a plain-English "Stuck?" answer
 *   - ad name and link steps copy the ad's own name and link
 *   - a text step names the Facebook box it goes into, and the name we use for it
 *   - no money figure, no promise about results, no product name, no em dash
 *   - UK English, no internal words (no "pack", "code", "primary text" except in
 *     the one "box called Primary text" sentence)
 *
 * Pure: no network, no database, no filesystem, no server-only (the screen
 * checks which screenshots exist in guide-server.ts).
 */

import { RECIPE_ITEMS, recipeLine } from './targeting-recipe.ts';

/** What a step's Copy button copies from the ad being set up. */
export type GuideCopyKind = 'ad_name' | 'link' | 'primary' | 'headline' | 'description' | 'none';

export type GuideStep = {
  id: string;
  title: string;
  /** Exactly one thing to do, in one sentence. */
  action: string;
  /** Extra help for the step, a few short sentences at most. */
  detail?: string;
  /** An ordered list of short settings to work down (the audience step only). */
  checklist?: readonly string[];
  copy: { kind: GuideCopyKind };
  /** The name of the box in Facebook this text goes into (text steps only). */
  facebookFieldName?: string;
  /** What we call the same text on our own screens (text steps only). */
  ourName?: string;
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
    title: 'Open Facebook Ads Manager',
    action: 'Open adsmanager.facebook.com in your web browser.',
    detail: 'Log in with the Facebook account that looks after your business. You need a Facebook page for your business, and an ad account to go with it.',
    copy: { kind: 'none' },
    stuck:
      'If you do not have a Facebook page yet, make one on Facebook from the Pages menu, using your company name and logo. If you have no ad account, Ads Manager offers to set one up the first time you start an ad. It asks for a payment method, and you only pay when your ads run.',
    screenshot: shot('open-ads-manager', 'Ads Manager open on the list of campaigns, with your ad account chosen at the top'),
  },
  {
    id: 'create-campaign',
    title: 'Start a new campaign',
    action: 'Press the green Create button.',
    detail: 'A campaign is a folder that holds your ad.',
    copy: { kind: 'none' },
    stuck:
      'The Create button is at the top left of the list of campaigns. If you cannot see it, check that your ad account is chosen at the top of the page. If Facebook offers a choice of set-up styles, pick the one that lets you choose the goal yourself.',
    screenshot: shot('create-campaign', 'The green Create button above the list of campaigns'),
  },
  {
    id: 'choose-traffic',
    title: 'Choose Traffic',
    action: 'Choose Traffic as the goal for your campaign.',
    detail: 'Traffic sends people to your website, which is where your enquiry form is. If Facebook asks where to send people, choose Website.',
    copy: { kind: 'none' },
    stuck:
      'Traffic is one of the choices in the list of goals. If you cannot see it, scroll down the list or look for a "See more" link, and pick Traffic rather than Leads or Sales.',
    screenshot: shot('choose-traffic', 'The list of campaign goals with Traffic highlighted'),
  },
  {
    id: 'set-budget',
    title: 'Choose a daily budget',
    action: 'Set a daily budget you are comfortable with.',
    detail:
      'Start small. You can raise it, lower it or switch the ad off at any time, once you see how it is doing. Nobody can promise what an ad will bring in, so pick an amount you are happy to spend.',
    copy: { kind: 'none' },
    stuck:
      'Facebook asks for the budget in the money of your ad account, so type a plain number. Choose a daily budget rather than a total one, and treat any estimate Facebook shows as a rough guess.',
    screenshot: shot('set-budget', 'The budget box set to a daily budget'),
  },
  {
    id: 'set-audience',
    title: 'Set up your audience',
    action: 'Set each of the seven choices below, in this order.',
    detail: 'You find these in the audience section on Facebook. Set each one as shown, then move to the next.',
    checklist: RECIPE_ITEMS.map(recipeLine),
    copy: { kind: 'none' },
    stuck:
      'If you cannot find a choice, scroll down the audience section, because Facebook shows them one under another. If you cannot see Interests, look for a link called Detailed targeting and open it, then search for each interest by name. Choose the options exactly as written here, even if Facebook suggests others.',
    screenshot: shot('set-audience', 'The audience section with location, age, interests, placements and budget set as listed'),
  },
  {
    id: 'choose-page',
    title: 'Choose your Facebook page',
    action: 'Choose your business Facebook page as the name on the ad.',
    detail: 'People see your page name on the ad, so use the page for your company.',
    copy: { kind: 'none' },
    stuck:
      'If your page is not in the list, it may belong to a different Facebook account. Log out and back in with the account that owns it. If you have no page, make one on Facebook with your company name and logo, then refresh Ads Manager.',
    screenshot: shot('choose-page', 'The ad section with your Facebook page chosen'),
  },
  {
    id: 'upload-file',
    title: 'Add the ad file',
    action: 'Upload the file for this ad.',
    detail: 'Download the file below, then add it in Ads Manager.',
    copy: { kind: 'none' },
    stuck:
      'If Facebook says the picture or video is cropped in some places, put the full screen file in the Stories and Reels slot and the feed file in the rest. If you only add one file, make it the feed one. On a phone, the files go to your downloads or your photos.',
    screenshot: shot('upload-file', 'The media section after uploading the feed file'),
  },
  {
    id: 'paste-primary',
    title: 'Paste your main text',
    action: 'Paste your main text into the box called Primary text in Facebook.',
    detail: 'This is the writing above your picture or video. Pick the wording you like best. You can try the others another time.',
    copy: { kind: 'primary' },
    facebookFieldName: 'Primary text',
    ourName: 'Main text',
    stuck:
      'Tap Copy, click in the box called Primary text in Facebook, then paste with Ctrl and V on a computer, Command and V on a Mac, or by holding your finger on the box on a phone. Paste it exactly as it is. If nothing pastes, select the text by hand and copy it.',
    screenshot: shot('paste-primary', 'The box called Primary text with the text pasted in'),
  },
  {
    id: 'paste-headline',
    title: 'Paste your headline',
    action: 'Paste your headline into the box called Headline in Facebook.',
    detail: 'This is the short bold line under your picture or video.',
    copy: { kind: 'headline' },
    facebookFieldName: 'Headline',
    ourName: 'Headline',
    stuck:
      'Tap Copy next to the headline and paste it into the Headline box under the main text. Leave it exactly as it is, because its length has been checked for Facebook.',
    screenshot: shot('paste-headline', 'The Headline box with the headline pasted in'),
  },
  {
    id: 'paste-description',
    title: 'Paste your extra line',
    action: 'Paste your extra line into the box called Description in Facebook.',
    detail: 'Facebook does not show this line everywhere, so people may not always see it, but it is still worth adding.',
    copy: { kind: 'description' },
    facebookFieldName: 'Description',
    ourName: 'Extra line',
    stuck:
      'If you cannot see a Description box, look for a link such as "Add more options" or "Show advanced options" just under the headline. If it is not there at all, you can skip this step, because the ad still works without it.',
    screenshot: shot('paste-description', 'The Description box with the extra line pasted in'),
  },
  {
    id: 'paste-ad-name',
    title: 'Paste your ad name',
    action: 'Paste your ad name into the box called Ad name in Facebook.',
    detail: 'Paste it exactly as it is, so we can show you which ad each enquiry came from.',
    copy: { kind: 'ad_name' },
    facebookFieldName: 'Ad name',
    ourName: 'Ad name',
    stuck:
      'The Ad name box is at the top of the ad section, and Facebook fills it in with a name of its own. Click in it, select everything, and paste. If you change it by mistake, come back here, copy it again and paste it over.',
    screenshot: shot('paste-ad-name', 'The Ad name box at the top of the ad section with the ad name pasted in'),
  },
  {
    id: 'paste-link',
    title: 'Paste your website link',
    action: 'Paste your website link into the box called Website URL in Facebook.',
    detail:
      'Paste it exactly as it is, and do not change anything. The part in curly brackets, {{ad.id}}, looks odd, but Facebook fills it in for you. This is so we can show you which ad works.',
    copy: { kind: 'link' },
    facebookFieldName: 'Website URL',
    ourName: 'Website link',
    stuck:
      'Choose Website as the destination, then paste into the Website URL box. If Facebook shows a message about the link, check that nothing was added before or after it. The curly brackets are meant to be there, so do not delete them.',
    screenshot: shot('paste-link', 'The Website URL box with the full link pasted in'),
  },
  {
    id: 'publish',
    title: 'Publish your ad',
    action: 'Press Publish when the preview looks right to you.',
    detail:
      'Facebook looks at every ad before it goes live, which can take up to a day. Facebook tells you when the ad is approved, or if it needs a change.',
    copy: { kind: 'none' },
    stuck:
      'If Facebook turns an ad down, it says why next to the ad in Ads Manager, and you can ask for a second look from there. If you are still stuck, get in touch and we will help.',
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

/** The progress bar's width in whole percent for the step at zero-based position `i` of `n` (step 1 of 13 is not an empty bar). */
export const stepPercent = (i: number, n: number): number => (n <= 0 ? 0 : Math.round(((clampStep(i, n) + 1) / n) * 100));

/** Steps that work on one particular ad (its texts, name, link or files), so the screen knows the ad is chosen first. */
export const needsAdPicker = (step: GuideStep): boolean => step.copy.kind !== 'none' || step.id === 'upload-file';

/** The step that shows the file to download for the chosen ad. */
export const UPLOAD_STEP_ID = 'upload-file';

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
    : { kind: 'placeholder', text: `Picture to come: ${step.screenshot.alt}` };
}

/** The ad's texts that a step's Copy button offers (several for main text, headline, extra line; one for name and link; none otherwise). */
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

/** What to download and add on the upload step, for the ad being set up. `count` is the number of pictures of a picture ad. */
export function uploadHelp(isVideo: boolean, count: number): string {
  return isVideo
    ? 'This ad is a video. Use the Feed one for most people. Add the Full screen one too if Facebook asks for Stories and Reels.'
    : `This ad has ${count} ${count === 1 ? 'picture' : 'pictures'}. Add ${count === 1 ? 'it' : 'all of them, in order'}. Use the Feed size for most people.`;
}

// ── Wording: the first text is the one we suggest, "Show me another wording" goes round the rest ──

/** The next wording after `i` out of `n`, going back to the first after the last (0 when there is nothing to choose). */
export const nextWording = (i: number, n: number): number => (n <= 1 ? 0 : (clampStep(i, n) + 1) % n);

/** "Wording 2 of 5", or null when there is only one. */
export const wordingLabel = (i: number, n: number): string | null => (n <= 1 ? null : `Wording ${clampStep(i, n) + 1} of ${n}`);

// ── Where the operator got to, kept in this browser only (one record for the whole set of ads) ──

export type GuideAdProgress = { step: number; done: boolean };
export type GuideProgress = { ads: Record<string, GuideAdProgress>; last: string | null };

export const EMPTY_PROGRESS: GuideProgress = { ads: {}, last: null };

/** The browser storage key for one set of ads. */
export const guideStorageKey = (packId: string): string => `ad-guide:v2:${packId}`;

/** Read what was stored, keeping only the ads on screen and steps in range. Anything unreadable is "nothing done yet". */
export function parseProgress(raw: string | null, adIds: readonly string[], total: number): GuideProgress {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object') return EMPTY_PROGRESS;
    const src = (o as { ads?: unknown }).ads;
    const ads: Record<string, GuideAdProgress> = {};
    if (src && typeof src === 'object') {
      for (const id of adIds) {
        const p = (src as Record<string, unknown>)[id];
        if (p && typeof p === 'object') {
          const step = (p as { step?: unknown }).step;
          const done = (p as { done?: unknown }).done === true;
          ads[id] = { step: clampStep(typeof step === 'number' ? step : 0, total), done };
        }
      }
    }
    const last = (o as { last?: unknown }).last;
    return { ads, last: typeof last === 'string' && adIds.includes(last) ? last : null };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export const serializeProgress = (p: GuideProgress): string => JSON.stringify(p);

/** The progress after moving one ad to `step` (it is the ad being set up now). */
export function withStep(p: GuideProgress, adId: string, step: number, total: number): GuideProgress {
  return { ads: { ...p.ads, [adId]: { step: clampStep(step, total), done: false } }, last: adId };
}

/** The progress after one ad is finished. */
export function withDone(p: GuideProgress, adId: string, total: number): GuideProgress {
  return { ads: { ...p.ads, [adId]: { step: clampStep(total - 1, total), done: true } }, last: adId };
}

/** The ad to offer next: the first ad after `currentId` (round the list) that is not finished yet, or null when all are. */
export function nextAdToSetUp(p: GuideProgress, adIds: readonly string[], currentId: string | null): string | null {
  if (adIds.length === 0) return null;
  const start = currentId ? adIds.indexOf(currentId) : -1;
  for (let k = 1; k <= adIds.length; k++) {
    const id = adIds[(start + k + adIds.length) % adIds.length];
    if (id !== currentId && p.ads[id]?.done !== true) return id;
  }
  return null;
}

/** A short plain line for an ad on the "which ad" screen: finished, partway, or not started. */
export function adProgressLabel(p: GuideProgress, adId: string, total: number): string {
  const a = p.ads[adId];
  if (!a) return 'Not started';
  if (a.done) return 'Done';
  return a.step > 0 ? `You are on step ${a.step + 1} of ${total}` : 'Not started';
}
