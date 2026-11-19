'use server';

import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { updateBillingSetting } from '@/lib/credit/unit-costs';
import { ACTION_SETTING_KEYS, validateActionForm, type ActionSettings } from '@/lib/si-actions/settings';
import { flashAndGo } from '../flash';
import { tidyInstructions } from '@/lib/si-actions/run-server';

const PAGE = '/admin/intelligence/actions';

async function requireAdmin(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=${PAGE}`);
  if (!isAdminEmail(user.email)) notFound();
}

/** Batch 27: the Actions page's settings form. Every field is checked against its bounds before anything is saved. */
export async function saveActionSettingsAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const get = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v : null;
  };
  const r = validateActionForm(get);
  if (!r.ok) return flashAndGo(PAGE, { kind: 'error', message: r.error });
  for (const [field, key] of Object.entries(ACTION_SETTING_KEYS) as [keyof ActionSettings, string][]) {
    await updateBillingSetting(key, r.settings[field]);
  }
  revalidatePath(PAGE);
  return flashAndGo(PAGE, { kind: 'ok', message: 'Saved. The next instruction uses these.' });
}

export type TidyState = { at: string; dry: boolean; ok: true; cancelled: number; expired: number; closed: number; snapshots: number } | { at: string; dry: boolean; ok: false; message: string } | null;

/**
 * Review R4 (R4-31): the nightly si-actions tidy (/api/internal/si-actions), for the admin who is logged in (the
 * internal route needs INTERNAL_API_SECRET, which Zac cannot read). `apply` 1 runs it; anything else is the dry run,
 * which counts and changes nothing. The same move as the cron: nothing is charged or refunded.
 */
export async function tidyInstructionsAction(_prev: TidyState, formData: FormData): Promise<TidyState> {
  await requireAdmin();
  const apply = formData.get('apply') === '1';
  const at = new Date().toISOString();
  try {
    return { at, dry: !apply, ok: true, ...(await tidyInstructions({ apply })) };
  } catch (err) {
    return { at, dry: !apply, ok: false, message: (err as Error)?.message ?? 'failed' };
  }
}
