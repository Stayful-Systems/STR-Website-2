/**
 * Batch 55 step 5 (Phase 1, 55c A1): the customer's brand, as the lead database pushes it (contract section 13, call 8
 * `profile`, and the optional `profile` inside `provision`), and the rule that decides which calculator settings it may
 * fill.
 *
 * PURE: no I/O, no Next, no server-only, so it runs under `node --test`. ad-profile-server.ts is the live wiring (the
 * logo download, the logo store, the database).
 *
 * Rules that must not drift:
 * - A CLOSED field set. Any other key, a non-https logo, a colour that is not #RRGGBB, a fee outside 0 to 100, more than
 *   10 areas or an area outside 1 to 80 characters, bedrooms outside 0 to 10 or min > max, or a missing profileAsOf:
 *   the whole profile is refused (400) and nothing is applied.
 * - Ordering by profileAsOf exactly as stateAsOf: older is 'stale', equal is applied again.
 * - A field is filled ONLY when it is still empty, or still equal to the value this site last wrote from a push, and
 *   NEVER when the customer has edited it here (`settings_edited`). So the customer's own choice always wins.
 * - Nothing here (nor its caller) logs the logo link, a colour, an area or a fee: codes only.
 */
import type { SiteSettings } from '../websites/page-model.ts';
import { MAX_AREAS } from '../websites/page-model.ts';
import { asObject } from './inbound.ts';

// ── The pushed profile ──

export interface AdProfile {
  /** A short-lived https link to the customer's logo, or null. Never stored or logged: the bytes are copied once. */
  logoUrl: string | null;
  /** #rrggbb (lower case), or null. */
  brandColour: string | null;
  /** The customer's own fee, 0 to 100, or null. */
  feePct: number | null;
  /** Up to 10 area names, main area first. */
  areas: string[];
  bedrooms: { min: number; max: number } | null;
  /** ISO 8601. */
  profileAsOf: string;
}

export const PROFILE_FIELDS = ['logoUrl', 'brandColour', 'feePct', 'areas', 'bedrooms', 'profileAsOf'] as const;
export const MAX_PUSHED_AREAS = 10;
export const MAX_PUSHED_AREA_LENGTH = 80;
export const MAX_LOGO_URL_LENGTH = 2048;
/** The calculator's own limit on one area name (the brand screen's parseAreas cuts at the same length). */
export const AREA_SETTING_LENGTH = 60;

const HEX = /^#[0-9a-fA-F]{6}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function parseIso(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/**
 * The logo link is fetched by this server, so it must be a plain public https address: no credentials, no port other
 * than 443, no IP literal, no localhost or internal-looking host. Null when it is not.
 */
export function safeLogoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LOGO_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  return url.toString();
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Strict check of a pushed profile. Null when anything is off (the caller answers 400 and applies nothing); never
 * throws. `logoUrl`, `brandColour`, `feePct` and `bedrooms` may be null or absent; `areas` may be absent (read as an
 * empty list); `profileAsOf` is required.
 */
export function parseAdProfile(raw: unknown): AdProfile | null {
  const r = asObject(raw);
  if (!r) return null;
  for (const key of Object.keys(r)) if (!(PROFILE_FIELDS as readonly string[]).includes(key)) return null;

  let logoUrl: string | null = null;
  if (r.logoUrl !== undefined && r.logoUrl !== null) {
    logoUrl = safeLogoUrl(r.logoUrl);
    if (!logoUrl) return null;
  }

  let brandColour: string | null = null;
  if (r.brandColour !== undefined && r.brandColour !== null) {
    if (typeof r.brandColour !== 'string' || !HEX.test(r.brandColour)) return null;
    brandColour = r.brandColour.toLowerCase();
  }

  let feePct: number | null = null;
  if (r.feePct !== undefined && r.feePct !== null) {
    if (typeof r.feePct !== 'number' || !Number.isFinite(r.feePct) || r.feePct < 0 || r.feePct > 100) return null;
    feePct = r.feePct;
  }

  const areas: string[] = [];
  if (r.areas !== undefined && r.areas !== null) {
    if (!Array.isArray(r.areas) || r.areas.length > MAX_PUSHED_AREAS) return null;
    for (const a of r.areas) {
      if (typeof a !== 'string') return null;
      const t = a.trim();
      if (t.length < 1 || t.length > MAX_PUSHED_AREA_LENGTH) return null;
      areas.push(t);
    }
  }

  let bedrooms: AdProfile['bedrooms'] = null;
  if (r.bedrooms !== undefined && r.bedrooms !== null) {
    const b = asObject(r.bedrooms);
    if (!b || Object.keys(b).some((k) => k !== 'min' && k !== 'max')) return null;
    if (!isInt(b.min) || !isInt(b.max) || b.min < 0 || b.max > 10 || b.min > b.max) return null;
    bedrooms = { min: b.min, max: b.max };
  }

  const profileAsOf = parseIso(r.profileAsOf);
  if (!profileAsOf) return null;
  return { logoUrl, brandColour, feePct, areas, bedrooms, profileAsOf };
}

