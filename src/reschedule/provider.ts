// M5 dedicated reschedule provider boundary (production types + guards).
//
// Injectable provider seam: the MCP server owns tool parsing + the exact
// If-Match wire contract; the host injects the HTTP/Google implementation.
// The production implementation is `createGoogleRescheduleProvider` in
// `./google.js` (real GET + PATCH against the fixed Google endpoint, real
// bearer auth from the SEPARATE `M5_RESCHEDULE_*` namespace, no OAuth flow
// at runtime). This module keeps ONLY the shared boundary types, the
// before-write guard, the fixed Google URL builder, and exact-whitespace
// write-scope validation. Fixture/test providers live in TESTS ONLY and
// must never be imported from this production module.

export type RescheduleTarget = {
  readonly calendarId: string;
  readonly eventId: string;
  readonly account?: string;
};

/** Authoritative pre-patch observation (read before patch). */
export type RescheduleObservation = {
  /** Exact opaque source etag ("" / missing means "no etag": reject). */
  readonly etag: string;
  readonly status: "confirmed" | "tentative" | "cancelled" | "deleted";
  /** Timed source instants; "" when the source is all-day (see startDate). */
  readonly start: string;
  readonly end: string;
  /** True for recurring masters/instances/exceptions (unsupported). */
  readonly recurring: boolean;
  /**
   * True for all-day sources (SUPPORTED for all-day → timed conversion).
   * Timed sources carry `start`/`end` instants; all-day sources carry
   * `startDate`/`endDate` YYYY-MM-DD bounds with `start`/`end` empty.
   */
  readonly allDay: boolean;
  /** All-day source start bound (YYYY-MM-DD, inclusive; all-day only). */
  readonly startDate?: string;
  /** All-day source end bound (YYYY-MM-DD, exclusive; all-day only). */
  readonly endDate?: string;
};

export type ReschedulePatch = {
  readonly start: string;
  readonly end: string;
};

/** Exact three-value provider return for ONE patch attempt. */
export type ProviderOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "definite_failure"; readonly code: string }
  | { readonly status: "unknown"; readonly code: string };

/** Known before-write definite-failure codes (fixed vocabulary). */
export const DEFINITE_FAILURE_CODES = [
  "etag_mismatch", // HTTP 412: expected etag did not match — NO patch applied
  "invalid_input",
  "recurring_unsupported",
  "cancelled_unsupported",
  "deleted_unsupported",
  "not_found",
  "auth_refused",
  // Read-transport loss BEFORE any dispatch: definite (no patch was sent,
  // so the no-commit proof is intact — never `unknown`-as-commit).
  "read_transport_lost",
  // Transient preflight read failure (HTTP 429/5xx) BEFORE any dispatch:
  // definite redacted upstream code (never `invalid_input`, no retry).
  "read_upstream_error",
] as const;

export interface RescheduleProvider {
  /** Authoritative read before patch (rejects unsupported shapes). */
  read(
    target: RescheduleTarget,
    signal?: AbortSignal,
  ): Promise<RescheduleObservation>;
  /**
   * Exactly ONE conditional patch: start/end ONLY with If-Match etag.
   * Implementations MUST NOT retry internally (retry:false), MUST NOT split
   * recurring series, and MUST map HTTP 412 to definite_failure/etag_mismatch.
   */
  patch(
    target: RescheduleTarget,
    patch: ReschedulePatch,
    options: { readonly ifMatch: string; readonly current?: RescheduleObservation },
    signal?: AbortSignal,
  ): Promise<ProviderOutcome>;
}

/* ------------------------------------------------------------------ */
/* Shared guards (production Google provider + server use these)       */
/* ------------------------------------------------------------------ */

/**
 * Strict YYYY-MM-DD calendar-date validation (no rollover): month lengths,
 * leap years, and real calendar days are enforced; `2026-02-30` is rejected.
 */
export function isStrictCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
    0;
  return day >= 1 && day <= daysInMonth;
}

/**
 * True when an all-day source observation carries strict, well-ordered
 * YYYY-MM-DD bounds (inclusive start, exclusive end strictly after start).
 * Timed-shape leftovers (`start`/`end` non-empty on an all-day source) are
 * rejected so a malformed source never reaches the wire.
 */
