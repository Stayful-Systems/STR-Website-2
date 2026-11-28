/**
 * Batch 55 step 5 (Phase 1, 55c A1): applying a pushed profile to the customer's calculator site.
 *
 * PURE: every I/O is an injected dependency (`ProfileDeps`), so the whole decision runs under `node --test`.
 * ad-profile-server.ts is the live wiring.
 *
 * ORDER
 *   1  the ad account (no row: 'no_account', the route answers 404 unknown_customer)
 *   2  ordering: an older profileAsOf than the one held is 'stale' (equal is applied again)
 *   3  the claim: profile_as_of is moved to this push in SQL, guarded the same way, so two pushes landing together
 *      cannot let the older one win
 *   4  the owner's calculator site (none, or a normal website: nothing to fill, only the bedrooms are remembered)
 *   5  the logo: downloaded only when the field may be filled; the same bytes as our copy change nothing
 *   6  planProfileFill (ad-profile.ts): only empty fields, or fields still equal to the last pushed value, never a
 *      field the customer edited
 *   7  the settings are written guarded by the row's updated_at (a customer saving at the same moment wins: the push
 *      is planned once more from the fresh row, and skipped if it moves again)
 *   8  profile_pushed is written (guarded by this push's profile_as_of); a logo copy replaced is deleted afterwards
 *
 * A failed logo never fails the push (company name only, a code recorded). A database error throws (a code only),
 * and the route answers server_error, so the lead database sends it again.
 */
import { planProfileFill, logoMayFill, shouldApplyProfile, type AdProfile, type LogoOutcome, type ProfilePushed, type SettingsEdited } from './ad-profile.ts';
import type { LogoFetch } from './ad-profile-logo.ts';
import type { SiteSettings } from '../websites/page-model.ts';

export interface ProfileSite {
  settings: SiteSettings;
  edited: SettingsEdited;
  funnelId: string;
  /** The row's updated_at as read: the write is guarded by it. */
  version: string;
}

export interface ProfileDeps {
  readAccount(ownerId: string): Promise<{ profileAsOf: Date | null; pushed: ProfilePushed } | null>;
  /** Moves profile_as_of to `asOfIso` only when it is null or not newer. True when it moved. */
  claim(ownerId: string, asOfIso: string): Promise<boolean>;
  /** The owner's CALCULATOR site, or null (no site, or a normal website). */
  readSite(ownerId: string): Promise<ProfileSite | null>;
  fetchLogo(url: string): Promise<LogoFetch>;
  /** Stores the bytes as the calculator's logo; our own public address, or null on failure. */
  storeLogo(input: { ownerId: string; funnelId: string; bytes: Uint8Array }): Promise<string | null>;
  /** Writes the merged settings when the row's updated_at is still `version`. 'conflict' when it moved. */
  writeSettings(ownerId: string, settings: SiteSettings, version: string): Promise<'ok' | 'conflict'>;
  deleteLogo(url: string): Promise<void>;
  /** Writes profile_pushed while profile_as_of is still `asOfIso`. */
  writePushed(ownerId: string, asOfIso: string, pushed: ProfilePushed): Promise<void>;
}

export type ApplyProfileResult = { result: 'applied' | 'stale' | 'no_account'; logoCode?: string };

export async function runApplyProfile(deps: ProfileDeps, ownerId: string, profile: AdProfile): Promise<ApplyProfileResult> {
  const account = await deps.readAccount(ownerId);
  if (!account) return { result: 'no_account' };
  if (!shouldApplyProfile(account.profileAsOf, profile.profileAsOf)) return { result: 'stale' };
  const asOfIso = new Date(profile.profileAsOf).toISOString();
  if (!(await deps.claim(ownerId, asOfIso))) return { result: 'stale' };

  const last = account.pushed;
  let pushed: ProfilePushed = { ...last, bedrooms: profile.bedrooms };
  let logoCode: string | undefined;
  let dropLogo: string | null = null;

  // Fetched at most once per push, even if the settings write is planned again.
  let fetched: LogoFetch | null = null;
  let storedUrl: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const site = await deps.readSite(ownerId);
    if (!site) break;

    let logo: LogoOutcome;
    if (profile.logoUrl === null) logo = { kind: 'none' };
    else if (!logoMayFill(site.settings, last, site.edited)) logo = { kind: 'skipped' };
    else {
      fetched ??= await deps.fetchLogo(profile.logoUrl);
      if (!fetched.ok) logo = { kind: 'failed', code: fetched.code };
      else if (last.logoSha256 === fetched.sha256 && last.logoUrl && site.settings.logoUrl === last.logoUrl) logo = { kind: 'unchanged', sha256: fetched.sha256 };
      else {
        storedUrl ??= await deps.storeLogo({ ownerId, funnelId: site.funnelId, bytes: fetched.bytes });
        logo = storedUrl ? { kind: 'stored', url: storedUrl, sha256: fetched.sha256 } : { kind: 'failed', code: 'store_failed' };
      }
    }

    const plan = planProfileFill({ settings: site.settings, edited: site.edited, last, profile, logo });
    logoCode = plan.logoCode;
    if (Object.keys(plan.patch).length === 0) {
      pushed = plan.pushed;
      break;
    }
    const written = await deps.writeSettings(ownerId, { ...site.settings, ...plan.patch }, site.version);
    if (written === 'ok') {
      pushed = plan.pushed;
      dropLogo = plan.dropLogo;
      break;
    }
    // The customer saved at the same moment: plan again from the fresh row (their edit mark is read again too).
  }

  // A copy stored but never put in the settings is taken back out.
  if (storedUrl && pushed.logoUrl !== storedUrl) await deps.deleteLogo(storedUrl);
  await deps.writePushed(ownerId, asOfIso, pushed);
  if (dropLogo && dropLogo !== pushed.logoUrl) await deps.deleteLogo(dropLogo);
  return { result: 'applied', ...(logoCode ? { logoCode } : {}) };
}
