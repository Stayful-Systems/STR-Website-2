// Read-only Google Sheets client for the lead-form link (Batch 35).
// No dependency: an RS256 JWT built with node:crypto, exchanged for a token.
// Secrets come from env only (never code, never the database). Errors are codes
// only: nothing here ever logs or throws a key, token, address or cell.
import { createSign } from 'node:crypto';

export type GoogleCode = 'not_configured' | 'not_shared' | 'not_found' | 'rate_limited' | 'error';

export class GoogleSheetsError extends Error {
  code: GoogleCode;
  constructor(code: GoogleCode) {
    super(code);
    this.name = 'GoogleSheetsError';
    this.code = code;
  }
}

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const JWT_LIFETIME_S = 3600;
const EARLY_EXPIRY_MS = 60_000;
const MIN_KEY_LENGTH = 100;

export type SheetTab = { gid: number; title: string };

export type GoogleDeps = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number; // ms since epoch
};

type Config = { email: string; privateKey: string };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function readConfig(env: Record<string, string | undefined>): Config | null {
  const email = (env.GOOGLE_SHEETS_SA_EMAIL ?? '').trim();
  const rawKey = (env.GOOGLE_SHEETS_SA_PRIVATE_KEY ?? '').trim();
  if (!email.includes('@') || rawKey.length < MIN_KEY_LENGTH) return null;
  // The env value carries escaped \n; unescape, and drop wrapping quotes.
  let privateKey = rawKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  if (!privateKey.includes('PRIVATE KEY')) return null;
  privateKey = privateKey.trim() + '\n';
  return { email, privateKey };
}

/** The service account email to show on the connect screen; null when not configured. */
export function serviceAccountEmail(env: Record<string, string | undefined> = process.env): string | null {
  return readConfig(env)?.email ?? null;
}

/** Build the signed RS256 JWT assertion (exported for tests). */
export function buildJwt(config: Config, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: config.email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat, exp: iat + JWT_LIFETIME_S }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(config.privateKey).toString('base64url')}`;
}

function codeForStatus(status: number): GoogleCode {
  if (status === 403) return 'not_shared';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'error';
}

export function createGoogleSheets(deps: GoogleDeps = {}) {
  const env = deps.env ?? process.env;
  const doFetch: typeof fetch = deps.fetch ?? ((...a) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  let cache: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    const config = readConfig(env);
    if (!config) throw new GoogleSheetsError('not_configured');
    if (cache && now() < cache.expiresAt) return cache.token;
    let assertion: string;
    try {
      assertion = buildJwt(config, now());
    } catch {
      throw new GoogleSheetsError('not_configured'); // unusable key
    }
    let res: Response;
    try {
      res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch {
      throw new GoogleSheetsError('error');
    }
    if (!res.ok) throw new GoogleSheetsError(res.status === 429 ? 'rate_limited' : 'error');
    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new GoogleSheetsError('error');
    }
    if (typeof json.access_token !== 'string' || !json.access_token) throw new GoogleSheetsError('error');
    const ttlS = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : JWT_LIFETIME_S;
    cache = { token: json.access_token, expiresAt: now() + ttlS * 1000 - EARLY_EXPIRY_MS };
    return cache.token;
  }

  async function api(path: string): Promise<unknown> {
    const token = await accessToken();
    let res: Response;
    try {
      res = await doFetch(`${API_BASE}/${path}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new GoogleSheetsError('error');
    }
    if (!res.ok) {
      if (res.status === 401) cache = null; // token refused: fetch a fresh one next time
      throw new GoogleSheetsError(codeForStatus(res.status));
    }
    try {
      return await res.json();
    } catch {
      throw new GoogleSheetsError('error');
    }
  }

  function checkId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new GoogleSheetsError('not_found');
    return encodeURIComponent(id);
  }

  async function sheetMeta(spreadsheetId: string): Promise<SheetTab[]> {
    const id = checkId(spreadsheetId);
    const json = (await api(`${id}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`)) as {
      sheets?: { properties?: { sheetId?: unknown; title?: unknown } }[];
    };
    const tabs: SheetTab[] = [];
    for (const s of json.sheets ?? []) {
      const p = s.properties;
      if (p && typeof p.sheetId === 'number' && typeof p.title === 'string') {
        tabs.push({ gid: p.sheetId, title: p.title });
      }
    }
    return tabs;
  }

  /** Whole rows fromRow..toRow (1-based, inclusive) of a tab, every cell a string. */
  async function readRange(spreadsheetId: string, tab: string, fromRow: number, toRow: number): Promise<string[][]> {
    const id = checkId(spreadsheetId);
    if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 1 || toRow < fromRow) {
      throw new GoogleSheetsError('error');
    }
    const quoted = `'${tab.replace(/'/g, "''")}'`;
    const range = encodeURIComponent(`${quoted}!${fromRow}:${toRow}`);
    const json = (await api(`${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`)) as {
      values?: unknown;
    };
    if (!Array.isArray(json.values)) return [];
    return json.values.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? '' : String(c))) : []));
  }

  return { sheetMeta, readRange, serviceAccountEmail: () => serviceAccountEmail(env) };
}

const defaultClient = createGoogleSheets();
export const sheetMeta = defaultClient.sheetMeta;
export const readRange = defaultClient.readRange;
