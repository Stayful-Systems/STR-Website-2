/**
 * A stage change on an ad lead, pushed by the lead database (Batch 55 step 2, contract section 11).
 *
 * LD maps its own pipeline stage to one of SI's `LEAD_STAGES` and pushes it so a customer never taps a stage twice.
 * This file is the decision: the body check, who the lead must belong to, the `stageAt` ordering and the
 * `meeting_reached_at` stamp. Every read and write arrives through `AdStageDeps`, so it all runs under `node --test`;
 * ad-stage-server.ts is the live wiring.
 *
 * Rules that must not drift:
 * - The lead must belong to the account's owner AND come from a calculator site. Anything else is `unknown_lead`
 *   (a site-mode lead's stage is the customer's own and never moved by the lead database).
 * - Ordering by `stageAt` against `leads.ld_stage_as_of`: newer replaces, equal is applied again, older is `stale`.
 * - `meeting_reached_at` is stamped once (Meeting booked or Signed), never cleared, as `setLeadStage` does.
 * - Only `stage`, `stage_changed_at`, `ld_stage_as_of` and `meeting_reached_at` are written: never `leads.status`
 *   or `leads.crm_pushed_at`.
 * - Nothing is logged here; the route logs a code at most.
 *
 * PURE: no network, no database, no server-only.
 */
import { isStage, type LeadStage } from '../leads/stage.ts';
import { meetingStampFor } from '../leads/meeting-stamp.ts';
import { asObject, parseLdCustomerId } from './inbound.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const LD_STAGE = /^[a-z][a-z0-9_]{0,63}$/;

export interface StageBody {
  ldCustomerId: string;
  siLeadId: string;
  stage: LeadStage;
  /** LD's own pipeline stage, kept for the record only (never written here). */
  ldStage: string | null;
  /** ISO 8601. */
  stageAt: string;
}

/** Strict check of the body. Null when anything is off; never throws. */
export function parseStageBody(raw: unknown): StageBody | null {
  const r = asObject(raw);
  if (!r) return null;
  const ldCustomerId = parseLdCustomerId(r.ld_customer_id);
  if (!ldCustomerId) return null;
  if (typeof r.si_lead_id !== 'string' || !UUID.test(r.si_lead_id)) return null;
  if (!isStage(r.stage)) return null;
  let ldStage: string | null = null;
  if (r.ld_stage !== undefined && r.ld_stage !== null) {
    if (typeof r.ld_stage !== 'string' || !LD_STAGE.test(r.ld_stage)) return null;
    ldStage = r.ld_stage;
  }
  if (typeof r.stageAt !== 'string' || !ISO.test(r.stageAt) || Number.isNaN(Date.parse(r.stageAt))) return null;
  return { ldCustomerId, siLeadId: r.si_lead_id.toLowerCase(), stage: r.stage, ldStage, stageAt: r.stageAt };
}

export interface StageLead {
  id: string;
  ownerId: string;
  /** The lead's report came from a calculator site (websites.mode = 'calculator'). */
  calculator: boolean;
  ldStageAsOf: string | null;
  meetingReachedAt: string | null;
}

export interface AdStageDeps {
  /** The owner id of the account with this lead database customer id, or null. */
  ownerOfCustomer(ldCustomerId: string): Promise<string | null>;
  /** The lead with this id under this owner, or null. */
  lead(ownerId: string, leadId: string): Promise<StageLead | null>;
  /**
   * Writes stage, stage_changed_at and ld_stage_as_of, only while ld_stage_as_of is null or not after `stageAtIso`
   * (the rule repeated in SQL). False when the filter matched nothing (a newer push landed first).
   */
  writeStage(ownerId: string, leadId: string, stage: LeadStage, stageAtIso: string): Promise<boolean>;
  /** Stamps meeting_reached_at only while it is null. */
  stampMeeting(ownerId: string, leadId: string, atIso: string): Promise<void>;
}

export type StageCode = 'applied' | 'stale' | 'bad_request' | 'unknown_customer' | 'unknown_lead' | 'server_error';

export interface StageOutcome {
  status: number;
  body: { ok: true; code: 'applied' | 'stale' } | { ok: false; code: Exclude<StageCode, 'applied' | 'stale'> };
}

/** Newer replaces, equal is applied again, older is stale. No stored time takes anything. */
export function stageIsNewer(currentIso: string | null, incomingIso: string): boolean {
  if (!currentIso) return true;
  const cur = Date.parse(currentIso);
  const inc = Date.parse(incomingIso);
  if (Number.isNaN(inc)) return false;
  if (Number.isNaN(cur)) return true;
  return inc >= cur;
}

const fail = (status: number, code: Exclude<StageCode, 'applied' | 'stale'>): StageOutcome => ({ status, body: { ok: false, code } });

export async function runStageUpdate(deps: AdStageDeps, raw: unknown): Promise<StageOutcome> {
  const input = parseStageBody(raw);
  if (!input) return fail(400, 'bad_request');
  try {
    const ownerId = await deps.ownerOfCustomer(input.ldCustomerId);
    if (!ownerId) return fail(404, 'unknown_customer');
    const lead = await deps.lead(ownerId, input.siLeadId);
    if (!lead || lead.ownerId !== ownerId || !lead.calculator) return fail(404, 'unknown_lead');
    if (!stageIsNewer(lead.ldStageAsOf, input.stageAt)) return { status: 200, body: { ok: true, code: 'stale' } };
    const at = new Date(Date.parse(input.stageAt)).toISOString();
    const wrote = await deps.writeStage(ownerId, lead.id, input.stage, at);
    if (!wrote) return { status: 200, body: { ok: true, code: 'stale' } };
    const stamp = meetingStampFor(lead.meetingReachedAt, input.stage, new Date(at));
    if (stamp) await deps.stampMeeting(ownerId, lead.id, stamp);
    return { status: 200, body: { ok: true, code: 'applied' } };
  } catch {
    return fail(500, 'server_error');
  }
}
