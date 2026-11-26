# Batch 55 Part A: the signed contract for the lead database (Part B)

This is the wire contract between the lead database (the caller, Part B) and Stayful Intelligence (this site, STR-Website-2).
Part A ships the receiving side. Part B must send exactly this. Everything is codes and flags: no request or response ever
carries a lead, and neither side logs a body, an email, a signature, a secret or a sign-in link.

## 1. Where to call

- Base URL: this site's own origin, the host members use (`NEXT_PUBLIC_SITE_URL` on this project, e.g. `https://stayful.co.uk`).
  Put it in the lead database's environment as its own setting (for example `SI_BASE_URL`); it is not `LEADDB_API_URL`
  (that is the other direction: this site calling the lead database for Batch 32).
- Three paths, all `POST`, all `content-type: application/json`:
  - `/api/internal/si/ad-route/provision`
  - `/api/internal/si/ad-route/state`
  - `/api/internal/si/ad-route/signin`
- Any other method, or an unknown path, is not part of the contract.

## 2. Signing

The scheme is the one Batch 32 already uses in the other direction (`src/lib/crm/signature.ts`, `signatureHeader`). Use the same code
or the same recipe; do not invent a variant.

- Secret: `SI_LEAD_PUSH_SECRET`, 32 characters or more, set on BOTH Vercel projects (the lead database and this site). It is the
  same value that signs Batch 32's calls, nothing new to create. Never in code or the database.
- Sign the exact bytes you send. Serialise the JSON body ONCE, sign that string, send that string. Do not re-serialise.
- `t` is the current Unix time in whole seconds.
- Signature = hex HMAC-SHA256 of the string `${t}.${body}` under the secret.
- Headers:
  - `x-stayful-signature: t=<t>,v1=<hex signature>`
  - `x-stayful-timestamp: <t>` (sent for symmetry; only the `t=` inside the signature header is trusted)
  - `content-type: application/json`
- Tolerance: five minutes either side of this site's clock (a clock ahead is refused as much as one behind). Retries must be
  re-signed with a fresh `t`; an old signature is refused.
- Body limit: 64 KB. Real bodies are a few hundred bytes.

### What a refusal looks like

| Status | Body | Meaning |
|---|---|---|
| 404 | empty | `SI_LEAD_PUSH_SECRET` is unset or under 32 characters on THIS side. Retry later; it is not a code. |
| 401 | `{ "ok": false, "code": "unauthorized" }` | Missing or wrong signature, or `t` outside the five minutes. No reason is given. |
| 413 | `{ "ok": false, "code": "too_large" }` | Body over 64 KB. Never retry. |
| 400 | `{ "ok": false, "code": "bad_request" }` | Signed correctly but the body is not valid JSON, or a field fails validation. Never retry the same body. |

