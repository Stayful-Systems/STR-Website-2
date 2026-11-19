/**
 * Batch 31: the public pages of a customer website, as pure components fed by
 * the page model (buildSitePages). What is drawn is exactly the text the
 * checks read (pageFields), plus the privacy page's own fixed wording below.
 *
 * Every link comes from the model, which built it with siteHref. The lead
 * form is a client component written in Phase 9; it is never imported here.
 * The caller passes `renderForm` (see ../lead-form-props.ts) and the pages
 * call it with the form's props wherever the model carries a form.
 *
 * Server-component compatible: no hooks, no state.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ARCHIVE_GRACE_DAYS, INACTIVE_DAYS } from '../../leads/retention.ts';
import type { LeadFormProps, RenderForm } from '../lead-form-props.ts';
import type { PageModel, Section } from '../page-model.ts';
import { PRIVACY_LABEL, SiteShell } from './SiteShell.tsx';

export type { LeadFormProps, RenderForm };

/** The element id the "Get my free estimate" links jump to. */
export const FORM_ANCHOR = 'estimate';

export interface SitePageProps {
  page: PageModel;
  /** Draws the step-1 form. Phase 9 passes its LeadForm here. */
  renderForm: RenderForm;
}

const buttonClass =
  'inline-flex items-center justify-center rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// ── Parts ──

