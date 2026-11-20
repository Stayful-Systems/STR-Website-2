/**
 * Batch 33: the admin's domain actions, each as a Dry run and a Run over the
 * same engine call. The server actions (app/admin/management/domain-actions.ts)
 * check the admin first and then hand over here; everything outside is injected,
 * so a dry run is shown to write and call nothing.
 *
 *   buy        a domain awaiting the admin (auto-buy is off)
 *   retry      a failed domain, bought or not
 *   release    Vercel first, then the site's address, then auto-renew off
 *   renew      renew it now (records the decision)
 *   dont_renew record the decision: it lapses at expiry
 *   settings   the three DOMAIN_KEYS settings, checked by checkDomainSetting
 *
 * A dry run returns the steps and what it would spend and does nothing else:
 * the engine's own dryRun flag never reaches the registrar, Vercel, the store's
 * writes or an email.
 *
 * Pure of server-only and the network: injected.
 */
import { money, type AdminKind } from './admin-view.ts';
import { checkDomainSetting, DOMAIN_KEYS, type DomainSettings } from './settings.ts';
import type { DomainEngine, RunResult } from './purchase-server.ts';

export interface AdminResult {
  ok: boolean;
  message: string;
  lines: string[];
  /** The Run button may now be offered (this dry run passed). */
  canRun: boolean;
}

export interface AdminDeps {
  engine: DomainEngine;
  readSettings: () => Promise<DomainSettings>;
  writeSetting: (key: string, value: boolean | number) => Promise<boolean>;
  adminId: string | null;
}

const KINDS: readonly AdminKind[] = ['buy', 'retry', 'release', 'renew', 'dont_renew'];
export const isAdminKind = (v: unknown): v is AdminKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);

const OUTCOME_TEXT: Record<string, string> = {
  registered: 'Bought. It is now connecting.',
  already_owned: 'Stayful already owned it: recorded as bought. It is now connecting.',
  held_cap: 'The daily spend cap stopped it. It is tried again the next UK day.',
  needs_choice: 'The name is gone or too dear. Nothing was spent; the member picks again.',
  retry_later: 'It did not go through this time. It will be tried again.',
  failed: 'It failed again. Check the error and Retry.',
  waiting_admin: 'Auto-buy is off: nothing happens until you press Buy.',
  not_configured: 'Buying is not set up (DOMAINS_REGISTRAR, the Openprovider login, the owner handle).',
  bad_status: 'It is not in a state this can be done from.',
  busy: 'Something else is already working on it.',
  not_found: 'That domain was not found.',
  released: 'Released.',
  vercel_failed: 'Vercel refused, so nothing else was touched. Try Release again.',
  registrar_failed: 'The registrar did not turn auto-renew off. Try Release again.',
  renewed: 'Renewed for a year.',
  renewed_charged: 'Renewed for a year, and the member was charged.',
  renewed_unpaid: 'Renewed for a year. The charge could not be taken (short balance) and is recorded as unpaid.',
  no_price: 'There is no recorded price to renew at.',
  live: 'Connected and live.',
  waiting: 'Connecting: still waiting (DNS, verification or HTTPS).',
  dont_renew: 'Recorded: it will not be renewed and lapses at expiry.',
  renew: 'Recorded: it will be renewed.',
};

const text = (outcome: string) => OUTCOME_TEXT[outcome] ?? 'Done.';

function dryResult(r: RunResult): AdminResult {
  const cost = r.costPence ? ` It would spend ${money(r.costPence)}.` : '';
  return {
    ok: r.ok,
    message: r.ok ? `Dry run passed: nothing was changed.${cost}` : `Dry run: ${text(r.outcome)}`,
    lines: (r.steps ?? []).map((s) => `${s.step}: ${s.detail}`),
    canRun: r.ok && r.outcome === 'dry_run',
  };
}

function runResult(r: RunResult): AdminResult {
  return { ok: r.ok, message: text(r.outcome), lines: [], canRun: false };
}

export function adminRunner(deps: AdminDeps) {
  const { engine } = deps;

  async function dryRun(kind: AdminKind, id: string): Promise<AdminResult> {
    switch (kind) {
      case 'buy':
        return dryResult(await engine.buy(id, { dryRun: true, admin: true }));
      case 'retry':
        return dryResult(await engine.retry(id, { dryRun: true }));
      case 'release':
        return dryResult(await engine.release(id, { dryRun: true }));
      case 'renew':
        return dryResult(await engine.renew(id, { dryRun: true }));
      case 'dont_renew':
        return dryResult(await engine.decideRenewal(id, 'dont_renew', deps.adminId, { dryRun: true }));
    }
  }

  async function run(kind: AdminKind, id: string): Promise<AdminResult> {
    switch (kind) {
      case 'buy':
        return runResult(await engine.buy(id, { admin: true }));
      case 'retry':
        return runResult(await engine.retry(id));
      case 'release':
        return runResult(await engine.release(id));
      case 'renew': {
        // The admin's decision first (so the 7-day rule leaves it alone), then the renewal itself.
        const decided = await engine.decideRenewal(id, 'renew', deps.adminId);
        if (!decided.ok) return runResult(decided);
        return runResult(await engine.renew(id));
      }
      case 'dont_renew':
        return runResult(await engine.decideRenewal(id, 'dont_renew', deps.adminId));
    }
  }

  async function dryRunSetting(key: string, raw: unknown): Promise<AdminResult> {
    const checked = checkDomainSetting(key, raw);
    if (!checked) return { ok: false, message: 'That value is not allowed.', lines: [], canRun: false };
    const now = await deps.readSettings();
    const was = key === DOMAIN_KEYS.chargeOn ? now.chargeOn : key === DOMAIN_KEYS.autoBuy ? now.autoBuy : now.dailySpendCapPence;
    const show = (v: boolean | number) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : money(v));
    if (was === checked.value) return { ok: true, message: `No change: it is already ${show(was)}.`, lines: [], canRun: false };
    const lines = [`${key}: ${show(was)} -> ${show(checked.value)}`];
    if (key === DOMAIN_KEYS.chargeOn && checked.value === true) lines.push('Turning this on charges members for the SECOND year of a domain onwards, equal to its cost. The first year is always free.');
    if (key === DOMAIN_KEYS.autoBuy && checked.value === false) lines.push('Purchases will wait for you to press Buy.');
    if (key === DOMAIN_KEYS.dailySpendCapPence && checked.value === 0) lines.push('A cap of £0 stops all buying and renewing.');
    return { ok: true, message: 'Dry run passed: nothing was changed.', lines, canRun: true };
  }

  async function saveSetting(key: string, raw: unknown): Promise<AdminResult> {
    const checked = checkDomainSetting(key, raw);
    if (!checked) return { ok: false, message: 'That value is not allowed.', lines: [], canRun: false };
    const ok = await deps.writeSetting(checked.key, checked.value);
    return { ok, message: ok ? 'Saved.' : 'Could not save that. Please try again.', lines: [], canRun: false };
  }

  return { dryRun, run, dryRunSetting, saveSetting };
}
