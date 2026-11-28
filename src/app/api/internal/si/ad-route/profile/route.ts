import { hasServiceRole } from '@/lib/supabase/admin';
import { parseAdProfile } from '@/lib/leaddb/ad-profile';
import { readAdAccountByCustomerId } from '@/lib/leaddb/ad-account-server';
import { applyAdProfile } from '@/lib/leaddb/ad-profile-server';
import { asObject, parseLdCustomerId, verifyInbound } from '@/lib/leaddb/inbound';

// ─── Lead database ad route: profile (Batch 55 step 5, contract section 13, call 8) ─────────
// The lead database pushes the customer's brand: logo (a short-lived signed https link), colour, fee, areas (main
// first) and bedroom range. This site fills ONLY calculator settings that are still empty or still equal to the last
// value pushed, never a field the customer edited here (55c A1). The logo is copied once into our own store; a dead or
// non-image link means the company name only.
//
//   POST { ld_customer_id, profile }   (signed, see inbound.ts)
//   → 200 { ok: true, code: 'applied' | 'stale' }   (stale: an older push, not an error)
//   → 400 bad_request   404 unknown_customer   500 server_error
//
// Never changes `allowed` (Zac's switch). Codes only in the response and logs: never the logo link, company or areas.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const body = asObject(verified.json);
  const ldCustomerId = parseLdCustomerId(body?.ld_customer_id);
  const profile = parseAdProfile(body?.profile);
  if (!ldCustomerId || !profile) return Response.json({ ok: false, code: 'bad_request' }, { status: 400 });

  try {
    const account = await readAdAccountByCustomerId(ldCustomerId);
    if (!account) return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    const result = await applyAdProfile(account.ownerId, profile);
    if (result === 'no_account') return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });
    return Response.json({ ok: true, code: result });
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    console.error('[leaddb-ad-route] profile failed:', /^[a-z_]+:[A-Za-z0-9_]+$/.test(text) ? text : 'error');
    return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
  }
}
