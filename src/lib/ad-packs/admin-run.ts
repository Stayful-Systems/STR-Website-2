/**
 * Batch 38: the admin's two ad pack actions, each as a Dry run and a Run over
 * the same engine call. The server actions (app/admin/ad-packs/actions.ts)
 * hand over here; everything outside is injected, so a dry run is shown to
 * write nothing and a non-admin is shown to be refused before anything is read.
 *
 *   regenerate    rebuild one pack from the owner's CURRENT website settings
 *                 (generatePack by:'admin'). Unlimited, never counts toward
 *                 regen_count (the engine skips the operator's rules for
 *                 by:'admin'). The Run needs the token the Dry run returned and
 *                 re-reads everything, re-plans, and refuses when it no longer
 *                 matches (the website changed, or a new version was made).
 *   link missing  linkMissingLeads, optionally for one owner. Counts only:
 *                 never a lead's details, not even a lead id.
 *
 * Every method checks the admin FIRST (the verified session user's email, never
 * a value from the request), then validates its arguments.
 *
 * Pure of server-only and the network: injected.
 */
import { isAdminEmail } from '../admin.ts';
import { LINK_MISSING_LIMIT, type LinkMissingResult } from './attribution.ts';
import { generateMessage, type DryPlan, type GenerateInput, type GenerateResult } from './generate-core.ts';
import { money } from './admin-view.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Page guard ──

/** What the page does with the signed-in user: sign in, show "not found" (the pattern of the other admin pages), or show the page. */
export function pageGuard(user: { email?: string | null } | null | undefined, isAdmin: (email: string | null | undefined) => boolean = isAdminEmail): 'login' | 'not_found' | 'ok' {
  if (!user) return 'login';
  return isAdmin(user.email) ? 'ok' : 'not_found';
}

// ── Results ──

export interface RegenerateResult {
  ok: boolean;
  message: string;
  lines: string[];
  /** The Run button may now be offered (this dry run passed). */
  canRun: boolean;
  /** Returned by a passing dry run; the Run must send it back. Null otherwise. */
  token: string | null;
}

export interface LinkMissingAdminResult {
  ok: boolean;
  message: string;
  lines: string[];
  canRun: boolean;
  /** Counts only. */
  count: number;
  linked: number;
  untagged: number;
  skipped: number;
  failed: number;
}

export const NOT_ALLOWED = 'Not allowed, or something went wrong. Please try again.';

const NO_REGEN = (message: string, lines: string[] = []): RegenerateResult => ({ ok: false, message, lines, canRun: false, token: null });
const NO_LINK = (message: string): LinkMissingAdminResult => ({ ok: false, message, lines: [], canRun: false, count: 0, linked: 0, untagged: 0, skipped: 0, failed: 0 });

// ── What the regenerate rebuilds from ──

export type RegenSourceCode = 'no_pack' | 'no_site' | 'no_domain' | 'no_area' | 'unreadable';

export type RegenSource =
  | {
      ok: true;
      ownerId: string;
      /** The owner's company name, for the admin's eyes only. */
      company: string;
      /** The pack is approved now: a regenerate sends it back to "Ready to look at". */
      wasApproved: boolean;
      /** The owner's CURRENT website settings and live domain, with the pack's stored area and photos. */
      input: GenerateInput;
    }
  | { ok: false; code: RegenSourceCode };

const SOURCE_TEXT: Record<RegenSourceCode, string> = {
  no_pack: 'That pack was not found.',
  no_site: 'The operator has no website to rebuild the pack from.',
  no_domain: 'The operator’s website has no live .co.uk domain yet, so the ads would link nowhere.',
  no_area: 'This pack has no saved area yet (the first one was never made), so there is nothing to rebuild. The operator makes the first pack themselves.',
  unreadable: 'Could not read the pack or the website just now. Please try again.',
};

export interface AdPackAdminDeps {
  /** The verified session user (supabase.auth.getUser), or null. */
  currentUser: () => Promise<{ email?: string | null } | null>;
  /** Defaults to isAdminEmail. */
  isAdmin?: (email: string | null | undefined) => boolean;
  readRegenSource: (packId: string) => Promise<RegenSource>;
  generate: (req: { ownerId: string; by: 'admin'; dry: boolean; input: GenerateInput }) => Promise<GenerateResult>;
  linkMissing: (opts: { ownerId?: string; sinceApproved?: boolean; dry?: boolean }) => Promise<LinkMissingResult>;
  /** One audit line: who did what to which pack. Never a lead, a text or an address. */
  audit?: (line: string) => void;
}

/** What the Dry run's plan has to match when the Run re-plans: the brand, the version and the operator. */
export function planToken(plan: Pick<DryPlan, 'brandHash' | 'version' | 'operatorCode'>): string {
  return `${plan.brandHash.slice(0, 16)}.v${plan.version}.${plan.operatorCode}`;
}

const hex = (c: string | null | undefined) => (c && c.trim() ? c.trim() : 'none');

