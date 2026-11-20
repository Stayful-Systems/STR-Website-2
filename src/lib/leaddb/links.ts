/**
 * Connecting an operator's Stayful Intelligence account to their lead database
 * account (Batch 32): start (the lead database emails a 6-digit code to the
 * customer's login email), confirm, revoke, and "send a test lead".
 *
 * Scoped to the OWNER: every function takes the owner's id (the caller got it
 * from `ownerIdOrNull`, which is null for a team member). The owner's id is
 * the `si_member_id` the lead database knows them by.
 *
 * The code is checked by the lead database and never stored here. Nothing the
 * lead database says is shown as it came: codes become sentences in
 * messages.ts.
 *
 * Pure of Next and the database (the store and the client are injected), so
 * it runs under `node --test`. The real store lives in store.ts.
 */
import { leadDbConfirm, leadDbPushLead, leadDbRevoke, leadDbStart, type LeadDbResult, type WebsiteLeadReply } from './client.ts';
import { buildTestBody } from './payload.ts';

export interface LinkRecord {
  owner_id: string;
  link_id: string | null;
  email: string;
  lead_type: 'management' | 'guaranteed_rent' | null;
  status: 'code_sent' | 'active' | 'revoked' | 'error';
  connected_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface LinkStore {
  get(ownerId: string): Promise<LinkRecord | null>;
  saveCodeSent(ownerId: string, linkId: string, email: string): Promise<void>;
  saveActive(ownerId: string, leadType: 'management' | 'guaranteed_rent'): Promise<void>;
  saveRevoked(ownerId: string): Promise<void>;
  saveError(ownerId: string, code: string): Promise<void>;
}

export interface LinkDeps {
  store: LinkStore;
  start: typeof leadDbStart;
  confirm: typeof leadDbConfirm;
  revoke: typeof leadDbRevoke;
  push: typeof leadDbPushLead;
  randomId: () => string;
}

export const realLinkClient = { start: leadDbStart, confirm: leadDbConfirm, revoke: leadDbRevoke, push: leadDbPushLead };

export interface LinkOutcome {
  ok: boolean;
  /** Short code for messages.ts. */
  code: string;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Asks the lead database to email a code. Nothing about the customer comes back. */
export async function startLink(ownerId: string, rawEmail: string, deps: LinkDeps): Promise<LinkOutcome> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) return { ok: false, code: 'bad_request' };
  const res = await deps.start({ si_member_id: ownerId, email });
  if (!res.ok || !res.data?.link_id) return { ok: false, code: res.ok ? 'bad_request' : res.code };
  // A fresh start replaces any earlier row: until the new code is confirmed nothing is pushed.
  await deps.store.saveCodeSent(ownerId, res.data.link_id, email);
  return { ok: true, code: 'code_sent' };
}

/** Checks the code the owner typed. On success the link is active and earlier "no link" failures are retried. */
export async function confirmLink(ownerId: string, rawCode: string, deps: LinkDeps): Promise<LinkOutcome> {
  const code = rawCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false, code: 'wrong_code' };
  const link = await deps.store.get(ownerId);
  if (!link || link.status !== 'code_sent' || !link.link_id) return { ok: false, code: 'unknown_link' };
  const res = await deps.confirm({ link_id: link.link_id, si_member_id: ownerId, code });
  if (!res.ok || !res.data) return { ok: false, code: res.code };
  await deps.store.saveActive(ownerId, res.data.lead_type);
  return { ok: true, code: 'confirmed' };
}

/**
 * Disconnects. The local link is revoked whatever the lead database says: an
 * operator who clicks Disconnect must stop sending at once, and the other side
 * is told best-effort (it never deletes, it stamps revoked_at).
 */
export async function revokeLink(ownerId: string, deps: LinkDeps): Promise<{ ok: true; remote: boolean }> {
  const link = await deps.store.get(ownerId);
  if (!link) return { ok: true, remote: false };
  await deps.store.saveRevoked(ownerId);
  const res = await deps.revoke({ si_member_id: ownerId });
  return { ok: true, remote: res.ok };
}

/** "Send a test lead": one clearly labelled lead, no landlord's details. Needs an active link. */
export async function testPush(ownerId: string, deps: LinkDeps): Promise<LinkOutcome & { reply?: WebsiteLeadReply }> {
  const link = await deps.store.get(ownerId);
  if (!link || link.status !== 'active') return { ok: false, code: 'not_linked' };
  const res: LeadDbResult<WebsiteLeadReply> = await deps.push(buildTestBody(ownerId, deps.randomId()));
  if (!res.ok || !res.data) {
    if (res.code === 'not_linked' || res.code === 'no_product') await deps.store.saveError(ownerId, res.code);
    return { ok: false, code: res.code };
  }
  return { ok: true, code: 'ok', reply: res.data };
}
