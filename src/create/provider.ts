// M6 dedicated create provider boundary (production types + guards).
//
// Injectable provider seam: the MCP server owns tool parsing; the host
// injects the HTTP/Google implementation. The production implementation is
// `createGoogleCreateProvider` in `./google.js` (real POST events.insert
// against the fixed Google endpoint, real bearer auth from the SEPARATE
// `M6_CREATE_*` namespace, no OAuth flow at runtime). Fixture/test
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

/** Exact-whitespace scope check: ONLY the narrow events scope authorizes. */
export function isExactCreateScope(value: unknown): boolean {
  return value === CREATE_REQUIRED_SCOPE;
}
