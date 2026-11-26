/**
 * The lead database ad route's provision call (Batch 55, Part A, phase A3):
 * a lead database customer becomes a member here, gets an ad account row
 * (allowed = false) and a calculator site.
 *
 * PURE: every I/O is an injected dependency (`ProvisionDeps`), so the whole
 * decision runs under `node --test`. provision-server.ts is the live wiring.
 *
 * Rules that must not drift:
 * - Idempotent on `ld_customer_id`: a repeat is 200 `exists`, applies the
 *   pushed state, and tries the calculator site again (so a half-finished
 *   first call is finished by the retry).
 * - An existing account with the same email is linked ONLY when it is an
 *   owner (not a team member), has no OTHER lead database account, and has no
 *   Stayful website of its own (`has_website`, 409).
 * - Nothing here sends an email, writes leads.status, or logs a person's
 *   details. The one log line the caller may write carries a code.
 */
import { parseAdAccountState, type AdAccountState, type LeadDbAdAccount } from './ad-account.ts';

export interface ProvisionInput {
  ldCustomerId: string;
  email: string;
  company: string;
  phone: string | null;
  state: AdAccountState;
}

export type ProvisionCode = 'created' | 'exists' | 'bad_request' | 'has_website' | 'conflict' | 'server_error';

export interface ProvisionOutcome {
  status: number;
  body: { ok: true; code: 'created' | 'exists' } | { ok: false; code: Exclude<ProvisionCode, 'created' | 'exists'> };
}

export type EnsureSiteResult = { ok: true; slug: string; created: boolean } | { ok: false; reason: 'has_website' | 'failed' };

export interface ProvisionDeps {
  readAccountByCustomerId(ldCustomerId: string): Promise<LeadDbAdAccount | null>;
  readAccountByOwner(ownerId: string): Promise<LeadDbAdAccount | null>;
  applyState(ownerId: string, state: AdAccountState): Promise<'applied' | 'stale' | 'no_account'>;
  createAccount(input: { ownerId: string; ldCustomerId: string; state: AdAccountState }): Promise<'created' | 'exists' | 'conflict'>;
  /** The profile with this email (already lower-cased), or null. */
  findOwnerByEmail(email: string): Promise<string | null>;
  isTeamMember(userId: string): Promise<boolean>;
  /** True when the owner has a website of their own (mode 'site'). */
  hasSiteWebsite(ownerId: string): Promise<boolean>;
  /** A new login (email already confirmed) with its profile row. Null on failure. */
  createMember(email: string): Promise<string | null>;
  ensureSite(input: { ownerId: string; company: string; email: string; phone: string | null }): Promise<EnsureSiteResult>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUSTOMER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PHONE = /^[0-9+()\-.\s]{3,40}$/;

const fail = (status: number, code: Exclude<ProvisionCode, 'created' | 'exists'>): ProvisionOutcome => ({ status, body: { ok: false, code } });
const ok = (code: 'created' | 'exists'): ProvisionOutcome => ({ status: 200, body: { ok: true, code } });

/** Strict check of the request body. Null when anything is off; never throws. */
export function parseProvisionBody(raw: unknown): ProvisionInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ld_customer_id !== 'string' || !CUSTOMER_ID.test(r.ld_customer_id)) return null;
  if (typeof r.email !== 'string') return null;
  const email = r.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return null;
  if (typeof r.company !== 'string') return null;
  const company = r.company.trim();
  if (company.length < 1 || company.length > 120) return null;
  let phone: string | null = null;
  if (r.phone !== undefined && r.phone !== null) {
    if (typeof r.phone !== 'string') return null;
    const p = r.phone.trim();
    if (p.length > 0) {
      if (!PHONE.test(p)) return null;
      phone = p;
    }
  }
  const state = parseAdAccountState(r.state);
  if (!state) return null;
  return { ldCustomerId: r.ld_customer_id, email, company, phone, state };
}

export async function runProvision(deps: ProvisionDeps, input: ProvisionInput): Promise<ProvisionOutcome> {
  // 1. A repeat for the same customer: refresh the state, finish the site, answer 'exists'.
  const known = await deps.readAccountByCustomerId(input.ldCustomerId);
  if (known) return finishExisting(deps, known.ownerId, input);

  // 2. The member: an existing owner with this email, or a new login.
  let ownerId = await deps.findOwnerByEmail(input.email);
  if (ownerId) {
    if (await deps.isTeamMember(ownerId)) return fail(409, 'conflict');
    const other = await deps.readAccountByOwner(ownerId);
    // Same owner, same customer is caught above; any row here is another customer's.
    if (other) return fail(409, 'conflict');
    if (await deps.hasSiteWebsite(ownerId)) return fail(409, 'has_website');
  } else {
    ownerId = await deps.createMember(input.email);
    if (!ownerId) return fail(500, 'server_error');
  }

  // 3. The ad account (allowed = false).
  const made = await deps.createAccount({ ownerId, ldCustomerId: input.ldCustomerId, state: input.state });
  if (made === 'conflict') return fail(409, 'conflict');
  if (made === 'exists') return finishExisting(deps, ownerId, input);

  // 4. The calculator site.
  const site = await deps.ensureSite({ ownerId, company: input.company, email: input.email, phone: input.phone });
  if (!site.ok) return site.reason === 'has_website' ? fail(409, 'has_website') : fail(500, 'server_error');
  return ok('created');
}

async function finishExisting(deps: ProvisionDeps, ownerId: string, input: ProvisionInput): Promise<ProvisionOutcome> {
  await deps.applyState(ownerId, input.state);
  const site = await deps.ensureSite({ ownerId, company: input.company, email: input.email, phone: input.phone });
  // A site-mode website that appeared since is not this call's problem: the account exists.
  if (!site.ok && site.reason === 'failed') return fail(500, 'server_error');
  return ok('exists');
}
