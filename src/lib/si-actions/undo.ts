/**
 * Batch 27: Undo's rules (Zac, 29 Sep: 24 hours, from the chat line or My
 * deals, for Keep/Pass, stage moves and profile changes; charges are never
 * undone).
 *
 * A step is put back only when what it changed is still as it left it. If
 * the member (or anything else) has changed it since, that step is left
 * alone and the eye says so: Undo never overwrites a later change.
 *
 * Pure: no network, no database, no server-only.
 */
import type { PipelineStatus } from '../listing/pipeline.ts';
import { UNDOABLE_KINDS, type StepKind, type StepStatus } from './config.ts';

/** Where a deal stood: its My deals stage (null: not there) and the member's own Keep / Pass. */
export interface StageState {
  stage: PipelineStatus | null;
  reaction: 'keep' | 'pass' | null;
  /** The member's own pipeline row for it, when there is one. */
  checkedListingId: string | null;
}

export interface UndoableStep {
  kind: StepKind;
  status: StepStatus;
  finishedAt: string | null;
  undoneAt: string | null;
  /** What it changed from (a profile change with no earlier answer has nothing to put back). */
  before?: unknown;
}

/** Whether a step can still be undone: done, an undoable kind, not undone already, inside the window. */
export function undoOpen(step: UndoableStep, now: Date, undoHours: number): boolean {
  if (!UNDOABLE_KINDS.has(step.kind) || step.status !== 'done' || step.undoneAt) return false;
  // Review: a question the member had never answered can't be "put back" (answerQuestion can't clear one), so no Undo is offered.
  if (step.kind === 'change_criteria') {
    const v = step.before && typeof step.before === 'object' ? (step.before as { value?: unknown }).value : undefined;
    if (v === undefined || v === null) return false;
  }
  const at = step.finishedAt ? Date.parse(step.finishedAt) : Number.NaN;
  return Number.isFinite(at) && now.getTime() - at <= undoHours * 60 * 60 * 1000;
}

