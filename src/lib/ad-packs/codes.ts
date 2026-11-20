/**
 * Batch 38: pack codes. Every ad in an operator's pack carries a code in its
 * ad name and its link, so a website lead is recorded against the ad that
 * brought it (lead_sources.ad_code is varchar(40)).
 *
 *   operator code  first 6 hex characters of the owner id, upper case, dashes
 *                  removed; the next 6 if that one is taken (unique column)
 *   pack code      SI-<operator code>-<angle>-<n>, e.g. SI-3F9A2C-5B-1
 *                  (n = the pack version)
 *
 * Pure: no network, no database, no server-only.
 */

export const ANGLES = ['5b', '3a', '17'] as const;
export type Angle = (typeof ANGLES)[number];

/** lead_sources.ad_code is varchar(40). */
export const PACK_CODE_MAX = 40;
/** Highest pack version a code can carry (keeps the code short and clean). */
export const PACK_VERSION_MAX = 9999;

const OPERATOR_CODE_LEN = 6;
const OPERATOR_CODE_RE = /^[0-9A-F]{6}$/;
const PACK_CODE_RE = /^SI-([0-9A-F]{6})-(5B|3A|17)-([1-9][0-9]{0,3})$/;

export type ParsedCode = { operatorCode: string; angle: Angle; n: number };

export function isAngle(v: unknown): v is Angle {
  return typeof v === 'string' && (ANGLES as readonly string[]).includes(v);
}

/**
 * The operator code for an owner id. Takes the first 6 hex characters of the
 * id (dashes removed, upper case); if that is in `taken`, the next 6, and so
 * on. Throws a clear Error when the id is not a uuid or every 6-character
 * slice of it is already taken.
 */
export function operatorCode(ownerId: string, taken?: ReadonlySet<string>): string {
  const hex = String(ownerId ?? '').replace(/-/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(hex)) {
    throw new Error('operatorCode: the owner id is not a uuid');
  }
  const used = new Set<string>();
  if (taken) for (const t of taken) used.add(String(t).toUpperCase());
  for (let i = 0; i + OPERATOR_CODE_LEN <= hex.length; i += OPERATOR_CODE_LEN) {
    const candidate = hex.slice(i, i + OPERATOR_CODE_LEN);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('operatorCode: every 6-character slice of this owner id is already taken');
}

/** SI-3F9A2C-5B-1. Throws on a bad operator code, angle or version. */
export function packCode(operator: string, angle: Angle, n: number): string {
  const op = String(operator ?? '').toUpperCase();
  if (!OPERATOR_CODE_RE.test(op)) throw new Error('packCode: the operator code must be 6 hex characters');
  if (!isAngle(angle)) throw new Error('packCode: unknown angle');
  if (!Number.isInteger(n) || n < 1 || n > PACK_VERSION_MAX) {
    throw new Error(`packCode: the pack version must be a whole number from 1 to ${PACK_VERSION_MAX}`);
  }
  return `SI-${op}-${angle.toUpperCase()}-${n}`.slice(0, PACK_CODE_MAX);
}

function safeDecode(s: string): string {
  let out = s;
  // Up to two passes: a code pasted through a redirect can be encoded twice.
  for (let i = 0; i < 2; i++) {
    if (!out.includes('%')) break;
    try {
      out = decodeURIComponent(out);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * The canonical pack code for whatever came in (a query value, a pasted
 * code): URL-encoding undone, whitespace and zero-width characters removed,
 * dash look-alikes turned into "-", surrounding punctuation dropped, upper
 * case. Null when it does not parse as a pack code.
 */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = safeDecode(raw)
    .replace(/[​-‍﻿]/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s+]+/g, '')
    .toUpperCase();
  s = s.replace(/^[^A-Z0-9]+/, '').replace(/[^A-Z0-9]+$/, '');
  const m = PACK_CODE_RE.exec(s);
  if (!m) return null;
  return `SI-${m[1]}-${m[2]}-${Number(m[3])}`;
}

/** The parts of a pack code, or null if it does not parse. */
export function parseCode(raw: unknown): ParsedCode | null {
  const code = normaliseCode(raw);
  if (!code) return null;
  const m = PACK_CODE_RE.exec(code);
  if (!m) return null;
  return { operatorCode: m[1], angle: m[2].toLowerCase() as Angle, n: Number(m[3]) };
}
