# Changelog (reschedule entrypoint)

## 1.0.0-reschedule.2 — real Google runtime

- REAL Google HTTP adapter (`google.ts`): exact events.get/patch shape
  normalization, recurring/instance/cancelled/deleted/all-day rejects,
  GET 404/410 no-write definite, PATCH start/end-only `If-Match`, 412
  definite `etag_mismatch`, 5xx/timeout/abort/malformed-2xx `unknown`,
  single fetch each, bounded timeout/abort/response-size, redirect refused.
- REAL auth (`auth.ts`): separate `M5_RESCHEDULE_*` namespace, exact
  whitespace scope tokens (substring match removed), exact account
  selection, refresh-before-dispatch only, separate 0600 token persistence,
  no interactive flow, no readonly reuse.
- Executable CLI (`cli.ts`, bin `calendar-reschedule-mcp`, `start` runs
  `dist/cli.js`); strict ISO `start < end` schema; SDK signal cancellation;
  real bounded stdio shutdown race.
- Production fixture provider REMOVED from production (fixtures live in
  tests only).
