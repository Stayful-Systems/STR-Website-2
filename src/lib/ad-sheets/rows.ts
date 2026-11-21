/**
 * Batch 35: one sheet row into a lead candidate.
 *
 * Meta lead-form rows carry their own quirks: phone numbers come as
 * "p:+44…", ids as "l:…" / "ag:…", and test leads are filled with dummy text.
 * Everything here is pure and never logs a row, an address or a number.
 */
import { createHash } from 'node:crypto';
import { normaliseCode } from '../ad-packs/codes.ts';
import { cleanMetaAdId } from '../ad-packs/links.ts';
import { normaliseMobile } from '../credit/abuse.ts';
import { tidyPostcode } from '../listing/cohorts.ts';
import type { HeaderField, HeaderMap, RequiredField } from './headers.ts';

export type Row = readonly unknown[];

export type Candidate = {
  name: string | null;
  email: string | null;
  /** +44… (or the other country's + form). */
  phone: string | null;
  /** "SW1A 1AA". */
  postcode: string | null;
  adName: string | null;
  /** Digits only (Meta's "ag:" prefix removed), or null. */
  adId: string | null;
  metaLeadId: string | null;
  /** Unknown columns only, {header: value}, empty values left out. */
  answers: Record<string, string>;
  /** A Meta test lead (decided from the raw row, before normalising). */
  test: boolean;
};

/** Longest row key (the column the key is stored in is wider than this). */
export const ROW_KEY_MAX = 80;

const TEST_MARKER = /\btest[\s_-]*lead\b|\bdummy[\s_-]*data\b/i;
const TEST_EMAIL = /^test@fb\.com$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function cell(row: Row, index: number | undefined): string {
  if (index === undefined) return '';
  const v = row[index];
  return v == null ? '' : String(v).trim();
}

/** First non-empty value across a field's columns. */
function first(row: Row, map: HeaderMap['map'], field: HeaderField): string {
  for (const i of map[field] ?? []) {
    const v = cell(row, i);
    if (v !== '') return v;
  }
  return '';
}

/** "ag:123", "l:123", "p:+44…": Meta's short type prefix. */
function stripPrefix(v: string): string {
  return v.replace(/^[a-z]{1,3}:\s*/i, '').trim();
}

export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normaliseMobile(stripPrefix(String(raw).trim()));
}

export function normalisePostcode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return tidyPostcode(String(raw).trim());
}

/** `hm` is what mapHeaders returned for this sheet's header row. */
export function toCandidate(row: Row, hm: HeaderMap): Candidate {
  const map = hm.map;

  let name = first(row, map, 'name');
  if (name === '') {
    name = [first(row, map, 'first_name'), first(row, map, 'last_name')].filter((p) => p !== '').join(' ');
  }
  name = name.replace(/\s+/g, ' ').trim();

  const emailRaw = first(row, map, 'email').toLowerCase();
  const adName = first(row, map, 'ad_name');
  const leadId = stripPrefix(first(row, map, 'lead_id'));

  const answers: Record<string, string> = {};
  const mapped = new Set<number>(Object.values(map).flat());
  for (const { index, header } of hm.unknown) {
    if (mapped.has(index)) continue;
    const v = cell(row, index);
    if (v === '') continue;
    let key = header;
    for (let n = 2; key in answers; n++) key = `${header} (${n})`;
    answers[key] = v;
  }

  return {
    name: name || null,
    email: EMAIL.test(emailRaw) ? emailRaw : null,
    phone: normalisePhone(first(row, map, 'phone')),
    postcode: normalisePostcode(first(row, map, 'postcode')),
    adName: adName || null,
    adId: cleanMetaAdId(stripPrefix(first(row, map, 'ad_id'))),
    metaLeadId: leadId || null,
    answers,
    test: rowLooksLikeTest(row),
  };
}

export function isComplete(c: Pick<Candidate, 'name' | 'email' | 'phone' | 'postcode'>): {
  complete: boolean;
  missing: RequiredField[];
} {
  const missing: RequiredField[] = [];
  if (!c.name) missing.push('name');
  if (!c.phone && !c.email) missing.push('phone_or_email');
  if (!c.postcode) missing.push('postcode');
  return { complete: missing.length === 0, missing };
}

function rowLooksLikeTest(row: Row): boolean {
  for (const v of row) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== '' && (TEST_MARKER.test(s) || TEST_EMAIL.test(s))) return true;
  }
  return false;
}

/** A Meta test lead ("<test lead: dummy data for full_name>", "dummy data"). Takes a raw row or a candidate. */
export function isTestLead(input: Row | Candidate): boolean {
  if (Array.isArray(input)) return rowLooksLikeTest(input);
  const c = input as Candidate;
  if (c.test) return true;
  const values = [c.name, c.email, c.phone, c.postcode, c.adName, ...Object.values(c.answers ?? {})];
  return values.some((v) => typeof v === 'string' && (TEST_MARKER.test(v) || TEST_EMAIL.test(v)));
}

/**
 * The key that makes a row import once: Meta's lead id when the row has one,
 * else a hash of its cells (trimmed, trailing empty cells ignored). At most
 * ROW_KEY_MAX characters.
 */
export function rowKey(row: Row, hm: HeaderMap): string {
  const id = stripPrefix(first(row, hm.map, 'lead_id'));
  if (id !== '') return `id:${id}`.slice(0, ROW_KEY_MAX);
  const cells = row.map((v) => (v == null ? '' : String(v).trim()));
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return `h:${createHash('sha256').update(JSON.stringify(cells)).digest('hex')}`.slice(0, ROW_KEY_MAX);
}

const CODE_IN_TEXT =
  /(?<![0-9A-Za-z])SI[ \t]*[-‐-―−][ \t]*[0-9A-F]{6}[ \t]*[-‐-―−][ \t]*(?:5B|3A|17)[ \t]*[-‐-―−][ \t]*[1-9][0-9]{0,3}(?![0-9A-Za-z])/gi;

/** The pack code inside free text ("SI-3F9A2C-5B-1 · Tenant notice"), normalised, or null. */
export function findCodeInText(text: unknown): string | null {
  if (typeof text !== 'string' || text === '') return null;
  for (const m of text.matchAll(CODE_IN_TEXT)) {
    const code = normaliseCode(m[0]);
    if (code) return code;
  }
  return null;
}
