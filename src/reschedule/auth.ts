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
// timeout AND bounded body, no retry) and persists ONLY the separate
// `M5_RESCHEDULE_*` token file using the existing secure pattern (0600).
// The same file is READ back at supplier creation (secure persistence, not
// write-only): an explicit `accessToken` in the config still wins over the
// file. No live Google/OAuth invocation happens at import or in tests
// unless the caller explicitly configures a token endpoint; unit tests
// point `tokenEndpoint` at a local fake.

import { readFileSync } from "node:fs";
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

/** Bound on the token-refresh response body (never unbounded). */
export const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * Read back the separately persisted write token (secure persistence, not
 * write-only). Returns null when the file is absent/unparseable — the
 * caller then falls back to an explicit token or a fresh refresh. Never
 * throws, never logs paths or contents.
 */
function readPersistedWriteToken(
  tokenFile: string,
): { accessToken: string; expiresAt: number } | null {
  let raw: string;
  try {
    raw = readFileSync(tokenFile, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { accessToken?: unknown; expiresAt?: unknown };
  if (
    typeof body.accessToken !== "string" ||
    body.accessToken.length === 0 ||
    typeof body.expiresAt !== "number" ||
    !Number.isFinite(body.expiresAt)
  ) {
    return null;
  }
  return { accessToken: body.accessToken, expiresAt: body.expiresAt };
}

/** Create a before-dispatch token supplier (refresh BEFORE any GET/PATCH). */
export function createAccessTokenSupplier(config: WriteCredentialConfig): {
  getAccessToken: () => string;
  refreshIfExpired: () => Promise<void>;
} {
  // Secure persistence read-back: the file written by a previous refresh
  // seeds the supplier when no explicit access token is configured. An
  // explicit `accessToken` always wins over the file.
  const persisted =
    (config.accessToken === undefined || config.accessToken.length === 0) &&
    config.tokenFile !== undefined
      ? readPersistedWriteToken(config.tokenFile)
      : null;
  let current =
    config.accessToken ?? persisted?.accessToken ?? "";
  let expiresAt =
    config.accessTokenExpiresAtMs ?? persisted?.expiresAt ?? 0;
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
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        throw new Error("auth_refused: token redirect refused");
      }
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        throw new Error("auth_refused: token refresh failed");
      }
      // Bounded refresh body: same deadline signal, hard size cap, then
      // strict JSON parse. An oversize/hanging/malformed refresh body is a
      // refusal (no token is minted), never an unbounded read.
      let raw: string;
      try {
        raw = await readBoundedRefreshBody(res, controller.signal);
      } catch {
        throw new Error("auth_refused: malformed token response");
      }
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new Error("auth_refused: malformed token response");
      }
      const parsed = body as {
        access_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
        scopes?: unknown;
      };
      if (
        typeof parsed.access_token !== "string" ||
        parsed.access_token.length === 0
      ) {
        throw new Error("auth_refused: malformed token response");
      }
      // Actual-grant verification where the server reports it: when the
      // refresh response carries a `scope`/`scopes` field, it MUST contain
      // the exact least-privilege write scope, otherwise the refresh is
      // refused (config alone never equals a grant; no false authorization
      // claim). Absent scope field = no claim to verify (accepted).
      const reportedScope =
        typeof parsed.scope === "string"
          ? parsed.scope
          : Array.isArray(parsed.scopes) &&
              parsed.scopes.every((s) => typeof s === "string")
            ? (parsed.scopes as string[]).join(" ")
            : undefined;
      if (
        reportedScope !== undefined &&
        !validateWriteCredential(reportedScope)
      ) {
        throw new Error("auth_refused: write scope not granted");
      }
      current = parsed.access_token;
      const ttl =
        typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
          ? parsed.expires_in
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

/**
 * Bounded refresh-body read under the live refresh deadline: chunks race
 * the same abort signal (headers-delivered hanging bodies cannot outlive
 * the deadline) and oversize bodies cancel the stream. Single attempt.
 */
async function readBoundedRefreshBody(
  res: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    if (signal.aborted) throw new Error("transport_lost");
    const text = await res.text();
    if (signal.aborted) throw new Error("transport_lost");
    if (text.length > TOKEN_RESPONSE_MAX_BYTES) {
      throw new Error("response_too_large");
    }
    return text;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("transport_lost"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } catch {
        try {
          await reader.cancel();
        } catch {
          // Best effort.
        }
        throw new Error("transport_lost");
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > TOKEN_RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Best effort.
        }
        throw new Error("response_too_large");
      }
      chunks.push(next.value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      reader.releaseLock();
    } catch {
      // Best effort.
    }
  }
}
