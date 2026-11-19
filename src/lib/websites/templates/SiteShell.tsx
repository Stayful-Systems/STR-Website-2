/**
 * Batch 31: the frame every public page of a customer website sits in: the
 * operator's header (logo or company name, navigation), the page, and the
 * footer. Pure presentation fed by the page model: every link comes from the
 * model (which built it with siteHref), nothing here builds an address.
 *
 * Brand: the operator's colour goes on as CSS custom properties through
 * funnels/brand.ts brandCssVars, the same way a funnel page does. Every other
 * colour is pinned to a neutral light set so the site never picks up
 * Stayful's own palette or dark mode.
 *
 * The only Stayful mention is the small footer line "Powered by Stayful
 * Intelligence": no Stayful header, banner or logo.
 *
 * Server-component compatible: no hooks, no state, no client code.
 */
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { EMPTY_BRAND, brandCssVars, readableOn } from '../../funnels/brand.ts';
import type { NavLink, PageModel } from '../page-model.ts';

/** Used when the operator has not set a colour. */
export const DEFAULT_PRIMARY = '#1e3a5f';

export const POWERED_BY = 'Powered by Stayful Intelligence';

/** The label the privacy page carries in the header and footer. */
export const PRIVACY_LABEL = 'Privacy & Terms';

/** Neutral light base plus the operator's primary: the whole site's theme. */
export function siteThemeVars(site: PageModel['site']): Record<string, string> {
  const primary = site.primary ?? DEFAULT_PRIMARY;
  return {
    '--background': '#ffffff',
    '--foreground': '#111827',
    '--card': '#f8fafc',
    '--card-foreground': '#111827',
    '--muted': '#f1f5f9',
    '--muted-foreground': '#475569',
    '--border': '#e2e8f0',
    '--input': '#cbd5e1',
    '--primary': primary,
    '--primary-foreground': site.onPrimary ?? readableOn(primary),
    ...brandCssVars({ ...EMPTY_BRAND, primary: site.primary }),
  };
}

const linkClass = 'text-sm font-medium text-foreground/80 hover:text-primary focus-visible:text-primary underline-offset-4 hover:underline';

function Logo({ page }: { page: PageModel }) {
  const { site } = page;
  const home = page.nav[0]?.href ?? page.href;
  return (
    <Link href={home} className="flex items-center gap-3 text-foreground" aria-label={`${site.companyName || 'Home'}: home`}>
      {site.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- an arbitrary customer host cannot go through next/image.
        <img src={site.logoUrl} alt="" className="h-10 w-auto max-w-[10rem] object-contain" />
      ) : null}
      {site.companyName ? <span className={site.logoUrl ? 'sr-only' : 'text-lg font-semibold'}>{site.companyName}</span> : null}
    </Link>
  );
}

/** Home, Areas (a menu, no script), Fees, About, FAQ, Privacy & Terms. */
function Nav({ page }: { page: PageModel }) {
  const [home, ...rest] = page.nav;
  const privacy = page.footer[0];
  const current = (l: NavLink) => (l.href === page.href ? ('page' as const) : undefined);
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {home ? (
        <Link href={home.href} aria-current={current(home)} className={linkClass}>
          {home.label}
        </Link>
      ) : null}
      {page.areaLinks.length ? (
        <details className="relative">
          <summary className={`${linkClass} cursor-pointer list-none`}>Areas</summary>
          <ul className="absolute left-0 z-10 mt-2 min-w-[12rem] rounded-lg border border-border bg-background p-2 shadow-md">
            {page.areaLinks.map((a) => (
              <li key={a.href}>
                <Link href={a.href} aria-current={current(a)} className="block rounded px-3 py-2 text-sm text-foreground hover:bg-muted">
                  {a.label}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {rest.map((l) => (
        <Link key={l.href} href={l.href} aria-current={current(l)} className={linkClass}>
          {l.label}
        </Link>
      ))}
      {privacy ? (
        <Link href={privacy.href} aria-current={current(privacy)} className={linkClass}>
          {PRIVACY_LABEL}
        </Link>
      ) : null}
    </nav>
  );
}

export function SiteShell({ page, children }: { page: PageModel; children: ReactNode }) {
  const { site } = page;
  const privacy = page.footer[0];
  return (
    <div style={{ ...siteThemeVars(site), colorScheme: 'light' } as CSSProperties} className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
          <Logo page={page} />
          <Nav page={page} />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
      <footer className="border-t border-border bg-muted">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground">
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
              <Link href={privacy.href} className="underline underline-offset-2">
                {PRIVACY_LABEL}
              </Link>
            ) : null}
          </div>
          <p className="text-xs">{POWERED_BY}</p>
        </div>
      </footer>
    </div>
  );
}
