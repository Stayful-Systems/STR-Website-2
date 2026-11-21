/**
 * Batch 37: the guide that goes with an exported website. One text, two shapes:
 *
 *   html   GUIDE.html, a single page with its own styles (no script, no external file), saved in the zip
 *   text   the same words as plain text, for the body of the email
 *
 * It tells the operator, in plain English: what is in the folder, how to put it on any host, how to
 * point their domain, how the enquiry form keeps working, how to swap it for their own, and the one
 * step that depends on where their domain is going (the tag, or the transfer code).
 *
 * The guide holds no secret: the transfer code is never in it (it is sent separately), and no figure
 * is typed here (the only date is the day our copy of the site stops, which the caller supplies).
 * No Stayful asset appears in it. Every value that is not fixed wording is escaped for the html.
 *
 * Pure: no network, no database, no server-only. Relative .ts imports only.
 */
import type { TransferMethod } from './transfer-rules.ts';

export interface GuideInput {
  /** The operator's company name. */
  siteName: string;
  /** The domain being moved ("harbour.co.uk"), or null when the site has none (files only). */
  domain: string | null;
  /** How the domain is moving: the registrar's tag, a transfer code, or not at all. */
  method: TransferMethod;
  /** Where the domain is going. Null when it is not moving. */
  provider: { name: string; tag: string; helpUrl: string | null } | null;
  /** The address the exported form posts to (it is in every page already; it is not a secret). */
  formAction: string;
  /** The day our copy of the site stops (an ISO date or time), or null when it is not set. */
  ourCopyEnds: string | null;
}

export interface Guide {
  subject: string;
  html: string;
  text: string;
}

type Block = { kind: 'p'; text: string } | { kind: 'list'; items: string[] } | { kind: 'code'; text: string };
interface Section {
  heading: string;
  blocks: Block[];
}

