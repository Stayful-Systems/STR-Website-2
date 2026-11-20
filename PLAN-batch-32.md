# Batch 32 — website leads go into the operator's lead database account

Paired with Stayful-Systems/lead-database issue #352, branch `claude/batch-32-si-website-leads`
(migration 0237). This repo: branch `batch-32-leaddb-push`, draft PR.

Planned against SI `cf6935e`, lead-database `ccb3102`. Review R5 is not on main; Zac chose to build anyway.

## What it does

A landlord fills in an operator's website form (Batch 31). That lead also appears in the operator's lead
database account as the operator's own lead, with the income report attached. Never charged, never given,
pooled or sold to anyone else. Still shows in SI Leads.

## The contract (both repos build to exactly this)

Base URL: `LEADDB_API_URL` (SI env, `https://leads.stayful.co.uk`). Shared secret `SI_LEAD_PUSH_SECRET`
(≥ 32 chars, env on both Vercel projects, never in code or DB).

All four endpoints are `POST`, JSON, and signed:

```
x-stayful-timestamp: <unix seconds>
x-stayful-signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
```

(`signBody` / `signatureHeader` from `src/lib/crm/signature.ts`.) Window 300 s both directions.
Secret unset or < 32 chars on the receiver → HTTP 404 `{}`. Missing/bad/stale signature → 401 `{ok:false,code:"bad_signature"}`.

Every response is JSON. Success `{ok:true,...}`. Failure `{ok:false,code:"<snake_case>"}` — codes only,
never an echo of the request body and never an address.

### POST /api/internal/si/link/start
Body `{ si_member_id: string(1..100), email: string }`
- 200 `{ok:true, link_id: uuid, status:"code_sent"}` (no customer details)
- 422 `{ok:false, code:"no_account"}` — no lead database customer for that email
- 422 `{ok:false, code:"no_product"}` — customer has neither management nor guaranteed-rent
- 429 `{ok:false, code:"rate_limited"}` — more than 5 starts per member per hour
- 400 `{ok:false, code:"bad_request"}`

### POST /api/internal/si/link/confirm
Body `{ link_id: uuid, si_member_id: string, code: string(6 digits) }`
- 200 `{ok:true, status:"confirmed", lead_type:"management"|"guaranteed_rent"}`
- 422 `{ok:false, code:"wrong_code"|"expired_code"|"too_many_attempts"|"unknown_link"}`
- 400 `bad_request`

### POST /api/internal/si/link/revoke
Body `{ si_member_id: string }` → 200 `{ok:true}` (idempotent; never deletes).

### POST /api/internal/si/website-leads
Body:
```json
{
  "si_member_id": "…",
  "si_lead_id": "<uuid, SI leads.id — the idempotency key>",
  "test": false,
  "lead": { "name": "", "email": "", "phone": "", "address": "", "postcode": "", "bedrooms": "", "message": "" },
  "report": {
    "gross_annual_income": 0,
    "nightly_rate": 0,
    "occupancy_pct": 0,
    "bedrooms": 0,
    "pdf_base64": "…"
  }
}
```
`report` is optional (absent = "report coming"). Figures are pounds / pounds-per-night / percent 0–100
(NOT a 0–1 fraction). PDF ≤ 3 MB decoded, must start `%PDF`.
`lead.message` is folded into the lead's profile by the receiver.
`test:true` creates ONE lead named "Test lead from Stayful Intelligence" (key `test:{link_id}:{UK date}`);
the other `lead` fields are ignored.

- 200 `{ok:true, outcome:"created"|"duplicate", replayed:boolean, lead_id:uuid, url:string, report:"attached"|"already_attached"|"coming"|"kept_existing"}`
- 403 `{ok:false, code:"not_linked"|"no_product"}`
- 409 `{ok:false, code:"in_progress"}` — SI retries
- 422 `{ok:false, code:"bad_report"|"empty_lead"}`; 400 `bad_request`; 413 `too_large`

### Retry rule SI applies (`client.ts` → `{ok, code, retryable}`)
Retryable: network error/timeout, HTTP ≥ 500, 408, 409, 429, **401 and 404** (a secret not yet set on one side
must not lose the lead; after 6 attempts the delivery is `failed` and admin can Retry).
Non-retryable: 400, 403, 413, 422.

## Rules both sides keep
- Operator is never charged. Nothing counts towards plans, credits or counters.
- `owner_source = 'si_website'` (lead database). Not `'lead_db'` (§71, analyser source).
- SI's `leads.status` and `crm_pushed_at` keep meaning "went to your CRM": the lead database state lives in
  SI's own `leaddb_deliveries` table.
- Address goes only into the customer's own lead. Logs carry ids only. Error responses are codes only.
- Knowledge entries: drafts in `src/lib/knowledge/seed.ts`, every figure a `{placeholder}`.
