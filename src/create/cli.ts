// M6 dedicated create MCP: EXECUTABLE stdio entrypoint (production).
//
// Separate process from readonly/reschedule. Wires the REAL Google
// provider (`createGoogleCreateProvider`) with the SHARED persisted write
// grant (the SAME `M5_RESCHEDULE_*` credential namespace + per-account
// grant file + existing OAuth client registration as the reschedule
// entrypoint) and serves the dedicated stdio MCP
// (`google-calendar-create` / `create-event` only).
//
// There is NO `M6_CREATE_*` credential namespace: the narrow
// `calendar.events` grant is scope-identical for reschedule and create, so
// the create runtime reuses the existing write runtime resolution
// (`resolveWriteRuntimeCredential` from `../reschedule/cli.js`), the
// existing before-dispatch token supplier (`createAccessTokenSupplier`
// from `../reschedule/auth.js`), and the same per-account persisted file
// (`updateWriteStoredAccessToken` from
// `../reschedule/writeTokenStore.js`). Credential sources, refusal rules,
// and refresh/persist behavior are therefore byte-identical to the
// reschedule CLI: explicit `M5_RESCHEDULE_*` env wins only when fully
// valid (any partial env credential refuses without file fallthrough),
// otherwise the selected persisted grant (`M5_RESCHEDULE_WRITE_TOKEN_PATH`
// or the isolated default) combined with the existing OAuth client
// registration (`loadCredentials` via `GOOGLE_OAUTH_CREDENTIALS`)
// authorizes the runtime. Missing/ambiguous/readonly/broad/mismatch
// grants refuse. Refreshed access tokens persist back atomically into the
// SAME per-account file (other accounts kept, 0600) — the single-token
// supplier format is never written over it.
//
// Defaults disabled: without a valid credential the process exits non-zero
// before listening. Production Google URL is IMMUTABLE: this CLI never
// reads test endpoint overrides. Fixture injection is NOT available here:
// tests use the explicit test-only programmatic runner at
// `src/tests/helpers/createTestRunner.ts` (unshipped, outside `bin`),
// which exercises the SAME production provider + MCP server factory
// through the SAME resolution/factory below with an explicit loopback
// endpoint passed PROGRAMMATICALLY (never via env).

import { loadCredentials } from "../auth/client.js";
import {
  createAccessTokenSupplier,
  type WriteCredentialConfig,
} from "../reschedule/auth.js";
import {
  resolveWriteRuntimeCredential,
  type ClientRegistrationLoader,
  type WriteRuntimeResolution,
} from "../reschedule/cli.js";
import { updateWriteStoredAccessToken } from "../reschedule/writeTokenStore.js";
import { createGoogleCreateProvider } from "./google.js";
import { runCreateStdio } from "./server.js";

export type { ClientRegistrationLoader, WriteRuntimeResolution };
export { resolveWriteRuntimeCredential };

/**
 * Test seam for the before-dispatch token endpoint / fetch / loopback
 * API base. Production NEVER sets these: the token endpoint stays the
 * fixed Google OAuth URL and the API base stays the fixed Google URL from
 * `./provider.js`. Tests inject a loopback OAuth fixture and/or a
 * loopback Google-shaped fixture PROGRAMMATICALLY (never via env).
 */
export interface CreateRuntimeFactoryOverrides {
  readonly tokenEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Explicit TEST seam only: loopback fixture base. Never set in prod. */
  readonly endpointBase?: string;
}

/**
 * Build the production create provider from an already-resolved write
 * runtime: refresh-before-startup (persisted back into the SAME
 * per-account file in store mode), then refresh-before-EACH-operation
 * (the provider awaits the hook before every insert, so a token that ages
 * out mid-process is renewed from the live supplier instead of a stale
 * closure; store mode persists each renewal back, other accounts kept).
 * The configured account is frozen from the resolved loader credential —
 * live env is never re-read per dispatch.
 */