const p = (text: string): Block => ({ kind: 'p', text });
const list = (...items: string[]): Block => ({ kind: 'list', items });
const code = (text: string): Block => ({ kind: 'code', text });

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "21 December 2026", or null for a missing or unreadable date. */
function dayOf(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

/** A help link we are willing to print: https only. */
const safeHelp = (v: string | null): string | null => (v && /^https:\/\/[^\s"'<>]+$/.test(v) ? v : null);

/** The step that depends on where the domain is going. */
function domainSteps(input: GuideInput): Section {
  const { domain, method, provider } = input;
  const heading = domain ? `Moving ${domain}` : 'Your domain';
  if (!domain || method === 'none') {
    return {
      heading: 'Your domain',
      blocks: [
        p('This website was not on a domain of its own, so there is nothing to move. When you have a domain, point it at the host you chose (see "Point your domain at the host").'),
      ],
    };
  }
  const where = provider ? provider.name : 'your new provider';
  const help = safeHelp(provider?.helpUrl ?? null);
  const helpLine = help ? `${where} has a help centre if you get stuck: ${help}` : '';
  if (method === 'tag') {
    return {
      heading,
      blocks: [
        p(`${domain} is a .co.uk domain, and those move between providers by changing a short code called the tag. The tag for ${where} is ${provider ? provider.tag : 'the one you gave us'}.`),
        list(
          `Make sure you have an account with ${where}. Open one now if you do not.`,
          `We change the tag on ${domain} to ${provider ? provider.tag : 'your provider\'s tag'} for you, and email you when it is done.`,
          `Once the tag is changed, ${domain} appears with ${where}. Sign in there, find the domain and confirm it is yours.`,
          'Check the domain still points at your site once it has arrived. If it does not, set the records your host gave you (see "Point your domain at the host").',
        ),
        ...(helpLine ? [p(helpLine)] : []),
      ],
    };
  }
  return {
    heading,
    blocks: [
      p(`${domain} is a .co.uk domain, and it moves between providers with a transfer code. We send you the code separately, by email and in your account. It is not in this guide, and you should not share it.`),
      list(
        `Make sure you have an account with ${where}. Open one now if you do not.`,
        `In ${where}, start a transfer of ${domain} into your account and, when it asks, enter the code we sent you.`,
        'Confirm the transfer when your provider emails you. It can take a few days.',
        'Check the domain still points at your site once it has arrived. If it does not, set the records your host gave you (see "Point your domain at the host").',
      ),
      ...(helpLine ? [p(helpLine)] : []),
    ],
  };
}

function sections(input: GuideInput): Section[] {
  const { siteName, domain, formAction } = input;
  const ends = dayOf(input.ourCopyEnds);
  const name = siteName.trim() || 'your website';
  const out: Section[] = [];

  out.push({
    heading: 'What you have',
    blocks: [
      p(`A folder holding the whole of ${name}: one page for each page of the site, a folder of images, and an assets folder with the styles, the fonts and the enquiry form's styles. It is plain files: no database, no installer and no JavaScript.`),
      p('Open index.html in any browser to see it before you do anything else. The pages link to each other with ordinary relative links, so it works from your own computer as well as from a host.'),
    ],
  });

  out.push({
    heading: 'Put the folder on a host',
    blocks: [
      p('Any host that serves ordinary web files will do. Most call it static hosting, web space or a website builder\'s file upload. Many have a free plan.'),
      list(
        'Upload everything inside the folder, not the folder itself, so that index.html sits at the top of your site.',
        'Keep the folder names as they are (images, assets, and areas if you have area pages).',
        'Open your site at the address your host gives you and click through every page.',
      ),
    ],
  });

  out.push({
    heading: 'Point your domain at the host',
    blocks: [
      p(
        domain
          ? `Your host will tell you what to set so that ${domain} shows your site. Usually it is a couple of records at the place that looks after the domain's settings. Copy them exactly as your host shows them.`
          : 'Your host will tell you what to set so that your own domain shows your site. Usually it is a couple of records at the place that looks after the domain\'s settings. Copy them exactly as your host shows them.',
      ),
      ...(ends
        ? [p(`Our copy of ${name} keeps working until ${ends}, so nothing goes dark while you do this. Take your time, and check your own copy works before that day.`)]
        : [p(`Our copy of ${name} keeps working for a while after you ask for this export, so nothing goes dark while you do this. Check your own copy works before it stops.`)]),
    ],
  });

  out.push(domainSteps(input));

  out.push({
    heading: 'How the enquiry form keeps working',
    blocks: [
      p('Every page that has the form sends it to our service, at the address in the form tag of that page. You do not need to do anything for it to keep working. It carries on after our copy of your site has stopped, and it does not depend on the site being live with us.'),
      p('When someone sends it, they see a thank-you page in your name and colour. Their enquiry reaches your account as a lead, as before. If your plan includes estimate reports, the person gets their report as normal. If you have no plan, the enquiry is still saved for you, but no report is made and you are not charged.'),
      p('The form has a hidden field that real visitors never see. Leave it in. It is how we tell people from robots.'),
    ],
  });

  out.push({
    heading: 'How to swap the form for your own',
    blocks: [
      p('You do not have to keep ours. To use your own form, or one from another service:'),
      list(
        'Open each page that has a form (every page except the privacy page) in a text editor.',
        'Find the form: it starts at the tag that begins with <form class="tf-form" and ends at the next </form>.',
        'Replace the whole thing with the form or embed your other service gives you. Delete the line that links assets/form.css if you no longer use it.',
        'Update the privacy page: it says who looks after the details people give. It should name whoever does after the swap.',
      ),
      p('If you only want to send the enquiry to a different address, change the action in the form tag. Keep the same field names, or the new place will not understand them.'),
      code(formAction),
    ],
  });

  out.push({
    heading: 'If something goes wrong',
    blocks: [
      p('A page looks plain and unstyled: the assets folder did not upload, or the folder names changed. Upload it again with the names as they were.'),
      p('A link goes to a page that is not found: your host may need the .html on the end of the address. Check the file is there.'),
      p('Anything else: reply to the email this guide came with, or write to us from your account.'),
    ],
  });

  return out;
}

const STYLES = `body{margin:0;background:#f8fafc;color:#111827;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.75rem;margin:0 0 .5rem}
h2{font-size:1.2rem;margin:2rem 0 .5rem}
p,li{margin:.5rem 0}
ul,ol{padding-left:1.25rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem}
pre{background:#fff;border:1px solid #e2e8f0;border-radius:.5rem;padding:.75rem;overflow-x:auto}
.lead{color:#475569}`;

function blockHtml(b: Block): string {
  if (b.kind === 'p') return `<p>${esc(b.text).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`;
  if (b.kind === 'list') return `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`;
  return `<pre>${esc(b.text)}</pre>`;
}

function blockText(b: Block): string {
  if (b.kind === 'p') return b.text;
  if (b.kind === 'list') return b.items.map((i, n) => `${n + 1}. ${i}`).join('\n');
  return `    ${b.text}`;
}

/** The guide for one transfer: GUIDE.html and the same words for the email. */
export function buildGuide(input: GuideInput): Guide {
  const name = input.siteName.trim() || 'your website';
  const title = `How to use your exported website: ${name}`;
  const secs = sections(input);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${esc(title)}</title><style>${STYLES}</style></head><body><main>` +
    `<h1>${esc(title)}</h1><p class="lead">Everything you need to run your website yourself.</p>` +
    secs.map((s) => `<h2>${esc(s.heading)}</h2>${s.blocks.map(blockHtml).join('')}`).join('') +
    `</main></body></html>`;
  const text = [title, '', 'Everything you need to run your website yourself.', '', ...secs.flatMap((s) => [s.heading, ...s.blocks.map(blockText), ''])]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
  return { subject: `Your website files: ${name}`, html, text };
}
