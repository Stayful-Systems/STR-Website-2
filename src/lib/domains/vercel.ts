/**
 * Batch 33: the Vercel project's domains, over Vercel's REST API.
 *
 *   addDomain(name)         add the root domain to the project ("already in this project" is OK)
 *   addWwwRedirect(name)    add www.<name> as a 308 redirect to <name>
 *   domainConfig(name)      is it misconfigured, and the A / CNAME values Vercel
 *                           recommends for THIS project (they change per project,
 *                           so they are read, never typed in)
 *   domainVerified(name)    is the domain verified on the project (asks Vercel to verify once if not)
 *   removeDomain(name)      remove it from the project (a 404 is "already gone")
 *
 * Endpoints (REST API, https://vercel.com/docs/rest-api):
 *   POST   /v10/projects/{project}/domains          body { name, redirect?, redirectStatusCode? }
 *   GET    /v9/projects/{project}/domains/{domain}
 *   POST   /v9/projects/{project}/domains/{domain}/verify
 *   DELETE /v9/projects/{project}/domains/{domain}
 *   GET    /v6/domains/{domain}/config
 * all with ?teamId=. Vercel's docs say a domain already on the project is a 400
 * and the brief says 409: either way, a refused add is followed by a GET, and
 * only a domain that IS in this project counts as done; one that belongs to
 * another project stays refused.
 *
 * Credentials: DOMAINS_VERCEL_TOKEN, DOMAINS_VERCEL_PROJECT_ID,
 * DOMAINS_VERCEL_TEAM_ID (not the reserved VERCEL_ prefix). Nothing here logs:
 * no headers, no bodies. A failure is a VercelError with a code and an HTTP
 * status, never a response body or the token.
 *
 * Pure of server-only: fetch and env are passed in, which is how the tests run.
 */

export type VercelErrorCode = 'unclear' | 'refused' | 'not_configured';

export class VercelError extends Error {
  readonly code: VercelErrorCode;
  readonly status: number | null;
  constructor(code: VercelErrorCode, status: number | null = null) {
    super(status === null ? `vercel:${code}` : `vercel:${code}:${status}`);
    this.name = 'VercelError';
    this.code = code;
    this.status = status;
  }
}

export interface DomainConfig {
  misconfigured: boolean;
  /** The IPv4 address(es) Vercel recommends for the root record, best first. */
  recommendedIPv4: string[];
  /** The CNAME target Vercel recommends for www, or null. */
  recommendedCNAME: string | null;
}

export interface VercelDomains {
  addDomain(name: string): Promise<void>;
  addWwwRedirect(name: string): Promise<void>;
  domainConfig(name: string): Promise<DomainConfig>;
  domainVerified(name: string): Promise<boolean>;
  removeDomain(name: string): Promise<void>;
}

export interface VercelConfig {
  token: string;
  projectId: string;
  teamId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const BASE = 'https://api.vercel.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

function assertDomain(name: string): void {
  if (typeof name !== 'string' || !DOMAIN.test(name)) throw new VercelError('refused', 400);
}

/** Rank-ordered "recommended" lists: [{ rank, value: string | string[] }] -> the values, best rank first. */
function recommended(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const rows = list
    .filter((r): r is { rank?: unknown; value?: unknown } => !!r && typeof r === 'object')
    .map((r, i) => ({ rank: typeof r.rank === 'number' ? r.rank : i + 1, values: ([] as unknown[]).concat(r.value ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0) }))
    .sort((a, b) => a.rank - b.rank);
  return rows.flatMap((r) => r.values);
}

export function createVercel(config: VercelConfig): VercelDomains {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const project = encodeURIComponent(config.projectId);
  const team = `teamId=${encodeURIComponent(config.teamId)}`;

  /** One call. A network failure, a timeout or a 5xx is `unclear`; any other non-2xx comes back as its status for the caller to judge. */
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}${team}`, {
        method,
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new VercelError('unclear');
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) throw new VercelError('unclear', res.status);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  const ok = (status: number) => status >= 200 && status < 300;

  async function inProject(name: string): Promise<boolean> {
    const r = await call('GET', `/v9/projects/${project}/domains/${encodeURIComponent(name)}`);
    if (ok(r.status)) return true;
    if (r.status === 404) return false;
    throw new VercelError('refused', r.status);
  }

  async function add(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    assertDomain(name);
    const r = await call('POST', `/v10/projects/${project}/domains`, { name, ...extra });
    if (ok(r.status)) return;
    // 409 (the brief) or 400 (the docs): "already exists". Only a domain already IN THIS project is fine.
    if ((r.status === 409 || r.status === 400) && (await inProject(name))) return;
    throw new VercelError('refused', r.status);
  }

  return {
    addDomain: (name) => add(name),
    addWwwRedirect: (name) => add(`www.${name}`, { redirect: name, redirectStatusCode: 308 }),

    async domainConfig(name) {
      assertDomain(name);
      const r = await call('GET', `/v6/domains/${encodeURIComponent(name)}/config`);
      if (!ok(r.status)) throw new VercelError('refused', r.status);
      const j = (r.json && typeof r.json === 'object' ? r.json : {}) as Record<string, unknown>;
      return {
        // Anything but an explicit false is "not set up yet".
        misconfigured: j.misconfigured !== false,
        recommendedIPv4: recommended(j.recommendedIPv4),
        recommendedCNAME: recommended(j.recommendedCNAME)[0] ?? null,
      };
    },

    async domainVerified(name) {
      assertDomain(name);
      const r = await call('GET', `/v9/projects/${project}/domains/${encodeURIComponent(name)}`);
      if (r.status === 404) return false;
      if (!ok(r.status)) throw new VercelError('refused', r.status);
      if ((r.json as { verified?: unknown } | null)?.verified === true) return true;
      const v = await call('POST', `/v9/projects/${project}/domains/${encodeURIComponent(name)}/verify`);
      if (!ok(v.status)) return false;
      return (v.json as { verified?: unknown } | null)?.verified === true;
    },

    async removeDomain(name) {
      assertDomain(name);
      const r = await call('DELETE', `/v9/projects/${project}/domains/${encodeURIComponent(name)}`);
      if (ok(r.status) || r.status === 404) return;
      throw new VercelError('refused', r.status);
    },
  };
}

type Env = Record<string, string | undefined>;

/** The project's domains client from DOMAINS_VERCEL_*, or a not_configured error. */
export function getVercel(env: Env = process.env): VercelDomains {
  const token = env.DOMAINS_VERCEL_TOKEN?.trim();
  const projectId = env.DOMAINS_VERCEL_PROJECT_ID?.trim();
  const teamId = env.DOMAINS_VERCEL_TEAM_ID?.trim();
  if (!token || !projectId || !teamId) throw new VercelError('not_configured');
  return createVercel({ token, projectId, teamId });
}

export function vercelConfigured(env: Env = process.env): boolean {
  return Boolean(env.DOMAINS_VERCEL_TOKEN?.trim() && env.DOMAINS_VERCEL_PROJECT_ID?.trim() && env.DOMAINS_VERCEL_TEAM_ID?.trim());
}
