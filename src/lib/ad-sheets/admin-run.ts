/**
 * Batch 35 (Phase 10): the admin's ad sheet actions, each over an injected
 * engine call so a dry run is shown to write nothing and a non-admin is shown
 * to be refused before anything is read. The server actions
 * (app/admin/ad-sheets/actions.ts) hand over here.
 *
 *   import         the sheet import (runAdSheetImport), for every sheet or one
 *                  link. Dry run lists counts and writes and sends nothing.
 *   disconnect     one link to state 'disconnected' (rows and leads stay). Its
 *                  own Dry run says what would change and writes nothing.
 *   guide checked  writes now() into billing_settings.ad_sheet_guide_checked_at.
 *
 * Every method checks the admin FIRST (the verified session user's email,
 * never a value from the request), then validates its arguments. Results are
 * COUNTS and CODES only: never a cell, a name, an email, a phone, a postcode
 * or an answer. A code from the engine is shown only if it is a short
 * lower-case token.
 *
 * Pure of server-only and the network: injected.
 */
import { isAdminEmail } from '../admin.ts';
import { safeCode, STATE_LABELS } from './admin-view.ts';
import type { ImportResult, LinkImportResult } from './import.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_ALLOWED = 'Not allowed, or something went wrong. Please try again.';

export interface AdSheetAdminResult {
  ok: boolean;
  message: string;
  /** Counts and codes only. */
  lines: string[];
}

export interface AdSheetLinkState {
  id: string;
  state: string;
}

export interface AdSheetAdminDeps {
  /** The verified session user (supabase.auth.getUser), or null. */
  currentUser: () => Promise<{ email?: string | null } | null>;
  /** Defaults to isAdminEmail. */
  isAdmin?: (email: string | null | undefined) => boolean;
  /** The sheet import (src/lib/ad-sheets/import-server.ts runAdSheetImport). */
  runImport: (opts: { dry: boolean; linkId?: string }) => Promise<ImportResult>;
  /** The state of one link, or null when there is none. Reads no rows. */
  readLink: (linkId: string) => Promise<AdSheetLinkState | null>;
  /** Sets the link to 'disconnected' (rows kept). False when nothing changed. */
  disconnect: (linkId: string) => Promise<boolean>;
  /** Writes the ISO time into billing_settings ad_sheet_guide_checked_at. */
  markGuideChecked: (iso: string) => Promise<void>;
  now?: () => Date;
  /** One audit line: who did what. Never a lead, a text or an address. */
  audit?: (line: string) => void;
}

const FAIL = (message: string = NOT_ALLOWED): AdSheetAdminResult => ({ ok: false, message, lines: [] });

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** One line per sheet: a short link reference, the engine's code and its counts. Nothing else of the engine's output is copied. */
export function importLines(links: readonly LinkImportResult[], dry: boolean): string[] {
  return links.map((l) => {
    const id = typeof l.linkId === 'string' && UUID.test(l.linkId) ? l.linkId.slice(0, 8) : 'unknown';
    const verb = dry ? 'would save' : 'saved';
    return (
      `Sheet ${id}: ${l.ok ? 'ok' : 'stopped'}, code ${safeCode(l.code)}; read ${count(l.rowsRead)}, already saved ${count(l.alreadySaved)}, ${verb} ${count(l.saved)} ` +
      `(imported ${count(l.imported)}, merged ${count(l.merged)}, incomplete ${count(l.incomplete)}, test ${count(l.test)}, foreign ${count(l.foreign)}, untagged ${count(l.untagged)}); ` +
      `${l.activated ? (dry ? 'would become active' : 'became active') : 'no activation'}; columns ${l.columnsChanged ? 'changed' : 'unchanged'}.`
    );
  });
}

