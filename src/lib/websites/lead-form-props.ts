/**
 * Batch 31: what the public site hands the lead form. Phase 9's LeadForm.tsx
 * (a client component: two steps, attribution read from the layout-level
 * context, no browser storage) implements against this interface; the
 * templates (templates/pages.tsx) never import LeadForm itself, they take a
 * `renderForm` function and call it with these props.
 *
 * Pure types: no network, no database, no server-only.
 */
import type { LeadFormDescriptor, PageKey } from './page-model.ts';

export interface LeadFormProps {
  /** The step-1 form: fields, consent wording, post address, privacy link. */
  form: LeadFormDescriptor;
  /** The operator's name, for the form's own wording. */
  companyName: string;
  /** The block's heading, e.g. "Get your free estimate". */
  heading: string;
  /** One line under the heading. */
  intro: string;
  /** The element id the page's "get an estimate" links jump to. */
  anchorId: string;
  /** Which page the form sits on (landing-page attribution is the path only). */
  pageKey: PageKey;
  /** The page's path inside the site: "" (home), "fees", "areas/<slug>". */
  pagePath: string;
}

/** What the templates take to draw the form without knowing the component. */
export type RenderForm = (props: LeadFormProps) => import('react').ReactNode;
