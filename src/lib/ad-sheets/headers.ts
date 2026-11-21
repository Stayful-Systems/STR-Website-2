/**
 * Batch 35: reading the header row of a Meta lead-form Google Sheet.
 *
 * Meta's export names are not guaranteed (and an operator can rename a
 * question), so matching is tolerant: a header is lower-cased and everything
 * but letters and digits is dropped ("Post Code", "post_code" and "POSTCODE?"
 * are one header). Columns that match no field are kept: they are the
 * operator's form questions and travel with the lead as its answers.
 *
 * Pure: no network, no database, no server-only. Never logs a header or a row.
 */
import { createHash } from 'node:crypto';

export type HeaderField =
  | 'name'
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'postcode'
  | 'ad_id'
  | 'ad_name'
  | 'lead_id'
  | 'created_time'
  | 'form_id'
  | 'form_name'
  | 'campaign_id'
  | 'campaign_name'
  | 'adset_id'
  | 'adset_name'
  | 'platform'
  | 'is_organic';

/** What a lead needs to be complete: a name, a way to ring or email, a postcode. */
export type RequiredField = 'name' | 'phone_or_email' | 'postcode';

/** Normalised variants (see normaliseHeader) per field. */
export const HEADER_VARIANTS: Record<HeaderField, readonly string[]> = {
  name: ['fullname', 'name', 'yourname', 'contactname', 'customername', 'leadname'],
  first_name: ['firstname', 'forename', 'givenname', 'yourfirstname'],
  last_name: ['lastname', 'surname', 'familyname', 'yourlastname'],
  email: ['email', 'emailaddress', 'youremail', 'youremailaddress', 'workemail'],
  phone: [
    'phonenumber',
    'phone',
    'mobile',
    'mobilenumber',
    'mobilephone',
    'telephone',
    'telephonenumber',
    'tel',
    'contactnumber',
    'yourphonenumber',
    'yourmobilenumber',
  ],
  postcode: [
    'postcode',
    'postalcode',
    'zip',
    'zipcode',
    'propertypostcode',
    'yourpostcode',
    'yourpropertypostcode',
    'postcodeofyourproperty',
    'whatisthepostcodeofyourproperty',
    'whatisyourpropertypostcode',
    'whatisyourpostcode',
    'whatpostcodeisyourpropertyin',
  ],
  ad_id: ['adid'],
  ad_name: ['adname', 'ad'],
  lead_id: ['id', 'leadid', 'leadgenid', 'leadgen'],
  created_time: ['createdtime', 'created', 'createdat', 'timecreated'],
  form_id: ['formid'],
  form_name: ['formname', 'form'],
  campaign_id: ['campaignid'],
  campaign_name: ['campaignname', 'campaign'],
  adset_id: ['adsetid'],
  adset_name: ['adsetname', 'adset'],
  platform: ['platform'],
  is_organic: ['isorganic', 'organic'],
};

const VARIANT_TO_FIELD: ReadonlyMap<string, HeaderField> = (() => {
  const m = new Map<string, HeaderField>();
  for (const [field, variants] of Object.entries(HEADER_VARIANTS) as [HeaderField, readonly string[]][]) {
    for (const v of variants) if (!m.has(v)) m.set(v, field);
  }
  return m;
})();

/** Lower case, letters and digits only. "Post_Code?" and "post code" both give "postcode". */
export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const POSTCODE_LOOSE = /postcode|postalcode|zipcode/;

export type HeaderMap = {
  /** Column indexes per field (first match first). Absent field: no column. */
  map: Partial<Record<HeaderField, number[]>>;
  /** Stable sha256 (hex) of the normalised header row. */
  hash: string;
  /** Required things with no column at all (not "empty in this row"). */
  missingRequired: RequiredField[];
  /** Columns that match no field: the form's own questions, kept as answers. */
  unknown: { index: number; header: string }[];
};

function headerCells(headerRow: readonly unknown[]): string[] {
  const cells = headerRow.map((c) => String(c ?? '').trim());
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** A stable fingerprint of the header row (trailing empty headers ignored). */
export function hashHeaders(headerRow: readonly unknown[]): string {
  const norm = headerCells(headerRow).map(normaliseHeader).join('|');
  return createHash('sha256').update(norm).digest('hex');
}

export function mapHeaders(headerRow: readonly unknown[]): HeaderMap {
  const cells = headerCells(headerRow);
  const map: Partial<Record<HeaderField, number[]>> = {};
  const claimed = new Set<number>();
  const add = (field: HeaderField, index: number) => {
    (map[field] ??= []).push(index);
    claimed.add(index);
  };

  cells.forEach((header, index) => {
    const field = VARIANT_TO_FIELD.get(normaliseHeader(header));
    if (field) add(field, index);
  });

  // A long question header that still says "postcode" ("Postcode of the
  // property you want to let?") counts, but only when no exact column did.
  if (!map.postcode) {
    const idx = cells.findIndex((h, i) => !claimed.has(i) && POSTCODE_LOOSE.test(normaliseHeader(h)));
    if (idx >= 0) add('postcode', idx);
  }

  const unknown: { index: number; header: string }[] = [];
  cells.forEach((header, index) => {
    if (!claimed.has(index) && header !== '') unknown.push({ index, header });
  });

  const missingRequired: RequiredField[] = [];
  if (!map.name && !map.first_name && !map.last_name) missingRequired.push('name');
  if (!map.phone && !map.email) missingRequired.push('phone_or_email');
  if (!map.postcode) missingRequired.push('postcode');

  return { map, hash: hashHeaders(headerRow), missingRequired, unknown };
}

/**
 * True when the header row changed since the stored hash. No stored hash (the
 * first read) is not a change.
 */
export function headersChanged(oldHash: string | null | undefined, newHash: string): boolean {
  if (!oldHash) return false;
  return oldHash !== newHash;
}
