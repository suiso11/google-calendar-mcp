# calendar-reschedule-mcp (M5 dedicated write entrypoint)

Separate stdio MCP entrypoint. Identity `google-calendar-reschedule` /
`1.0.0-reschedule.1` — deliberately distinct from the readonly
`google-calendar` / `3.0.0-readonly.2`. Registers ONLY `reschedule-event`
(start/end-only, strict `additionalProperties: false`, exact ISO
`start < end`, opaque `expectedEtag`).

Production provider: REAL Google Calendar `events.get` + `events.patch`
(`google.ts`) against the FIXED `https://www.googleapis.com` URL —
single fetch each, explicit bearer from the SEPARATE `M5_RESCHEDULE_*`
namespace, exact-whitespace write-scope check, exact account selection,
no readonly token reuse, no interactive OAuth flow, no scope broadening.
One conditional PATCH with `If-Match` only; 412 is definite
`etag_mismatch`; 5xx/timeout/abort/disconnect/malformed-2xx after dispatch
is `unknown` (never resend). Redirects refused before any credential leak.
Bounded timeout + abort + response size. No live writes in tests.

Run: `pnpm --filter @m5-fork/calendar-reschedule-mcp build` then
`node dist/cli.js` (executable: `calendar-reschedule-mcp`). Without the
full write credential the process exits non-zero before listening
(defaults disabled).
