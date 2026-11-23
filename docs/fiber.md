# Vendor discovery with Fiber AI

When a property's vendor directory has no approved vendor for a case's trade, Relay can look for local businesses
with [Fiber AI](https://fiber.ai), check what comes back, and put the plausible ones in front of a manager.

**Discovery is not authorization.** A business found by a search is never contacted by Relay, never offered work,
and never shown to a resident or contractor. It becomes a vendor only when a manager verifies it themselves and
approves it for that property.

## What is called

Relay uses the official TypeScript SDK, [`@fiberai/sdk`](https://www.npmjs.com/package/@fiberai/sdk) `0.0.66`, and two
documented operations. The request and response shapes come from the SDK's generated types and these sources:

- https://api.fiber.ai/llms.txt
- https://docs.fiber.ai/build
- https://docs.fiber.ai/build/sdks
- https://docs.fiber.ai/account/api-keys

| Purpose | SDK function | HTTP | Request | Cost |
| --- | --- | --- | --- | --- |
| Balance check before any paid call | `getOrgCredits` | `GET /v1/get-org-credits` | `apiKey` | free |
| Local business search | `googleMapsSearch2` | `POST /v1/google-maps/search` | `apiKey`, `query`, `location` | 2 credits per search (one page of up to 20 places) |

The response fields Relay reads are:

- `output.places[]`: `placeId`, `name`, `url`, `rating`, `reviewCount`, `phoneNumber`, `websiteUrl`, `address`, `categories`, `openingHours`, `coordinates`;
- `chargeInfo`, `warnings` and `advice`, recorded verbatim on the discovery row.

Errors are mapped from the documented statuses:

| Status | Error code | Retried? |
| --- | --- | --- |
| 401 / 403 | `auth`; `API_KEY_*CREDIT_LIMIT*` is `key_limit` | No |
| 402 | `credits_exhausted`, including `outOfCreditsAlert` | No |
| 429 | `rate_limited` | Yes |
| 500 / 503 | `provider_error` | Yes |
| No response | `unreachable` / `timeout` | Yes |
| 501 | `sandbox_unsupported` | No |

Code: `app/src/server/vendors/fiber.ts`.

## What is sent

Exactly a trade phrase and the building's city, for example `"heating and cooling contractor"` near
`"Waterloo, ON"`. Never a resident's name, unit, words or contact details. The API key is read only on the server,
sent in the request body as the SDK requires, and never logged, stored, returned to a browser or put in an error
message.

## The workflow

1. **Coverage check.** When a case needs a vendor (routed, declined, expired, rejected, reopened, resumed), the
   coordinator job first runs a deterministic check, model or no model: is any vendor approved at this property for
   the trade, excluding ones that already declined or lapsed on this case?
2. **A discovery task on the case** (`VendorDiscovery`):
   - `QUEUED` when the property allows automatic discovery or a manager asked for it;
   - otherwise `AWAITING_MANAGER`, with a button to approve the search;
   - at most one in flight per case and trade, enforced by a partial unique index, so concurrent triggers cannot
     start two paid searches.
3. **Cache.** The same property, trade, query and location within `FIBER_CACHE_DAYS` (14) reuses the earlier result:
   a new row marked "reused", no call, no credits. Refreshing a page never calls the provider.
4. **The job** (`vendorDiscoveryJob`, pg-boss):
   - claims the row (`QUEUED` to `RUNNING`, compare-and-set), so one worker runs it however many times it was queued;
   - checks the balance (free);
   - refuses if the search would go below the reserve or over the daily budget;
   - makes ONE search;
   - saves the raw places with `chargeInfo` before doing anything else, so an interrupted run resumes from the saved
     response without paying again;
   - retries `unreachable` / `timeout` / 429 / 5xx with backoff (three attempts), and fails clearly after that.
5. **Checks on every place** (`evaluatePlace`), all from the source fields:
   - a business at all? (parks, transit stops and landmarks are dropped);
   - the right trade? (supply stores are not service providers);
   - distance from the building, against the property's `serviceRadiusKm`;
   - a phone or website listed?
   - already a vendor in Relay? (place id, normalized name, phone digits or website host);
   - what nobody has confirmed: licence, insurance, availability, pricing, email.
6. **Keep the best few.** At most `FIBER_MAX_CANDIDATES` (3) are kept and ranked by area, trade fit, contact
   details and reviews. Everything dropped is listed with the reason. The same business found again updates its
   existing row (`timesSeen`); it is never duplicated.
7. **The manager decides**, on the case page or the Vendors page:
   - reject (with a reason), shortlist, or **mark verified** (a note of what they checked);
   - only a verified business can be **approved for this property**, and only with a phone or email.
   - A duplicate of an existing vendor approves that vendor at this property instead of creating a copy.
   - Approval flags every case at the property waiting for that trade, so the coordinator resumes it.
8. **The AI's part.** The coordinator can list the candidates, ask for a search (only when there is no approved
   vendor), and leave a short note on a candidate. The note is kept only if it passes the grounding check: no number,
   claim (licence, insurance, availability, price) or name that is not in the listing. It cannot propose, contact or
   approve a candidate: `propose_vendor` accepts only refs from `list_vendors`, which reads the approved directory.

## Cost controls

| Setting | Default | Meaning |
| --- | --- | --- |
| `FIBER_CREDITS_PER_SEARCH` | 2 | The documented price, checked against the balance before every paid call |
| `FIBER_MIN_BALANCE` | 10 | Never search if the balance would go below this |
| `FIBER_DAILY_CREDIT_BUDGET` | 6 | At most this many credits per UTC day, summed from recorded `chargeInfo` |
| `FIBER_MAX_CANDIDATES` | 3 | Businesses kept per search |
| `FIBER_CACHE_DAYS` | 14 | Reuse a result instead of searching again |
| Property "search automatically" | off (on for the Maple Court demo) | Off: a manager approves each search first |

`sk_test_` keys run in Fiber's sandbox (no credits). The docs do not say whether Google Maps search is available in
the sandbox: a 501 is handled as `sandbox_unsupported`.

## Modes

| `FIBER_MODE` | Behaviour |
| --- | --- |
| unset, key set | `live` (`sk_live_`) or `sandbox` (`sk_test_`) |
| unset, no key | `off`: discovery is skipped with the reason. Managers add vendors by hand and the case is not blocked |
| `fixture` | The real SDK call path runs against a local fixture "API" (`app/src/server/vendors/fixtures.ts`) of FICTIONAL businesses in the documented response shape. Its `chargeInfo` says no call was made. Used by the tests, CI and demos without a key. Scenarios: normal, empty, down, exhausted, exhausted_mid, rate_limited, server_error, invalid_key, slow |

Fixture results are labelled as fixture data everywhere they appear. They are never presented as live results.

## Tests

`app/tests/api/discovery.test.ts`, 18 tests over HTTP in fixture mode, covers:

- vendor exists;
- no vendor;
- valid results, with the exact query, `chargeInfo` recorded, reasons citing fields, and the unknowns listed;
- filtered places with reasons;
- duplicates of a known vendor;
- resident and cross-property isolation;
- cache reuse with no new call;
- a forced search that deduplicates rows;
- wrong area and missing contacts;
- an unverified candidate that cannot be dispatched or onboarded;
- reject, reopen and verify with notes;
- concurrent onboarding;
- duplicate onboarding;
- contact details required;
- no results;
- the API down (three attempts, then a clear failure);
- credits exhausted (a balance check before any search, and a 402 that is not retried);
- no key;
- concurrent requests making one call;
- an interrupted run resuming without a second call;
- repeated interruptions failing clearly.

The browser journey "missing vendor" (`app/e2e/tests/journeys.spec.ts`) does the same through the UI.

## Live validation

`app/scripts/fiber-live-check.ts` makes ONE capped live search, and only with `--yes`:

1. the free balance check;
2. a refusal below the reserve;
3. one search for 2 credits;
4. at most 3 businesses kept;
5. `chargeInfo` and warnings written to `docs/evidence/fiber-live-check.json`.

**Status:** see [STATUS.md](../STATUS.md). This build had no `FIBER_API_KEY` available, so no live call was made and
no credits were used; every result above comes from fixtures.