export function adSheetAdminRunner(deps: AdSheetAdminDeps) {
  const isAdmin = deps.isAdmin ?? isAdminEmail;
  const now = deps.now ?? (() => new Date());

  /** The signed-in admin's email, or null: checked before anything else is read or written. */
  async function admin(): Promise<string | null> {
    const user = await deps.currentUser();
    if (!user || !isAdmin(user.email)) return null;
    return user.email ?? 'admin';
  }

  return {
    /** Import for every sheet (no linkId) or one. `dry` is decided server-side by the action. */
    async importRun(opts: { dry: boolean; linkId?: string }): Promise<AdSheetAdminResult> {
      const who = await admin();
      if (!who) return FAIL();
      const dry = opts.dry === true;
      let linkId: string | undefined;
      if (opts.linkId !== undefined) {
        if (typeof opts.linkId !== 'string' || !UUID.test(opts.linkId)) return FAIL('That sheet link is not valid.');
        linkId = opts.linkId;
      }
      const res = await deps.runImport(linkId ? { dry, linkId } : { dry });
      deps.audit?.(`ad-sheets import ${dry ? 'dry' : 'run'} by ${who}${linkId ? ` link ${linkId.slice(0, 8)}` : ''}: ${safeCode(res.code)}`);
      if (res.code === 'not_configured') return { ok: false, message: 'Lead form link not available yet: the Google service account is not set up here, so nothing was read.', lines: [] };
      if (!res.ok) return { ok: false, message: `The import stopped (code ${safeCode(res.code)}). Try again in a few minutes.`, lines: importLines(res.links, dry) };
      const lines = importLines(res.links, dry);
      const n = res.links.length;
      return {
        ok: true,
        message: dry
          ? `Dry run: ${n} sheet${n === 1 ? '' : 's'} checked. Nothing was written or sent.`
          : `Import run: ${n} sheet${n === 1 ? '' : 's'} read.`,
        lines: n === 0 ? ['No sheet is being read just now (only active sheets, or ones waiting for a test row, are).'] : lines,
      };
    },

    /** Disconnect one link. Dry: says what would change and writes nothing. */
    async disconnect(opts: { linkId: string; dry: boolean }): Promise<AdSheetAdminResult> {
      const who = await admin();
      if (!who) return FAIL();
      if (typeof opts.linkId !== 'string' || !UUID.test(opts.linkId)) return FAIL('That sheet link is not valid.');
      const link = await deps.readLink(opts.linkId);
      if (!link) return FAIL('That sheet was not found.');
      if (link.state === 'disconnected') return { ok: true, message: 'Already disconnected. Nothing to change.', lines: [] };
      const from = STATE_LABELS[link.state] ?? 'Unknown';
      if (opts.dry === true) {
        return {
          ok: true,
          message: 'Dry run: nothing was written.',
          lines: [`Would change: state ${from} → Disconnected.`, 'Rows already read and the leads they made are kept.', 'The operator’s ads go back to the website link; the sheet is no longer read.'],
        };
      }
      const changed = await deps.disconnect(opts.linkId);
      deps.audit?.(`ad-sheets disconnect by ${who} link ${opts.linkId.slice(0, 8)}: ${changed ? 'done' : 'unchanged'}`);
      if (!changed) return FAIL('Could not disconnect just now. Please try again.');
      return { ok: true, message: 'Disconnected.', lines: [`State ${from} → Disconnected. Rows kept.`] };
    },

    /** "Mark checked": writes now() into the guide-checked setting. Dry writes nothing. */
    async markGuideChecked(opts: { dry: boolean }): Promise<AdSheetAdminResult> {
      const who = await admin();
      if (!who) return FAIL();
      const at = now().toISOString();
      if (opts.dry === true) return { ok: true, message: 'Dry run: nothing was written.', lines: [`Would record the guide screenshots as checked at ${at}.`] };
      await deps.markGuideChecked(at);
      deps.audit?.(`ad-sheets guide marked checked by ${who}`);
      return { ok: true, message: 'Marked checked.', lines: [] };
    },
  };
}

export type AdSheetAdminRunner = ReturnType<typeof adSheetAdminRunner>;
