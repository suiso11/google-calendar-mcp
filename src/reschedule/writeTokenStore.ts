// M5 SEPARATE write-consent token store (never the readonly token file).
//
// Namespace: ONLY `M5_RESCHEDULE_WRITE_TOKEN_PATH` is read here (never
// `GOOGLE_*` / `MCP_GOOGLE_*` / readonly profile files). The default path
// lives in a DIFFERENT config directory than the readonly runtime's, so a
// fresh narrow consent can never overwrite the existing readonly grants.
// Persisted grants are exact-scope validated (`validateWriteCredential`);
// broad or readonly scopes are refused and nothing is written. Files are
// created 0600 and re-chmodded 0600 (private, owner-only). No live
// Google/OAuth invocation happens here; this is file persistence only.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Credentials } from "google-auth-library";
import { validateAccountId } from "../auth/paths.js";
import { validateWriteCredential } from "./provider.js";

/** Env override for the SEPARATE write token file (never a readonly path). */
export const WRITE_TOKEN_PATH_ENV = "M5_RESCHEDULE_WRITE_TOKEN_PATH" as const;

/** Default SEPARATE write token file (outside the readonly directory). */
export function getDefaultWriteTokenPath(): string {
  return join(homedir(), ".config", "google-calendar-mcp-write", "tokens.json");
}

/** Resolve the SEPARATE write token path (env override else isolated default). */
export function getWriteTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WRITE_TOKEN_PATH_ENV];
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return getDefaultWriteTokenPath();
}

/** Fixed refusal messages (never include paths, scopes, or token bytes). */
export const WRITE_TOKEN_REFUSALS = Object.freeze({
  invalidAccount: "write consent refused: invalid account",
  invalidGrant: "write consent refused: grant not valid",
  unreadable: "write consent refused: stored grant unreadable",
} as const);

/** Persisted per-account write grant (Google credentials plus local metadata). */
export type WriteStoredGrant = Credentials & { readonly obtained_at?: number };

/** Multi-account write token file (SEPARATE path only, never the readonly file). */
export type WriteTokenFile = Record<string, WriteStoredGrant>;

async function readWriteTokenFile(tokenPath: string): Promise<WriteTokenFile> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, "utf-8");
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw new Error(WRITE_TOKEN_REFUSALS.unreadable);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(WRITE_TOKEN_REFUSALS.unreadable);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(WRITE_TOKEN_REFUSALS.unreadable);
  }
  return parsed as WriteTokenFile;
}

/**
 * Persist a freshly consented write grant under `account` (merge, 0600).
 * Refuses (writing nothing) unless `credentials.scope` carries the exact
 * least-privilege write scope and a refresh token is present. A corrupt
 * existing file refuses rather than clobbering (fail closed, no data loss).
 */
export async function saveWriteCredentials(
  account: string,
  credentials: Credentials,
  tokenPath: string,
): Promise<void> {
  try {
    validateAccountId(account);
  } catch {
    throw new Error(WRITE_TOKEN_REFUSALS.invalidAccount);
  }
  const scope = credentials.scope;
  const refresh = credentials.refresh_token;
  if (typeof scope !== "string" || !validateWriteCredential(scope)) {
    throw new Error(WRITE_TOKEN_REFUSALS.invalidGrant);
  }
  if (typeof refresh !== "string" || refresh.length === 0) {
    throw new Error(WRITE_TOKEN_REFUSALS.invalidGrant);
  }
  const current = await readWriteTokenFile(tokenPath);
  const next: WriteTokenFile = {
    ...current,
    [account]: { ...credentials, obtained_at: Date.now() },
  };
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    await chmod(tokenPath, 0o600);
  } catch {
    // Best effort: the file was already created 0600.
  }
}