export async function createCreateRuntimeProvider(
  resolved: WriteRuntimeResolution,
  overrides: CreateRuntimeFactoryOverrides = {},
): Promise<{
  readonly provider: ReturnType<typeof createGoogleCreateProvider>;
  readonly credentialScope: string;
}> {
  const { credential, tokenPath, source } = resolved;
  const supplierConfig: WriteCredentialConfig = {
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
    refreshToken: credential.refreshToken,
    grantedScope: credential.grantedScope,
    account: credential.account,
    ...(credential.accessToken !== undefined
      ? { accessToken: credential.accessToken }
      : {}),
    ...(credential.accessTokenExpiresAtMs !== undefined
      ? { accessTokenExpiresAtMs: credential.accessTokenExpiresAtMs }
      : {}),
    ...(overrides.tokenEndpoint !== undefined
      ? { tokenEndpoint: overrides.tokenEndpoint }
      : {}),
    ...(overrides.fetchImpl !== undefined
      ? { fetchImpl: overrides.fetchImpl }
      : {}),
    ...(overrides.timeoutMs !== undefined
      ? { timeoutMs: overrides.timeoutMs }
      : {}),
  };
  const supplier = createAccessTokenSupplier(supplierConfig);
  await supplier.refreshIfExpired();
  if (source === "store") {
    await updateWriteStoredAccessToken(
      credential.account,
      supplier.getAccessToken(),
      supplier.getExpiresAtMs(),
      tokenPath,
    );
  }
  // Immutable production endpoint: no `endpointBase` is ever set here, so
  // the provider always uses the FIXED Google URL from `./provider.js`
  // unless an explicit test override is injected above.
  const provider = createGoogleCreateProvider({
    getAccessToken: () => supplier.getAccessToken(),
    refreshAccessToken: async () => {
      await supplier.refreshIfExpired();
      if (source === "store") {
        await updateWriteStoredAccessToken(
          credential.account,
          supplier.getAccessToken(),
          supplier.getExpiresAtMs(),
          tokenPath,
        );
      }
    },
    account: credential.account,
    ...(overrides.endpointBase !== undefined
      ? { endpointBase: overrides.endpointBase }
      : {}),
  });
  return { provider, credentialScope: credential.grantedScope };
}

/**
 * Resolve the create runtime credential (testable, no process exit, no
 * secrets in errors). This IS the shared write runtime resolution: the
 * `M5_RESCHEDULE_*` namespace, the per-account persisted grant file, and
 * the existing OAuth client registration. Test endpoint overrides are
 * never read here.
 */
export async function resolveCreateRuntimeCredential(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    loadClientRegistration?: ClientRegistrationLoader;
  } = {},
): Promise<WriteRuntimeResolution> {
  return resolveWriteRuntimeCredential(env, deps);
}

async function main(): Promise<void> {
  let resolved: WriteRuntimeResolution;
  try {
    resolved = await resolveWriteRuntimeCredential(process.env, {
      loadClientRegistration: loadCredentials,
    });
  } catch {
    console.error(
      "google-calendar-create: write credential not configured (auth_refused)",
    );
    process.exit(2);
    return;
  }
  let runtime: Awaited<ReturnType<typeof createCreateRuntimeProvider>>;
  try {
    runtime = await createCreateRuntimeProvider(resolved);
  } catch {
    console.error("google-calendar-create: token refresh failed (auth_refused)");
    process.exit(2);
    return;
  }
  await runCreateStdio({
    provider: runtime.provider,
    credentialScope: runtime.credentialScope,
  });
}

// Entry guard: importing this module (tests resolving the credential
// loader / provider factory) must not start the stdio server or exit the
// process. Production runs via `build/create-cli.js` (argv contains
// `create-cli`). The reschedule guard (`reschedule-cli`) stays false here,
// so importing the shared loader never starts the reschedule server.
if (process.argv[1]?.includes("create-cli") === true) {
  await main();
}
