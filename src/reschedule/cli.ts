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
// at startup). Production Google URL is FIXED (no endpoint override env;
// `endpointBase` stays unset in this CLI).

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
    // Explicit TEST seam only: when the caller sets
    // `M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE=1`, the provisioned fake
    // access token is treated as currently valid (no live OAuth round-trip
    // at startup or per dispatch in tests). Production never sets this flag.
    ...(process.env.M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE === "1" &&
    credential.accessToken !== undefined &&
    credential.accessToken.length > 0
      ? { accessTokenExpiresAtMs: Date.now() + 3_600_000 }
      : {}),
  });
  // Explicit TEST seam only: when the caller sets
  // `M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE=1`, the loopback fixture
  // base from `M5_RESCHEDULE_TEST_ENDPOINT_BASE` is used (tests provision a
  // fake token treated as current above; no live OAuth). Production never
  // sets this flag, so production always uses the FIXED Google URL +
  // refresh-before-every-dispatch.
  const testOverride =
    process.env.M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE === "1"
      ? (process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE ?? "")
      : "";
  const hasCurrentToken =
    credential.accessToken !== undefined && credential.accessToken.length > 0;
  if (testOverride.length > 0 && hasCurrentToken) {
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => supplier.getAccessToken(),
      refreshAccessToken: () => supplier.refreshIfExpired(),
      account: credential.account,
      endpointBase: testOverride,
    });
    await runRescheduleStdio({
      provider,
      credentialScope: credential.grantedScope,
    });
    return;
  }
  try {
    await supplier.refreshIfExpired();
  } catch {
    console.error("reschedule-mcp: token refresh failed (auth_refused)");
    process.exit(2);
    return;
  }
  const provider = createGoogleRescheduleProvider({
    getAccessToken: () => supplier.getAccessToken(),
    // Refresh-before-EACH-operation/dispatch as needed (no PATCH replay):
    // the provider awaits this before every GET and every PATCH, so a token
    // that ages out mid-process is renewed from a truly current lifecycle
    // source instead of a stale initial-refresh closure.
    refreshAccessToken: () => supplier.refreshIfExpired(),
    account: credential.account,
    ...(testOverride.length > 0 ? { endpointBase: testOverride } : {}),
  });
  await runRescheduleStdio({
    provider,
    credentialScope: credential.grantedScope,
  });
}

await main();
