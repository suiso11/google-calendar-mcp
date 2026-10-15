// M5 dedicated reschedule provider boundary.
//
// Injectable provider seam: the MCP server owns tool parsing + the exact
// If-Match wire contract; the host injects the HTTP/Google implementation.
// Reuses the existing Google client shape where safe (events.patch with
// If-Match), but NEVER shares the readonly credential namespace and NEVER
// invokes an OAuth flow at runtime.
//
// Closed three-outcome contract per dispatch:
//   - `succeeded` — provider confirmed the patch.
//   - `definite_failure` — provider proved the write did NOT happen (HTTP
//     412 precondition failed on the exact etag, or a known before-write
//     rejection: invalid input, recurring/instance, cancelled/deleted,
//     all-day, not-found, scope/auth refusal). No patch was applied.
//   - `unknown` — the write may or may not have happened (timeout, abort,
//     disconnect after possible dispatch). NEVER auto-resend, NEVER cancel.
//
// Transport: retry:false — exactly ONE HTTP attempt per logical update
// (including auth/refresh layers: no hidden resend). Repeated logical
// updates must not auto resend; external idempotency is at-most-once via
// grant + conditional etag, not exactly-once provider magic.

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
  readonly start: string;
  readonly end: string;
  /** True for recurring masters/instances/exceptions (unsupported). */
  readonly recurring: boolean;
  /** True for all-day events (unsupported for timed-only reschedule). */
  readonly allDay: boolean;
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
  "allday_unsupported",
  "not_found",
  "auth_refused",
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
    options: { readonly ifMatch: string },
    signal?: AbortSignal,
  ): Promise<ProviderOutcome>;
}

/* ------------------------------------------------------------------ */
/* Shared guards (both fixture + Google providers use these)           */
/* ------------------------------------------------------------------ */

/**
 * Reject unsupported shapes BEFORE any patch (no patch dispatched):
 * missing etag, recurring, cancelled/deleted, all-day. Returns the fixed
 * definite code or null when the shape is patchable.
 */
export function beforeWriteGuard(observation: RescheduleObservation): string | null {
  if (observation.etag.length === 0) return "auth_refused";
  if (observation.recurring) return "recurring_unsupported";
  if (observation.status === "cancelled") return "cancelled_unsupported";
  if (observation.status === "deleted") return "deleted_unsupported";
  if (observation.allDay) return "allday_unsupported";
  return null;
}

/* ------------------------------------------------------------------ */
/* Local real-HTTP fixture provider (tests + smoke; never production)  */
/* ------------------------------------------------------------------ */

export type FixtureEventRecord = {
  etag: string;
  status: "confirmed" | "tentative" | "cancelled" | "deleted";
  start: string;
  end: string;
  recurring: boolean;
  allDay: boolean;
};

/**
 * HTTP fixture provider: exercises the REAL wire adapter (single fetch,
 * If-Match header, 412 mapping, no retry) against a local loopback fixture
 * server. The fixture server stores events keyed by calendarId/eventId and
 * implements exact-etag If-Match semantics.
 */
export function createFixtureHttpProvider(options: {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}): RescheduleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const keyOf = (t: RescheduleTarget) =>
    `${encodeURIComponent(t.calendarId)}/${encodeURIComponent(t.eventId)}`;

  async function read(
    target: RescheduleTarget,
    signal?: AbortSignal,
  ): Promise<RescheduleObservation> {
    const res = await fetchImpl(`${base}/events/${keyOf(target)}`, {
      method: "GET",
      signal,
      redirect: "manual",
    });
    if (res.status === 404) {
      return {
        etag: "",
        status: "deleted",
        start: "",
        end: "",
        recurring: false,
        allDay: false,
      };
    }
    if (!res.ok) throw new Error(`fixture read failed: HTTP ${res.status}`);
    const body = (await res.json()) as FixtureEventRecord;
    return {
      etag: body.etag,
      status: body.status,
      start: body.start,
      end: body.end,
      recurring: body.recurring,
      allDay: body.allDay,
    };
  }

  async function patch(
    target: RescheduleTarget,
    patchBody: ReschedulePatch,
    opts: { readonly ifMatch: string },
    signal?: AbortSignal,
  ): Promise<ProviderOutcome> {
    // Guard: read-before-patch rejects unsupported shapes with NO patch.
    let current: RescheduleObservation;
    try {
      current = await read(target, signal);
    } catch {
      return { status: "unknown", code: "read_transport_lost" };
    }
    if (current.status === "deleted" && current.etag === "") {
      return { status: "definite_failure", code: "not_found" };
    }
    const guard = beforeWriteGuard(current);
    if (guard !== null) {
      return { status: "definite_failure", code: guard };
    }
    // EXACTLY ONE conditional PATCH, retry:false, no redirect follow.
    let res: Response;
    try {
      res = await fetchImpl(`${base}/events/${keyOf(target)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "If-Match": opts.ifMatch,
        },
        body: JSON.stringify({ start: patchBody.start, end: patchBody.end }),
        signal,
        redirect: "manual",
      });
    } catch {
      // Transport lost around a possibly-dispatched write: unknown, no resend.
      return { status: "unknown", code: "transport_lost" };
    }
    if (res.status === 412) {
      // Exact etag did not match: provider proves NO patch was applied.
      return { status: "definite_failure", code: "etag_mismatch" };
    }
    if (res.status === 404) {
      return { status: "definite_failure", code: "not_found" };
    }
    if (res.status === 400 || res.status === 422) {
      return { status: "definite_failure", code: "invalid_input" };
    }
    if (res.status >= 300 && res.status < 400) {
      return { status: "definite_failure", code: "invalid_input" };
    }
    if (!res.ok) {
      return { status: "definite_failure", code: "invalid_input" };
    }
    return { status: "succeeded" };
  }

  return { read, patch };
}

/* ------------------------------------------------------------------ */
/* Google wire adapter (documented mapping; NO live mutation here)     */
/* ------------------------------------------------------------------ */

/**
 * Google Calendar wire mapping for events.patch (DOCUMENTED, not executed
 * live in this task): PATCH
 * `https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}`
 * with body `{start:{dateTime}, end:{dateTime}}` ONLY and header
 * `If-Match: "<exact etag>"`. Single attempt (retry:false, no redirect
 * follow, no batch, no recurring split). HTTP 412 → definite etag_mismatch;
 * 400/404/403/410/422 before-write failures → definite codes; network
 * timeout/abort/disconnect after dispatch → unknown (no resend, no cancel).
 *
 * Credential namespace: `M5_RESCHEDULE_*` ONLY (never the readonly
 * `GOOGLE_*` / `MCP_GOOGLE_*` namespace). Write scope validation requires a
 * write-capable scope (`.../auth/calendar.events` or `.../auth/calendar`);
 * readonly tokens (`calendar.events.readonly`) are REFUSED without any OAuth
 * flow, consent request, or scope broadening at runtime.
 */
export const GOOGLE_PATCH_URL = (
  calendarId: string,
  eventId: string,
): string =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

export function validateWriteCredential(scope: string | undefined): boolean {
  if (typeof scope !== "string" || scope.length === 0) return false;
  if (scope.includes("calendar.events.readonly")) return false;
  if (scope.includes("calendar.readonly")) return false;
  return (
    scope.includes("https://www.googleapis.com/auth/calendar.events") ||
    scope === "https://www.googleapis.com/auth/calendar"
  );
}
