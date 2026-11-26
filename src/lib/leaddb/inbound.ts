/**
 * Verifying a signed call FROM the lead database (Batch 55, Part A).
 *
 * The lead database signs its requests to us exactly as we sign ours to it
 * (Batch 32, client.ts): the header `x-stayful-signature: t=<unix>,v1=<hex>`,
 * where the hex is an HMAC-SHA256 over `${t}.${raw body}` under the shared
 * secret SI_LEAD_PUSH_SECRET. The timestamp must be within five minutes of our
 * clock (either side). `x-stayful-timestamp` is sent too; only the `t=` inside
 * the signature is trusted.
 *
 * What this never does:
 *   - log, return or echo the body, the signature or the secret
 *   - say why a signature failed (one code, `unauthorized`)
 *   - answer when the secret is unset or short: a plain empty 404, as if the
 *     route did not exist (the same rule as the outbound client's
 *     not_configured, seen from the other side)
 *
 * PURE of Next and the database, so it runs under `node --test`.
 */
import { SIGNATURE_HEADER, verifySignature } from '../crm/signature.ts';
import { MIN_SECRET_LENGTH } from './client.ts';

/** A larger body is refused unread past this point: the real ones are a few hundred bytes. */
export const MAX_INBOUND_BYTES = 64 * 1024;

export type InboundResult =
  | { ok: true; raw: string; json: unknown }
  | { ok: false; response: Response };

export interface VerifyInboundOptions {
  env?: Record<string, string | undefined>;
  nowSeconds?: number;
}

const fail = (status: number, code: string): { ok: false; response: Response } => ({
  ok: false,
  response: Response.json({ ok: false, code }, { status }),
});

/**
 * Reads the raw body once, checks the signature, and parses it as JSON.
 * 404 (empty body) when SI_LEAD_PUSH_SECRET is unset or under 32 characters;
 * 413 when the body is too large; 401 `unauthorized` on a missing or wrong
 * signature or a timestamp that is old or in the future; 400 `bad_request`
 * when a correctly signed body is not JSON.
 */
export async function verifyInbound(req: Request, opts: VerifyInboundOptions = {}): Promise<InboundResult> {
  const secret = (opts.env ?? process.env).SI_LEAD_PUSH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, response: new Response(null, { status: 404 }) };
  }

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_INBOUND_BYTES) return fail(413, 'too_large');

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail(400, 'bad_request');
  }
  if (raw.length > MAX_INBOUND_BYTES) return fail(413, 'too_large');

  const verdict = verifySignature({
    secret,
    body: raw,
    header: req.headers.get(SIGNATURE_HEADER),
    nowSeconds: opts.nowSeconds,
  });
  if (!verdict.ok) return fail(401, 'unauthorized');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_request');
  }
  return { ok: true, raw, json };
}

const LD_CUSTOMER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The lead database's customer id as a body field: a short id string, or null. Never throws. */
export function parseLdCustomerId(raw: unknown): string | null {
  return typeof raw === 'string' && LD_CUSTOMER_ID.test(raw) ? raw : null;
}

/** A body that is a JSON object, or null. */
export function asObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}
