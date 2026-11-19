/**
 * Batch 31: a clean sample site (settings + copy) for tests of the page model,
 * the checks and the templates. Not used by the app.
 *
 * Pure: no network, no database, no server-only.
 */
import type { SiteRef } from './types.ts';
import type { SiteCopy, SiteSettings } from './page-model.ts';

export const SAMPLE_SITE: SiteRef = { slug: 'northern-lets' };

export const SAMPLE_SETTINGS: SiteSettings = {
  companyName: 'Northern Lets',
  logoUrl: 'https://example.com/logo.png',
  brandColour: '#0a96a0',
  areas: ['Leeds', 'Harrogate'],
  managementFeePct: 15,
  contactEmail: 'hello@northernlets.co.uk',
  contactPhone: '0113 496 0123',
  photoUrl: null,
  aboutText: null,
};

export const SAMPLE_COPY: SiteCopy = {
  home: {
    headline: 'Short-let management for Yorkshire landlords',
    subheadline: 'Find out what your property could earn as a short let.',
    intro: 'We look after the guests, the cleaning and the paperwork, and you stay the owner.',
    benefits: [
      { title: 'You stay in control', body: 'You choose the dates, the rules and who stays in your property.' },
      { title: 'Local people', body: 'We live and work in the area, so a problem is dealt with quickly.' },
    ],
  },
  areas: [
    { area: 'Leeds', headline: 'Short-let management in Leeds', body: 'Leeds has steady demand from visitors, students and contractors.\n\nWe manage flats and houses across the city.' },
    { area: 'Harrogate', headline: 'Short-let management in Harrogate', body: 'Harrogate is busy with conferences and weekend visitors.' },
  ],
  fees: {
    headline: 'Simple, clear fees',
    body: 'One fee covers the day-to-day running of your property. There are no set-up charges.',
    includes: ['Guest messaging', 'Cleaning and changeovers', 'Pricing and listing management'],
  },
  about: { headline: 'About Northern Lets', body: 'Northern Lets is a small local team that manages short-let homes.' },
  faq: {
    headline: 'Questions landlords ask',
    items: [
      { question: 'Do I stay the owner?', answer: 'Yes. The property stays yours and we manage it for you.' },
      { question: 'Can you promise an income?', answer: 'No. Bookings depend on the market, so we give an estimate, not a promise.' },
    ],
  },
};
