#!/usr/bin/env node
// M5 dedicated reschedule MCP: EXECUTABLE stdio entrypoint (production).
//
// Separate process from the readonly surface. Wires the REAL Google
// provider (`createGoogleRescheduleProvider`) with the SEPARATE
// `M5_RESCHEDULE_*` credential namespace and serves the dedicated stdio
// MCP (`google-calendar-reschedule` / `reschedule-event` only).
//
// Credential sources (explicit env OR persisted out-of-band grant):
// - Explicit env mode (documented contract, retained when valid): the full
//   `M5_RESCHEDULE_*` credential in the environment. Any partial env
//   credential refuses without falling through to the file.
// - Persisted-grant mode: the per-account grant written by `auth:write`
//   (`saveWriteCredentials` into `M5_RESCHEDULE_WRITE_TOKEN_PATH` or the
//   isolated default) combined with the existing OAuth client registration
//   (`loadCredentials`). The selected account is exact; missing/ambiguous/
//   readonly/broad/mismatch grants refuse. Refreshed access tokens persist
//   back atomically into the SAME per-account file (other accounts kept,
//   0600) — the single-token supplier format is never written over it.
//
// Defaults disabled: without a valid credential the process exits non-zero
// before listening (no partial surface, no readonly token reuse, no OAuth
// flow, no scope broadening, no live write at startup). Production Google
// URL is IMMUTABLE: this CLI never reads test endpoint overrides; those
// flags are ignored (never forwarded, never used as endpoint or token
// source). Fixture injection is NOT available here: tests use the explicit
// test-only programmatic runner at
// `src/tests/helpers/rescheduleTestRunner.ts` (unshipped, outside `bin`),
// which exercises the SAME production provider + MCP server factory.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCredentials } from "../auth/client.js";
import { validateAccountId } from "../auth/paths.js";
import { getSecureTokenPath } from "../auth/utils.js";
import {
  createAccessTokenSupplier,
  loadWriteCredentialFromEnv,
  type WriteCredentialConfig,
} from "./auth.js";
import { createGoogleRescheduleProvider } from "./google.js";
import { runRescheduleStdio } from "./server.js";
import {
  getWriteTokenPath,
  loadWriteStoredGrant,
  updateWriteStoredAccessToken,
} from "./writeTokenStore.js";

export type ClientRegistrationLoader = () => Promise<{
  client_id: string;
  client_secret: string;
}>;

export interface WriteRuntimeResolution {
  readonly credential: WriteCredentialConfig;
  readonly tokenPath: string;
  readonly source: "env" | "store";
}

function readonlyPathFor(env: NodeJS.ProcessEnv): string {
  if (env === process.env) {
    try {
      return getSecureTokenPath();
    } catch {
      return "";
    }
  }
  const override = env.GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH;
  if (override !== undefined && override.length > 0) return resolve(override);
  const configDir =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configDir, "google-calendar-mcp-readonly", "tokens.json");
}

function hasExplicitEnvCredential(env: NodeJS.ProcessEnv): boolean {
  for (const key of [
    "M5_RESCHEDULE_CLIENT_ID",
    "M5_RESCHEDULE_CLIENT_SECRET",
    "M5_RESCHEDULE_REFRESH_TOKEN",
    "M5_RESCHEDULE_GRANTED_SCOPE",
    "M5_RESCHEDULE_ACCESS_TOKEN",
  ] as const) {
    const value = env[key];
    if (value !== undefined && value.length > 0) return true;
  }
  return false;
}

/**
 * Resolve the write runtime credential (testable, no process exit, no
 * secrets in errors). Explicit env mode wins only when fully valid; any
 * partial env credential refuses without file fallthrough. Otherwise the
 * selected persisted grant + OAuth client registration authorizes the
 * runtime. Test endpoint overrides are never read here.
 */
