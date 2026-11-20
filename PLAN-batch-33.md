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
- [ ] Phase 2 — Pure core (name, policy, redirect, activity kind)
  Notes:
- [ ] Phase 3 — Registrar module (interface, Openprovider, fake)
  Notes:
- [ ] Phase 4 — Vercel client and env
  Notes:
- [ ] Phase 5 — Purchase and connect engine
  Notes:
- [ ] Phase 6a — Host routing (proxy)
  Notes:
- [ ] Phase 6b — Addresses (urls.ts, layout, Notice, golive)
  Notes:
- [ ] Phase 7 — Lead form on own domains
  Notes:
- [ ] Phase 8 — Member domain picker
  Notes:
- [ ] Phase 9 — Status cron
  Notes:
- [ ] Phase 10 — Admin domains panel
  Notes:
- [ ] Phase 11 — Knowledge drafts
  Notes:
- [ ] Phase 12 — Final checks, push, draft PR
  Notes:
