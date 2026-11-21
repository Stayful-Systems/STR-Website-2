/**
 * What the lead form screen says when something does not work, in plain
 * English (Batch 35). Codes in, sentences out; nothing from Google or the
 * database is ever shown as it came, and nothing here names a sheet or an
 * account. Pure.
 */

export const NOT_AVAILABLE = 'Lead form link not available yet';

/** What a required thing is called for the operator, never the code. */
const MISSING_LABEL: Record<string, string> = {
  name: 'a name column',
  phone_or_email: 'a phone number or email column',
  postcode: 'a postcode column',
};

/** "a name column, a phone number or email column and a postcode column". */
export function missingText(missing: readonly string[]): string {
  const labels = missing.map((m) => MISSING_LABEL[m] ?? 'a column').filter((v, i, a) => a.indexOf(v) === i);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export const SHEET_MESSAGES: Record<string, string> = {
  signed_out: 'Please sign in again.',
  member: 'Only the account owner can set up lead forms.',
  not_available: NOT_AVAILABLE,
  not_configured: NOT_AVAILABLE,
  no_pack: 'Approve your ad pack first, then you can switch to lead forms.',
  bad_link: 'That does not look like a Google Sheets link. Open the sheet, copy the address from your browser and paste it here.',
  not_shared: 'We cannot open that sheet yet. Share it with the email address shown above, as a viewer, then check again.',
  not_found: 'We could not find that sheet. Check the link and try again.',
  tab_not_found: 'We could not find that tab in the sheet. Open the tab Meta fills in, copy the address again and try again.',
  taken: 'That sheet is already connected to another account. Use the sheet Meta created for your own form.',
  no_headers: 'We can open the sheet, but its first row is empty. Check the form is connected to this sheet in Meta, then try again.',
  rate_limited: 'Google is busy right now. Please try again in a minute.',
  error: 'Something went wrong. Please try again soon.',
  db: 'Something went wrong. Please try again soon.',
};

/** A sentence for a code; an unknown code reads as a generic try-again, never as the code itself. */
export function sheetMessage(code: string | null | undefined): string {
  if (!code) return SHEET_MESSAGES.error;
  return SHEET_MESSAGES[code] ?? SHEET_MESSAGES.error;
}

/** The headers sentence: which columns the sheet is missing. */
export function headersMissingMessage(missing: readonly string[]): string {
  const what = missingText(missing);
  return what
    ? `We can open the sheet, but it has no ${what}. Check the form asks for them and is connected to this sheet in Meta, then try again.`
    : SHEET_MESSAGES.error;
}

// ── The six guided steps ──

export type SheetStep = {
  /** 1 to 6; the screenshot is public/ad-packs/guide/sheet-<n>.png. */
  n: number;
  title: string;
  /** Exactly one thing to do, in one sentence. */
  action: string;
  detail: string;
  /** A plain-English answer for someone who is stuck. */
  stuck: string;
  shotAlt: string;
};

export const SHEET_GUIDE_URL_DIR = '/ad-packs/guide';
export const sheetShotUrl = (n: number): string => `${SHEET_GUIDE_URL_DIR}/sheet-${n}.png`;
export const sheetShotFile = (n: number): string => `sheet-${n}.png`;

export const SHEET_STEPS: readonly SheetStep[] = [
  {
    n: 1,
    title: 'Make the instant form',
    action: 'In Meta, make an instant form with these questions.',
    detail: 'In Ads Manager choose Instant forms, then Create form. Ask for full name, email, phone number and postcode, then add the questions below. Copy each one so it is worded exactly the same.',
    stuck: 'Meta calls the form a lead form or an instant form. Pick the "More volume" type, add the contact questions Meta offers, then add each question below as a short answer or multiple choice question.',
    shotAlt: 'Meta instant form editor with the questions list open',
  },
  {
    n: 2,
    title: 'Connect the form to a Google Sheet',
    action: 'In Meta, connect the form to a new Google Sheet.',
    detail: 'In Meta Business Suite open Leads Center, then CRM integrations, and choose Google Sheets. Let Meta make the sheet for you and pick your form.',
    stuck: 'If you do not see Google Sheets, open Leads Center from Business Suite and look under Integrations. You need to be the admin of your Facebook Page. Meta asks you to sign in to Google once; use the Google account that should own the sheet.',
    shotAlt: 'Meta Leads Center with Google Sheets chosen as the place leads go',
  },
  {
    n: 3,
    title: 'Share the sheet with us',
    action: 'In Google Sheets, share your sheet with this email address as a viewer.',
    detail: 'Open the sheet Meta made, press Share, paste the address below and choose Viewer. We only ever read it. We never change it, and we never look at any other sheet.',
    stuck: 'Press the green Share button at the top right of the sheet, paste the address and make sure the role says Viewer, not Editor. If Google asks whether to send a notification, you can untick it.',
    shotAlt: 'The Google Sheets Share box with the address pasted and Viewer chosen',
  },
  {
    n: 4,
    title: 'Paste the sheet link',
    action: 'Paste the link to your sheet and we will check it.',
    detail: 'Copy the address from your browser while the sheet is open. We check that we can read it and that it has a name, a phone number or email, and a postcode.',
    stuck: 'Open the sheet in your browser, click the address bar, copy everything and paste it here. If we cannot open it, check step 3 again: the sheet must be shared with the address shown there.',
    shotAlt: 'A Google Sheet open with its address highlighted in the browser bar',
  },
  {
    n: 5,
    title: 'Send a test lead',
    action: 'In Meta, send a test lead to your form.',
    detail: 'Open Meta’s lead ads testing tool, pick your Page and your form, and press Create lead. We read the sheet about once an hour, or press Check now to look straight away.',
    stuck: 'Search for "lead ads testing tool" in your browser to find it. Make sure the Page and the form are the same ones you connected to the sheet. A test lead can take a minute to appear in the sheet.',
    shotAlt: 'Meta’s lead ads testing tool with the Create lead button',
  },
  {
    n: 6,
    title: 'Point your ads at the form',
    action: 'In Ads Manager, change each ad’s destination to your instant form.',
    detail: 'Open each ad, find Destination and choose Instant form instead of Website, then pick your form. Keep the ad name exactly as it is: it carries the pack code that tells us which ad each lead came from.',
    stuck: 'You change the destination on the ad itself, not on the campaign. If your campaign was set up for link clicks, make a new campaign with the Leads objective and copy the ads across with the same names.',
    shotAlt: 'Ads Manager ad editor with Instant form chosen as the destination',
  },
];