function Paragraphs({ items }: { items: string[] }) {
  return (
    <>
      {items.map((t, i) => (
        <p key={i} className="mt-3 leading-relaxed text-foreground/90">
          {t}
        </p>
      ))}
    </>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 list-disc space-y-1 pl-5 text-foreground/90">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

function SectionBlock({ section }: { section: Section }) {
  if (!section.heading && !section.paragraphs.length && !section.items.length) return null;
  return (
    <section id={section.id} className="mt-8">
      {section.heading ? <h2 className="text-xl font-semibold text-foreground">{section.heading}</h2> : null}
      <Paragraphs items={section.paragraphs} />
      <Bullets items={section.items} />
    </section>
  );
}

function EstimateLink({ page, label }: { page: PageModel; label: string }) {
  if (!page.form) return null;
  // The model's own href plus the in-page anchor: still an address the model built.
  return (
    <Link href={`${page.href}#${FORM_ANCHOR}`} className={buttonClass}>
      {label}
    </Link>
  );
}

function FormBlock({ page, renderForm }: SitePageProps) {
  if (!page.form) return null;
  const company = page.site.companyName;
  return (
    <section id={FORM_ANCHOR} className="mt-12 scroll-mt-6 rounded-2xl border border-border bg-card p-6 text-card-foreground">
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
  );
}

function OtherAreas({ page }: { page: PageModel }) {
  const others = page.areaLinks.filter((a) => a.href !== page.href);
  if (!others.length) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-foreground">Other areas we cover</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {others.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="rounded-full border border-border px-3 py-1 text-sm text-foreground hover:bg-muted">
              {a.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Pages ──

export function HomePage(props: SitePageProps) {
  const { page } = props;
  const benefits = page.sections.filter((s) => s.id.startsWith('benefit-'));
  const intro = page.sections.find((s) => s.id === 'intro');
  return (
    <>
      <section className="py-4">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{page.heading}</h1>
        {page.intro ? <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{page.intro}</p> : null}
        <div className="mt-6">
          <EstimateLink page={page} label={page.form?.submitLabel ?? 'Get my free estimate'} />
        </div>
      </section>
      {intro ? (
        <section id="intro" className="mt-6 max-w-2xl">
          <Paragraphs items={intro.paragraphs} />
        </section>
      ) : null}
      {benefits.length ? (
        <section className="mt-10 grid gap-4 sm:grid-cols-2">
          {benefits.map((b) => (
            <div key={b.id} id={b.id} className="rounded-xl border border-border bg-card p-5">
              {b.heading ? <h2 className="text-lg font-semibold text-foreground">{b.heading}</h2> : null}
              <Paragraphs items={b.paragraphs} />
            </div>
          ))}
        </section>
      ) : null}
      {page.areaLinks.length ? (
        <section id="areas" className="mt-10">
          <h2 className="text-xl font-semibold text-foreground">Areas we cover</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {page.areaLinks.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
                  {a.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <FormBlock {...props} />
    </>
  );
}

export function AreaPage(props: SitePageProps) {
  const { page } = props;
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{page.heading}</h1>
      {page.sections.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      <div className="mt-6">
        <EstimateLink page={page} label={page.form?.submitLabel ?? 'Get my free estimate'} />
      </div>
      <OtherAreas page={page} />
      <FormBlock {...props} />
    </>
  );
}

export function FeesPage(props: SitePageProps) {
  const { page } = props;
  const fee = page.sections.find((s) => s.id === 'fee');
  const rest = page.sections.filter((s) => s.id !== 'fee');
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{page.heading}</h1>
      {fee && fee.paragraphs.length ? (
        <section id="fee" className="mt-6 rounded-xl border border-border bg-card p-5">
          {fee.heading ? <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{fee.heading}</h2> : null}
          {fee.paragraphs.map((t, i) => (
            <p key={i} className="mt-2 text-2xl font-semibold text-foreground">
              {t}
            </p>
          ))}
        </section>
      ) : null}
      {rest.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      <div className="mt-6">
        <EstimateLink page={page} label={page.form?.submitLabel ?? 'Get my free estimate'} />
      </div>
      <FormBlock {...props} />
    </>
  );
}

export function AboutPage(props: SitePageProps) {
  const { page } = props;
  const photo = page.site.photoUrl;
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{page.heading}</h1>
      <div className={photo ? 'mt-6 grid gap-8 md:grid-cols-[1fr_16rem]' : 'mt-6'}>
        <div>
          {page.sections.map((s) => (
            <SectionBlock key={s.id} section={s} />
          ))}
        </div>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- an arbitrary customer host cannot go through next/image.
          <img src={photo} alt={page.site.companyName ? `The ${page.site.companyName} team` : 'The team'} className="h-auto w-full rounded-xl object-cover" />
        ) : null}
      </div>
      <FormBlock {...props} />
    </>
  );
}

export function FaqPage(props: SitePageProps) {
  const { page } = props;
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{page.heading}</h1>
      <div className="mt-6 divide-y divide-border rounded-xl border border-border">
        {page.faq.map((q, i) => (
          <details key={i} className="group p-4" id={`faq-${i + 1}`}>
            <summary className="cursor-pointer list-none font-medium text-foreground">{q.question}</summary>
            <p className="mt-2 leading-relaxed text-foreground/90">{q.answer}</p>
          </details>
        ))}
      </div>
      <FormBlock {...props} />
    </>
  );
}

// ── Privacy & Terms ──

/** "182 days" is "about 6 months": the same figure the consent wording gives. */
export const RETENTION_MONTHS = Math.round(INACTIVE_DAYS / 30.4);

/**
 * The privacy page's fixed wording beyond the model's own sections. The
 * operator is the data controller and Stayful Intelligence the processor;
 * the retention period is the leads retention constant, worded the way
 * consentText words it ("up to 6 months after they were last used, then
 * deleted").
 */
export function privacyExtraSections(page: PageModel): { id: string; heading: string; paragraphs: string[]; items: string[] }[] {
  const who = page.site.companyName || 'the company running this site';
  return [
    {
      id: 'processor',
      heading: 'Who else handles your details',
      paragraphs: [
        `Stayful Intelligence is the processor. It holds your details for ${who} and works out your estimate on its behalf. It acts only on ${who}'s instructions and does not use your details for its own purposes.`,
      ],
      items: [],
    },
    {
      id: 'retention',
      heading: 'How long your details are kept',
      paragraphs: [
        `Your details are kept for up to ${RETENTION_MONTHS} months after they were last used, then deleted. A short grace period of ${ARCHIVE_GRACE_DAYS} days applies before they are removed for good.`,
      ],
      items: [],
    },
    {
      id: 'rights',
      heading: 'Your rights',
      paragraphs: [`You can ask ${who} to show you, correct or delete your details at any time, using the contact details below.`],
      items: [],
    },
    {
      id: 'terms',
      heading: 'Terms of use',
      paragraphs: [
        'The estimate you receive is a guide based on local market data. It is not a promise of any income, and actual results depend on the market.',
        `Asking for an estimate does not commit you to anything. If you go ahead, you stay the owner of your property.`,
      ],
      items: [],
    },
  ];
}

export function PrivacyPage({ page }: SitePageProps) {
  const extras = privacyExtraSections(page);
  // Contact goes last, after the fixed wording.
  const contact = page.sections.find((s) => s.id === 'contact');
  const before = page.sections.filter((s) => s.id !== 'contact');
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{PRIVACY_LABEL}</h1>
      {page.intro ? <p className="mt-4 max-w-2xl text-muted-foreground">{page.intro}</p> : null}
      {before.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      {extras.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      {contact ? <SectionBlock section={contact} /> : null}
    </>
  );
}

// ── The whole page ──

function Body(props: SitePageProps): ReactNode {
  switch (props.page.key) {
    case 'home':
      return <HomePage {...props} />;
    case 'area':
      return <AreaPage {...props} />;
    case 'fees':
      return <FeesPage {...props} />;
    case 'about':
      return <AboutPage {...props} />;
    case 'faq':
      return <FaqPage {...props} />;
    case 'privacy':
      return <PrivacyPage {...props} />;
  }
}

/** One page of a customer website, inside the operator's shell. Phase 9's routes render this. */
export function SitePage(props: SitePageProps) {
  return (
    <SiteShell page={props.page}>
      <Body {...props} />
    </SiteShell>
  );
}
