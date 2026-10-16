# Dedicated reschedule entrypoint (M5, separate surface)

Separate stdio MCP entrypoint. Identity `google-calendar-reschedule` /
`1.0.0-reschedule.1` — deliberately distinct from the readonly
`google-calendar` / `3.0.0-readonly.2`. Registers ONLY `reschedule-event`
(start/end-only, strict `additionalProperties: false`, exact ISO
`start < end`, opaque `expectedEtag`).

## Provenance

- Base: `6939311fd3eae9846648e0a175e304c9500f578e`
  (`feat/companion-readonly-compatibility`); this branch
  (`feat/m5-reschedule-entrypoint-v2`) has true ancestry on that commit.
- Reschedule sources under `src/reschedule/` (+ entry
  `src/reschedule-cli.ts`) are ported byte-identical from standalone work
  `164cb83` (orphan branch `feat/m5-reschedule-entrypoint`, no shared
  history — retained for reference, superseded by this branch).
- Readonly surface unchanged: `src/index.ts`, `src/server.ts`,
  `src/auth/*`, `src/handlers/*`, `src/tools/*`, `package.json`
  name/version (`@cocal/google-calendar-mcp` / `3.0.0-readonly.2`),
  `build/index.js` entry. Additive only: `src/reschedule/*`,
  `src/reschedule-cli.ts`, `build/reschedule-cli.js` bundle,
  `build:reschedule` / `start:reschedule` scripts, `calendar-reschedule-mcp`
  bin, this file.

## Production provider

REAL Google Calendar `events.get` + `events.patch`
(`src/reschedule/google.ts`) against the FIXED `https://www.googleapis.com`
URL — single fetch each, explicit bearer from the SEPARATE
`M5_RESCHEDULE_*` namespace, exact-whitespace write-scope check, exact
account selection, no readonly token reuse, no interactive OAuth flow, no
scope broadening. One conditional PATCH with `If-Match` only; 412 is
definite `etag_mismatch`; 5xx/timeout/abort/disconnect/malformed-2xx after
dispatch is `unknown` (never resend). Redirects refused before any
credential leak. Bounded timeout + abort + response size. No live writes in
tests (tests inject a loopback fixture ONLY through
`M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE=1` +
`M5_RESCHEDULE_TEST_ENDPOINT_BASE`, never set in production).

## Run

- Build only the separate entrypoint: `npm run build:reschedule`
- Full build (readonly bundles + reschedule bundle): `npm run build`
- Run: `npm run start:reschedule` (executable: `calendar-reschedule-mcp`).
  Without the full write credential the process exits non-zero before
  listening (defaults disabled).

## Checks

- `npm run lint` (tsc, includes `src/reschedule/*`)
- `npm run check:imports`
- `npm run build` then stdio smoke of `build/reschedule-cli.js` against a
  loopback fixture (see Companion Harness acceptance notes; no live
  Google, no OAuth activation).

## Separate write consent (out-of-band, user-driven)

The reschedule entrypoint never performs OAuth itself: grants are
provisioned out of band with the dedicated consent command, which reuses
the existing OAuth client registration for a SEPARATE narrow grant.

- Run: `npm run auth:write -- --account write --port 3500 --ttl-minutes 12 --no-browser`
  (entry `src/write-auth-server.ts` -> `build/write-auth-server.js`;
  sources `src/reschedule/writeAuthServer.ts`, `src/reschedule/writeAuthCli.ts`,
  `src/reschedule/writeTokenStore.ts`).
- Loopback only (`127.0.0.1`, exact redirect
  `http://127.0.0.1:<actual-port>/oauth2callback`); preferred ports
  `3500-3505`, dedicated fallback `3510`. The landing page links to Google;
  the state-bearing Google URL is never printed.
- Exact scope `https://www.googleapis.com/auth/calendar.events` only
  (state + PKCE-S256, single-use callback, 12-minute default window, 1-30
  minute clamp). Broad (`.../auth/calendar`) and readonly grants are refused
  and never persisted; a missing scope or refresh token refuses as well.
- Separate token file `~/.config/google-calendar-mcp-write/tokens.json`
  (override `M5_RESCHEDULE_WRITE_TOKEN_PATH`, 0600, multi-account merge).
  The readonly token file is never read or written; startup refuses when
  both paths resolve equal.
- No calendar reads/writes happen here and no write flags are enabled; a
  named TEST event plus explicit approval is still required before any
  reschedule.

## Review hardening (fork PR4 review, implemented as ground truth)

- Persisted-grant runtime: the per-account `auth:write` grant loads with the
  existing OAuth client registration into the CLI (`resolveWriteRuntimeCredential`);
  refreshed tokens persist back into the SAME per-account file (atomic merge,
  0600, other accounts kept). Partial env credentials and
  missing/ambiguous/readonly/broad grants refuse closed; TEST endpoint
  overrides are never read by the shipped CLI.
- Default-surface bounds: omitted `pageSize` sends `maxResults: 20` (one
  page, no eager pagination); `list-events`/`search-events` advertise and
  enforce exactly one optional account string (no multi-account array).
- Sparse cancelled GETs report `cancelled_unsupported` (0 PATCH) before
  bounds requirements; strict bounds still apply to non-cancelled events.
- Scope note: the DEFAULT entrypoint (`google-calendar` / `build/index.js`)
  still exposes EXACTLY the three readonly tools (see default smoke in
  acceptance notes). The separate opt-in entrypoint above exists under
  explicit user authorization per merged PR3 discussion 4283103241 and is NOT
  a widening of the default surface.

## Review hardening (fork PR3 review 5532918829, implemented as ground truth)

- Wildcard/list/stale etags never dispatch: `expectedEtag` must be an exact
  candidate (no `*`, no `,`) AND equal the just-read `current.etag`, checked
  in the server AND in the provider (direct calls safe). The approved etag
  still rides `If-Match` verbatim, so a GET→PATCH race is proven by HTTP 412
  (definite `etag_mismatch`, no apply, no resend).
- Strict calendar dates: `isStrictCalendarInstant` enforces month lengths,
  leap years, time/offset ranges (no `Date.parse` rollover — `2023-02-30`
  rejected); valid leap/fraction/offset instants and `start < end` preserved.
- Least privilege: any broad `.../auth/calendar` token in the scope string
  refuses the whole credential (startup AND refresh response, same
  `validateWriteCredential`); a refused refresh persists no token file.
- Preflight GET 429/500 keeps the redacted definite `read_upstream_error`
  (0 PATCH, no retry, no secret body), distinct from `invalid_input`; all
  other failure outcomes unchanged.
- Scope note (discussion 4282819721): the DEFAULT entrypoint
  (`google-calendar` / `build/index.js`) still exposes EXACTLY the three
  readonly tools — pinned by
  `src/tests/unit/reschedule/defaultReadonlyEntry.test.ts` (no reschedule
  imports in default sources, bin mapping unchanged). The separate opt-in
  entrypoint above exists under explicit user authorization and is NOT a
  widening of the default surface.
