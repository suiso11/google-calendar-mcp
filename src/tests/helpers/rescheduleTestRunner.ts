// M5 TEST-ONLY programmatic runner (NEVER shipped, outside `bin`).
//
// Exercises the SAME production provider (`createGoogleRescheduleProvider`)
// and the SAME MCP server factory (`createRescheduleServer` /
// `runRescheduleStdio`) with an explicit loopback `endpointBase` passed
// PROGRAMMATICALLY (never via shipped-CLI env flags). The shipped CLI
// (`src/reschedule/cli.ts`, bin `calendar-reschedule-mcp`) ignores all
// `M5_RESCHEDULE_TEST_*` env and always uses the immutable Google host.
// This module is imported ONLY by tests; `scripts/build.js` never bundles
// it (entrypoints are `src/index.ts`, `src/auth-server.ts`,
// `src/reschedule-cli.ts` only) and `package.json` `files` ships only
// `build/`.

import { createAccessTokenSupplier } from "../../reschedule/auth.js";
import { createGoogleRescheduleProvider } from "../../reschedule/google.js";
import {
  createRescheduleServer,
  runRescheduleStdio,
} from "../../reschedule/server.js";

export { createGoogleRescheduleProvider, createRescheduleServer };

export interface TestRunnerCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly grantedScope: string;
  readonly account: string;
  readonly accessToken: string;
}

/** Default fake write credential for fixture tests (never real Google). */
export function testCredential(
  overrides: Partial<TestRunnerCredential> = {},
): TestRunnerCredential {
  return {
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    grantedScope: "https://www.googleapis.com/auth/calendar.events",
    account: "test-account",
    accessToken: "fake-token-for-tests",
    ...overrides,
  };
}

/**
 * Build the SAME production provider + server with an explicit loopback
 * endpoint (programmatic injection, no env bypass). The fake access token
 * is treated as currently valid (no live OAuth round-trip).
 */
export function createTestRescheduleServer(
  endpointBase: string,
  credential: TestRunnerCredential = testCredential(),
) {
  const supplier = createAccessTokenSupplier({
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
    refreshToken: credential.refreshToken,
    grantedScope: credential.grantedScope,
    account: credential.account,
    accessToken: credential.accessToken,
    accessTokenExpiresAtMs: Date.now() + 3_600_000,
  });
  const provider = createGoogleRescheduleProvider({
    getAccessToken: () => supplier.getAccessToken(),
    refreshAccessToken: () => supplier.refreshIfExpired(),
    account: credential.account,
    endpointBase,
  });
  return createRescheduleServer({
    provider,
    credentialScope: credential.grantedScope,
  });
}

/** Stdio entry for child-process tests: explicit endpoint, same factory. */
export async function runTestRescheduleStdio(
  endpointBase: string,
  credential: TestRunnerCredential = testCredential(),
): Promise<void> {
  const supplier = createAccessTokenSupplier({
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
    refreshToken: credential.refreshToken,
    grantedScope: credential.grantedScope,
    account: credential.account,
    accessToken: credential.accessToken,
    accessTokenExpiresAtMs: Date.now() + 3_600_000,
  });
  const provider = createGoogleRescheduleProvider({
    getAccessToken: () => supplier.getAccessToken(),
    refreshAccessToken: () => supplier.refreshIfExpired(),
    account: credential.account,
    endpointBase,
  });
  await runRescheduleStdio({
    provider,
    credentialScope: credential.grantedScope,
  });
}
