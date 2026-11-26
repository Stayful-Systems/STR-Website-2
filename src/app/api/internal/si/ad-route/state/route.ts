import { hasServiceRole } from '@/lib/supabase/admin';
import { parseAdAccountState } from '@/lib/leaddb/ad-account';
import { applyAdAccountState, readAdAccountByCustomerId } from '@/lib/leaddb/ad-account-server';
import { asObject, parseLdCustomerId, verifyInbound } from '@/lib/leaddb/inbound';

// ─── Lead database ad route: state (Batch 55, Part A, phase A3) ─────────
// The lead database pushes an operator's account state on EVERY change (card
// added or removed, pause, cancel scheduled, cancel effective, lapse,
// reinstatement). This site stores it and checks it locally; a missing state
// stops the route (fail closed).
//
//   POST { ld_customer_id, state }   (signed, see inbound.ts)
//   → 200 { ok: true, code: 'applied' | 'stale' }   (stale: an older push, not an error)
//   → 400 bad_request   404 unknown_customer   500 server_error
//
// Never changes `allowed` (Zac's switch). Codes only in the response and logs.
// Contract for the lead database: docs/build/batch-55-part-a-CONTRACT.md.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const body = asObject(verified.json);
  const ldCustomerId = parseLdCustomerId(body?.ld_customer_id);
  const state = parseAdAccountState(body?.state);
  if (!ldCustomerId || !state) return Response.json({ ok: false, code: 'bad_request' }, { status: 400 });

  try {
    const account = await readAdAccountByCustomerId(ldCustomerId);
    if (!account) return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    const result = await applyAdAccountState(account.ownerId, state);
    if (result === 'no_account') return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    return Response.json({ ok: true, code: result });
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    console.error('[leaddb-ad-route] state failed:', /^[a-z_]+:[A-Za-z0-9_]+$/.test(text) ? text : 'error');
    return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
  }
}