Retry rule for Part B (matches Batch 32's): retry a network error, timeout, 5xx, 401 and 404 (a secret not yet set on one side);
do not retry 400, 409 `conflict` / `has_website`, 413. A 404 with an EMPTY body is the unset secret (retry later); a 404 with `unknown_customer` is not retryable until a `provision` succeeds.

## 3. The account state object

Sent inside `provision` and `state`. camelCase, exactly these fields; anything else is ignored.

```json
{
  "accountStatus": "active",
  "cardOnFile": true,
  "cancelEffectiveAt": null,
  "lapsed": false,
  "stateAsOf": "2026-11-26T10:15:30.000Z"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `accountStatus` | string (1 to 64 chars) or null | no | The lead database's own status word. This site reads only `cancelled` and `lapsed` (case-insensitive, trimmed). `active`, `paused`, `past_due`, `pending_cancel` and anything else are stored but do not stop the route by themselves. |
| `cardOnFile` | boolean | YES | True only when a usable payment card is on the account. |
| `cancelEffectiveAt` | ISO 8601 string or null | no | When a scheduled cancellation takes effect. Null when none is scheduled. Send it as soon as a cancellation is scheduled, not only when it happens. |
| `lapsed` | boolean | YES | True once the account has lapsed (payments failed for good, or the operator is otherwise written off). |
| `stateAsOf` | ISO 8601 string | YES | When the lead database says this state was true (not when the push was sent). Used for ordering. |

A state that fails validation (missing `cardOnFile`, `lapsed` or `stateAsOf`, wrong types, a date that is not ISO 8601, a status over
64 characters) is a 400 `bad_request` and is NOT applied.

### Ordering: stateAsOf

- A newer `stateAsOf` replaces the stored state.
- An EQUAL `stateAsOf` is applied again (so re-sending is safe and idempotent).
- An OLDER `stateAsOf` is ignored. The response is still 200, with code `stale`. It is not an error and must not be retried.
- Part B must therefore stamp `stateAsOf` from the moment the underlying fact changed (or from a monotonic clock on the account
  record), never from a retry's send time that could overtake a later real change.

### The stop rule, in plain words

The lead database ad route for an operator is STOPPED when ANY of these is true on this side:

1. This site has no account for the customer (never provisioned).
2. No state has ever arrived for it.
3. `lapsed` is true.
4. `accountStatus` is `cancelled` or `lapsed`.
5. The current time is at or after `cancelEffectiveAt`.
6. `cardOnFile` is false.
7. (Separate from the state) Zac has not set the owner's `allowed` switch.

Pause never stops the route: `accountStatus: "paused"` with a card on file keeps it going. `past_due` also does not stop it by
itself: this site only stops for past due if the lead database ALSO sets `cardOnFile: false` or `lapsed: true` (or cancels).
That is the lead database's decision to make and to push. This is an assumption for Zac to confirm; it is what the code does.

### Fail closed

This site never guesses. A customer with no account, or an account that has never received a state, is STOPPED. After that, the
last stored state is what applies: if a push is lost, a card removed on the lead database but never pushed still reads as "card on
file" here. So the route is only as safe as Part B's pushes, and Part B MUST push state on EVERY change (next section).

## 4. Part B must push state on every change

Send a `state` call whenever any of these happens, with `stateAsOf` set to the time of the change:

- a card is added (`cardOnFile: true`)
- a card is removed, expires or is replaced by none (`cardOnFile: false`)
- the account is paused or un-paused (`accountStatus` changes; the route is unaffected, but keep the record true)
- a cancellation is scheduled (`cancelEffectiveAt` set, `accountStatus` e.g. `pending_cancel`)
- a scheduled cancellation is withdrawn (`cancelEffectiveAt: null`)
- a cancellation takes effect (`accountStatus: "cancelled"`)
- the account lapses (`lapsed: true`, `accountStatus: "lapsed"`)
- the account is reinstated (`lapsed: false`, status back to `active`, card state as true)
- payments go past due or recover (`accountStatus`; also change `cardOnFile`/`lapsed` if the route should stop)

Also push the full current state after any outage, as a catch-up. Consider a periodic re-push (daily is plenty): an equal
`stateAsOf` is harmless, and a state refreshed with a later `stateAsOf` repairs any push that was lost.

## 5. provision

`POST /api/internal/si/ad-route/provision`

Called once when a lead database customer with no Academy, no website and no domain is to be offered the three landlord ads.

Request:

```json
{
  "ld_customer_id": "cust_123",
  "email": "operator@example.com",
  "company": "Example Homes",
  "phone": "07123 456789",
  "state": { "accountStatus": "active", "cardOnFile": true, "cancelEffectiveAt": null, "lapsed": false, "stateAsOf": "2026-11-26T10:15:30.000Z" }
}
```

| Field | Rule |
|---|---|
| `ld_customer_id` | string, 1 to 128 chars of letters, digits and `. _ : -`. The lead database's own stable id for this operator. The key for everything after. |
| `email` | the operator's verified login email on the lead database (this site trusts it as verified). Trimmed and lower-cased. |
| `company` | the operator's company name, 1 to 120 chars. Becomes the calculator site's brand name. |
| `phone` | a phone number (digits, spaces, `+ ( ) - .`, 3 to 40 chars), or `null` / omitted. |
| `state` | the state object above, all required fields present. |

What this site does:

1. If an account already exists for this `ld_customer_id`: applies the state (rules above), finishes the calculator site if a previous
   attempt left it unfinished, and answers `exists`. Nothing is created twice.
2. Otherwise finds the member by email:
   - an existing account that is an owner (not a team member), has no OTHER lead database account and has no website of its own
     is LINKED;
   - an existing team member, or an owner linked to a different `ld_customer_id`, is a 409 `conflict`;
   - an existing owner who already has their own Stayful website is a 409 `has_website` (the route is not offered to them);
   - no account: a new login is created (email pre-confirmed). No email is sent to the operator by this call.
3. Stores the account with `allowed = false`. Zac switches each owner on at `/admin/ad-packs`; a push NEVER changes `allowed`.
4. Makes the branded calculator site at a Stayful address.

Responses (all JSON):

| Status | Body | Meaning | Retry? |
|---|---|---|---|
| 200 | `{ "ok": true, "code": "created" }` | Account and site made. | n/a |
| 200 | `{ "ok": true, "code": "exists" }` | Already provisioned; state applied (an older state is ignored). | n/a |
| 400 | `{ "ok": false, "code": "bad_request" }` | Body failed validation. | no |
| 409 | `{ "ok": false, "code": "has_website" }` | The owner already has a Stayful website. | no |
| 409 | `{ "ok": false, "code": "conflict" }` | The email is a team member, or already linked to another lead database customer, or this customer id belongs to another owner. | no (needs a person) |
| 500 | `{ "ok": false, "code": "server_error" }` | Something failed on this side. | yes, with a fresh signature; safe because it is idempotent |
| 503 | `{ "ok": false, "code": "server_error" }` | Storage not configured on this side. | yes, later |

Idempotency: the key is `ld_customer_id`. Repeating the same call (a retry, a timeout whose first attempt actually landed) is safe
and returns `exists`. A repeat with a changed `email`, `company` or `phone` does not change the stored account or site; only the
state is applied.

## 6. state

`POST /api/internal/si/ad-route/state`

```json
{
  "ld_customer_id": "cust_123",
  "state": { "accountStatus": "paused", "cardOnFile": true, "cancelEffectiveAt": null, "lapsed": false, "stateAsOf": "2026-11-27T08:00:00.000Z" }
}
```

| Status | Body | Meaning | Retry? |
|---|---|---|---|
| 200 | `{ "ok": true, "code": "applied" }` | Stored. | n/a |
| 200 | `{ "ok": true, "code": "stale" }` | A newer state is already held; this one was ignored. Not an error. | no |
| 400 | `{ "ok": false, "code": "bad_request" }` | Body or state failed validation. | no |
| 404 | `{ "ok": false, "code": "unknown_customer" }` | No account for this `ld_customer_id`: `provision` it first. | after provision |
| 500 | `{ "ok": false, "code": "server_error" }` | Failed on this side. | yes |

`state` never creates an account and never touches `allowed`.

## 7. signin

`POST /api/internal/si/ad-route/signin`

For the "Make my ads" button in the lead database. Returns a one-time sign-in link that lands the operator signed in on `/leads/ads`.

```json
{ "ld_customer_id": "cust_123" }
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true, "url": "https://.../auth/confirm?token_hash=...&type=magiclink&next=%2Fleads%2Fads" }` | Redirect the operator's browser to `url`. |
| 400 | `{ "ok": false, "code": "bad_request" }` | Body failed validation. |
| 404 | `{ "ok": false, "code": "unknown_customer" }` | No account for this customer id (not provisioned). |
| 500 | `{ "ok": false, "code": "server_error" }` | Could not mint the link. Retry. |

- Works only for a provisioned `ld_customer_id`.
- Single use. The link is created for the operator's login and expires on Supabase's schedule; if it fails or has been used, call
  `signin` again for a fresh one. Mint it at click time and redirect straight away: do not store it, email it or log it.
- This call does not send any email, and neither does Supabase.
- Signing in does not mean the route is switched on: the operator sees the ads screen only as far as the stop rule and Zac's
  `allowed` switch let them.

## 8. Checklist for Part B

- [ ] `SI_LEAD_PUSH_SECRET` (32+ chars) on both Vercel projects; same value.
- [ ] A signing helper identical to `signatureHeader` (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`), body serialised once.
- [ ] Call `provision` once per operator when they take the ads route; treat 200 `created` and `exists` the same.
- [ ] Push `state` on EVERY change listed in section 4, `stateAsOf` = time of the change; ignore `stale`.
- [ ] Push the full state after any outage, and consider a daily catch-up.
- [ ] Call `signin` at click time, redirect straight to the returned `url`, never store or log it.
- [ ] Never log bodies, emails, signatures, the secret or the sign-in url; log ids and codes only.
- [ ] Do not retry 400, 409 or 413. Retry 5xx, network errors, timeouts, 401 and 404 with a fresh signature.
