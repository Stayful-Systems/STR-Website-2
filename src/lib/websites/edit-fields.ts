/**
 * Batch 36: the fields of one page of copy, as the edit screen shows them, and
 * putting edited values back into a SiteCopy. Pure: no network, no database,
 * no server-only, so the screen and the tests share it.
 *
 * The screen edits one page at a time (a rewritten page the operator wants to
 * change before approving it). Every value goes back through sanitiseCopy on
 * the server, so a hand-built value is bounded and trimmed there.
 */
import { pageRefKey, type PageRef } from './edit-rules.ts';
import type { SiteCopy } from './page-model.ts';

export interface PageField {
  /** The form field's name, e.g. "headline", "benefit.1.body". */
  name: string;
  label: string;
  multiline: boolean;
  value: string;
}

const f = (name: string, label: string, value: string, multiline = false): PageField => ({ name, label, multiline, value });

/** The words for a page in a sentence: "home", "fees", "York" (an area). */
export function pageLabel(ref: PageRef, areaName?: string): string {
  if (ref.page === 'area') return areaName || ref.area || 'area';
  return ref.page === 'faq' ? 'FAQ' : ref.page;
}

/** The editable fields of a page. An area that has no block yet has empty ones. */
export function pageFieldsOf(copy: SiteCopy, ref: PageRef): PageField[] {
  switch (ref.page) {
    case 'home':
      return [
        f('headline', 'Headline', copy.home.headline),
        f('subheadline', 'Sub-headline', copy.home.subheadline),
        f('intro', 'Introduction', copy.home.intro, true),
        ...copy.home.benefits.flatMap((b, i) => [f(`benefit.${i}.title`, `Benefit ${i + 1} title`, b.title), f(`benefit.${i}.body`, `Benefit ${i + 1} text`, b.body, true)]),
      ];
    case 'area': {
      const a = copy.areas.find((x) => x.area.toLowerCase() === (ref.area ?? '').toLowerCase());
      return [f('headline', 'Headline', a?.headline ?? ''), f('body', 'Text', a?.body ?? '', true)];
    }
    case 'fees':
      return [f('headline', 'Headline', copy.fees.headline), f('body', 'Text', copy.fees.body, true), f('includes', 'What is included (one per line)', copy.fees.includes.join('\n'), true)];
    case 'about':
      return [f('headline', 'Headline', copy.about.headline), f('body', 'Text', copy.about.body, true)];
    case 'faq':
      return [f('headline', 'Headline', copy.faq.headline), ...copy.faq.items.flatMap((q, i) => [f(`faq.${i}.question`, `Question ${i + 1}`, q.question), f(`faq.${i}.answer`, `Answer ${i + 1}`, q.answer, true)])];
  }
}

const valueOf = (values: Record<string, string>, name: string, fallback: string): string => (typeof values[name] === 'string' ? values[name] : fallback);

/** A new copy with this page's values replaced; fields not in `values` keep what they were. The input is not changed. */
export function applyPageFields(copy: SiteCopy, ref: PageRef, values: Record<string, string>): SiteCopy {
  const next: SiteCopy = structuredClone(copy);
  switch (ref.page) {
    case 'home':
      next.home.headline = valueOf(values, 'headline', next.home.headline);
      next.home.subheadline = valueOf(values, 'subheadline', next.home.subheadline);
      next.home.intro = valueOf(values, 'intro', next.home.intro);
      next.home.benefits = next.home.benefits.map((b, i) => ({ title: valueOf(values, `benefit.${i}.title`, b.title), body: valueOf(values, `benefit.${i}.body`, b.body) }));
      break;
    case 'area': {
      const i = next.areas.findIndex((x) => x.area.toLowerCase() === (ref.area ?? '').toLowerCase());
      if (i >= 0) next.areas[i] = { ...next.areas[i], headline: valueOf(values, 'headline', next.areas[i].headline), body: valueOf(values, 'body', next.areas[i].body) };
      break;
    }
    case 'fees':
      next.fees.headline = valueOf(values, 'headline', next.fees.headline);
      next.fees.body = valueOf(values, 'body', next.fees.body);
      next.fees.includes = typeof values.includes === 'string' ? values.includes.split('\n').map((s) => s.trim()).filter(Boolean) : next.fees.includes;
      break;
    case 'about':
      next.about.headline = valueOf(values, 'headline', next.about.headline);
      next.about.body = valueOf(values, 'body', next.about.body);
      break;
    case 'faq':
      next.faq.headline = valueOf(values, 'headline', next.faq.headline);
      next.faq.items = next.faq.items.map((q, i) => ({ question: valueOf(values, `faq.${i}.question`, q.question), answer: valueOf(values, `faq.${i}.answer`, q.answer) }));
      break;
  }
  return next;
}

/** The page key (edit-rules pageRefKey) for a ref, for a form's hidden field or a React key. */
export const keyOf = (ref: PageRef): string => pageRefKey(ref);
