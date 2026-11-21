/**
 * Batch 33: the real registrar, Openprovider's REST API, over plain fetch.
 *
 * SOURCES (all checked 2026-11-20 against the Openprovider developer portal,
 * https://developer.openprovider.com : its API reference renders from the
 * OpenAPI document published at /data/swagger.spec.js, which is what the
 * request and response shapes below were read from; get-started.html gave the
 * login and token notes):
 *
 *   Base URL     https://api.openprovider.eu/v1 (index.html, rest-api-documentation.html).
 *                The brief said v1beta. docs.openprovider.com now says v1beta is
 *                discontinued (off 30 June 2027), v1 is "functionally identical" and
 *                moving is a base-URL change, so this file uses /v1.
 *   login        POST /auth/login  {username, password, ip} -> {code, data:{token, reseller_id}}
 *                (swagger LoginRequest / LoginResponse; "ip" 0.0.0.0 = any address).
 *   check        POST /domains/check  {domains:[{name, extension}], with_price}
 *                -> data.results[{domain, status 'free'|'active', is_premium,
 *                premium:{currency, price:{create}}, price:{product:{currency, price},
 *                reseller:{currency, price}}, reason}] (swagger CheckDomainRequest/Result).
 *                Prices are decimal currency units (8.06), converted here to pence.
 *   find         GET /domains?full_name=...  -> data.results[domain record] (List domains).
 *   info         GET /domains/{id}           -> data = the same record (Get domain).
 *   register     POST /domains  {domain:{name, extension}, period, owner_handle,
 *                admin_handle, tech_handle, billing_handle, autorenew, ns_group}
 *                -> data{id, status, activation_date, expiration_date, renewal_date}.
 *   autorenew    PUT /domains/{id}  {autorenew: 'on'|'off'|'default'} (Update domain).
 *   renew        POST /domains/{id}/renew {id, domain, period}  -> data{status} only,
 *                so the new expiry is read back with GET /domains/{id}.
 *   dns          PUT /dns/zones/{name} {name, domain, records:{replace:[{name, type,
 *                value, ttl}]}}  and POST /dns/zones {domain, type, records:[...]}
 *                (Update zone / Create zone).
 *
 * UNCONFIRMED (the docs do not say; each is a guess and is listed in the batch report):
 *   1. The sandbox host. The portal never names it; https://api.sandbox.openprovider.eu/v1
 *      is the brief's host with the documented /v1 path.
 *   2. The token lifetime. Docs say only "valid for a limited time". The token is
 *      cached up to TOKEN_MAX_AGE_MS and refreshed once on any 401.
 *   3. That an expired or bad token is an HTTP 401 (rather than some other status).
 *   4. How "already registered" looks on POST /domains: no error code is documented.
 *      taken is HTTP 409, or a 4xx / non-zero-code body whose description reads
 *      like "already registered / not free / unavailable". Anything else 4xx is refused.
 *   5. That ns_group 'dns-openprovider' (Openprovider's default nameserver group)
 *      exists on the account; the swagger marks no create field required.
 *   6. DNS: whether records.replace swaps the whole zone or only the named records;
 *      whether a registered domain already has a zone (a 404 on PUT is treated as
 *      "no zone yet" and the zone is created with POST); that record names are
 *      fully qualified ("example.co.uk", "www.example.co.uk" as the swagger
 *      examples show); the minimum TTL.
 *   7. The timezone of "YYYY-MM-DD HH:MM:SS" dates (read as UTC), and that
 *      renewal_date (not the registry-side expiration_date, which the swagger
 *      says is not the primary reference) is the date to report as expiresAt.
 *   8. Whether the full_name filter on GET /domains is exact (matches are
 *      checked exactly client-side anyway).
 *   9. Whether price.reseller is in the account currency, and whether it is
 *      ex-VAT. It is used when present, else price.product.
 *  10. changeIpsTag: the swagger has no .co.uk IPS tag / Nominet tag-change call
 *      (the /tags endpoints are customer labels, /domains/{id}/transfer/* and
 *      /authcode are for other TLDs and transfers in). It is therefore refused.
 *
 * RULES: bearer token cached in memory per client; one re-login on a 401; every
 * request has a timeout (default 10s); a timeout, a network error or a 5xx is
 * `unclear` (the call may have happened) and never `taken`; other 4xx is
 * `refused`. Nothing is logged: no logging calls exist in this file, and a thrown
 * RegistrarError carries only its code and HTTP status, never a body, header,
 * username, password or token.
 *
 * Nothing is imported from outside src/lib/domains, and not server-only: the
 * tests run under plain node with a mocked fetch.
 */
