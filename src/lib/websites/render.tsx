import type { ReactNode } from 'react';
import { LeadForm } from './LeadForm';
import type { RenderForm } from './lead-form-props';
import { buildSitePages, pageAt, type PageModel, type SiteCopy, type SiteSettings } from './page-model';
import { SitePage } from './templates/pages';
import type { SiteRef } from './types';

/**
 * Batch 31: the one way a customer website is drawn, shared by the public
 * routes (src/app/s/[slug]/**) and Phase 10's setup preview, so the preview is
 * the same components with the same copy and the same form.
 *
 * Server-component compatible: no hooks, no browser APIs. LeadForm is a client
 * component; `renderForm` is called on the server by the templates, and what it
 * returns is the client element.
 *
 *   leadFormRenderer({ preview })   the `renderForm` slot the templates take.
 *                                   preview: the form is drawn but sends nothing.
 *   sitePagesOf(site, settings, copy)  the page model list (null while there is no copy yet)
 *   renderSitePage(...)             one page of a site as an element, or null for a path that
 *                                   is not one of its pages (the caller 404s)
 */

/** The templates' `renderForm` slot, backed by the real two-step form. */
export function leadFormRenderer(opts: { preview?: boolean } = {}): RenderForm {
  const preview = opts.preview === true;
  return function renderLeadForm(props) {
    return <LeadForm {...props} preview={preview} />;
  };
}

/** Every page of the site, or null when there is no copy to build from. */
export function sitePagesOf(site: SiteRef, settings: SiteSettings, copy: SiteCopy | null): PageModel[] | null {
  if (!copy) return null;
  return buildSitePages({ site, settings, copy });
}

/** One page by its path inside the site ("", "fees", "areas/york"), drawn in the operator's shell. */
export function renderSitePage(pages: readonly PageModel[], path: string, opts: { preview?: boolean } = {}): ReactNode | null {
  const page = pageAt(pages, path);
  if (!page) return null;
  return <SitePage page={page} renderForm={leadFormRenderer(opts)} />;
}
