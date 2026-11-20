'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { adminRunner, isAdminKind, type AdminResult } from '@/lib/domains/admin-run';
import { liveDomainEngine, readDomainSettings, writeDomainSetting } from '@/lib/domains/store-server';

/**
 * Batch 33: /admin/management's website domain actions.
 *
 *   dryRunDomainAction / runDomainAction         buy · retry · release · renew · dont_renew
 *   dryRunDomainSettingAction / saveDomainSettingAction   the three domain settings
 *
 * Every action checks the admin FIRST (requireAdmin), before it reads its
 * arguments, and writes one audit line to the console. A Dry run only reads:
 * it goes through the engine's dryRun flag, which makes no write and no
 * registrar, Vercel or email call (admin.test.ts pins it). The panel offers
 * Run only after a passing dry run for the same input.
 *
 * Nothing here returns a registrar reference, a token or a response body.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { id: data.user.id, email: data.user.email! };
}

/** The admin trail: who did what to which domain. */
function audit(admin: { email: string }, what: string): void {
  console.info(`[admin] domains: ${admin.email} ${what}`);
}

const FAIL: AdminResult = { ok: false, message: 'Not allowed, or something went wrong. Please try again.', lines: [], canRun: false };
const refresh = () => revalidatePath('/admin/management');

function runner(adminId: string | null) {
  return adminRunner({ engine: liveDomainEngine(), readSettings: readDomainSettings, writeSetting: writeDomainSetting, adminId });
}

export async function dryRunDomainAction(kind: string, domainId: string): Promise<AdminResult> {
  try {
    const admin = await requireAdmin();
    if (!isAdminKind(kind)) return { ...FAIL, message: 'Unknown action.' };
    return await runner(admin.id).dryRun(kind, String(domainId ?? ''));
  } catch {
    return FAIL;
  }
}

export async function runDomainAction(kind: string, domainId: string): Promise<AdminResult> {
  try {
    const admin = await requireAdmin();
    if (!isAdminKind(kind)) return { ...FAIL, message: 'Unknown action.' };
    const result = await runner(admin.id).run(kind, String(domainId ?? ''));
    audit(admin, `ran ${kind} on domain ${String(domainId ?? '').slice(0, 36)}: ${result.message}`);
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}

export async function dryRunDomainSettingAction(key: string, value: string): Promise<AdminResult> {
  try {
    const admin = await requireAdmin();
    return await runner(admin.id).dryRunSetting(String(key ?? ''), value);
  } catch {
    return FAIL;
  }
}

export async function saveDomainSettingAction(key: string, value: string): Promise<AdminResult> {
  try {
    const admin = await requireAdmin();
    const result = await runner(admin.id).saveSetting(String(key ?? ''), value);
    audit(admin, `set ${String(key ?? '').slice(0, 40)} to ${String(value ?? '').slice(0, 20)}: ${result.message}`);
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}
