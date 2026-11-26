/**
 * Batch 55 (Part A), phase A4: the calculator-only site's page. The operator's
 * brand and ONE thing: the income form and, after it, the report the form
 * already streams. No navigation to other pages, no page copy blocks, no
 * about / fees / FAQ / areas.
 *
 * It reuses the website's own pieces: siteThemeVars, the same LeadForm (through
 * `renderForm`, so step 1, step 2 and the report are exactly the website's) and
 * the same privacy page body. The only other page a calculator site has is the
 * privacy page the consent tick links to.
 *
 * Server-component compatible: no hooks, no state, no client code.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { PageModel } from '../page-model.ts';
import { FORM_ANCHOR, PrivacyPage, type SitePageProps } from './pages.tsx';
import { POWERED_BY, PRIVACY_LABEL, siteThemeVars } from './SiteShell.tsx';

/** The fixed heading: wording of ours, never stored copy. */
export const CALCULATOR_HEADING = 'What could your property earn as a short-term let?';

function Brand({ page }: { page: PageModel }) {
  const { site } = page;
  return (
    <div className="flex items-center gap-3 text-foreground">
      {site.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- an arbitrary customer host cannot go through next/image.
        <img src={site.logoUrl} alt="" className="h-10 w-auto max-w-[10rem] object-contain" />
      ) : null}
      {site.companyName ? <span className={site.logoUrl ? 'sr-only' : 'text-lg font-semibold'}>{site.companyName}</span> : null}
    </div>
  );
}

/** The branded frame: a header with the logo or name (no links), the page, a footer with the contact details and the privacy link. */
export function CalculatorShell({ page, children }: { page: PageModel; children: ReactNode }) {
  const { site } = page;
  const privacy = page.footer[0];
  return (
    <div style={{ ...siteThemeVars(site), colorScheme: 'light' } as CSSProperties} className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-4">
          <Brand page={page} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
      <footer className="border-t border-border bg-muted">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              {site.companyName ? <p className="font-semibold text-foreground">{site.companyName}</p> : null}
              {site.contactEmail ? (
                <p>
                  <a href={`mailto:${site.contactEmail}`} className="underline underline-offset-2">
                    {site.contactEmail}
                  </a>
                </p>
              ) : null}
              {site.contactPhone ? (
                <p>
                  {site.phoneTel ? (
                    <a href={`tel:${site.phoneTel}`} className="underline underline-offset-2">
                      {site.contactPhone}
                    </a>
                  ) : (
                    site.contactPhone
                  )}
                </p>
              ) : null}
            </div>
            {privacy ? (
              <a href={privacy.href} className="underline underline-offset-2">
                {PRIVACY_LABEL}
              </a>
            ) : null}
          </div>
          <p className="text-xs">{POWERED_BY}</p>
        </div>
      </footer>
    </div>
  );
}

/** The calculator itself: the heading, one line, and the website's form. `page` is the model's home page (it carries the form). */
export function CalculatorPage({ page, renderForm }: SitePageProps) {
  const company = page.site.companyName;
  return (
    <CalculatorShell page={page}>
      <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{CALCULATOR_HEADING}</h1>
      <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
        {company ? `Tell ${company} about your property and get a free income estimate.` : 'Tell us about your property and get a free income estimate.'}
      </p>
      {page.form ? (
        <section id={FORM_ANCHOR} className="mt-8 scroll-mt-6 rounded-2xl border border-border bg-card p-6 text-card-foreground">
          {renderForm({
            form: page.form,
            companyName: company,
            heading: 'Get your free estimate',
            intro: company ? `Tell ${company} where to send it. It takes a minute.` : 'Tell us where to send it. It takes a minute.',
            anchorId: `${FORM_ANCHOR}-form`,
            pageKey: page.key,
            pagePath: page.path,
          })}
        </section>
      ) : null}
    </CalculatorShell>
  );
}

/** The privacy page, in the same frame (the website's own body, no navigation). */
export function CalculatorPrivacy({ page, renderForm }: SitePageProps) {
  return (
    <CalculatorShell page={page}>
      <PrivacyPage page={page} renderForm={renderForm} />
    </CalculatorShell>
  );
}
