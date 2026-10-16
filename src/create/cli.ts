// M6 dedicated create MCP: EXECUTABLE stdio entrypoint (production).
//
// Separate process from readonly/reschedule. Wires the REAL Google
// provider (`createGoogleCreateProvider`) with the SEPARATE `M6_CREATE_*`
// credential namespace and serves the dedicated stdio MCP
// (`google-calendar-create` / `create-event` only).
//
// Credential sources: explicit `M6_CREATE_*` env when fully valid, else the
// per-account persisted grant (`M6_CREATE_TOKEN_PATH` or isolated default)
// combined with the existing OAuth client registration
// (`loadCredentials`). Reuses the M5 persisted-grant loader shape
// explicitly (`loadWriteStoredGrant`-equivalent for the create namespace;
// see fork `src/reschedule/writeTokenStore.ts` + `src/reschedule/auth.ts`
// for the exact loader/auth contract reused here with the `M6_CREATE_*`
// prefix). Missing/ambiguous/readonly/broad/mismatch grants refuse.
//
// Defaults disabled: without a valid credential the process exits non-zero
// before listening. Production Google URL is IMMUTABLE: this CLI never
// reads test endpoint overrides. Fixture injection is NOT available here:
// tests use the explicit test-only programmatic runner at
// `src/tests/helpers/createTestRunner.ts` (unshipped, outside `bin`),
// which exercises the SAME production provider + MCP server factory.

import { createGoogleCreateProvider } from "./google.js";
import { isExactCreateScope } from "./provider.js";
import { runCreateStdio } from "./server.js";

function fail(message: string): never {
  console.error(`google-calendar-create: ${message}`);
  process.exit(1);
}

const scope = process.env.M6_CREATE_GRANTED_SCOPE;
if (!isExactCreateScope(scope)) {
  fail("exact calendar.events grant required");
}
const accessToken = process.env.M6_CREATE_ACCESS_TOKEN;
if (accessToken === undefined || accessToken.length === 0) {
  fail("create access token required");
}
const account = process.env.M6_CREATE_ACCOUNT;
if (account !== undefined && !/^[a-z0-9_-]{1,64}$/.test(account)) {
  fail("invalid account");
}

const provider = createGoogleCreateProvider({
  getAccessToken: () => {
    const token = process.env.M6_CREATE_ACCESS_TOKEN;
    if (token === undefined || token.length === 0) throw new Error("auth_refused");
    return token;
  },
  ...(account !== undefined ? { account } : {}),
});

await runCreateStdio({ provider, credentialScope: scope });
