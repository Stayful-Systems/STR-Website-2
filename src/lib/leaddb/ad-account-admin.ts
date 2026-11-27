/**
 * Batch 55 (Part A), phase A8: what /admin/ad-packs shows about each lead database ad account. States and flags only:
 * never an email, a name or a cell. Plain English labels.
 *
 * Pure: no I/O, no Next, no server-only (runs under `node --test`). The read is `listAdAccounts` in ad-account-server.ts.
 */
import { adRouteVerdict, type AdRouteStopReason, type LeadDbAdAccount } from './ad-account.ts';

export interface AdAccountAdminRow {
  ownerId: string;
  allowed: boolean;
  /** When Zac last switched "Allowed" on or off (ISO), or null when never. */
  allowedAt: string | null;
  cardOnFile: boolean;
  /** The lead database's account state in plain words ("Active", "Paused", "Cancelling", "Past due", "Cancelled", "Lapsed", "Not sent yet", "Other"). */
  accountLabel: string;
  /** The date a scheduled cancellation takes effect (ISO), or null. */
  cancelEffectiveAt: string | null;
  lapsed: boolean;
  /** When the lead database said this state was true (ISO), or null when no state has ever arrived. */
  stateAsOf: string | null;
  /** Whether the route is open for this owner right now, and if not, why in a few words. */
  routeOpen: boolean;
  routeReason: string | null;
  /** Round grants not used yet. */
  unusedRounds: number;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  pending_cancel: 'Cancelling',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  lapsed: 'Lapsed',
};

/** The account state as a short plain label. An unrecognised value reads "Other" (the raw text is never shown). */
export function accountLabel(status: string | null, hasState: boolean): string {
  if (!hasState) return 'Not sent yet';
  const key = status?.trim().toLowerCase() ?? '';
  if (key === '') return 'Not sent yet';
  return STATUS_LABELS[key] ?? 'Other';
}

const REASONS: Record<AdRouteStopReason, string> = {
  no_account: 'No account',
  account_stopped: 'Account stopped',
  no_card: 'No card on file',
  unpaid_hold: 'Unpaid hold',
  not_allowed: 'Not allowed yet',
};

export function adAccountAdminRow(account: LeadDbAdAccount, allowedAt: string | null, unusedRounds: number, now: Date): AdAccountAdminRow {
  const verdict = adRouteVerdict(account, now);
  return {
    ownerId: account.ownerId,
    allowed: account.allowed,
    allowedAt,
    cardOnFile: account.cardOnFile,
    accountLabel: accountLabel(account.accountStatus, account.stateAsOf !== null),
    cancelEffectiveAt: account.cancelEffectiveAt ? account.cancelEffectiveAt.toISOString() : null,
    lapsed: account.lapsed,
    stateAsOf: account.stateAsOf ? account.stateAsOf.toISOString() : null,
    routeOpen: verdict.ok,
    routeReason: verdict.ok ? null : REASONS[verdict.reason],
    unusedRounds: Math.max(0, Math.trunc(unusedRounds)),
  };
}