function sourceLines(src: Extract<RegenSource, { ok: true }>): string[] {
  const b = src.input.brand;
  return [
    `Operator: ${src.company || 'no company name'}`,
    `Rebuilt from the website as it is now: company “${b.company.trim()}”, colour ${hex(b.brandColour)}, logo ${b.logoUrl ? 'yes' : 'none (name in type only)'}, fee ${b.feePct === null || b.feePct === undefined ? 'none (no fee line)' : `${b.feePct}%`}, ${src.input.photos.length} saved photo${src.input.photos.length === 1 ? '' : 's'}, site photo ${b.photoUrl ? 'yes' : 'none'}, domain ${src.input.domain}.`,
  ];
}

function planLines(plan: DryPlan, src: Extract<RegenSource, { ok: true }>): string[] {
  const lines = sourceLines(src);
  lines.push(`Area: ${plan.areaLabel} (${plan.areaKey}), ${plan.bedrooms}-bed${plan.fellBack ? ', using the wider postcode area because the district had too few reports' : ''}.`);
  lines.push(plan.figure ? `Example figure: ${plan.figure.label}` : 'No example figure (too few reports): the ads are made without one.');
  lines.push(plan.regenerate ? `Would make version ${plan.version}. The older versions’ codes keep working.` : `Would make the first version (${plan.version}).`);
  for (const ad of plan.ads) {
    const what = ad.files.length > 0 ? `${ad.files.length} image files` : ad.video === 'coming' ? 'video coming' : 'no files';
    lines.push(`${ad.adName}: ${what}.`);
  }
  if (plan.checks.ok) {
    lines.push(`Checks: all passed${plan.checks.warnings.length ? `, ${plan.checks.warnings.length} warning${plan.checks.warnings.length === 1 ? '' : 's'}` : ''}.`);
  } else {
    lines.push(`Checks: ${plan.checks.failures.length} would fail.`);
    for (const f of plan.checks.failures.slice(0, 6)) lines.push(`  ${f.where}: ${f.detail}`);
  }
  lines.push(`Cost: ${money(plan.estimatedCostPence)} estimated; ${plan.monthSpendPence === null ? 'this month’s spend could not be read' : `${money(plan.monthSpendPence)} spent this month so far`}. An admin regenerate is unlimited and does not use the operator’s free regeneration.`);
  if (src.wasApproved) {
    lines.push('The pack is approved now. After this it goes back to “Ready to look at” until the operator approves the new version. Ads already running keep their old codes and keep linking leads.');
  }
  return lines;
}

