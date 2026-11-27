import { hasServiceRole } from '@/lib/supabase/admin';
import { parseUnpaidHold } from '@/lib/leaddb/ad-account';
import { applyUnpaidHold, readAdAccountByCustomerId } from '@/lib/leaddb/ad-account-server';
import { asObject, parseLdCustomerId, verifyInbound } from '@/lib/leaddb/inbound';

// ─── Lead database ad route: unpaid hold (Batch 55 step 2, contract section 12) ─────────
// The lead database says the unpaid hold is on (unpaid ad-lead charges reached the hold figure) or off (the charge
// succeeded). While it is on, the calculator takes no new lead (stop condition 8, the same neutral page as the stop
// rule); a report already running still finishes. Named "unpaid hold", never "pause".
//
//   POST { ld_customer_id, on, owedPence, holdAsOf }   (signed, see inbound.ts)
//   → 200 { ok: true, code: 'applied' | 'stale' }   (stale: an older call, not an error)
//   → 400 bad_request   404 unknown_customer   500 server_error
//
// owedPence is for the admin screen only. Never changes `allowed` (Zac's switch). Codes only in the response and logs.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const body = asObject(verified.json);
  const ldCustomerId = parseLdCustomerId(body?.ld_customer_id);
  const hold = parseUnpaidHold(body);
  if (!ldCustomerId || !hold) return Response.json({ ok: false, code: 'bad_request' }, { status: 400 });

  try {
    const account = await readAdAccountByCustomerId(ldCustomerId);
    if (!account) return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    const result = await applyUnpaidHold(account.ownerId, hold);
    if (result === 'no_account') return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    return Response.json({ ok: true, code: result });
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    console.error('[leaddb-ad-route] unpaid hold failed:', /^[a-z_]+:[A-Za-z0-9_]+$/.test(text) ? text : 'error');
    return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
  }
}
