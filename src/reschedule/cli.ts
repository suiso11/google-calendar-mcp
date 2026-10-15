#!/usr/bin/env node
// M5 dedicated reschedule MCP: EXECUTABLE stdio entrypoint (production).
//
// Separate process from the readonly surface. Wires the REAL Google
// provider (`createGoogleRescheduleProvider`) with the SEPARATE
// `M5_RESCHEDULE_*` credential namespace and serves the dedicated stdio
// MCP (`google-calendar-reschedule` / `reschedule-event` only).
//
// Defaults disabled: without the full write credential in the environment
// the process exits non-zero before listening (no partial surface, no
// readonly token reuse, no OAuth flow, no scope broadening, no live write
// at startup). Production Google URL is IMMUTABLE: this CLI never reads
// `M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE`, `M5_RESCHEDULE_TEST_ENDPOINT_BASE`,
// or `M5_RESCHEDULE_FORK_CLI`; those flags are ignored (never forwarded,
// never used as endpoint or token source). Fixture injection is NOT
// available here: tests use the explicit test-only programmatic runner at
// `src/tests/helpers/rescheduleTestRunner.ts` (unshipped, outside `bin`),
// which exercises the SAME production provider + MCP server factory.

import {
  createAccessTokenSupplier,
  loadWriteCredentialFromEnv,
  type WriteCredentialConfig,
} from "./auth.js";
import { createGoogleRescheduleProvider } from "./google.js";
import { runRescheduleStdio } from "./server.js";

async function main(): Promise<void> {
  let credential: WriteCredentialConfig;
  try {
    credential = loadWriteCredentialFromEnv(process.env);
  } catch {
    console.error(
      "reschedule-mcp: write credential not configured (auth_refused)",
    );
    process.exit(2);
    return;
  }
  const supplier = createAccessTokenSupplier({
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
    refreshToken: credential.refreshToken,
    grantedScope: credential.grantedScope,
    account: credential.account,
    ...(credential.accessToken !== undefined
      ? { accessToken: credential.accessToken }
      : {}),
  });
  try {
    await supplier.refreshIfExpired();
  } catch {
    console.error("reschedule-mcp: token refresh failed (auth_refused)");
    process.exit(2);
    return;
  }
  // Immutable production endpoint: no `endpointBase` is ever set here, so
  // the provider always uses the FIXED Google URL from `./provider.js`.
  const provider = createGoogleRescheduleProvider({
    getAccessToken: () => supplier.getAccessToken(),
    // Refresh-before-EACH-operation/dispatch as needed (no PATCH replay):
    // the provider awaits this before every GET and every PATCH, so a token
    // that ages out mid-process is renewed from a truly current lifecycle
    // source instead of a stale initial-refresh closure.
    refreshAccessToken: () => supplier.refreshIfExpired(),
    account: credential.account,
  });
  await runRescheduleStdio({
    provider,
    credentialScope: credential.grantedScope,
  });
}

await main();
