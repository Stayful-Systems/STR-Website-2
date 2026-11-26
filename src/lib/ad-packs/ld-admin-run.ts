/**
 * Batch 55 (Part A), phase A8: the admin's two lead database ad route actions on /admin/ad-packs.
 *
 *   setAllowed   Zac's "Allowed" switch for one owner (leaddb_ad_accounts.allowed, stamped with who and when).
 *   grantRound   one more creative round for one owner, with a REQUIRED reason (ad_pack_round_grants). The reason is kept
 *                for the record and never logged or shown again.
 *
 * Every method checks the admin FIRST (the verified session user, never an argument), then validates its arguments.
 * Each success writes ONE audit line that carries ids only (the admin's id and the owner's id): never the reason, an
 * email or a name. Everything outside is injected, so a non-admin is shown to be refused before anything is read.
 *
 * Pure of server-only and the network.
 */
import { isAdminEmail } from '../admin.ts';
import { cleanGrantReason } from './round-limit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LdAdminResult {
  ok: boolean;
  message: string;
}

export const LD_NOT_ALLOWED = 'Not allowed, or something went wrong. Please try again.';
const NO_ACCOUNT = 'That owner has no lead database ad account yet, so there is nothing to change.';
const TRY_LATER = 'Could not do that just now. Nothing was changed. Please try again.';

export interface LeadDbAdminDeps {
  /** The verified session user (supabase.auth.getUser), or null. */
  currentUser: () => Promise<{ id?: string | null; email?: string | null } | null>;
  /** Defaults to isAdminEmail. */
  isAdmin?: (email: string | null | undefined) => boolean;
  /** Switch the owner's route on or off; false when the owner has no account. */
  setAllowed: (ownerId: string, allowed: boolean, adminId: string) => Promise<boolean>;
  /** Record one grant of an extra round. */
  grantRound: (ownerId: string, adminId: string, reason: string) => Promise<'granted' | 'no_account'>;
  /** One audit line. Ids only. */
  audit?: (line: string) => void;
}

export function leadDbAdminRunner(deps: LeadDbAdminDeps) {
  const isAdmin = deps.isAdmin ?? isAdminEmail;
  const audit = deps.audit ?? (() => {});

  /** The admin's id, or null for anyone else (including a user with no id). Checked before anything is read. */
  async function gate(): Promise<string | null> {
    const user = await deps.currentUser();
    if (!user || !isAdmin(user.email)) return null;
    return typeof user.id === 'string' && UUID.test(user.id) ? user.id : null;
  }

  async function setAllowed(ownerId: unknown, allowed: unknown): Promise<LdAdminResult> {
    const adminId = await gate();
    if (!adminId) return { ok: false, message: LD_NOT_ALLOWED };
    if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return { ok: false, message: 'That is not an owner.' };
    if (typeof allowed !== 'boolean') return { ok: false, message: 'Choose on or off.' };
    try {
      if (!(await deps.setAllowed(ownerId, allowed, adminId))) return { ok: false, message: NO_ACCOUNT };
    } catch {
      return { ok: false, message: TRY_LATER };
    }
    audit(`admin ${adminId} set lead database ads ${allowed ? 'allowed' : 'not allowed'} for owner ${ownerId}`);
    return { ok: true, message: allowed ? 'Allowed. This owner can now make their ads.' : 'Not allowed. This owner can no longer make ads.' };
  }

  async function grantRound(ownerId: unknown, reason: unknown): Promise<LdAdminResult> {
    const adminId = await gate();
    if (!adminId) return { ok: false, message: LD_NOT_ALLOWED };
    if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return { ok: false, message: 'That is not an owner.' };
    const why = cleanGrantReason(reason);
    if (why === null) return { ok: false, message: 'Say why you are giving an extra round. A reason is needed.' };
    try {
      if ((await deps.grantRound(ownerId, adminId, why)) === 'no_account') return { ok: false, message: NO_ACCOUNT };
    } catch {
      return { ok: false, message: TRY_LATER };
    }
    audit(`admin ${adminId} granted an extra round to owner ${ownerId}`);
    return { ok: true, message: 'Extra round given. It is used up the next time this owner makes their ads.' };
  }

  return { setAllowed, grantRound };
}

export type LeadDbAdminRunner = ReturnType<typeof leadDbAdminRunner>;
