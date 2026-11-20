/**
 * Batch 38: the tracked link and the ad name for each ad in a pack, and the
 * clean-up of Meta's ad id.
 *
 * The link carries the pack code (?ad=<CODE>, read by the lead form and kept
 * in lead_sources.ad_code) and Meta's own ad id in utm_content. Meta fills
 * {{ad.id}} in at click time, so the placeholder stays LITERAL in the link we
 * hand out: percent-encoding it would stop Meta replacing it.
 *
 * Pure: no network, no database, no server-only.
 */
import { normaliseCode, parseCode } from './codes.ts';
import type { Angle } from './codes.ts';

export const AD_ID_PLACEHOLDER = '{{ad.id}}';
/** A Meta ad id is a long run of digits; this is the most we keep. */
export const META_AD_ID_MAX = 30;

export const ANGLE_LABELS: Record<Angle, string> = {
  '5b': 'Tenant notice',
  '3a': 'Moving abroad',
  '17': 'Renting rules changed',
};

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function bareHost(domain: string): string {
  const host = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!HOST_RE.test(host)) throw new Error('adLink: the domain must be a bare host such as acme.co.uk');
  return host;
}

/**
 * https://<domain>/?ad=<CODE>&utm_source=facebook&utm_medium=paid_social
 *   &utm_campaign=SI-<operator>&utm_content={{ad.id}}
 */
export function adLink(input: { domain: string; code: string; operatorCode: string }): string {
  const host = bareHost(input.domain);
  const code = normaliseCode(input.code);
  if (!code) throw new Error('adLink: the code is not a pack code');
  const op = String(input.operatorCode ?? '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(op)) throw new Error('adLink: the operator code must be 6 hex characters');
  if (parseCode(code)?.operatorCode !== op) throw new Error('adLink: the code does not belong to this operator');
  return (
    `https://${host}/?ad=${encodeURIComponent(code)}` +
    `&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-${op}` +
    `&utm_content=${AD_ID_PLACEHOLDER}`
  );
}

/** `SI-3F9A2C-5B-1 · Tenant notice`: code first so Meta's truncation never cuts it. */
export function adName(code: string, angle: Angle): string {
  const c = normaliseCode(code);
  if (!c) throw new Error('adName: the code is not a pack code');
  const label = ANGLE_LABELS[angle];
  if (!label) throw new Error('adName: unknown angle');
  return `${c} · ${label}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * True when utm_content is Meta's untouched placeholder (plain or
 * URL-encoded) or empty: no real ad id came through.
 */
export function isAdIdPlaceholder(s: string | null | undefined): boolean {
  if (s == null) return true;
  const t = String(s).trim();
  if (t === '') return true;
  const lower = t.toLowerCase();
  if (lower === AD_ID_PLACEHOLDER) return true;
  const decoded = safeDecode(safeDecode(t)).trim().toLowerCase();
  return decoded === AD_ID_PLACEHOLDER;
}

/** A Meta ad id: digits only, 30 at most. A placeholder or anything else is null. */
export function cleanMetaAdId(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (isAdIdPlaceholder(t)) return null;
  if (!/^[0-9]{1,30}$/.test(t)) return null;
  return t;
}
