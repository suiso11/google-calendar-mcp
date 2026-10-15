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
