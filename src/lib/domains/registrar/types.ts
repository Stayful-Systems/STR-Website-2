/**
 * Batch 33: what a domain registrar must be able to do. Openprovider is the
 * real one (openprovider.ts); fake.ts is the in-memory one the tests (and a
 * dry local run) use. Nothing outside src/lib/domains imports any of this.
 *
 * Every failure is a RegistrarError with one of four codes:
 *   taken           the name is not available (somebody else holds it)
 *   unclear         a timeout, a dropped connection or a 5xx: the call may or
 *                   may not have happened. NEVER treated as "taken", and
 *                   never retried blind: ask findOwned first.
 *   refused         the registrar said no (bad input, not GBP, premium, ...)
 *   not_configured  no registrar is set up (DOMAINS_REGISTRAR unset, fake in
 *                   production, credentials missing)
 * The message is the code and an HTTP status, never a response body, a header
 * or a credential: it may be stored and logged (the plan's issue 15).
 *
 * Pure types and one error class: no network, no database, no server-only.
 */

export type RegistrarErrorCode = 'taken' | 'unclear' | 'refused' | 'not_configured';

export class RegistrarError extends Error {
  readonly code: RegistrarErrorCode;
  readonly status: number | null;
  constructor(code: RegistrarErrorCode, status: number | null = null) {
    super(status === null ? `registrar:${code}` : `registrar:${code}:${status}`);
    this.name = 'RegistrarError';
    this.code = code;
    this.status = status;
  }
}

export function isRegistrarError(e: unknown): e is RegistrarError {
  return e instanceof RegistrarError;
}

export interface Availability {
  name: string;
  available: boolean;
  /** A premium-priced name: never bought. */
  premium: boolean;
  /** The first year's price in pence, GBP only. Null when the name is not available. */
  pricePence: number | null;
}

/** A DNS record on the root ('@') or www. */
export interface DnsRecord {
  type: 'A' | 'CNAME';
  /** '@' for the root, 'www' for the www host. */
  host: '@' | 'www';
  value: string;
  ttl?: number;
}

export interface OwnedDomain {
  ref: string;
  /** ISO timestamp, or null when the registrar did not say. */
  expiresAt: string | null;
  autoRenew: boolean | null;
}

export interface Registrar {
  /** 'openprovider' | 'fake': stored on website_domains.registrar. */
  readonly id: string;
  /** Availability and GBP price for each name, in the order given. A non-GBP price is a `refused` error. */
  check(names: readonly string[]): Promise<Availability[]>;
  /** Is this name already ours in the registrar's account? Null when it is not. */
  findOwned(name: string): Promise<OwnedDomain | null>;
  /** Register for one year, auto-renew off, owner = Stayful's handle. Throws `taken` when it is gone. */
  register(name: string, opts: { ownerHandle: string }): Promise<{ ref: string; expiresAt: string | null }>;
  /** Replace the zone's A / CNAME records at the root and www. */
  setDns(name: string, records: readonly DnsRecord[]): Promise<void>;
  setAutoRenew(name: string, on: boolean): Promise<void>;
  /** Renew for one year: the new expiry. */
  renew(name: string): Promise<{ expiresAt: string }>;
  info(name: string): Promise<OwnedDomain | null>;
  /** Batch 37 (moving a domain to the member's own registrar). */
  changeIpsTag(name: string, tag: string): Promise<void>;
  /** Batch 37: the domain's transfer (auth) code. Absent or unreadable: `refused` (a manual step). Never logged or stored. */
  transferCode(name: string): Promise<string>;
}
