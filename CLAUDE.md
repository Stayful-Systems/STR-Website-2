@AGENTS.md

## Code search: use Graphify first

This repo is indexed in the Graphify MCP. For any question about how the code works, where something lives, what calls what, or what a change would affect:
1. Use the graphify tools first (`mcp__graphify__graphify_find`, `mcp__graphify__query_graph`, `mcp__graphify__graphify_callers`, `mcp__graphify__graphify_callees`, `mcp__graphify__graphify_impact`, `mcp__graphify__graphify_file_neighbors`).
2. Only open a file with Read once the graph has told you which file and lines matter.
3. Don't grep or read whole folders to explore.
4. The graph is a snapshot of the last indexed commit. If code was just changed, check the files you edit directly.

If the repo isn't in the Graphify `list_repositories`, work as normal.

# Stayful Intelligence knowledge (Batch 24)

Any change to a feature, price, limit or rule must add or update the matching
Stayful Intelligence knowledge entries (as drafts for Zac to approve, in
`src/lib/knowledge/seed.ts`), and every figure must be a placeholder resolved
from settings (`src/lib/knowledge/placeholders.ts`), never typed into an
answer. If the change adds or moves something the nightly job drafts from,
update `src/lib/knowledge/service-facts.ts` too. See
`src/lib/knowledge/README.md`.

# Bug check before handing back

- Did this change a feature, price, limit or rule? Then the matching
  knowledge entries are added or updated in `src/lib/knowledge/seed.ts` as
  drafts (never approved in code), every figure in them is a `{placeholder}`
  resolved from settings, and `npm test` passes (the seed tests check every
  placeholder resolves against the schema's seeds and no answer types a
  figure).

# Batch 32: website leads go into the operator's lead database account

A landlord's website lead is also pushed, signed, to the operator's own lead
database account (never charged, never given, pooled or sold on). Plan and the
wire contract: `PLAN-batch-32.md`. Code: `src/lib/leaddb/`.

- **Contract.** Four signed POSTs to `LEADDB_API_URL` (`/api/internal/si/link/start|confirm|revoke`
  and `/api/internal/si/website-leads`), signed with `signatureHeader` (`src/lib/crm/signature.ts`) under
  `SI_LEAD_PUSH_SECRET` (32+ characters, set on both Vercel projects, never in code or the database).
  Unset or short on our side: the client returns `not_configured` (retryable) and the connect screen says
  "Lead database link not available yet". Responses are codes only; the retry rule is in `client.ts`.
- **Two names, never mixed.** The lead database stores these leads with `owner_source = 'si_website'`. That is
  not `LEAD_DB_SOURCE = 'lead_db'` (§71, the analyser's `analyser_reports.source`).
- **Tables.** `leaddb_links` (one row per owner: the confirmed link) and `leaddb_deliveries` (one row per lead:
  the retry queue and its state). `leads.status` and `leads.crm_pushed_at` keep meaning "went to your CRM" and
  are **never** written by this (a test pins it). Neither table is in `ACCESS_COLUMNS`.
- **Flow.** `enqueueLeadDbPush(leadId)` runs after the step-1 save (`/api/s/[slug]/lead`) and after the report is
  done (`report-server.ts`), as `void ….catch(() => {})`: it never throws and never waits. It acts only for a
  website lead, not held, whose owner has an ACTIVE link. `/api/internal/leaddb-deliveries` (`3-59/10 * * * *`,
  `?dry=1` lists and sends nothing) sweeps then drains. The lead goes first ("Report coming"); the report goes
  again under the same SI lead id when `website_reports.state = 'done'`. Occupancy is a percent 0–100.
- **Never log a lead.** Log lines carry a lead id and a code at most, never an address or a body.
- **Connect.** `src/app/leads/integrations/LeadDbPanel.tsx`: login email → code → connected. Owner only
  (`ownerIdOrNull`); logs the record-only kind `leaddb_connected`. A failure is shown in plain English
  (`messages.ts`).
- **Knowledge.** Four draft entries in `seed.ts` (`leaddb_*`) and a line in `service-facts.ts`.
