// M6 production Google HTTP adapter: REAL events.insert, no live writes here.
//
// Production behavior (exercised in tests against a local Google-shaped
// loopback fixture injected through `endpointBase`; the production CLI
// never sets `endpointBase`, so production always hits the FIXED Google
// URL from `./provider.js`):
//   - Auth: explicit bearer `accessToken` (SEPARATE `M6_CREATE_*`
//     namespace; never a readonly/reschedule token). No interactive OAuth
//     flow, no consent request, no scope broadening at runtime.
//   - Single attempt per logical insert: exactly ONE fetch (no library
//     retries, no auth auto-replay, no resend on 409/timeout/loss). A
//     refresh may happen BEFORE dispatch (auth layer), never after.
//   - Bounded transport: ONE deadline/abort spans headers AND bounded body
//     consumption, `redirect: "manual"` (any 3xx is UNKNOWN after a
//     possibly-dispatched POST — never followed, never definite), bounded
//     response size (oversize/unparseable 2xx bodies are UNKNOWN: the write
//     may have happened and the proof was lost).
//   - Body discipline: Google POST body carries ONLY
//     `{ id, summary, start: { dateTime }, end: { dateTime } }` (stable id +
//     immutable title + timed bounds). No description/attendees/recurrence.
//   - Account gate: exact configured-account mismatch rejected BEFORE any
//     token or provider I/O.
//   - POST 409/duplicate/alreadyExists: definite_failure (provider proves NO
//     overwrite — never an overwrite, never a retry, never a resend).
//   - POST 401/403/400/422/404/410 before proof of dispatch: definite
//     `auth_refused` / `invalid_input` / `not_found` (nothing claims a
//     commit; no resend).
//   - 5xx / timeout / abort / disconnect / malformed-2xx AFTER a possible
//     dispatch: `unknown` (never a resend, never a cancel, never definite).
//   - Errors never expose raw private data: fixed codes + status only.
//   - Body deadline: abort AFTER dispatch maps to `unknown` (may have been
//     dispatched); abort BEFORE dispatch maps to definite `auth_refused`/
//     `invalid_input` only when no bytes were sent — this adapter cannot
//     prove pre-dispatch, so any caller-signal abort around dispatch is
//     `unknown`.

import {
  type CreateBody,
  type CreateProvider,
  type CreateTarget,
  googleEventsInsertUrl,
} from "./provider.js";

/** Bounded transport budgets (fixed, never auto-raised). */
export const GOOGLE_CREATE_TIMEOUT_MS = 15_000;
export const GOOGLE_CREATE_MAX_BODY_BYTES = 256 * 1024;

export interface GoogleCreateProviderOptions {
  readonly getAccessToken: () => string;
  readonly refreshAccessToken?: () => Promise<void>;
  readonly account?: string;
  /** Explicit TEST seam only: loopback fixture base. Never set in prod. */
  readonly endpointBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

async function consumeBounded(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const text = await res.text();
  if (signal.aborted) throw new Error("transport_lost");
  if (text.length > maxBytes) throw new Error("response_too_large");
  return text;
}

export function createGoogleCreateProvider(
  options: GoogleCreateProviderOptions,
): CreateProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GOOGLE_CREATE_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? GOOGLE_CREATE_MAX_BODY_BYTES;

  function assertAccount(target: CreateTarget): void {
    if (target.account !== undefined) {
      if (options.account === undefined || target.account !== options.account) {
        throw new Error("auth_refused");
      }
    }
  }

  async function insert(
    target: CreateTarget,
    body: CreateBody,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "succeeded" }
    | { readonly status: "definite_failure"; readonly code: string }
    | { readonly status: "unknown"; readonly code: string }
  > {
    try {
      assertAccount(target);
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    if (
      !/^[0-9a-f]{32}$/.test(body.id) ||
      body.summary.length === 0 ||
      Number.isNaN(Date.parse(body.start)) ||
      Number.isNaN(Date.parse(body.end)) ||
      !(Date.parse(body.end) > Date.parse(body.start))
    ) {
      return { status: "definite_failure", code: "invalid_input" };
    }
    try {
      await options.refreshAccessToken?.();
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    let token: string;
    try {
      token = options.getAccessToken();
    } catch {
      return { status: "definite_failure", code: "auth_refused" };
    }
    const url = googleEventsInsertUrl(target.calendarId, options.endpointBase);
    // THE single POST: body ONLY { id, summary, start, end }.
    const postBody = JSON.stringify({
      id: body.id,
      summary: body.summary,
      start: { dateTime: body.start },
      end: { dateTime: body.end },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const detach: Array<() => void> = [];
    try {
      if (signal !== undefined) {
        if (signal.aborted) controller.abort("cancelled");
        else {
          const onAbort = () => controller.abort("cancelled");
          signal.addEventListener("abort", onAbort, { once: true });
          detach.push(() => signal.removeEventListener("abort", onAbort));
        }
      }
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: postBody,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        return { status: "unknown", code: "transport_lost" };
      }
      if (res.status >= 300 && res.status < 400) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        return { status: "unknown", code: "upstream_unknown" };
      }
      if (res.status === 409) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        return { status: "definite_failure", code: "already_exists" };
      }
      if (res.status === 401 || res.status === 403) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        return { status: "definite_failure", code: "auth_refused" };
      }
      if (
        res.status === 400 ||
        res.status === 422 ||
        res.status === 404 ||
        res.status === 410
      ) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        return {
          status: "definite_failure",
          code: res.status === 404 || res.status === 410 ? "not_found" : "invalid_input",
        };
      }
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          // Best effort.
        }
        if (res.status >= 500)
          return { status: "unknown", code: "upstream_5xx" };
        return { status: "unknown", code: "upstream_unknown" };
      }
      try {
        const text = await consumeBounded(res, maxBytes, controller.signal);
        if (text.length > 0) JSON.parse(text);
      } catch {
        return { status: "unknown", code: "response_unparseable" };
      }
      return { status: "succeeded" };
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

  return { insert };
}
