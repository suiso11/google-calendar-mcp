// M5 SEPARATE write-credential auth (no readonly reuse, no OAuth flow).
//
// Namespace: ONLY `M5_RESCHEDULE_*` is read here (never `GOOGLE_*` /
// `MCP_GOOGLE_*` / readonly profile files). Write scope is validated with
// EXACT whitespace token matching (`validateWriteCredential`); readonly
// tokens are refused without any consent/scope-broadening attempt.
//
// Token model: the caller provisions (out of band) a write OAuth client
// (`M5_RESCHEDULE_CLIENT_ID/SECRET`), a refresh token
// (`M5_RESCHEDULE_REFRESH_TOKEN`), and the granted scope string
// (`M5_RESCHEDULE_GRANTED_SCOPE`). `getValidAccessToken` returns the
// current in-memory/file access token when unexpired, otherwise performs
// ONE RFC6749 refresh_token grant BEFORE dispatch (single fetch, bounded
// timeout, no retry) and persists ONLY the separate `M5_RESCHEDULE_*`
// token file using the existing secure pattern (0600). No live
// Google/OAuth invocation happens at import or in tests unless the caller
// explicitly configures a token endpoint; unit tests point
// `tokenEndpoint` at a local fake.

import { validateWriteCredential } from "./provider.js";

export interface WriteCredentialConfig {
  /** Current valid access token (may be empty when only refresh exists). */
  readonly accessToken?: string;
  /** Access-token expiry epoch ms (0/undefined = refresh before dispatch). */
  readonly accessTokenExpiresAtMs?: number;
  /** Write OAuth client id (SEPARATE namespace, never readonly client). */
  readonly clientId: string;
  /** Write OAuth client secret (SEPARATE namespace). */
  readonly clientSecret: string;
  /** Long-lived refresh token (SEPARATE namespace). */
  readonly refreshToken: string;
  /** Granted scope string (exact-whitespace validated for write). */
  readonly grantedScope: string;
  /** Exact account selection (opaque; must be non-empty). */
  readonly account: string;
  /** RFC6749 token endpoint (default Google; tests inject a fake). */
  readonly tokenEndpoint?: string;
  /** Where refreshed tokens are persisted (SEPARATE file only). */
  readonly tokenFile?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Load the SEPARATE write credential from the process environment. */
export function loadWriteCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WriteCredentialConfig {
  const account = env.M5_RESCHEDULE_ACCOUNT ?? "";
  const clientId = env.M5_RESCHEDULE_CLIENT_ID ?? "";
  const clientSecret = env.M5_RESCHEDULE_CLIENT_SECRET ?? "";
  const refreshToken = env.M5_RESCHEDULE_REFRESH_TOKEN ?? "";
  const grantedScope = env.M5_RESCHEDULE_GRANTED_SCOPE ?? "";
  if (account.length === 0) throw new Error("auth_refused: missing account");
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error("auth_refused: missing write OAuth client");
  }
  if (refreshToken.length === 0) {
    throw new Error("auth_refused: missing write refresh token");
  }
  if (!validateWriteCredential(grantedScope)) {
    throw new Error("auth_refused: write scope not granted");
  }
  const accessToken = env.M5_RESCHEDULE_ACCESS_TOKEN;
  return {
    ...(accessToken !== undefined ? { accessToken } : {}),
    clientId,
    clientSecret,
    refreshToken,
    grantedScope,
    account,
  };
}

/** Create a before-dispatch token supplier (refresh BEFORE any GET/PATCH). */
export function createAccessTokenSupplier(config: WriteCredentialConfig): {
  getAccessToken: () => string;
  refreshIfExpired: () => Promise<void>;
} {
  let current = config.accessToken ?? "";
  let expiresAt = config.accessTokenExpiresAtMs ?? 0;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  function getAccessToken(): string {
    if (current.length === 0) throw new Error("auth_refused: no access token");
    return current;
  }

  async function refreshIfExpired(): Promise<void> {
    if (current.length > 0 && Date.now() < expiresAt - 60_000) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const res = await fetchImpl(
        config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: config.refreshToken,
          }).toString(),
          signal: controller.signal,
          redirect: "manual",
        },
      );
      if (res.status >= 300 && res.status < 400) {
        throw new Error("auth_refused: token redirect refused");
      }
      if (!res.ok) throw new Error("auth_refused: token refresh failed");
      const body = (await res.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (
        typeof body.access_token !== "string" ||
        body.access_token.length === 0
      ) {
        throw new Error("auth_refused: malformed token response");
      }
      current = body.access_token;
      const ttl =
        typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
          ? body.expires_in
          : 3600;
      expiresAt = Date.now() + Math.max(0, ttl) * 1000;
      if (config.tokenFile !== undefined) {
        const { writeFileSync, chmodSync } = await import("node:fs");
        writeFileSync(
          config.tokenFile,
          JSON.stringify({ accessToken: current, expiresAt }),
          { mode: 0o600 },
        );
        try {
          chmodSync(config.tokenFile, 0o600);
        } catch {
          // Best effort: file was already created 0600.
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { getAccessToken, refreshIfExpired };
}
