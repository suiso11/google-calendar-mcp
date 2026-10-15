// M5 production Google HTTP adapter: REAL GET + PATCH, no live writes here.
//
// Production behavior (exercised in tests against a local Google-shaped
// loopback fixture injected through `endpointBase`; the production CLI
// never sets `endpointBase`, so production always hits the FIXED Google
// URL from `./provider.js`):
//   - Auth: explicit bearer `accessToken` supplied by `./auth.js` (SEPARATE
//     `M5_RESCHEDULE_*` namespace; never a readonly token). No interactive
//     OAuth flow, no consent request, no scope broadening at runtime.
//   - Single attempt per logical update: exactly ONE fetch for GET and
//     exactly ONE fetch for PATCH (no library retries, no auth auto-replay,
//     no PATCH retry). A refresh may happen BEFORE dispatch (auth layer),
//     never as a retry after dispatch.
//   - Bounded transport: per-request timeout + AbortSignal propagation,
//     `redirect: "manual"` (any 3xx is rejected BEFORE any credential leak
//     follow — the adapter never follows redirects), bounded response size
//     (oversize bodies are rejected without unbounded buffering).
//   - GET 404/410: definite `not_found` with NO write (never deletion
//     proof — the caller maps it to a before-write definite failure).
//   - Shape rejects (recurring/instance, cancelled/deleted, all-day,
//     missing etag): before-write definite codes with NO patch dispatched.
//   - PATCH start/end ONLY with `If-Match: <exact etag>`; 412 is definite
//     `etag_mismatch` (provider proves NO patch was applied).
//   - 5xx / timeout / abort / disconnect / malformed-2xx AFTER a possible
//     dispatch: `unknown` (never a resend, never a cancel, never definite).
//   - Errors never expose raw private data: fixed codes + status only.

import {
  googleEventUrl,
  type RescheduleObservation,
  type ReschedulePatch,
  type RescheduleProvider,
  type RescheduleTarget,
} from "./provider.js";

/** Bounded transport budgets (fixed, never auto-raised). */
export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;
export const GOOGLE_MAX_BODY_BYTES = 256 * 1024;

export interface GoogleRescheduleProviderOptions {
  /** Current valid access token (refreshed BEFORE dispatch by auth layer). */
  readonly getAccessToken: () => string;
  /** Exact Google account selection (opaque; sent only as configured). */
  readonly account?: string;
  /**
   * Explicit TEST seam only: loopback fixture base (e.g.
   * `http://127.0.0.1:PORT`). Production CLI never sets this, so
   * production always uses the FIXED Google URL.
   */
  readonly endpointBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

interface GoogleEventShape {
  readonly id: string;
  readonly etag?: unknown;
  readonly status?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly recurrence?: unknown;
  readonly recurringEventId?: unknown;
}

function isTimedEndpoint(value: unknown): value is { dateTime: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { dateTime?: unknown; date?: unknown };
  return typeof v.dateTime === "string" && v.date === undefined;
}

function parseTimedInstant(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Exact Google events.shape normalization (strict; rejects unsupported). */
export function normalizeGoogleObservation(
  raw: unknown,
  expectedEventId: string,
): RescheduleObservation {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("malformed_response");
  }
  const body = raw as GoogleEventShape;
  if (typeof body.id !== "string" || body.id !== expectedEventId) {
    throw new Error("malformed_response");
  }
  const etag = typeof body.etag === "string" ? body.etag : "";
  const statusRaw = body.status;
  const status: RescheduleObservation["status"] =
    statusRaw === "confirmed" || statusRaw === "tentative"
      ? statusRaw
      : statusRaw === "cancelled"
        ? "cancelled"
        : "deleted";
  const recurring =
    body.recurrence !== undefined ||
    body.recurringEventId !== undefined ||
    (typeof body.id === "string" && body.id.includes("_"));
  const allDay = !isTimedEndpoint(body.start) || !isTimedEndpoint(body.end);
  let start = "";
  let end = "";
  if (!allDay) {
    const s = (body.start as { dateTime: string }).dateTime;
    const e = (body.end as { dateTime: string }).dateTime;
    const sMs = parseTimedInstant(s);
    const eMs = parseTimedInstant(e);
    if (sMs === undefined || eMs === undefined || !(eMs > sMs)) {
      throw new Error("malformed_response");
    }
    start = s;
    end = e;
  }
  return { etag, status, start, end, recurring, allDay };
}

async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("response_too_large");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Best effort.
      }
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function singleFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const detach: Array<() => void> = [];
  try {
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort("cancelled");
      else {
        const onAbort = () => controller.abort("cancelled");
        callerSignal.addEventListener("abort", onAbort, { once: true });
        detach.push(() => callerSignal.removeEventListener("abort", onAbort));
      }
    }
    // Single attempt: no retry, no redirect follow (manual => 3xx observed).
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
    for (const d of detach) {
      try {
        d();
      } catch {
        // Best effort.
      }
    }
  }
}

function sanitizeStatus(status: number): string {
  return `http_${status}`;
}

