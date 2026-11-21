/**
 * Batch 35 (Phase 7): what the "Switch to lead forms" card does, with everything
 * outside it injected (the session, the switches, the store, Google, the
 * activity log), so the rules are tested without a session, a database or
 * Google. src/app/leads/ads/sheet-actions.ts wires the real ones.
 *
 * THE RULES:
 *   - Owner only. The owner is the signed-in account owner's id from
 *     `deps.session()` (ownerIdOrNull); a team member is refused before anything
 *     is read. The browser sends a pasted link and nothing else.
 *   - Only with an approved pack, and only while both switches are on (an admin
 *     previewing skips the switches).
 *   - connectSheet checks the sheet FIRST (shared, header row readable, a name,
 *     a phone or email and a postcode column), refuses a sheet another account
 *     already linked (never saying whose; the database's unique constraint says
 *     the same thing), then saves the owner's single link as `waiting_test_row`.
 *   - checkSheet only reads. A tick for "test lead read" is the link being
 *     `active`, which only the import sets, when it reads a test row.
 *   - Mode: the ad guide and the ad links stay in WEBSITE mode until the link is
 *     `active` (connected AND a row read). Disconnect (or a link that errors)
 *     returns to website mode. Rows already read are kept.
 *   - Nothing logs or returns a sheet's contents or id; the link id is the most
 *     that is logged. Every refusal is one plain sentence (messages.ts).
 *
 * Pure: no network, no database, no server-only.
 */
import { GoogleSheetsError, type SheetTab } from './google.ts';
import { mapHeaders, type HeaderMap } from './headers.ts';
import { headersMissingMessage, sheetMessage } from './messages.ts';
import { sheetCardAvailable } from './settings.ts';
import { parseSheetLink } from './sheet-link.ts';

export type LinkState = 'waiting_test_row' | 'active' | 'error' | 'disconnected';
export type AdMode = 'website' | 'lead_form';

/** The owner's single link, as far as the connect screen needs it. */
export interface SheetLinkRecord {
  id: string;
  ownerId: string;
  spreadsheetId: string;
  tabGid: string | null;
  tabTitle: string | null;
  state: LinkState;
  activatedAt: string | null;
  lastErrorCode: string | null;
}

/** What a connect (or reconnect) writes; the store resets every counter the import keeps. */
export interface SaveLink {
  spreadsheetId: string;
  tabGid: string;
  tabTitle: string;
  headerHash: string;
  headerMap: HeaderMap['map'];
  connectedAt: string;
}

export interface ConnectStore {
  getByOwner(ownerId: string): Promise<SheetLinkRecord | null>;
  /** The owner of the link on this sheet, if any (the id only: nothing else of it leaves the store). */
  ownerOfSpreadsheet(spreadsheetId: string): Promise<string | null>;
  /** Upserts the owner's one row as waiting_test_row, resetting what the import keeps. 'taken' = the unique constraint on the sheet. */
  save(ownerId: string, row: SaveLink): Promise<{ ok: true; link: SheetLinkRecord } | { ok: false; code: 'taken' | 'db' }>;
  /** Sets state 'disconnected' on the owner's link; the rows it read stay. */
  disconnect(ownerId: string): Promise<boolean>;
}

export interface SheetGoogle {
  sheetMeta(spreadsheetId: string): Promise<SheetTab[]>;
  readRange(spreadsheetId: string, tab: string, fromRow: number, toRow: number): Promise<string[][]>;
  serviceAccountEmail(): string | null;
}

export type Session = { ok: true; ownerId: string; email: string | null; admin: boolean } | { ok: false; reason: 'signed_out' | 'member' };

export interface ConnectDeps {
  session(): Promise<Session>;
  /** ad_packs_enabled and ad_sheets_enabled. */
  switches(): Promise<{ adPacksEnabled: boolean; sheetsEnabled: boolean }>;
  /** True when the owner's pack is approved. */
  packApproved(ownerId: string): Promise<boolean>;
  store: ConnectStore;
  google: SheetGoogle;
  /** Reads the owner's own link now (the import, scoped to that link). Never throws. */
  importNow(linkId: string): Promise<void>;
  /** Records activity. Resolves when written; never rejects. */
  record(ownerId: string, kind: 'ad_sheet_connected', opts: { extras: Record<string, string | number>; dedupeKey: string }): Promise<void>;
  now(): Date;
}