/** When the Undo button goes (the latest finish among the steps, plus the window). */
export function undoUntil(finishedAt: readonly (string | null)[], undoHours: number): string | null {
  const times = finishedAt.map((t) => (t ? Date.parse(t) : Number.NaN)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return new Date(Math.max(...times) + undoHours * 60 * 60 * 1000).toISOString();
}

/** A stage step is still as it left it. */
export function stageUnchanged(current: StageState, after: StageState): boolean {
  return current.stage === after.stage && current.reaction === after.reaction;
}

/**
 * How a stage step is put back:
 *   'stage'          set the stage it was at (setStageForMember)
 *   'clear'          it wasn't in My deals: take back the Keep / Pass (setDealReaction null)
 *   'clear_and_row'  as 'clear', and remove the pipeline row the step made (it had none before)
 */
export function stageRestore(before: StageState, after: StageState): 'stage' | 'clear' | 'clear_and_row' {
  if (before.stage !== null) return 'stage';
  return after.checkedListingId && !before.checkedListingId ? 'clear_and_row' : 'clear';
}

/** Two stored answers are the same (key order doesn't matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

/** What Undo did, in one line: "Put back 4 of 4", "Put back 3 — 1 had changed since, so I left it". */
export function undoLine(r: { undone: number; changed: number; failed: number }): string {
  const total = r.undone + r.changed + r.failed;
  if (total === 0) return 'There was nothing to undo.';
  if (r.undone === 0) return r.changed > 0 ? 'Nothing put back: it has changed since, so I left it.' : 'I couldn’t put that back just now. Please try again.';
  const head = r.undone === total ? (total === 1 ? 'Done — put back.' : `Done — put all ${total} back.`) : `Put back ${r.undone} of ${total}.`;
  const notes: string[] = [];
  if (r.changed > 0) notes.push(`${r.changed} had changed since, so I left ${r.changed === 1 ? 'it' : 'them'}`);
  if (r.failed > 0) notes.push(`${r.failed} couldn’t be put back`);
  return notes.length > 0 ? `${head} ${notes.join('; ')}.` : head;
}

// ── Review R4 (R4-05, Zac 19 Nov 2026): the two minimum-profit figures stay separate ──

/** Both minimum-profit figures as they stood: the buying one, and the rent-to-rent one (null: the buying one stands for both). */
export interface Minimums {
  buy: number;
  r2r: number | null;
}

/** The member's two minimums now, for Undo to put back exactly. */
export function minimumsOf(goals: { finance: { targetMarginPcm: number }; r2r: { minMarginPcm: number | null } }): Minimums {
  return { buy: goals.finance.targetMarginPcm, r2r: goals.r2r.minMarginPcm };
}

/** An older member with two different minimums (from before Batch 30); a new member's one answer writes both, so they are equal. */
export function twoMinimums(m: Minimums): boolean {
  return m.r2r !== null && m.r2r !== m.buy;
}

export function isMinimums(v: unknown): v is Minimums {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.buy === 'number' && Number.isFinite(o.buy) && (o.r2r === null || (typeof o.r2r === 'number' && Number.isFinite(o.r2r)));
}

/**
 * What a minimum-profit change saves, so it writes only the figure it is about:
 *   the rent-to-rent minimum   its own question (r2r_min_profit), the buying figure untouched
 *   the minimum profit         the one answer (both figures) while they are equal; only the buying
 *                              figure ({ pcm, only: 'buy' }) when the member has two different ones
 * `before` is both figures, for Undo.
 */
export function minimumWrite(q: 'min_profit' | 'r2r_min_profit', pcm: number, goals: Parameters<typeof minimumsOf>[0]): { savedAs: 'min_profit' | 'r2r_min_profit'; value: number | { pcm: number; only: 'buy' }; before: Minimums } {
  const before = minimumsOf(goals);
  if (q === 'r2r_min_profit') return { savedAs: 'r2r_min_profit', value: pcm, before };
  return { savedAs: 'min_profit', value: twoMinimums(before) ? { pcm, only: 'buy' } : pcm, before };
}

/** The figure a saved value left on its question (a buying-only save leaves its pcm), for Undo's changed-since check. */
export function writtenValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { only?: unknown }).only === 'buy') return (v as { pcm?: unknown }).pcm;
  return v;
}

/**
 * How Undo puts a profile change back: both minimums at once through the one minimum
 * ({ buy, r2r }), when the step kept both; else the answer it kept, through the question it changed.
 */
export function restoreFor(savedAs: string, before: unknown): { questionId: string; value: unknown } {
  return isMinimums(before) ? { questionId: 'min_profit', value: { buy: before.buy, r2r: before.r2r } } : { questionId: savedAs, value: before };
}

// ── Review R4 (R4-07, R4-08, Zac 19 Nov 2026): a price ceiling and Buying cash, put back exactly ──

/** What Undo saves back for a price ceiling: the budget as it stood, none included (applyAnswer('budget', …) takes it). */
export function budgetRestoreOf(goals: { budget: string | null }): { restore: 'budget'; budget: string | null } {
  return { restore: 'budget', budget: goals.budget };
}

/**
 * What Undo saves back for a Buying cash change. The answer also writes the
 * older budget ceilings and the Buy to let band, and clears "worked out", so
 * all of those are kept and put back as they were (applyAnswer('cash_available', …)).
 */
export function cashRestoreOf(goals: { budget: string | null; buyer: { cashAvailable: string | null; cashFromBudget: boolean }; brrr: { budget: string | null }; btl: { cashBand: string | null } }): {
  restore: 'cash';
  cashAvailable: string | null;
  cashFromBudget: boolean;
  budget: string | null;
  brrrBudget: string | null;
  btlCash: string | null;
} {
  return { restore: 'cash', cashAvailable: goals.buyer.cashAvailable, cashFromBudget: Boolean(goals.buyer.cashFromBudget), budget: goals.budget, brrrBudget: goals.brrr.budget, btlCash: goals.btl.cashBand };
}