/** Create the REAL production Google provider (GET + conditional PATCH). */
export function createGoogleRescheduleProvider(
  options: GoogleRescheduleProviderOptions,
): RescheduleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? GOOGLE_MAX_BODY_BYTES;

  async function read(
    target: RescheduleTarget,
    signal?: AbortSignal,
  ): Promise<RescheduleObservation> {
    const url = googleEventUrl(
      target.calendarId,
      target.eventId,
      options.endpointBase,
    );
    let res: Response;
    try {
      res = await singleFetch(
        url,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${options.getAccessToken()}`,
            accept: "application/json",
          },
          ...(signal !== undefined ? { signal } : {}),
        },
        fetchImpl,
        timeoutMs,
        signal,
      );
    } catch {
      throw new Error("transport_lost");
    }
    if (res.status >= 300 && res.status < 400) {
      // Redirect before any credential leak: never follow; fail the read.
      try {
        await res.body?.cancel();
      } catch {
        // Best effort.
      }
      throw new Error(`redirect_refused:${sanitizeStatus(res.status)}`);
    }
    if (res.status === 404 || res.status === 410) {
      // Definite no-write marker (NOT deletion proof): empty etag + deleted
      // shape so the before-write guard rejects with NO patch. The server
      // maps empty-etag reads to `not_found`/definite without minting a
      // tombstone.
      return {
        etag: "",
        status: "deleted",
        start: "",
        end: "",
        recurring: false,
        allDay: false,
      };
    }
    if (!res.ok) throw new Error(`read_failed:${sanitizeStatus(res.status)}`);
    let text: string;
    try {
      text = await readBoundedBody(res, maxBytes);
    } catch {
      throw new Error("transport_lost");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("malformed_response");
    }
    return normalizeGoogleObservation(parsed, target.eventId);
  }

  async function patch(
    target: RescheduleTarget,
    patchBody: ReschedulePatch,
    opts: { readonly ifMatch: string },
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "succeeded" }
    | { readonly status: "definite_failure"; readonly code: string }
    | { readonly status: "unknown"; readonly code: string }
  > {
    if (opts.ifMatch.length === 0) {
      return { status: "definite_failure", code: "auth_refused" };
    }
    // Read-before-patch: unsupported shapes fail with NO patch dispatched.
    let current: RescheduleObservation;
    try {
      current = await read(target, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("redirect_refused")) {
        return { status: "definite_failure", code: "invalid_input" };
      }
      if (message.startsWith("read_failed:http_4")) {
        return { status: "definite_failure", code: "not_found" };
      }
      return { status: "unknown", code: "read_transport_lost" };
    }
    if (current.status === "deleted" && current.etag === "") {
      return { status: "definite_failure", code: "not_found" };
    }
    if (current.etag.length === 0) {
      return { status: "definite_failure", code: "auth_refused" };
    }
    if (current.recurring) {
      return { status: "definite_failure", code: "recurring_unsupported" };
    }
    if (current.status === "cancelled") {
      return { status: "definite_failure", code: "cancelled_unsupported" };
    }
    if (current.status === "deleted") {
      return { status: "definite_failure", code: "deleted_unsupported" };
    }
    if (current.allDay) {
      return { status: "definite_failure", code: "allday_unsupported" };
    }
    // EXACTLY ONE conditional PATCH: start/end ONLY + If-Match exact etag.
    const url = googleEventUrl(
      target.calendarId,
      target.eventId,
      options.endpointBase,
    );
    let res: Response;
    try {
      res = await singleFetch(
        url,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${options.getAccessToken()}`,
            "content-type": "application/json",
            "If-Match": opts.ifMatch,
          },
          body: JSON.stringify({
            start: { dateTime: patchBody.start },
            end: { dateTime: patchBody.end },
          }),
          ...(signal !== undefined ? { signal } : {}),
        },
        fetchImpl,
        timeoutMs,
        signal,
      );
    } catch {
      return { status: "unknown", code: "transport_lost" };
    }
    if (res.status >= 300 && res.status < 400) {
      try {
        await res.body?.cancel();
      } catch {
        // Best effort.
      }
      return { status: "definite_failure", code: "invalid_input" };
    }
    if (res.status === 412) {
      return { status: "definite_failure", code: "etag_mismatch" };
    }
    if (res.status === 404 || res.status === 410) {
      return { status: "definite_failure", code: "not_found" };
    }
    if (
      res.status === 400 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 422
    ) {
      return { status: "definite_failure", code: "invalid_input" };
    }
    if (!res.ok) {
      // 5xx after a possibly-dispatched write: UNKNOWN (never definite).
      if (res.status >= 500) return { status: "unknown", code: "upstream_5xx" };
      return { status: "definite_failure", code: "invalid_input" };
    }
    // Malformed 2xx body after dispatch: UNKNOWN (the write may have
    // happened; the proof was lost).
    try {
      const text = await readBoundedBody(res, maxBytes);
      if (text.length > 0) JSON.parse(text);
    } catch {
      return { status: "unknown", code: "response_unparseable" };
    }
    return { status: "succeeded" };
  }

  return { read, patch };
}