/** Newer replaces, equal is applied again, older is stale. No stored time takes anything. */
export function shouldApplyProfile(currentAsOf: Date | null | undefined, incomingIso: string): boolean {
  if (!currentAsOf) return true;
  const t = Date.parse(incomingIso);
  if (Number.isNaN(t)) return false;
  return t >= currentAsOf.getTime();
}

// ── What this site last wrote, and what the customer edited ──

/** The calculator fields a push may fill (by their SiteSettings keys) and the customer's edits are recorded for. */
export const PROFILE_SETTING_FIELDS = ['logoUrl', 'brandColour', 'areas', 'managementFeePct'] as const satisfies readonly (keyof SiteSettings)[];
export type ProfileSettingField = (typeof PROFILE_SETTING_FIELDS)[number];

/** Why a pushed logo was not used (or 'stored' / 'unchanged' / 'none' when it was handled). A code, never the link. */
export const LOGO_CODES = ['stored', 'unchanged', 'none', 'edited', 'kept', 'bad_url', 'fetch_failed', 'too_big', 'not_image', 'store_failed'] as const;
export type LogoCode = (typeof LOGO_CODES)[number];

/** leaddb_ad_accounts.profile_pushed: what this site last WROTE from a push (never the lead database's signed link). */
export interface ProfilePushed {
  /** Our own stored copy of the logo, or null. */
  logoUrl?: string | null;
  /** The copied logo's bytes, hashed: the same logo pushed again is not stored twice. */
  logoSha256?: string | null;
  logoCode?: LogoCode | null;
  brandColour?: string | null;
  feePct?: number | null;
  areas?: string[];
  /** Kept for the pack's bedroom count (lowest in the range). Never a calculator setting. */
  bedrooms?: { min: number; max: number } | null;
}

/** websites.settings_edited: field -> ISO time the customer last changed it. */
export type SettingsEdited = Partial<Record<ProfileSettingField, string>>;

export function parseProfilePushed(raw: unknown): ProfilePushed {
  const o = asObject(raw);
  if (!o) return {};
  const out: ProfilePushed = {};
  if (typeof o.logoUrl === 'string' || o.logoUrl === null) out.logoUrl = o.logoUrl as string | null;
  if (typeof o.logoSha256 === 'string' || o.logoSha256 === null) out.logoSha256 = o.logoSha256 as string | null;
  if ((LOGO_CODES as readonly unknown[]).includes(o.logoCode) || o.logoCode === null) out.logoCode = o.logoCode as LogoCode | null;
  if (typeof o.brandColour === 'string' || o.brandColour === null) out.brandColour = o.brandColour as string | null;
  if ((typeof o.feePct === 'number' && Number.isFinite(o.feePct)) || o.feePct === null) out.feePct = o.feePct as number | null;
  if (Array.isArray(o.areas)) out.areas = o.areas.filter((a): a is string => typeof a === 'string');
  if (o.bedrooms === null) out.bedrooms = null;
  else {
    const b = asObject(o.bedrooms);
    if (b && isInt(b.min) && isInt(b.max) && b.min >= 0 && b.max <= 10 && b.min <= b.max) out.bedrooms = { min: b.min, max: b.max };
  }
  return out;
}

