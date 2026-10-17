// M6 TEST-ONLY create runner (never shipped, never production).
//
// Exercises the SAME production provider (`createGoogleCreateProvider`)
// and the SAME MCP server factory (`createCreateServer` /
// `runCreateStdio`) through the SAME production credential resolution +
// provider factory (`resolveCreateRuntimeCredential` /
// `createCreateRuntimeProvider` from `../../create/cli.js`) with an
// explicit loopback `endpointBase` passed PROGRAMMATICALLY (never via
// shipped-CLI env flags). The shipped CLI (`src/create/cli.ts`, bin
// `calendar-create-mcp`) ignores all `M6_CREATE_TEST_*` env and always
// uses the immutable Google host. This module is imported ONLY by tests;
// `scripts/build.js` never bundles it (entrypoints are `src/index.ts`,
// `src/auth-server.ts`, `src/reschedule-cli.ts`, `src/create/cli.ts`
// only) and `package.json` `files` ships only `build/`.

import {
  createCreateRuntimeProvider,
  resolveCreateRuntimeCredential,
} from "../../create/cli.js";
import { createGoogleCreateProvider } from "../../create/google.js";
import {
  createCreateServer,
  runCreateStdio,
} from "../../create/server.js";
import { createAccessTokenSupplier } from "../../reschedule/auth.js";

export { createGoogleCreateProvider, createCreateServer };

export interface TestRunnerCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly grantedScope: string;
  readonly account: string;
  readonly accessToken: string;
}

/** Default fixture write credential for tests (never real Google). */
export function testCreateCredential(
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
 * endpoint (programmatic injection, no env bypass). The fixture access
 * token is treated as currently valid (future expiry, no live OAuth
 * round-trip) through the SAME production token supplier.
 */
export function createTestCreateServer(
  endpointBase: string,
  credential: TestRunnerCredential = testCreateCredential(),
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
  const provider = createGoogleCreateProvider({
    getAccessToken: () => supplier.getAccessToken(),
    refreshAccessToken: () => supplier.refreshIfExpired(),
    account: credential.account,
    endpointBase,
  });
  return createCreateServer({
    provider,
    credentialScope: credential.grantedScope,
  });
}

/**
 * Stdio entry for child-process tests: resolve the REAL persisted grant
 * from the process env through the SAME production resolution, then serve
 * the SAME production provider + MCP server factory against the explicit
 * loopback endpoint (programmatic injection, no env bypass). The temp
 * grant carries a future-expiry access token so no refresh network is
 * needed.
 */
export async function runTestCreateStdio(
  endpointBase: string,
): Promise<void> {
  const resolved = await resolveCreateRuntimeCredential(process.env);
  const runtime = await createCreateRuntimeProvider(resolved, {
    endpointBase,
  });
  await runCreateStdio({
    provider: runtime.provider,
    credentialScope: runtime.credentialScope,
  });
}