/** Everything the screen is told: plain words and ticks, never an id, a sheet address or a cell. */
export interface SheetStatus {
  /** False: show nothing (not the owner, switches off, no approved pack). */
  available: boolean;
  /** The address to share the sheet with; null when the link is not set up on our side. */
  serviceEmail: string | null;
  state: 'none' | LinkState;
  mode: AdMode;
  /** Ticks. Each is true only when we confirmed it. */
  shared: boolean;
  headersFound: boolean;
  testRowRead: boolean;
  /** Plain English, e.g. "a postcode column". Empty when nothing is missing. */
  missing: string[];
  /** A sentence about what is wrong now, or null. */
  problem: string | null;
}

export type SheetState = { ok?: boolean; error?: string; notice?: string; status?: SheetStatus };

/** The one rule for the mode: lead-form mode only for a link that is active. */
export function adMode(state: 'none' | LinkState): AdMode {
  return state === 'active' ? 'lead_form' : 'website';
}

const CLOSED: SheetStatus = { available: false, serviceEmail: null, state: 'none', mode: 'website', shared: false, headersFound: false, testRowRead: false, missing: [], problem: null };

/** The screen's view of a stored link (or none). */
export function statusOfLink(link: SheetLinkRecord | null, serviceEmail: string | null): SheetStatus {
  const state: SheetStatus['state'] = link ? link.state : 'none';
  const live = link !== null && link.state !== 'disconnected';
  const unreadable = live && (link.lastErrorCode === 'not_shared' || link.lastErrorCode === 'not_found');
  return {
    available: true,
    serviceEmail,
    state,
    mode: adMode(state),
    shared: live && !unreadable,
    headersFound: live,
    testRowRead: state === 'active',
    missing: [],
    problem: state === 'error' ? sheetMessage(link?.lastErrorCode ?? 'error') : null,
  };
}

// ── The gate ──

type Gate = { ok: true; ownerId: string; admin: boolean } | { ok: false; code: string };

async function gate(deps: ConnectDeps): Promise<Gate> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, code: s.reason };
  const sw = await deps.switches();
  if (!sheetCardAvailable({ ...sw, admin: s.admin })) return { ok: false, code: 'not_available' };
  if (!(await deps.packApproved(s.ownerId))) return { ok: false, code: 'no_pack' };
  return { ok: true, ownerId: s.ownerId, admin: s.admin };
}

// ── Looking at a sheet ──

type Inspected = { ok: true; tab: SheetTab; header: HeaderMap } | { ok: false; code: string; missing?: string[] };

const codeOf = (err: unknown): string => (err instanceof GoogleSheetsError ? err.code : 'error');

