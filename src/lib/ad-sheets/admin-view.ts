/**
 * Batch 35 (Phase 10): what /admin/ad-sheets shows. Pure: the loader
 * (admin-server.ts) hands in plain fields; nothing here reads a lead or a row.
 *
 * One row per connected sheet. Only state, counts, dates and a short code are
 * carried: never a cell, a name, an email of a landlord, a phone, a postcode or
 * an answer. The owner is shown the way the other admin pages show owners (the
 * operator's own company name and sign-in email).
 */

export const GUIDE_DUE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface AdSheetLinkInput {
  id: string;
  ownerId: string;
  state: string;
  lastRowRead: number;
  lastImportAt: string | null;
  lastErrorCode: string | null;
  untaggedCount: number;
  rowsImported: number;
  columnsChangedAt: string | null;
}

export interface AdSheetOwnerInput {
  company: string | null;
  email: string | null;
}

export interface AdSheetAdminRow {
  linkId: string;
  ownerLabel: string;
  state: string;
  stateLabel: string;
  lastRowRead: number;
  lastImportAt: string | null;
  /** A short code only, '' when none. */
  errorCode: string;
  untaggedCount: number;
  rowsImported: number;
  columnsChangedAt: string | null;
  /** Import can be run for this sheet (it is being read). */
  canImport: boolean;
  /** Disconnect makes sense (not already disconnected). */
  canDisconnect: boolean;
}

export interface GuideStatus {
  checkedAt: string | null;
  /** Never checked, or more than 30 days ago. */
  due: boolean;
}

export interface AdSheetsAdminView {
  switchOn: boolean;
  guide: GuideStatus;
  rows: AdSheetAdminRow[];
}

export const STATE_LABELS: Record<string, string> = {
  waiting_test_row: 'Waiting for a test row',
  active: 'Active',
  error: 'Error',
  disconnected: 'Disconnected',
};

const SAFE_CODE = /^[a-z0-9_]{1,40}$/;

/** A code the page may show: lower-case letters, digits and underscores only; anything else is shown as 'error'. */
export function safeCode(raw: unknown): string {
  return typeof raw === 'string' && SAFE_CODE.test(raw) ? raw : 'error';
}

function whole(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** "Guide screenshots last checked": due when never checked, unreadable, or more than 30 days ago. */
export function guideStatus(checkedAt: string | null | undefined, now: Date): GuideStatus {
  if (!checkedAt) return { checkedAt: null, due: true };
  const t = Date.parse(checkedAt);
  if (Number.isNaN(t)) return { checkedAt: null, due: true };
  return { checkedAt, due: now.getTime() - t > GUIDE_DUE_DAYS * DAY_MS };
}

export function ownerLabel(o: AdSheetOwnerInput | undefined): string {
  if (!o) return 'Unknown operator';
  const parts = [o.company, o.email].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.length > 0 ? parts.join(' · ') : 'Unknown operator';
}

export function buildAdSheetsAdminView(input: {
  links: readonly AdSheetLinkInput[];
  owners: ReadonlyMap<string, AdSheetOwnerInput>;
  switchOn: boolean;
  guideCheckedAt: string | null;
  now: Date;
}): AdSheetsAdminView {
  const rows = input.links.map((l): AdSheetAdminRow => ({
    linkId: l.id,
    ownerLabel: ownerLabel(input.owners.get(l.ownerId)),
    state: l.state,
    stateLabel: STATE_LABELS[l.state] ?? 'Unknown',
    lastRowRead: whole(l.lastRowRead),
    lastImportAt: l.lastImportAt,
    errorCode: l.lastErrorCode ? safeCode(l.lastErrorCode) : '',
    untaggedCount: whole(l.untaggedCount),
    rowsImported: whole(l.rowsImported),
    columnsChangedAt: l.columnsChangedAt,
    canImport: l.state === 'active' || l.state === 'waiting_test_row',
    canDisconnect: l.state !== 'disconnected',
  }));
  return { switchOn: input.switchOn, guide: guideStatus(input.guideCheckedAt, input.now), rows };
}