export function isValidAllDaySource(
  observation: RescheduleObservation,
): boolean {
  if (!observation.allDay) return true;
  const { startDate, endDate } = observation;
  if (typeof startDate !== "string" || typeof endDate !== "string") {
    return false;
  }
  if (!isStrictCalendarDate(startDate) || !isStrictCalendarDate(endDate)) {
    return false;
  }
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || !(endMs > startMs)) {
    return false;
  }
  // All-day sources must not carry timed instants alongside date bounds.
  if (observation.start !== "" || observation.end !== "") return false;
  return true;
}

/**
 * Reject unsupported shapes BEFORE any patch (no patch dispatched):
 * missing etag, recurring, cancelled/deleted, malformed all-day bounds.
 * All-day → timed conversion is SUPPORTED, so a valid all-day source
 * passes; a malformed all-day source is `invalid_input`. Returns the fixed
 * definite code or null when the shape is patchable.
 */
export function beforeWriteGuard(
  observation: RescheduleObservation,
): string | null {
  if (observation.etag.length === 0) return "auth_refused";
  if (observation.recurring) return "recurring_unsupported";
  if (observation.status === "cancelled") return "cancelled_unsupported";
  if (observation.status === "deleted") return "deleted_unsupported";
  if (!isValidAllDaySource(observation)) return "invalid_input";
  return null;
}

/* ------------------------------------------------------------------ */
/* Production Google endpoint (FIXED) + explicit test seam             */
/* ------------------------------------------------------------------ */

/** Fixed production Google Calendar API base (never overridden in prod). */
export const GOOGLE_API_BASE = "https://www.googleapis.com" as const;

/**
 * Production events.get/patch URL (FIXED Google endpoint). `baseOverride`
 * exists ONLY as an explicit test seam: the production CLI never sets it.
 * Tests inject a loopback fixture base through provider options instead.
 */
export function googleEventUrl(
  calendarId: string,
  eventId: string,
  baseOverride?: string,
): string {
  const base = (baseOverride ?? GOOGLE_API_BASE).replace(/\/$/, "");
  return `${base}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

/** Legacy alias (same fixed production URL, no override). */
export const GOOGLE_PATCH_URL = (calendarId: string, eventId: string): string =>
  googleEventUrl(calendarId, eventId);

/* ------------------------------------------------------------------ */
/* Exact-whitespace write-scope validation (production)                */
/* ------------------------------------------------------------------ */

/** Write-capable scope token (exact least-privilege: calendar.events only). */
export const WRITE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/**
 * Broad write scopes that are NEVER accepted, even when the exact
 * least-privilege token is also present. The full `.../auth/calendar`
 * token implies full calendar access and must never ride the dedicated
 * write namespace.
 */
export const REFUSED_BROAD_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
] as const;

/**
 * Validate that a granted-scope string carries the exact least-privilege
 * write scope (`.../calendar.events` ONLY). The granted value is split on
 * EXACT ASCII whitespace runs; one token must equal the exact write scope.
 * Substring matching is NEVER used, so `.../calendar.events.foo`,
 * `.../calendar.readonly-plus`, or the broad `.../calendar` scope cannot
 * pass. Any broad write scope (`.../auth/calendar`) present ANYWHERE in the
 * string refuses the WHOLE credential — even when the exact write token is
 * also present (least privilege: overprivileged credentials never enter the
 * dedicated namespace). Readonly tokens (`calendar.readonly`,
 * `calendar.events.readonly`, `calendar.settings.readonly`, ...) alongside
 * the exact write token remain accepted: they grant nothing beyond reads.
 * Empty/missing scope is refused. Config alone is not a
 * grant: the live OAuth refresh response `scope` (when present) is verified
 * separately in `./auth.js` with this SAME function, and a refused refresh
 * persists nothing (no token file write on refusal). No OAuth flow is
 * started here and no scope is broadened.
 */
export function validateWriteCredential(scope: string | undefined): boolean {
  if (typeof scope !== "string" || scope.length === 0) return false;
  const tokens = scope.split(/[\t\n\f\r ]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  for (const broad of REFUSED_BROAD_WRITE_SCOPES) {
    if (tokens.some((t) => t === broad)) return false;
  }
  return tokens.some((t) => t === WRITE_SCOPES[0]);
}

/**
 * True when a caller-supplied etag is a usable exact conditional value:
 * non-empty, not the `*` wildcard, and not an If-Match list (`,`).
 * Wildcards/lists never satisfy the committed-grant equality contract, even
 * when the live etag happens to contain the same bytes (it never does — a
 * live wildcard etag is itself refused as unauthenticated).
 */
export function isExactEtagCandidate(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (value.includes("*") || value.includes(",")) return false;
  return true;
}