/** Shared? The right tab? A header row with the columns we need? Reads only. */
async function inspect(google: SheetGoogle, spreadsheetId: string, gid: number | null): Promise<Inspected> {
  let tabs: SheetTab[];
  try {
    tabs = await google.sheetMeta(spreadsheetId);
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
  if (tabs.length === 0) return { ok: false, code: 'not_found' };
  const tab = gid === null ? tabs[0] : tabs.find((t) => t.gid === gid);
  if (!tab) return { ok: false, code: 'tab_not_found' };
  let rows: string[][];
  try {
    rows = await google.readRange(spreadsheetId, tab.title, 1, 1);
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
  const first = rows[0] ?? [];
  if (first.every((c) => String(c ?? '').trim() === '')) return { ok: false, code: 'no_headers' };
  const header = mapHeaders(first);
  if (header.missingRequired.length > 0) return { ok: false, code: 'headers_missing', missing: header.missingRequired };
  return { ok: true, tab, header };
}

function errorOf(code: string, missing?: string[]): string {
  return code === 'headers_missing' ? headersMissingMessage(missing ?? []) : sheetMessage(code);
}

// ── Connect ──

/** Step 4: the owner pastes the sheet link; we check it, then save the owner's one link as waiting for a test row. */
export async function connectSheetOp(deps: ConnectDeps, input: { link?: unknown }): Promise<SheetState> {
  const g = await gate(deps);
  if (!g.ok) return { error: sheetMessage(g.code) };
  const email = deps.google.serviceAccountEmail();
  if (email === null) return { error: sheetMessage('not_configured') };

  const parsed = typeof input.link === 'string' ? parseSheetLink(input.link) : null;
  if (!parsed) return { error: sheetMessage('bad_link') };

  // Another account's sheet is refused before Google is asked about it, and never says whose.
  const holder = await deps.store.ownerOfSpreadsheet(parsed.spreadsheetId);
  if (holder !== null && holder !== g.ownerId) return { error: sheetMessage('taken') };

  const seen = await inspect(deps.google, parsed.spreadsheetId, parsed.gid);
  if (!seen.ok) return { error: errorOf(seen.code, seen.missing) };

  const saved = await deps.store.save(g.ownerId, {
    spreadsheetId: parsed.spreadsheetId,
    tabGid: String(seen.tab.gid),
    tabTitle: seen.tab.title,
    headerHash: seen.header.hash,
    headerMap: seen.header.map,
    connectedAt: deps.now().toISOString(),
  });
  if (!saved.ok) return { error: sheetMessage(saved.code) };
  return {
    ok: true,
    notice: 'We can read your sheet. Now send a test lead from Meta.',
    status: { ...statusOfLink(saved.link, email), headersFound: true, shared: true },
  };
}

// ── Check (read only) ──

/**
 * The owner's link as it stands, for the screen and its poll. Reads only (no
 * Google call, no write) except one record-only activity line: when the caller
 * was watching and the link is now active, `ad_sheet_connected` is logged (once:
 * its key is the link and the moment it went active).
 */
export async function checkSheetOp(deps: ConnectDeps, input: { watching?: boolean } = {}): Promise<SheetStatus> {
  const g = await gate(deps);
  if (!g.ok) return CLOSED;
  const link = await deps.store.getByOwner(g.ownerId);
  const status = statusOfLink(link, deps.google.serviceAccountEmail());
  if (input.watching === true && link && link.state === 'active') {
    await deps.record(g.ownerId, 'ad_sheet_connected', { extras: { link: link.id }, dedupeKey: `ad_sheet_connected:${link.id}:${link.activatedAt ?? 'active'}` });
  }
  return status;
}

/** Step 5's "Check now": the import for the owner's own link only, then the link as it stands. */
export async function readNowOp(deps: ConnectDeps): Promise<SheetState> {
  const g = await gate(deps);
  if (!g.ok) return { error: sheetMessage(g.code) };
  const link = await deps.store.getByOwner(g.ownerId);
  if (!link || (link.state !== 'waiting_test_row' && link.state !== 'active')) return { error: sheetMessage('error'), status: statusOfLink(link, deps.google.serviceAccountEmail()) };
  await deps.importNow(link.id);
  const status = await checkSheetOp(deps, { watching: true });
  return status.testRowRead ? { ok: true, notice: 'We read your test lead. You are connected.', status } : { ok: true, notice: 'No test lead yet. Send one from Meta, wait a minute and check again.', status };
}

// ── Disconnect ──

/** Back to website mode. The rows already read, and the leads they made, stay. */
export async function disconnectSheetOp(deps: ConnectDeps): Promise<SheetState> {
  // The owner only; the switches and the pack do not matter: turning lead forms off must never trap a link on.
  const s = await deps.session();
  if (!s.ok) return { error: sheetMessage(s.reason) };
  const ok = await deps.store.disconnect(s.ownerId);
  if (!ok) return { error: sheetMessage('db') };
  const link = await deps.store.getByOwner(s.ownerId);
  return { ok: true, notice: 'Disconnected. Your ads go back to your website link.', status: statusOfLink(link, deps.google.serviceAccountEmail()) };
}
