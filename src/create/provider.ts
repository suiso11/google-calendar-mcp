// M6 dedicated create provider boundary (production types + guards).
//
// Injectable provider seam: the MCP server owns tool parsing; the host
// injects the HTTP/Google implementation. The production implementation is
// `createGoogleCreateProvider` in `./google.js` (real POST events.insert
// against the fixed Google endpoint, real bearer auth from the SHARED
// persisted write grant — the SAME `M5_RESCHEDULE_*` namespace as
// reschedule, no OAuth flow at runtime). Fixture/test
// providers live in TESTS ONLY and must never be imported here.

export type CreateTarget = {
  readonly calendarId: string;
  readonly account?: string;
};

export type CreateBody = {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
};

/** Exact three-value provider return for ONE insert attempt. */
export type CreateProviderOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "definite_failure"; readonly code: string }
  | { readonly status: "unknown"; readonly code: string };

export interface CreateProvider {
  /**
   * Exactly ONE events.insert: body ONLY
   * `{ id, summary, start: { dateTime }, end: { dateTime } }`.
   * Implementations MUST NOT retry internally, MUST NOT overwrite on 409,
   * and MUST map 409/alreadyExists to definite_failure.
   */
  insert(
    target: CreateTarget,
    body: CreateBody,
    signal?: AbortSignal,
  ): Promise<CreateProviderOutcome>;
}

/* Shared fixed endpoint + scope validation (provider + server use these). */

import { validateWriteCredential } from "../reschedule/provider.js";

export const GOOGLE_API_BASE = "https://www.googleapis.com" as const;
export const CREATE_REQUIRED_SCOPE =
  "https://www.googleapis.com/auth/calendar.events" as const;

export function googleEventsInsertUrl(
  calendarId: string,
  baseOverride?: string,
): string {
  const base = (baseOverride ?? GOOGLE_API_BASE).replace(/\/$/, "");
  return `${base}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

/**
 * Create authorization check: the EXACT narrow write TOKEN (not the raw
 * scope string) must be present. Reuses the SHARED `validateWriteCredential`
 * predicate directly, so every grant the shared reschedule runtime accepts
 * is accepted here too: the narrow `calendar.events` token alone, with
 * surrounding/multiple whitespace, or alongside read-only extras
 * (`calendar.events.readonly`, ...). A broad `calendar`/`auth/calendar`
 * token ANYWHERE still refuses the whole credential (least privilege), and
 * readonly-only / unrelated-suffix scopes stay refused. This does NOT
 * broaden write authority: the grant loader already approves those
 * readonly extras, and the credential still authorizes only the narrow
 * write token.
 */
export function isExactCreateScope(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return validateWriteCredential(value);
}