export function parseSettingsEdited(raw: unknown): SettingsEdited {
  const o = asObject(raw);
  if (!o) return {};
  const out: SettingsEdited = {};
  for (const f of PROFILE_SETTING_FIELDS) if (typeof o[f] === 'string' && o[f]) out[f] = o[f] as string;
  return out;
}

const sameAreas = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The fields a customer's brand-screen save really changed, among the ones a push may fill. Only these are marked
 * edited: saving the same value back leaves the field following the lead database.
 */
export function changedProfileFields(before: Pick<SiteSettings, ProfileSettingField>, after: Partial<Pick<SiteSettings, ProfileSettingField>>): ProfileSettingField[] {
  const out: ProfileSettingField[] = [];
  if (after.logoUrl !== undefined && (after.logoUrl ?? null) !== (before.logoUrl ?? null)) out.push('logoUrl');
  if (after.brandColour !== undefined && (after.brandColour ?? null)?.toLowerCase() !== (before.brandColour ?? null)?.toLowerCase()) out.push('brandColour');
  if (after.areas !== undefined && !sameAreas(after.areas, before.areas ?? [])) out.push('areas');
  if (after.managementFeePct !== undefined && (after.managementFeePct ?? null) !== (before.managementFeePct ?? null)) out.push('managementFeePct');
  return out;
}

/** The marks after an edit: each changed field stamped with `nowIso`, the others kept. */
export function markEdited(current: SettingsEdited, fields: readonly ProfileSettingField[], nowIso: string): SettingsEdited {
  const out: SettingsEdited = { ...current };
  for (const f of fields) out[f] = nowIso;
  return out;
}

// ── The fill rule ──

/** The pushed areas as calculator areas: one line each (no comma or newline), cut to the setting's length, no repeats, main first, at most MAX_AREAS. */
export function areasForSettings(areas: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of areas) {
    const name = a.replace(/[\n,]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, AREA_SETTING_LENGTH).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_AREAS) break;
  }
  return out;
}

/**
 * The pushed fee as the calculator's managementFeePct: rounded to one decimal place as the brand screen saves it.
 * DECISION (for Zac): a pushed 0 is "no fee line" (null), because the brand screen itself never accepts 0.
 */
export function feeForSettings(feePct: number | null): number | null {
  if (feePct === null || !Number.isFinite(feePct) || feePct <= 0 || feePct > 100) return null;
  return Math.round(feePct * 10) / 10;
}

/**
 * May a push fill this field? Never when the customer edited it. Otherwise when it is still empty, or still exactly the
 * value this site last wrote from a push (`lastPushed` undefined means nothing was ever pushed for it: a value already
 * there is the customer's own and stays).
 */
export function mayFill<T>(field: ProfileSettingField, current: T, lastPushed: T | undefined, edited: SettingsEdited, isEmpty: (v: T) => boolean, same: (a: T, b: T) => boolean): boolean {
  if (edited[field]) return false;
  if (isEmpty(current)) return true;
  return lastPushed !== undefined && same(current, lastPushed);
}

