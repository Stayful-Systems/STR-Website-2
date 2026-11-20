# PLAN — Batch 33: customer websites, Phase 3 — automatic .co.uk domains

Planned against origin/main `cf6935e` (re-checked 20 Nov 2026: main has not moved).
Review R5 is NOT on main. Zac said (20 Nov) to continue without it, provided everything builds and merges clean.
Branch: `claude/lucid-einstein-w05zyj` (the harness branch for this session; Zac agreed to it replacing `claude/magical-ritchie-m5npfw`).
Baseline: `npm test` 3661 pass / 0 fail, `npm run lint` clean, `npm run build` see Phase 0 notes.
Full design and the issue register are in Zac's brief; this file is the checklist.

## Rules for every phase
- Read CLAUDE.md and AGENTS.md. Graphify first. Read `node_modules/next/dist/docs` before a route, proxy or server action.
- Never touch: `src/lib/access.ts`, Batch 32 lead-database files, `src/lib/funnels/charge-server.ts`, `src/lib/funnels/tiers*.ts`, `src/lib/tracking/**`, `src/app/f/**`, academy files, `src/lib/websites/report-server.ts`, the Batch 31 schema section (append after it only).
- Knowledge drafts are placeholders from settings, never typed figures (Phase 11).
- The brief's Batch 31 test "nothing may follow the Batch 31 section" is relaxed (one changed assertion in `src/lib/websites/schema.test.ts`) because Batch 33 appends after it, as the brief requires.

## Progress
- [x] Phase 0 — Prep
  Notes: main still `cf6935e`. R5 not on main; Zac's go-ahead 20 Nov. Baseline npm test 3661/3661 pass; lint clean; build passes. Plan kept as PLAN-batch-33.md (PLAN.md holds merged 31a history).
- [x] Phase 1 — Schema and settings
  Notes: schema block appended after Batch 31 (4 tables, 3 functions, 3 seeds). Local Postgres 16: shim + schema run 3 times, schema/data/index dumps identical; domains-smoke.sql passes (found a real bug: FOUND overwritten by the aggregate select, fixed + pinned). Touched: ci.yml (+2 lines), websites/schema.test.ts (one assertion relaxed: Batch 31 need no longer be the last section). settings.ts exports DOMAIN_KEYS, parseDomains, checkDomainSetting (admin input check).
- [x] Phase 2 — Pure core (name, policy, redirect, activity kind)
  Notes: name.ts (also strips a trailing lettings), policy.ts, redirect.ts, kind website_domain_chosen (record-only). 61 tests.
- [x] Phase 3 — Registrar module (interface, Openprovider, fake)
  Notes: Interface, fake and picker by me; openprovider.ts by a helper from the portal's OpenAPI spec (/v1). UNCONFIRMED against a real account: sandbox host, token lifetime, 'already registered' response, ns_group, DNS replace semantics, expiry field, whether the reseller price is ex-VAT; changeIpsTag always refuses (no .co.uk IPS call in the spec; Batch 37 is a panel step).
- [x] Phase 4 — Vercel client and env
  Notes: vercel.ts + fake; docs say an existing domain is a 400 (brief said 409): either is followed by a GET and only a domain already in THIS project counts as OK.
- [x] Phase 5 — Purchase and connect engine
  Notes: purchase-server.ts (injected deps), store-server.ts (real wiring; the one rpc to website_domain_charge), emails, test-store.ts. Added retry(), releasedBefore guard (a member cannot re-buy after an admin release). 38 engine tests.
- [x] Phase 6a — Host routing (proxy)
  Notes: host-lookup.ts (pure, cached), host-server.ts, proxy.ts (+9 lines), /s/[slug]/robots.txt. Dev run with a faked lookup: site host rewrites / and /fees, /login /admin 404, app host /s/harbour?utm_source=x&junk=1 -> 301 https://harbourmanagement.co.uk/?utm_source=x. Supabase session skipped on own-domain hosts.
- [x] Phase 6b — Addresses (urls.ts, layout, Notice, golive)
  Notes: CUSTOM_DOMAINS_ON=true, siteAbsoluteUrl, siteDomain only accepts a plain <label>.co.uk, layout indexable + per-page canonical on a domain, Notice uses siteAbsoluteUrl, golive passes {slug} only (1 changed line).
- [x] Phase 7 — Lead form on own domains
  Notes: Turnstile skipped only when website_domains says this site's domain is live (server-side); honeypot hp_company_site returns quiet ok and saves nothing; page-model adds skipBotCheck; LeadForm hides the widget.
- [x] Phase 8 — Member domain picker
  Notes: DomainPicker, domain-actions (only 'name' read from the form), DomainSection inside Notice (the live state IS the Notice, so WebsiteSetup.tsx needed no change).
- [x] Phase 9 — Status cron
  Notes: cron-run.ts (injected) + route + vercel.json entry. Added column autorenew_alerted_for (one auto-renew email per period).
- [x] Phase 10 — Admin domains panel
  Notes: admin-run/admin-view/admin-server, domain-actions (requireAdmin first, console audit), DomainsPanel, page.tsx +4 lines.
- [x] Phase 11 — Knowledge drafts
  Notes: Four drafts + domain_charge_on condition + service-facts block; wording matches the flow (choose after the site is live).
- [x] Phase 12 — Final checks, push, draft PR
  Notes: npm test 3860 pass / 0 fail; lint 0 errors (79 warnings, as baseline); build passes; schema run 3x identical, domains-smoke passes; protected files untouched (git diff empty).
