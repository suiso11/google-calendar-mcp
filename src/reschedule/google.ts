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
//   - Bounded transport: ONE deadline/abort spans headers AND the bounded
//     response-body consumption (a headers-delivered never-ending body can
//     never hang past the deadline), `redirect: "manual"` (any 3xx is
//     rejected BEFORE any credential leak follow — the adapter never follows
//     redirects), bounded response size (oversize bodies are rejected with the
//     stream cancelled, without unbounded buffering).
//   - Account gate: an exact configured-account mismatch is rejected BEFORE
//     any token or provider I/O (no inference on opaque ids).
//   - GET 404/410: definite `not_found` with NO write (never deletion
//     proof — the caller maps it to a before-write definite failure).
//   - GET 401/403: definite `auth_refused` (never `not_found`, never
//     `unknown` — no patch was dispatched, so the proof is intact).
//   - Read transport loss / malformed / oversize BEFORE any dispatch:
//     definite (no patch dispatched), never `unknown`-as-commit.
//   - Shape rejects (recurring/instance, cancelled/deleted, all-day,
//     missing etag): before-write definite codes with NO patch dispatched.
//   - PATCH start/end ONLY with `If-Match: <exact etag>`; 412 is definite
//     `etag_mismatch` (provider proves NO patch was applied).
//   - 5xx / timeout / abort / disconnect / malformed-2xx AFTER a possible
//     dispatch: `unknown` (never a resend, never a cancel, never definite).
//   - Errors never expose raw private data: fixed codes + status only.

import {
  googleEventUrl,
  isExactEtagCandidate,
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
  /**
   * Refresh BEFORE each dispatch (auth layer `refreshIfExpired`). Awaited
   * before every GET/PATCH; never a retry after dispatch.
   */
  readonly refreshAccessToken?: () => Promise<void>;
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
  // Unknown/malformed status is NEVER minted as a deletion: it is a shape
  // reject (the caller maps it to a before-write definite failure with NO
  // patch dispatched).
  if (
    statusRaw !== "confirmed" &&
    statusRaw !== "tentative" &&
    statusRaw !== "cancelled"
  ) {
    throw new Error("malformed_response");
  }
  const status: RescheduleObservation["status"] = statusRaw;
  const recurring =
    body.recurrence !== undefined || body.recurringEventId !== undefined;
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

/** Rejection bound to a live deadline signal (never hangs past the bound). */
function signalRejection(signal: AbortSignal): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("transport_lost"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Bounded body consumption under the LIVE deadline signal: the same
 * deadline/abort that covers the headers keeps covering every streamed
 * chunk, so a headers-delivered never-ending body cannot hang forever.
 * Oversize and deadline/caller aborts cancel the stream (no unbounded
 * buffering, no leaked reader).
 */
async function consumeBoundedBody(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    if (signal.aborted) throw new Error("transport_lost");
    const text = await res.text();
    if (signal.aborted) throw new Error("transport_lost");
    if (text.length > maxBytes) throw new Error("response_too_large");
    return text;
  }
  const rejection = signalRejection(signal);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), rejection.promise]);
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
      if (total > maxBytes) {
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
    rejection.cleanup();
    try {
      reader.releaseLock();
    } catch {
      // Best effort.
    }
  }
}

/**
 * Single attempt whose ONE deadline/abort spans headers AND bounded body
 * consumption: the timer and the caller-signal wiring are released only
 * after `consume` settles, so clearing on headers (and detaching the
 * caller signal early) can never strand a hanging body read.
 */
