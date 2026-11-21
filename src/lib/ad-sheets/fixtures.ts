/**
 * Batch 35: a header row laid out like Meta's lead-form Google Sheet export,
 * and sample rows. All values are invented (07700 900xxx is Ofcom's reserved
 * drama range). Used by the ad-sheets tests.
 */

export const FIXTURE_HEADERS: string[] = [
  'id',
  'created_time',
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'form_id',
  'form_name',
  'is_organic',
  'platform',
  'how_many_properties_do_you_own?',
  'are_you_thinking_of_moving_to_short_lets?',
  'full_name',
  'email',
  'phone_number',
  'post_code',
];

/** A normal lead from a pack ad: the pack code is in the ad name. */
export const FIXTURE_ROW_PACK: string[] = [
  'l:1001000000000001',
  '2026-11-18T09:14:03+00:00',
  'ag:120210000000000001',
  'SI-3F9A2C-5B-1 · Tenant notice',
  'as:120210000000000002',
  'Landlords UK',
  'c:120210000000000003',
  'Landlord ads November',
  'f:120210000000000004',
  'Landlord enquiry',
  'false',
  'fb',
  '2 to 5',
  'Yes, within 3 months',
  'Alex Example',
  'Alex.Example@Example.com ',
  'p:+447700900123',
  'sw1a1aa',
];

/** A lead from an ad that is not in a pack: no code, a Meta ad id only. */
export const FIXTURE_ROW_PLAIN: string[] = [
  'l:1001000000000002',
  '2026-11-18T10:30:41+00:00',
  'ag:120210000000000009',
  'Landlord video 2',
  'as:120210000000000002',
  'Landlords UK',
  'c:120210000000000003',
  'Landlord ads November',
  'f:120210000000000004',
  'Landlord enquiry',
  'false',
  'ig',
  '1',
  'Not sure',
  'Sam Sample',
  '',
  'p:07700 900456',
  'M1 1AE',
];

/** No postcode and no phone: kept, but incomplete. */
export const FIXTURE_ROW_INCOMPLETE: string[] = [
  'l:1001000000000003',
  '2026-11-19T07:02:11+00:00',
  'ag:120210000000000001',
  'SI-3F9A2C-5B-1 · Tenant notice',
  'as:120210000000000002',
  'Landlords UK',
  'c:120210000000000003',
  'Landlord ads November',
  'f:120210000000000004',
  'Landlord enquiry',
  'false',
  'fb',
  '3',
  '',
  'Jo Partial',
  'jo.partial@example.com',
];

/** What Meta's "Test your form" tool produces. */
export const FIXTURE_ROW_TEST: string[] = [
  'l:1001000000000004',
  '2026-11-19T12:00:00+00:00',
  'ag:120210000000000001',
  'SI-3F9A2C-5B-1 · Tenant notice',
  'as:120210000000000002',
  'Landlords UK',
  'c:120210000000000003',
  'Landlord ads November',
  'f:120210000000000004',
  'Landlord enquiry',
  'true',
  'fb',
  '<test lead: dummy data for how_many_properties_do_you_own?>',
  '<test lead: dummy data for are_you_thinking_of_moving_to_short_lets?>',
  '<test lead: dummy data for full_name>',
  'test@fb.com',
  '<test lead: dummy data for phone_number>',
  '<test lead: dummy data for post_code>',
];

export const FIXTURE_ROWS: string[][] = [
  FIXTURE_ROW_PACK,
  FIXTURE_ROW_PLAIN,
  FIXTURE_ROW_INCOMPLETE,
  FIXTURE_ROW_TEST,
];