import { RegistrarError, type Availability, type DnsRecord, type OwnedDomain, type Registrar } from './types.ts';

export interface OpenproviderConfig {
  username: string;
  password: string;
  sandbox: boolean;
  /** Defaults to globalThis.fetch; tests pass a mock. */
  fetch?: typeof fetch;
  /** Per-request timeout, default 10 seconds. */
  timeoutMs?: number;
}

const PRODUCTION_BASE = 'https://api.openprovider.eu/v1';
const SANDBOX_BASE = 'https://api.sandbox.openprovider.eu/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
/** The lifetime is undocumented: refresh well inside any plausible one. A 401 refreshes sooner. */
const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const EXTENSION = 'co.uk';
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.co\.uk$/i;
/** Description text that means "somebody holds this name" (UNCONFIRMED, see header). */
const TAKEN_RE = /already\s+(?:registered|exists?|taken)|not\s+(?:free|available)|unavailable|domain\s+exists|duplicate/i;

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body: unknown;
}
interface CallOpts {
  /** Statuses the caller handles itself (e.g. 404 = not found). */
  tolerate?: readonly number[];
  /** Read a client error as "taken" when it looks like the name is gone (register only). */
  takenOnConflict?: boolean;
}

function asObj(x: unknown): Json | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : null;
}
function asStr(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}
function asNum(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** 'YYYY-MM-DD HH:MM:SS' (read as UTC) or an ISO string, to an ISO timestamp; null for empty, zero or unparseable. */
function toIso(raw: unknown): string | null {
  const s = asStr(raw);
  if (!s || s.startsWith('0000-00-00')) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The date to report as the expiry (renewal_date first: see UNCONFIRMED 7). */
function expiryOf(rec: Json): string | null {
  return toIso(rec.renewal_date) ?? toIso(rec.expiration_date);
}

function autoRenewOf(raw: unknown): boolean | null {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

function split(name: string): { label: string; extension: string; full: string } {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new RegistrarError('refused');
  const full = name.toLowerCase();
  return { label: full.slice(0, -(EXTENSION.length + 1)), extension: EXTENSION, full };
}

/** Pence from a decimal price, or null when it is not a usable number. */
function toPence(price: unknown): number | null {
  const n = asNum(price);
  return n !== null && n >= 0 ? Math.round(n * 100) : null;
}

export function createOpenprovider(config: OpenproviderConfig): Registrar {
  const base = config.sandbox ? SANDBOX_BASE : PRODUCTION_BASE;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => (config.fetch ?? globalThis.fetch)(...args);

  let token: string | null = null;
  let tokenAt = 0;
  let loginInFlight: Promise<string> | null = null;

  /** One HTTP exchange with a timeout. Timeout, network error or an unreadable body is `unclear`. */
  async function send(method: string, path: string, body: unknown, bearer: string | null): Promise<Reply> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: res.status, body: parsed };
    } catch {
      // Timeout (abort), DNS, reset, TLS: the request may or may not have landed.
      throw new RegistrarError('unclear');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn a reply into a throw (or pass it through) by the status rules. */
  function judge(r: Reply, opts: CallOpts = {}): Reply {
    if (r.status >= 500) throw new RegistrarError('unclear', r.status);
    if (opts.tolerate?.includes(r.status)) return r;
    const b = asObj(r.body);
    if (b?.maintenance === true) throw new RegistrarError('unclear', r.status);
    const code = b ? asNum(b.code) : null;
    const failed = r.status >= 300 || (code !== null && code !== 0);
    if (!failed) return r;
    if (opts.takenOnConflict && (r.status === 409 || TAKEN_RE.test(asStr(b?.desc) ?? ''))) {
      throw new RegistrarError('taken', r.status);
    }
    throw new RegistrarError('refused', r.status);
  }

  async function login(): Promise<string> {
    const r = judge(await send('POST', '/auth/login', { username: config.username, password: config.password, ip: '0.0.0.0' }, null));
    const t = asStr(asObj(asObj(r.body)?.data)?.token);
    if (t === null) throw new RegistrarError('unclear', r.status);
    token = t;
    tokenAt = Date.now();
    return t;
  }

  function getToken(): Promise<string> {
    if (token !== null && Date.now() - tokenAt < TOKEN_MAX_AGE_MS) return Promise.resolve(token);
    loginInFlight ??= login().finally(() => {
      loginInFlight = null;
    });
    return loginInFlight;
  }

  /** An authenticated call: re-logs in once on a 401, then judges the reply. */
  async function call(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<Reply> {
    const used = await getToken();
    let r = await send(method, path, body, used);
    if (r.status === 401) {
      if (token === used) token = null;
      r = await send(method, path, body, await getToken());
    }
    return judge(r, opts);
  }

  /** Our own record for a name: the domain row, or null. */
  async function lookup(full: string): Promise<Json | null> {
    const r = await call('GET', `/domains?full_name=${encodeURIComponent(full)}&limit=10`);
    const results = asObj(asObj(r.body)?.data)?.results;
    if (!Array.isArray(results)) throw new RegistrarError('unclear', r.status);
    for (const row of results) {
      const rec = asObj(row);
      const d = asObj(rec?.domain);
      if (rec && d && `${String(d.name)}.${String(d.extension)}`.toLowerCase() === full) return rec;
    }
    return null;
  }

  function idOf(rec: Json): string {
    const id = asNum(rec.id);
    if (id === null || !Number.isInteger(id) || id <= 0) throw new RegistrarError('unclear');
    return String(id);
  }

  function owned(rec: Json): OwnedDomain {
    return { ref: idOf(rec), expiresAt: expiryOf(rec), autoRenew: autoRenewOf(rec.autorenew) };
  }

  /** The registrar id of a domain we must already own, else refused (404). */
  async function idFor(full: string): Promise<string> {
    const rec = await lookup(full);
    if (!rec) throw new RegistrarError('refused', 404);
    return idOf(rec);
  }

  return {
    id: 'openprovider',

    async check(names) {
      const parts = names.map((n) => split(n));
      if (parts.length === 0) return [];
      const r = await call('POST', '/domains/check', {
        domains: parts.map((p) => ({ name: p.label, extension: p.extension })),
        with_price: true,
      });
      const results = asObj(asObj(r.body)?.data)?.results;
      if (!Array.isArray(results)) throw new RegistrarError('unclear', r.status);
      const byName = new Map<string, Json>();
      for (const row of results) {
        const rec = asObj(row);
        const dn = asStr(rec?.domain);
        if (rec && dn) byName.set(dn.toLowerCase(), rec);
      }
      return parts.map((p, i): Availability => {
        const rec = byName.get(p.full) ?? asObj(results[i]);
        if (!rec) throw new RegistrarError('unclear', r.status);
        const available = rec.status === 'free';
        const premium = rec.is_premium === true;
        if (!available) return { name: names[i], available: false, premium, pricePence: null };
        let currency: unknown;
        let price: unknown;
        if (premium) {
          const pp = asObj(rec.premium);
          currency = pp?.currency;
          price = asObj(pp?.price)?.create;
        } else {
          const group = asObj(rec.price);
          const reseller = asObj(group?.reseller);
          const chosen = asNum(reseller?.price) !== null ? reseller : asObj(group?.product);
          currency = chosen?.currency;
          price = chosen?.price;
        }
        const pence = toPence(price);
        if (pence === null || currency !== 'GBP') throw new RegistrarError('refused', r.status);
        return { name: names[i], available: true, premium, pricePence: pence };
      });
    },

    async findOwned(name) {
      const rec = await lookup(split(name).full);
      return rec ? owned(rec) : null;
    },

    async register(name, opts) {
      const p = split(name);
      if (!opts || typeof opts.ownerHandle !== 'string' || opts.ownerHandle.trim() === '') throw new RegistrarError('refused');
      const handle = opts.ownerHandle.trim();
      const r = await call(
        'POST',
        '/domains',
        {
          domain: { name: p.label, extension: p.extension },
          period: 1,
          owner_handle: handle,
          admin_handle: handle,
          tech_handle: handle,
          billing_handle: handle,
          autorenew: 'off',
          ns_group: 'dns-openprovider',
        },
        { takenOnConflict: true },
      );
      const data = asObj(asObj(r.body)?.data);
      const id = data ? asNum(data.id) : null;
      // The call succeeded but we cannot tell what was bought: the caller must ask findOwned.
      if (!data || id === null) throw new RegistrarError('unclear', r.status);
      return { ref: String(id), expiresAt: expiryOf(data) };
    },

    async setDns(name, records: readonly DnsRecord[]) {
      const p = split(name);
      const rows = records.map((rec) => {
        if ((rec.type !== 'A' && rec.type !== 'CNAME') || (rec.host !== '@' && rec.host !== 'www')) throw new RegistrarError('refused');
        if (typeof rec.value !== 'string' || rec.value.trim() === '') throw new RegistrarError('refused');
        return {
          name: rec.host === '@' ? p.full : `www.${p.full}`,
          type: rec.type,
          value: rec.value.trim(),
          ttl: rec.ttl ?? 3600,
        };
      });
      const domain = { name: p.label, extension: p.extension };
      const path = `/dns/zones/${encodeURIComponent(p.full)}`;
      const put = await call('PUT', path, { name: p.full, domain, records: { replace: rows } }, { tolerate: [404] });
      if (put.status === 404) {
        // No zone yet: create it with the records.
        const made = await call('POST', '/dns/zones', { domain, type: 'master', records: rows });
        if (asObj(asObj(made.body)?.data)?.success === false) throw new RegistrarError('refused', made.status);
        return;
      }
      if (asObj(asObj(put.body)?.data)?.success === false) throw new RegistrarError('refused', put.status);
    },

    async setAutoRenew(name, on) {
      const id = await idFor(split(name).full);
      await call('PUT', `/domains/${id}`, { autorenew: on ? 'on' : 'off' });
    },

    async renew(name) {
      const p = split(name);
      const id = await idFor(p.full);
      await call('POST', `/domains/${id}/renew`, { id: Number(id), domain: { name: p.label, extension: p.extension }, period: 1 });
      // Renew answers with a status only: read the new expiry back.
      const r = await call('GET', `/domains/${id}`, undefined, { tolerate: [404] });
      const rec = asObj(asObj(r.body)?.data);
      const expiresAt = r.status === 404 || !rec ? null : expiryOf(rec);
      // Money may have moved but the expiry is unreadable: the caller re-reads with info.
      if (expiresAt === null) throw new RegistrarError('unclear', r.status);
      return { expiresAt };
    },

    async info(name) {
      const found = await lookup(split(name).full);
      if (!found) return null;
      const r = await call('GET', `/domains/${idOf(found)}`, undefined, { tolerate: [404] });
      if (r.status === 404) return null;
      const rec = asObj(asObj(r.body)?.data);
      if (!rec) throw new RegistrarError('unclear', r.status);
      return owned({ ...rec, id: rec.id ?? found.id });
    },

    async changeIpsTag(name) {
      split(name);
      // Openprovider's REST API has no documented call for the .co.uk IPS tag
      // (Nominet tag change): the swagger's /tags are customer labels and the
      // transfer endpoints are for moving domains IN. Until it is confirmed, say
      // no rather than guess a call that moves a customer's domain.
      throw new RegistrarError('refused');
    },

    async transferCode(name) {
      // Batch 37. UNCONFIRMED for .uk until 9 Feb 2027 (the Nominet change): the
      // documented Get domain record (GET /domains/{id}) carries `auth_code` for
      // TLDs that have one. A .co.uk may not return it yet; absent is `refused`
      // (the manual step), never a guess. The code is returned, never logged.
      const found = await lookup(split(name).full);
      if (!found) throw new RegistrarError('refused', 404);
      const r = await call('GET', `/domains/${idOf(found)}`, undefined, { tolerate: [404] });
      if (r.status === 404) throw new RegistrarError('refused', 404);
      const code = asStr(asObj(asObj(r.body)?.data)?.auth_code);
      if (!code || !code.trim()) throw new RegistrarError('refused');
      return code.trim();
    },
  };
}