async function singleAttempt<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  consume: (res: Response, liveSignal: AbortSignal) => Promise<T>,
): Promise<T> {
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
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
    return await consume(res, controller.signal);
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

/** Classified read errors: thrown BEFORE any patch dispatch (definite). */
const READ_CLASSIFIED = new Set([
  "auth_refused",
  "not_found",
  "redirect_refused",
  "malformed_response",
  "response_too_large",
  "read_failed",
  "read_transport_lost",
]);

function readErrorCode(message: string): string | null {
  if (READ_CLASSIFIED.has(message)) return message;
  if (message.startsWith("redirect_refused")) return "redirect_refused";
  if (message.startsWith("read_failed:")) return "read_failed";
  return null;
}

/** Create the REAL production Google provider (GET + conditional PATCH). */
export function createGoogleRescheduleProvider(
  options: GoogleRescheduleProviderOptions,
): RescheduleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? GOOGLE_MAX_BODY_BYTES;

  /**
   * Exact configured-account gate: an explicit target account that does not
   * equal the configured account is rejected BEFORE any token or provider
   * I/O. Ids are opaque: no inference, no normalization, no fallback.
   */
  function assertAccount(target: RescheduleTarget): void {
    if (target.account !== undefined) {
      if (options.account === undefined || target.account !== options.account) {
        throw new Error("auth_refused");
      }
    }
  }

  /** Refresh-before-dispatch (auth layer); never a retry after dispatch. */
  async function refreshBeforeDispatch(): Promise<void> {
    if (options.refreshAccessToken !== undefined) {
      await options.refreshAccessToken();
    }
  }

  async function read(
    target: RescheduleTarget,
    signal?: AbortSignal,
  ): Promise<RescheduleObservation> {
    // Account gate FIRST: no token I/O, no provider I/O on mismatch.
    assertAccount(target);
    try {
      await refreshBeforeDispatch();
    } catch {
      throw new Error("auth_refused");
    }
    let token: string;
    try {
      token = options.getAccessToken();
    } catch {
      throw new Error("auth_refused");
    }
    const url = googleEventUrl(
      target.calendarId,
      target.eventId,
      options.endpointBase,
    );
    try {
      return await singleAttempt(
        url,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
          ...(signal !== undefined ? { signal } : {}),
        },
        fetchImpl,
        timeoutMs,
        signal,
        async (res, liveSignal) => {
          if (res.status >= 300 && res.status < 400) {
            // Redirect before any credential leak: never follow; fail.
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            throw new Error("redirect_refused");
          }
          if (res.status === 404 || res.status === 410) {
            // Definite no-write marker (NOT deletion proof): empty etag +
            // deleted shape so the before-write guard rejects with NO patch.
            // The server maps empty-etag reads to `not_found`/definite without
            // minting a tombstone.
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            throw new Error("not_found");
          }
          if (res.status === 401 || res.status === 403) {
            // Definite auth refusal: no patch was (or will be) dispatched on
            // this read, so the proof is intact — never `not_found`, never
            // `unknown`.
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            throw new Error("auth_refused");
          }
          if (!res.ok)
            throw new Error(`read_failed:${sanitizeStatus(res.status)}`);
          let text: string;
          try {
            text = await consumeBoundedBody(res, maxBytes, liveSignal);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "response_too_large") throw error;
            throw new Error("read_transport_lost");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            throw new Error("malformed_response");
          }
          return normalizeGoogleObservation(parsed, target.eventId);
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (readErrorCode(message) !== null) throw error;
      throw new Error("read_transport_lost");
    }
  }

  async function patch(
    target: RescheduleTarget,
    patchBody: ReschedulePatch,
    opts: { readonly ifMatch: string; readonly current?: RescheduleObservation },
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "succeeded" }
    | { readonly status: "definite_failure"; readonly code: string }
    | { readonly status: "unknown"; readonly code: string }
  > {
    // Committed-grant equality contract (safe for DIRECT provider calls too):
    // wildcards / If-Match lists never dispatch. A supplied observation must
    // equal the conditional etag exactly or the patch is refused with NO
    // dispatch; a live wildcard etag is itself unauthenticated.
    if (!isExactEtagCandidate(opts.ifMatch)) {
      return { status: "definite_failure", code: "etag_mismatch" };
    }
    // Account gate FIRST: no token I/O, no provider I/O on mismatch.
    try {
      assertAccount(target);
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    // Single read-before-patch: reuse the server's already-read observation
    // when supplied (ONE GET per update); otherwise exactly one GET here.
    // Unsupported shapes fail with NO patch dispatched.
    let current: RescheduleObservation;
    if (opts.current !== undefined) {
      current = opts.current;
    } else {
      try {
        current = await read(target, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "auth_refused") {
          return { status: "definite_failure", code: "auth_refused" };
        }
        if (message === "not_found") {
          return { status: "definite_failure", code: "not_found" };
        }
        // Transient preflight failures (HTTP 429/5xx surfaced as
        // `read_failed:http_*`) BEFORE any dispatch: definite with a
        // redacted upstream code — never `invalid_input` (the request was
        // well-formed; the upstream was not), never not_found/auth, never
        // unknown-commit — and NO patch dispatched. All other pre-dispatch
        // read failures keep their existing definite codes below.
        if (message.startsWith("read_failed:")) {
          return { status: "definite_failure", code: "read_upstream_error" };
        }
        // redirect / malformed / oversize / read-transport / other 4xx BEFORE
        // any dispatch: definite (no patch dispatched), never unknown-commit
        // and never not_found/auth.
        return { status: "definite_failure", code: "invalid_input" };
      }
    }
    // Exact equality with the just-read etag BEFORE dispatch: a stale or
    // wildcard/list conditional never reaches the wire (the server's own
    // guard does the same; this keeps direct provider calls safe too). The
    // approved etag still rides `If-Match` verbatim on the live attempt, so
    // a race between GET and PATCH is proven by HTTP 412 below.
    if (!isExactEtagCandidate(current.etag)) {
      return { status: "definite_failure", code: "auth_refused" };
    }
    if (opts.ifMatch !== current.etag) {
      return { status: "definite_failure", code: "etag_mismatch" };
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
    // Refresh-before-dispatch again here: the pre-read refresh may have aged
    // across the guard window; this is still BEFORE dispatch, never a retry.
    try {
      await refreshBeforeDispatch();
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    let patchToken: string;
    try {
      patchToken = options.getAccessToken();
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    const url = googleEventUrl(
      target.calendarId,
      target.eventId,
      options.endpointBase,
    );
    try {
      return await singleAttempt(
        url,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${patchToken}`,
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
        async (res, liveSignal) => {
          if (res.status >= 300 && res.status < 400) {
            // 3xx AFTER a possibly-dispatched PATCH: UNKNOWN (never
            // definite). The dispatch already happened, so no definite
            // no-commit proof exists; never resend, never follow (manual).
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            return { status: "unknown", code: "upstream_unknown" } as const;
          }
          if (res.status === 412) {
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            return { status: "definite_failure", code: "etag_mismatch" } as const;
          }
          if (res.status === 404 || res.status === 410) {
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            return { status: "definite_failure", code: "not_found" } as const;
          }
          if (res.status === 401 || res.status === 403) {
            // The server refused the credentials, so it applied nothing:
            // definite (never unknown, never not_found).
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            return { status: "definite_failure", code: "auth_refused" } as const;
          }
          if (res.status === 400 || res.status === 422) {
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            return { status: "definite_failure", code: "invalid_input" } as const;
          }
          if (!res.ok) {
            // 5xx after a possibly-dispatched write: UNKNOWN (never
            // definite). Anything else unlisted is refused without proof of
            // dispatch, but the dispatch already happened — UNKNOWN.
            try {
              await res.body?.cancel();
            } catch {
              // Best effort.
            }
            if (res.status >= 500)
              return { status: "unknown", code: "upstream_5xx" } as const;
            return { status: "unknown", code: "upstream_unknown" } as const;
          }
          // Malformed/oversize/timeout 2xx body after dispatch: UNKNOWN (the
          // write may have happened; the proof was lost).
          try {
            const text = await consumeBoundedBody(res, maxBytes, liveSignal);
            if (text.length > 0) JSON.parse(text);
          } catch {
            return { status: "unknown", code: "response_unparseable" } as const;
          }
          return { status: "succeeded" } as const;
        },
      );
    } catch {
      return { status: "unknown", code: "transport_lost" };
    }
  }

  return { read, patch };
}