const emptyText = (v: string | null): boolean => v === null || v === undefined || v.trim() === '';
const sameText = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null);
const sameColour = (a: string | null, b: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Whether the logo may be replaced at all (checked BEFORE anything is downloaded). */
export function logoMayFill(current: Pick<SiteSettings, 'logoUrl'>, last: ProfilePushed, edited: SettingsEdited): boolean {
  return mayFill('logoUrl', current.logoUrl, last.logoUrl, edited, emptyText, sameText);
}

/** What happened to the pushed logo (the server decides it: the download, the sniff, the store). */
export type LogoOutcome =
  /** The profile carried no logo. */
  | { kind: 'none' }
  /** A new copy is stored at `url` (our own address). */
  | { kind: 'stored'; url: string; sha256: string }
  /** The same bytes as the copy already in use: nothing changes. */
  | { kind: 'unchanged'; sha256: string }
  /** The logo could not be used (dead link, not an image, too big, store failed): company name only. */
  | { kind: 'failed'; code: Extract<LogoCode, 'bad_url' | 'fetch_failed' | 'too_big' | 'not_image' | 'store_failed'> }
  /** The logo field may not be filled (edited by the customer, or their own logo): not even downloaded. */
  | { kind: 'skipped' };

export interface ProfileFillPlan {
  /** The calculator settings to write (only the fields that change). Empty: nothing to write. */
  patch: Partial<Pick<SiteSettings, ProfileSettingField>>;
  /** The new leaddb_ad_accounts.profile_pushed. */
  pushed: ProfilePushed;
  /** Our previous stored logo copy, to delete once the new settings are saved (only when it was ours from a push and is replaced or cleared). */
  dropLogo: string | null;
  logoCode: LogoCode;
}

/**
 * Which calculator settings a push fills, and what to remember as pushed. Pure.
 *
 * - colour, areas, fee: written when `mayFill`; a pushed null (or no areas) clears a field only when it still holds
 *   the last pushed value (an empty field stays empty).
 * - logo: from the server's `LogoOutcome`. A stored copy replaces the field; a pushed null clears the field when it
 *   still holds our last copy; a failure leaves the field as it is (company name only when it was empty; a logo
 *   copied from an earlier push is KEPT rather than wiped by a dead link, decision for Zac).
 * - What is remembered as pushed for a field is what was WRITTEN; a field not written keeps its previous record.
 * - bedrooms are always remembered (they are not a calculator setting).
 */
export function planProfileFill(input: {
  settings: Pick<SiteSettings, ProfileSettingField>;
  edited: SettingsEdited;
  last: ProfilePushed;
  profile: AdProfile;
  logo: LogoOutcome;
}): ProfileFillPlan {
  const { settings, edited, last, profile, logo } = input;
  const patch: ProfileFillPlan['patch'] = {};
  const pushed: ProfilePushed = { ...last, bedrooms: profile.bedrooms };

  // Colour.
  if (mayFill('brandColour', settings.brandColour, last.brandColour, edited, emptyText, sameColour)) {
    const next = profile.brandColour;
    if ((settings.brandColour ?? null) !== next) patch.brandColour = next;
    pushed.brandColour = next;
  }

  // Areas (main first).
  const areas = areasForSettings(profile.areas);
  if (mayFill('areas', settings.areas ?? [], last.areas, edited, (v) => v.length === 0, sameAreas)) {
    if (!sameAreas(settings.areas ?? [], areas)) patch.areas = areas;
    pushed.areas = areas;
  }

  // Fee.
  const fee = feeForSettings(profile.feePct);
  if (mayFill<number | null>('managementFeePct', settings.managementFeePct, last.feePct, edited, (v) => v === null || v === undefined, (a, b) => (a ?? null) === (b ?? null))) {
    if ((settings.managementFeePct ?? null) !== fee) patch.managementFeePct = fee;
    pushed.feePct = fee;
  }

  // Logo.
  let dropLogo: string | null = null;
  let logoCode: LogoCode;
  const ourLastCopy = last.logoUrl ?? null;
  const holdsOurCopy = ourLastCopy !== null && settings.logoUrl === ourLastCopy;
  switch (logo.kind) {
    case 'skipped':
      logoCode = edited.logoUrl ? 'edited' : 'kept';
      break;
    case 'none':
      logoCode = 'none';
      if (holdsOurCopy) {
        patch.logoUrl = null;
        dropLogo = ourLastCopy;
      }
      if (holdsOurCopy || settings.logoUrl === null) {
        pushed.logoUrl = null;
        pushed.logoSha256 = null;
      }
      break;
    case 'unchanged':
      logoCode = 'unchanged';
      break;
    case 'stored':
      logoCode = 'stored';
      patch.logoUrl = logo.url;
      pushed.logoUrl = logo.url;
      pushed.logoSha256 = logo.sha256;
      if (holdsOurCopy && ourLastCopy !== logo.url) dropLogo = ourLastCopy;
      break;
    case 'failed':
      logoCode = logo.code;
      break;
  }
  pushed.logoCode = logoCode;
  return { patch, pushed, dropLogo, logoCode };
}

// ── The pack (55c A1) ──

/** The bedroom count a lead database pack prefers: the lowest in the pushed range, or null (the area's most common is used). */
export function preferredBedrooms(pushed: ProfilePushed | null | undefined): number | null {
  const b = pushed?.bedrooms;
  return b && isInt(b.min) && b.min >= 0 && b.min <= 10 ? b.min : null;
}
