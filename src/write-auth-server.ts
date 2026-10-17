// M5 SEPARATE write-consent entrypoint (out-of-band Google consent only).
//
// Provenance: additive on the readonly base
// `6939311fd3eae9846648e0a175e304c9500f578e` alongside the separate
// reschedule line (`src/reschedule/`, entry `src/reschedule-cli.ts`). The
// readonly entry (`src/index.ts` -> `build/index.js`, name
// `google-calendar`, version `3.0.0-readonly.2`) is untouched: this bundle
// (`build/write-auth-server.js`, script `npm run auth:write`) registers NO
// MCP tools and performs NO calendar reads/writes.
//
// Run (user-driven, loopback only):
//   npm run auth:write -- --account write --port 3500 --ttl-minutes 12 --no-browser
// The server prints only the LOCAL landing URL (the state-bearing Google
// URL is opened from the landing page, never logged) and exits when the
// user approves or the bounded window expires.

import { runWriteAuthCli } from "./reschedule/writeAuthCli.js";

await runWriteAuthCli(process.argv.slice(2));