export function adPackAdminRunner(deps: AdPackAdminDeps) {
  const isAdmin = deps.isAdmin ?? isAdminEmail;
  const audit = deps.audit ?? (() => {});

  /** The admin's email, or null for anyone else. Checked before anything is read. */
  async function gate(): Promise<string | null> {
    const user = await deps.currentUser();
    return user && isAdmin(user.email) ? String(user.email) : null;
  }

  /** Read the pack's inputs afresh and ask the engine for a dry run. Nothing is written. */
  async function plan(packId: string): Promise<{ src: Extract<RegenSource, { ok: true }>; result: GenerateResult } | { refusal: RegenerateResult }> {
    const src = await deps.readRegenSource(packId);
    if (!src.ok) return { refusal: NO_REGEN(SOURCE_TEXT[src.code]) };
    const result = await deps.generate({ ownerId: src.ownerId, by: 'admin', dry: true, input: src.input });
    return { src, result };
  }

  async function dryRegenerate(packId: unknown): Promise<RegenerateResult> {
    if (!(await gate())) return NO_REGEN(NOT_ALLOWED);
    if (typeof packId !== 'string' || !UUID.test(packId)) return NO_REGEN('That is not a pack.');
    const p = await plan(packId);
    if ('refusal' in p) return p.refusal;
    return describeDry(p.src, p.result);
  }

  function describeDry(src: Extract<RegenSource, { ok: true }>, r: GenerateResult): RegenerateResult {
    if (!r.ok) return NO_REGEN(`Dry run: ${r.message || generateMessage(r.code)}`);
    if (!r.dry) return NO_REGEN(NOT_ALLOWED); // the engine must answer a dry run with a dry result
    if (r.wouldBlock) return NO_REGEN(`Dry run: this would be refused. ${r.wouldBlock.message}`, r.plan ? planLines(r.plan, src) : sourceLines(src));
    if (!r.plan) return NO_REGEN(`Dry run: ${generateMessage('generate_failed')}`);
    const lines = planLines(r.plan, src);
    if (!r.plan.checks.ok) {
      // A checks_failed version would replace the one the operator can see with one they cannot.
      return NO_REGEN('Dry run: the checks would fail, so no pack would be made. Fix the cause (shown below) and run the dry run again.', lines);
    }
    return { ok: true, message: 'Dry run passed: nothing was changed.', lines, canRun: true, token: planToken(r.plan) };
  }

  async function runRegenerate(packId: unknown, token: unknown): Promise<RegenerateResult> {
    const adminEmail = await gate();
    if (!adminEmail) return NO_REGEN(NOT_ALLOWED);
    if (typeof packId !== 'string' || !UUID.test(packId)) return NO_REGEN('That is not a pack.');
    if (typeof token !== 'string' || token === '') return NO_REGEN('Run a dry run on this pack first.');

    // Re-validated here, from the database as it is now: never trust that the client's dry run still holds.
    const p = await plan(packId);
    if ('refusal' in p) return p.refusal;
    const dry = describeDry(p.src, p.result);
    if (!dry.canRun || dry.token === null) return { ...dry, message: dry.message.replace(/^Dry run: /, '') };
    if (dry.token !== token) {
      return NO_REGEN('The website or the pack changed since that dry run. Nothing was made: run the dry run again.', dry.lines);
    }

    const made = await deps.generate({ ownerId: p.src.ownerId, by: 'admin', dry: false, input: p.src.input });
    if (!made.ok) {
      audit(`${adminEmail} regenerate pack ${packId}: ${made.code}`);
      return NO_REGEN(made.message || generateMessage(made.code));
    }
    if (made.dry) return NO_REGEN(NOT_ALLOWED);
    audit(`${adminEmail} regenerated pack ${packId}: version ${made.version}, ${made.status}`);
    const lines = [
      `Version ${made.version}: ${made.ads.map((a) => a.code).join(', ')}.`,
      `Cost: ${money(made.costPence)}. The operator’s own regeneration count was not used (${made.regenCount} used).`,
    ];
    if (!made.checks.ok) {
      lines.push(`${made.checks.failures.length} check${made.checks.failures.length === 1 ? '' : 's'} failed.`);
      for (const f of made.checks.failures.slice(0, 6)) lines.push(`  ${f.where}: ${f.detail}`);
    }
    return {
      ok: made.status === 'preview',
      message:
        made.status === 'preview'
          ? 'Regenerated. The pack is “Ready to look at”: the operator looks at it and approves it.'
          : 'The new version failed its checks, so the operator cannot see it. See below.',
      lines,
      canRun: false,
      token: null,
    };
  }

  // ── Link missing leads ──

  /** Empty means everyone; otherwise one owner's id. Anything else is refused. */
  function scope(raw: unknown): { ok: true; ownerId?: string } | { ok: false } {
    if (raw === undefined || raw === null || raw === '') return { ok: true };
    if (typeof raw === 'string' && UUID.test(raw.trim())) return { ok: true, ownerId: raw.trim() };
    return { ok: false };
  }

  function countsOf(r: LinkMissingResult): Pick<LinkMissingAdminResult, 'count' | 'linked' | 'untagged' | 'skipped' | 'failed'> {
    return { count: r.count, linked: r.linked, untagged: r.untagged, skipped: r.skipped, failed: r.failed };
  }

  async function dryLinkMissing(ownerId?: unknown): Promise<LinkMissingAdminResult> {
    if (!(await gate())) return NO_LINK(NOT_ALLOWED);
    const s = scope(ownerId);
    if (!s.ok) return NO_LINK('That is not an operator id.');
    const r = await deps.linkMissing({ ...(s.ownerId ? { ownerId: s.ownerId } : {}), sinceApproved: true, dry: true });
    if (!r.ok) return NO_LINK('Could not look just now. Nothing was changed. Please try again.');
    const where = s.ownerId ? 'for that operator' : 'across all operators';
    const more = r.count >= LINK_MISSING_LIMIT ? ` That is the most one run handles (${LINK_MISSING_LIMIT}); run it again for the rest.` : '';
    return {
      ok: true,
      message:
        r.count === 0
          ? `Dry run: no website leads ${where} are missing their ad. Nothing was changed.`
          : `Dry run: ${r.count} website lead${r.count === 1 ? '' : 's'} ${where} with an approved pack ${r.count === 1 ? 'has' : 'have'} no ad recorded yet. Nothing was changed.${more}`,
      lines: [],
      canRun: r.count > 0,
      ...countsOf(r),
    };
  }

  async function runLinkMissing(ownerId?: unknown): Promise<LinkMissingAdminResult> {
    const adminEmail = await gate();
    if (!adminEmail) return NO_LINK(NOT_ALLOWED);
    const s = scope(ownerId);
    if (!s.ok) return NO_LINK('That is not an operator id.');
    const r = await deps.linkMissing({ ...(s.ownerId ? { ownerId: s.ownerId } : {}), sinceApproved: true, dry: false });
    if (!r.ok) return NO_LINK('Could not do that just now. Please try again.');
    audit(`${adminEmail} linked missing leads${s.ownerId ? ` for owner ${s.ownerId}` : ''}: ${r.linked} linked, ${r.untagged} no ad, ${r.skipped} skipped, ${r.failed} failed`);
    const more = r.count >= LINK_MISSING_LIMIT ? ' There may be more: run it again.' : '';
    return {
      ok: r.failed === 0,
      message: `Looked at ${r.count} lead${r.count === 1 ? '' : 's'}: ${r.linked} recorded against an ad, ${r.untagged} recorded as no ad, ${r.skipped} skipped, ${r.failed} could not be done.${more}`,
      lines: [],
      canRun: false,
      ...countsOf(r),
    };
  }

  return { dryRegenerate, runRegenerate, dryLinkMissing, runLinkMissing };
}

export type AdPackAdminRunner = ReturnType<typeof adPackAdminRunner>;
