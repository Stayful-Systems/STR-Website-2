/**
 * The signed client for the lead database's website-lead door (Batch 32).
 *
 * Every call is a POST with the body signed by `signatureHeader` (the same
 * `t=<unix>,v1=<hex>` over `${t}.${body}` the CRM webhook uses; the secret is
 * a shared one in SI_LEAD_PUSH_SECRET, never in code or the database).
 *
 * What this never does:
 *   - throw: every failure is a `{ ok: false, code, retryable }`
 *   - log the body: it carries a landlord's name, number and address. The one
 *     log line says the path's name and a code, nothing else.
 *   - echo what the other side said: only its short snake_case `code` is read
 *
 * Retry rule (PLAN-batch-32.md): a network error, a timeout, 5xx, 408, 409
 * (in progress), 429, and 401 / 404 (a secret not yet set on one side must
 * not lose the lead) are worth another go. 400, 403, 413 and 422 will fail
 * identically for ever.
 *
 * Pure of Next and the database, so it runs under `node --test`.
 */
import { signatureHeader, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../crm/signature.ts';

export const MIN_SECRET_LENGTH = 32;
export const TIMEOUT_MS = 20_000;

export type LeadDbPath =
  | '/api/internal/si/link/start'
  | '/api/internal/si/link/confirm'
  | '/api/internal/si/link/revoke'
  | '/api/internal/si/website-leads';

export interface LeadDbResult<T = Record<string, unknown>> {
  ok: boolean;
  /** Short snake_case code: the other side's, or ours (not_configured, network, timeout, http_NNN). */
  code: string;
  retryable: boolean;
  status: number;
  data?: T;
}

export interface LeadDbConfig {
  baseUrl: string;
  secret: string;
}

/** The configuration, or null when either variable is unset or the secret is too short to trust. */
export function leadDbConfig(env: Record<string, string | undefined> = process.env): LeadDbConfig | null {
  const secret = env.SI_LEAD_PUSH_SECRET;
  const base = env.LEADDB_API_URL;
  if (!secret || secret.length < MIN_SECRET_LENGTH || !base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
  return { baseUrl: url.origin, secret };
}

/** Whether a failed status is worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 409 || status === 429 || status === 401 || status === 404;
}

export interface PostOptions {
  fetchImpl?: typeof fetch;
  config?: LeadDbConfig | null;
  timeoutMs?: number;
  nowSeconds?: number;
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export async function postSigned<T = Record<string, unknown>>(
  path: LeadDbPath,
  payload: Record<string, unknown>,
  opts: PostOptions = {},
): Promise<LeadDbResult<T>> {
  const config = opts.config === undefined ? leadDbConfig() : opts.config;
  if (!config) return { ok: false, code: 'not_configured', retryable: true, status: 0 };

  const body = JSON.stringify(payload);
  const ts = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signatureHeader(config.secret, body, ts),
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (res.ok && json?.ok === true) return { ok: true, code: 'ok', retryable: false, status: res.status, data: json as T };
    const said = typeof json?.code === 'string' && CODE.test(json.code) ? json.code : null;
    const code = said ?? (res.status === 404 ? 'not_available' : `http_${res.status}`);
    // A 200 that did not say ok is the other side refusing: never retried.
    const retryable = res.ok ? false : isRetryableStatus(res.status);
    return { ok: false, code, retryable, status: res.status };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    // Name only: an error's text can carry the URL or what was sent.
    console.error('[leaddb] request failed:', path, aborted ? 'timeout' : 'network');
    return { ok: false, code: aborted ? 'timeout' : 'network', retryable: true, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── Typed calls ───────────────────────────────────────────────────────────

export interface WebsiteLeadBody {
  si_member_id: string;
  si_lead_id: string;
  test?: boolean;
  lead: { name: string; email: string; phone: string; address: string; postcode: string; bedrooms: string; message: string };
  report?: { gross_annual_income: number; nightly_rate: number; occupancy_pct: number; bedrooms: number; pdf_base64: string };
}

export interface WebsiteLeadReply {
  ok: true;
  outcome: 'created' | 'duplicate';
  replayed: boolean;
  lead_id: string;
  url: string;
  report: 'attached' | 'already_attached' | 'coming' | 'kept_existing';
}

export const leadDbStart = (body: { si_member_id: string; email: string }, o?: PostOptions) =>
  postSigned<{ ok: true; link_id: string; status: 'code_sent' }>('/api/internal/si/link/start', body, o);

export const leadDbConfirm = (body: { link_id: string; si_member_id: string; code: string }, o?: PostOptions) =>
  postSigned<{ ok: true; status: 'confirmed'; lead_type: 'management' | 'guaranteed_rent' }>('/api/internal/si/link/confirm', body, o);

export const leadDbRevoke = (body: { si_member_id: string }, o?: PostOptions) =>
  postSigned('/api/internal/si/link/revoke', body, o);

export const leadDbPushLead = (body: WebsiteLeadBody, o?: PostOptions) =>
  postSigned<WebsiteLeadReply>('/api/internal/si/website-leads', body as unknown as Record<string, unknown>, o);
