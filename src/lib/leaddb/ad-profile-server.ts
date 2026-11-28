import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { deleteLogoIfOurs, uploadLogo } from '../funnels/storage';
import { isCalculatorMode } from '../websites/calculator';
import { parseSiteSettings } from '../websites/store-server';
import { markEdited, parseProfilePushed, parseSettingsEdited, preferredBedrooms, type AdProfile, type ProfilePushed, type ProfileSettingField } from './ad-profile';
import { fetchLogo } from './ad-profile-logo';
import { runApplyProfile, type ApplyProfileResult, type ProfileDeps } from './ad-profile-run';

/**
 * Batch 55 step 5 (Phase 1, 55c A1): the live wiring for a pushed profile (ad-profile-run.ts holds the decisions).
 * Service role only. A log line carries a code at most: never the logo link, a colour, an area, a fee or a body.
 *
 *   applyAdProfile(ownerId, profile)      the profile call and the profile inside provision
 *   markCalculatorFieldsEdited(...)       the brand screen's save marks the fields the customer changed
 *   readPushedBedrooms(ownerId)           the lowest pushed bedroom count, for a lead database pack
 */

const db = () => createAdminClient();

function codeOf(error: { code?: string } | null | undefined): string {
  return error?.code ?? 'error';
}

function liveProfileDeps(): ProfileDeps {
  return {
    async readAccount(ownerId) {
      const { data, error } = await db().from('leaddb_ad_accounts').select('profile_as_of, profile_pushed').eq('owner_id', ownerId).maybeSingle();
      if (error) {
        console.error('[leaddb-ad-profile] account read failed:', codeOf(error));
        throw new Error(`ad_profile_read_failed:${codeOf(error)}`);
      }
      if (!data) return null;
      const row = data as { profile_as_of: string | null; profile_pushed: unknown };
      const t = row.profile_as_of ? Date.parse(row.profile_as_of) : NaN;
      return { profileAsOf: Number.isNaN(t) ? null : new Date(t), pushed: parseProfilePushed(row.profile_pushed) };
    },

    async claim(ownerId, asOfIso) {
      const { data, error } = await db()
        .from('leaddb_ad_accounts')
        .update({ profile_as_of: asOfIso, updated_at: new Date().toISOString() })
        .eq('owner_id', ownerId)
        .or(`profile_as_of.is.null,profile_as_of.lte.${asOfIso}`)
        .select('owner_id');
      if (error) {
        console.error('[leaddb-ad-profile] claim failed:', codeOf(error));
        throw new Error(`ad_profile_claim_failed:${codeOf(error)}`);
      }
      return (data ?? []).length > 0;
    },

    async readSite(ownerId) {
      const { data, error } = await db().from('websites').select('funnel_id, mode, settings, settings_edited, updated_at').eq('user_id', ownerId).maybeSingle();
      if (error) {
        console.error('[leaddb-ad-profile] site read failed:', codeOf(error));
        throw new Error(`ad_profile_site_failed:${codeOf(error)}`);
      }
      if (!data) return null;
      const row = data as { funnel_id: string; mode: unknown; settings: unknown; settings_edited: unknown; updated_at: string };
      if (!isCalculatorMode(row.mode)) return null;
      return { settings: parseSiteSettings(row.settings), edited: parseSettingsEdited(row.settings_edited), funnelId: String(row.funnel_id), version: String(row.updated_at) };
    },

    fetchLogo: (url) => fetchLogo(url),

    async storeLogo({ ownerId, funnelId, bytes }) {
      const r = await uploadLogo({ userId: ownerId, funnelId, bytes });
      return r.ok && r.url ? r.url : null;
    },

    async writeSettings(ownerId, settings, version) {
      const { data, error } = await db()
        .from('websites')
        .update({ settings: parseSiteSettings(settings), updated_at: new Date().toISOString() })
        .eq('user_id', ownerId)
        .eq('mode', 'calculator')
        .eq('updated_at', version)
        .select('id');
      if (error) {
        console.error('[leaddb-ad-profile] settings write failed:', codeOf(error));
        throw new Error(`ad_profile_settings_failed:${codeOf(error)}`);
      }
      return (data ?? []).length > 0 ? 'ok' : 'conflict';
    },

    deleteLogo: (url) => deleteLogoIfOurs(url),

    async writePushed(ownerId, asOfIso, pushed) {
      const { error } = await db()
        .from('leaddb_ad_accounts')
        .update({ profile_pushed: pushed, updated_at: new Date().toISOString() })
        .eq('owner_id', ownerId)
        .eq('profile_as_of', asOfIso);
      if (error) {
        console.error('[leaddb-ad-profile] pushed write failed:', codeOf(error));
        throw new Error(`ad_profile_pushed_failed:${codeOf(error)}`);
      }
    },
  };
}

/** A pushed profile, applied to the owner's calculator site (see ad-profile-run.ts). Throws a code only on a database error. */
export async function applyAdProfile(ownerId: string, profile: AdProfile): Promise<ApplyProfileResult['result']> {
  const out = await runApplyProfile(liveProfileDeps(), ownerId, profile);
  if (out.logoCode && out.logoCode !== 'stored' && out.logoCode !== 'unchanged' && out.logoCode !== 'none' && out.logoCode !== 'kept' && out.logoCode !== 'edited') {
    // A code only: the link is never logged.
    console.warn('[leaddb-ad-profile] logo not used:', out.logoCode);
  }
  return out.result;
}

/**
 * The brand screen's save: stamps each field the customer really changed, so a later push never fills it again.
 * Never throws and never blocks the save (a failure is a logged code); called BEFORE the settings are saved, so a
 * push landing in between cannot overwrite the new choice.
 */
export async function markCalculatorFieldsEdited(ownerId: string, fields: readonly ProfileSettingField[]): Promise<void> {
  if (fields.length === 0 || !hasServiceRole()) return;
  try {
    const { data, error } = await db().from('websites').select('settings_edited').eq('user_id', ownerId).maybeSingle();
    if (error || !data) {
      if (error) console.error('[leaddb-ad-profile] edited read failed:', codeOf(error));
      return;
    }
    const next = markEdited(parseSettingsEdited((data as { settings_edited: unknown }).settings_edited), fields, new Date().toISOString());
    const { error: writeErr } = await db().from('websites').update({ settings_edited: next }).eq('user_id', ownerId);
    if (writeErr) console.error('[leaddb-ad-profile] edited write failed:', codeOf(writeErr));
  } catch {
    console.error('[leaddb-ad-profile] edited mark failed');
  }
}

/** The lowest bedroom count the lead database pushed for this owner, or null (the area's most common is used). Never throws. */
export async function readPushedBedrooms(ownerId: string): Promise<number | null> {
  if (!hasServiceRole()) return null;
  try {
    const { data, error } = await db().from('leaddb_ad_accounts').select('profile_pushed').eq('owner_id', ownerId).maybeSingle();
    if (error || !data) return null;
    return preferredBedrooms(parseProfilePushed((data as { profile_pushed: unknown }).profile_pushed) as ProfilePushed);
  } catch {
    return null;
  }
}
