'use server';

import { redirect, notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { updateBillingSetting } from '@/lib/credit/unit-costs';
import { BTL_FINANCE_KEY, BTL_REPORT_PENCE_KEY } from '@/lib/btl/config';
import { validateBtlSettingsForm } from '@/lib/btl/admin-form';

const PAGE = '/admin/deals/btl';

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=${PAGE}`);
  if (!isAdminEmail(user.email)) notFound();
  return user;
}

/**
 * Review R4 (R4-31, Zac 19 Nov 2026): the buy-to-let settings form: the £2 report's price and the finance. It writes
 * the two existing rows (btl_report_pence, btl_finance) and nothing else; every other btl_* setting stays SQL-only.
 * Every field is checked against the readers' own bounds first: one out of range and nothing is saved.
 */
export async function saveBtlSettingsAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const get = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v : null;
  };
  const r = validateBtlSettingsForm(get);
  if (!r.ok) redirect(`${PAGE}?settings=error&why=${encodeURIComponent(r.error)}#settings`);
  await updateBillingSetting(BTL_REPORT_PENCE_KEY, r.reportPence);
  await updateBillingSetting(BTL_FINANCE_KEY, r.finance);
  revalidatePath(PAGE);
  redirect(`${PAGE}?settings=saved#settings`);
}
