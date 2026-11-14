'use server';

import { redirect, notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { runDealTypesBackfill } from '@/lib/profile/deal-types-backfill-run';
import { runQuizV2Backfill } from '@/lib/profile/quiz-v2-backfill-run';

/**
 * Batch 17: the deal-types backfill, for real (the dry run is the page's own
 * read, ?dealTypes=dry). Idempotent: press it again and nothing changes.
 */
export async function runDealTypesBackfillAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?redirect=/admin/profiles');
  if (!isAdminEmail(user.email)) notFound();
  const result = await runDealTypesBackfill({ dry: false, triggeredBy: user.email ?? 'admin' });
  const b = result.body as { written?: number; leftForNextRun?: number; alreadyOnTypes?: number; outOfTime?: boolean; error?: string };
  const q = new URLSearchParams({ dealTypes: result.status === 200 ? 'done' : 'failed', written: String(b.written ?? 0), left: String(b.leftForNextRun ?? 0), already: String(b.alreadyOnTypes ?? 0), ...(b.outOfTime ? { outOfTime: '1' } : {}) });
  redirect(`/admin/profiles?${q.toString()}#deal-types`);
}

/**
 * Batch 30: the shorter-quiz backfill, for real (the dry run is the page's own
 * read, ?quizV2=dry). The same move as /api/internal/quiz-v2-backfill, for the
 * admin who is logged in. Idempotent: press it again and nothing changes.
 */
export async function runQuizV2BackfillAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?redirect=/admin/profiles');
  if (!isAdminEmail(user.email)) notFound();
  const result = await runQuizV2Backfill({ dry: false, triggeredBy: user.email ?? 'admin' });
  const b = result.body as { written?: number; leftForNextRun?: number; alreadyMoved?: number; outOfTime?: boolean; error?: string };
  const q = new URLSearchParams({ quizV2: result.status === 200 ? 'done' : 'failed', written: String(b.written ?? 0), left: String(b.leftForNextRun ?? 0), already: String(b.alreadyMoved ?? 0), ...(b.outOfTime ? { outOfTime: '1' } : {}) });
  redirect(`/admin/profiles?${q.toString()}#quiz-v2`);
}