export async function resolveWriteRuntimeCredential(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    loadClientRegistration?: ClientRegistrationLoader;
  } = {},
): Promise<WriteRuntimeResolution> {
  const account = env.M5_RESCHEDULE_ACCOUNT ?? "";
  if (account.length === 0) throw new Error("auth_refused: missing account");
  try {
    validateAccountId(account);
  } catch {
    throw new Error("auth_refused: invalid account");
  }
  const tokenPath = getWriteTokenPath(env);
  const readonlyPath = readonlyPathFor(env);
  if (readonlyPath !== "" && resolve(tokenPath) === resolve(readonlyPath)) {
    throw new Error("auth_refused: write token path collision");
  }
  if (hasExplicitEnvCredential(env)) {
    const credential = loadWriteCredentialFromEnv(env);
    return { credential, tokenPath, source: "env" };
  }
  const grant = await loadWriteStoredGrant(account, tokenPath).catch(() => {
    throw new Error("auth_refused: stored grant unavailable");
  });
  const loadRegistration = deps.loadClientRegistration ?? loadCredentials;
  let registration: { client_id: string; client_secret: string };
  try {
    registration = await loadRegistration();
  } catch {
    throw new Error("auth_refused: missing write OAuth client");
  }
  if (
    typeof registration.client_id !== "string" ||
    registration.client_id.length === 0 ||
    typeof registration.client_secret !== "string" ||
    registration.client_secret.length === 0
  ) {
    throw new Error("auth_refused: missing write OAuth client");
  }
  const refreshToken =
    typeof grant.refresh_token === "string" ? grant.refresh_token : "";
  const grantedScope = typeof grant.scope === "string" ? grant.scope : "";
  if (refreshToken.length === 0 || grantedScope.length === 0) {
    throw new Error("auth_refused: stored grant unavailable");
  }
  const accessToken =
    typeof grant.access_token === "string" && grant.access_token.length > 0
      ? grant.access_token
      : undefined;
  const expiresAt =
    typeof grant.expiry_date === "number" && Number.isFinite(grant.expiry_date)
      ? grant.expiry_date
      : undefined;
  const credential: WriteCredentialConfig = {
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    refreshToken,
    grantedScope,
    account,
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(expiresAt !== undefined ? { accessTokenExpiresAtMs: expiresAt } : {}),
  };
  return { credential, tokenPath, source: "store" };
}

async function persistStoreRefresh(
  account: string,
  tokenPath: string,
  accessToken: string,
  expiresAtMs: number,
): Promise<void> {
  await updateWriteStoredAccessToken(
    account,
    accessToken,
    expiresAtMs,
    tokenPath,
  );
}

async function main(): Promise<void> {
  let resolved: WriteRuntimeResolution;
  try {
    resolved = await resolveWriteRuntimeCredential(process.env);
  } catch {
    console.error(
      "reschedule-mcp: write credential not configured (auth_refused)",
    );
    process.exit(2);
    return;
  }
  const { credential, tokenPath, source } = resolved;
  const supplier = createAccessTokenSupplier({
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
  });
  try {
    await supplier.refreshIfExpired();
    if (source === "store") {
      await persistStoreRefresh(
        credential.account,
        tokenPath,
        supplier.getAccessToken(),
        supplier.getExpiresAtMs(),
      );
    }
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
    // source instead of a stale initial-refresh closure. Store mode persists
    // each renewal back into the per-account file (other accounts kept).
    refreshAccessToken: async () => {
      await supplier.refreshIfExpired();
      if (source === "store") {
        await persistStoreRefresh(
          credential.account,
          tokenPath,
          supplier.getAccessToken(),
          supplier.getExpiresAtMs(),
        );
      }
    },
    account: credential.account,
  });
  await runRescheduleStdio({
    provider,
    credentialScope: credential.grantedScope,
  });
}

// Entry guard: importing this module (tests resolving the credential
// loader) must not start the stdio server or exit the process. Production
// runs via `build/reschedule-cli.js` (argv contains `reschedule-cli`).
if (process.argv[1]?.includes("reschedule-cli") === true) {
  await main();
}
