import 'server-only';

/**
 * Review R4 (R4-03): the end of the profit range each member is judged on, for
 * the places that size "Most you can pay" without a whole tailoring profile
 * (price-drop alerts, My deals' offer range). The same pure helper as Today,
 * Browse, the email, the reveal, match counts and standout
 * (criteria.ts profitEndChoice), on the same three reads tailoringForSeats
 * makes: About you, the quiz marks and the sign-up date, with
 * billing_settings.quiz_shorter_from. A member it cannot read is judged on the
 * low end (the stricter end, as every check was before Batch 30). Reads only.
 */
import type { createAdminClient } from '../supabase/admin';
import { getBillingSettings } from '../credit/unit-costs';
import { DEFAULT_ABOUT, parseAboutYou } from '../profile/about';
import { parseAnswered } from '../profile/state';
import { profitEndChoice, type ProfitEnd } from './criteria';

type Admin = ReturnType<typeof createAdminClient>;

const CHUNK = 200;

export async function profitEndsFor(admin: Admin, userIds: readonly string[]): Promise<Map<string, ProfitEnd>> {
  const out = new Map<string, ProfitEnd>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const shorterFrom = (await getBillingSettings().catch(() => null))?.lifecycle.quizShorterFrom ?? null;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const some = ids.slice(i, i + CHUNK);
    const [aboutRes, quizRes] = await Promise.all([admin.from('profiles').select('id, about_you, created_at').in('id', some), admin.from('profile_quiz').select('user_id, answered').in('user_id', some)]);
    if (aboutRes.error) console.warn('[profit end] profiles unreadable:', aboutRes.error.message);
    if (quizRes.error) console.warn('[profit end] quiz marks unreadable:', quizRes.error.message);
    const marks = new Map(((quizRes.data ?? []) as { user_id: string; answered: unknown }[]).map((r) => [r.user_id, parseAnswered(r.answered)]));
    for (const r of (aboutRes.data ?? []) as { id: string; about_you: unknown; created_at?: string | null }[]) {
      out.set(r.id, profitEndChoice(parseAboutYou(r.about_you) ?? DEFAULT_ABOUT, marks.get(r.id)?.risk, { joinedAt: r.created_at ?? null, shorterFrom }).end);
    }
  }
  return out;
}

/** One member's end (the low end when it cannot be read, or without the service role). */
export async function profitEndForMember(admin: Admin | null, userId: string): Promise<ProfitEnd> {
  if (!admin) return 'low';
  return (await profitEndsFor(admin, [userId]).catch(() => null))?.get(userId) ?? 'low';
}
