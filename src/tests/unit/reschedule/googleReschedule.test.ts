// M5 fork provider default-behavior tests (self-contained).
//
// Exercises the REAL production Google adapter (`createGoogleRescheduleProvider`)
// with an injected `fetchImpl` only: no network, no Google, no OAuth, no
// filesystem. Covers the default safety contract:
//   - body hang/abort: a headers-delivered never-ending body cannot outlive
//     the single deadline (ONE deadline spans headers AND body consumption);
//   - exact account: a target account that does not exactly equal the
//     configured account is rejected BEFORE any token or provider I/O;
//   - per-request refresh: the auth refresh runs BEFORE every GET and every
//     PATCH (a token that ages out mid-process is renewed; never a retry
//     after dispatch);
//   - single GET: a supplied read observation means zero GET fetches (exactly
//     one PATCH); otherwise exactly one GET + one PATCH;
//   - after-dispatch unknown: 5xx / transport loss / unparseable 2xx AFTER a
//     possible dispatch is `unknown` (never definite, exactly one attempt);
//   - pre-dispatch definite: 404/401/malformed/oversize/shape rejects BEFORE
//     any dispatch are definite with NO patch dispatched.

import { describe, expect, it } from 'vitest';
import {
  createGoogleRescheduleProvider,
} from '../../../reschedule/google.js';
import type { RescheduleObservation } from '../../../reschedule/provider.js';

const TARGET = { calendarId: 'primary', eventId: 'evt-1' } as const;
const PATCH = { start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z' } as const;
const ETAG = '"etag-v1"';

function timedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    etag: ETAG,
    status: 'confirmed',
    start: { dateTime: '2026-02-01T10:00:00Z' },
    end: { dateTime: '2026-02-01T11:00:00Z' },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Headers-delivered, never-ending body: never yields, never closes. */
function hangingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function timedOutSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('caller-cancelled'));
  return controller.signal;
}

describe('fork reschedule provider default behavior (injected fetch)', () => {
  it('exact-account mismatch is rejected BEFORE any token or provider I/O', async () => {
    let tokenCalls = 0;
    let refreshCalls = 0;
    let fetchCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => {
        tokenCalls += 1;
        return 'token';
      },
      refreshAccessToken: async () => {
        refreshCalls += 1;
      },
      account: 'configured@example',
      fetchImpl: (async () => {
        fetchCalls += 1;
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    await expect(
      provider.read({ ...TARGET, account: 'other@example' }),
    ).rejects.toThrow('auth_refused');
    expect(
      await provider.patch({ ...TARGET, account: 'other@example' }, PATCH, {
        ifMatch: ETAG,
      }),
    ).toEqual({ status: 'definite_failure', code: 'auth_refused' });
    expect(tokenCalls).toBe(0);
    expect(refreshCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('refresh runs BEFORE every GET and every PATCH (per-request, never a retry)', async () => {
    const calls: string[] = [];
    let refreshCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => 'token',
      refreshAccessToken: async () => {
        refreshCalls += 1;
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(init?.method ?? 'GET'));
        if (init?.method === 'PATCH') return new Response('{}', { status: 200 });
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    await provider.read(TARGET);
    expect(refreshCalls).toBe(1);
    // Patch without a supplied observation: refresh before GET + refresh
    // before PATCH (the pre-read refresh may have aged across the guard).
    const noCurrent = await provider.patch(TARGET, PATCH, { ifMatch: ETAG });
    expect(noCurrent.status).toBe('succeeded');
    expect(refreshCalls).toBe(3);
    expect(calls).toEqual(['GET', 'GET', 'PATCH']);
    // Patch WITH the already-read observation: no second GET, one refresh.
    calls.length = 0;
    const current: RescheduleObservation = {
      etag: ETAG,
      status: 'confirmed',
      start: '2026-02-01T10:00:00Z',
      end: '2026-02-01T11:00:00Z',
      recurring: false,
      allDay: false,
    };
    const withCurrent = await provider.patch(TARGET, PATCH, {
      ifMatch: ETAG,
      current,
    });
    expect(withCurrent.status).toBe('succeeded');
    expect(refreshCalls).toBe(4);
    expect(calls).toEqual(['PATCH']);
  });

  it('pre-dispatch failures are definite with NO patch dispatched', async () => {
    const cases: Array<{
      name: string;
      get: () => Response;
      code: string;
    }> = [
      { name: '404', get: () => new Response('{}', { status: 404 }), code: 'not_found' },
      { name: '401', get: () => new Response('{}', { status: 401 }), code: 'auth_refused' },
      {
        name: 'malformed',
        get: () => jsonResponse({ id: 'evt-1', status: 'bogus' }),
        code: 'invalid_input',
      },
      {
        name: 'oversize',
        get: () => jsonResponse(timedEvent()),
        code: 'invalid_input',
      },
      {
        name: 'recurring',
        get: () => jsonResponse(timedEvent({ recurrence: ['RRULE:FREQ=DAILY'] })),
        code: 'recurring_unsupported',
      },
      {
        name: 'cancelled',
        get: () => jsonResponse(timedEvent({ status: 'cancelled' })),
        code: 'cancelled_unsupported',
      },
      {
        name: 'all-day',
        get: () =>
          jsonResponse(
            timedEvent({ start: { date: '2026-02-01' }, end: { date: '2026-02-02' } }),
          ),
        code: 'allday_unsupported',
      },
      {
        name: 'missing-etag',
        get: () => jsonResponse(timedEvent({ etag: undefined })),
        code: 'auth_refused',
      },
    ];
    for (const failure of cases) {
      let patchCalls = 0;
      const oversize = failure.name === 'oversize';
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => 'token',
        ...(oversize ? { maxBodyBytes: 8 } : {}),
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'PATCH') {
            patchCalls += 1;
            return new Response('{}', { status: 200 });
          }
          return failure.get();
        }) as typeof fetch,
      });
      const outcome = await provider.patch(TARGET, PATCH, { ifMatch: ETAG });
      expect(outcome, failure.name).toEqual({
        status: 'definite_failure',
        code: failure.code,
      });
      expect(patchCalls, failure.name).toBe(0);
    }
  });

  it('after-dispatch loss is unknown with exactly ONE attempt (no resend)', async () => {
    const cases: Array<{ name: string; patch: () => Response | Promise<Response> }> = [
      { name: '5xx', patch: () => new Response('{}', { status: 500 }) },
      {
        // POST-dispatch 3xx (redirect never followed): the PATCH was already
        // received by the server, so the outcome is UNKNOWN (never definite,
        // exactly one attempt, no resend, no follow).
        name: '3xx-after-patch',
        patch: () => new Response('', { status: 302 }),
      },
      {
        name: 'unparseable-2xx',
        patch: () => new Response('not-json{{{', { status: 200 }),
      },
      {
        name: 'throw',
        patch: () => {
          throw new Error('socket lost');
        },
      },
    ];
    for (const failure of cases) {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => 'token',
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'PATCH') {
            patchCalls += 1;
            return failure.patch();
          }
          return jsonResponse(timedEvent());
        }) as typeof fetch,
      });
      const outcome = await provider.patch(TARGET, PATCH, { ifMatch: ETAG });
      expect(outcome.status, failure.name).toBe('unknown');
      expect(patchCalls, failure.name).toBe(1);
    }
  });

  it('hanging response body cannot outlive the deadline (body hang/abort)', async () => {
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => 'token',
      timeoutMs: 300,
      fetchImpl: (async () => hangingResponse()) as typeof fetch,
    });
    const started = Date.now();
    await expect(provider.read(TARGET)).rejects.toThrow('read_transport_lost');
    expect(Date.now() - started).toBeLessThan(10_000);
    // A caller-aborted dispatch is prompt definite-before-dispatch, not a hang.
    const startedAbort = Date.now();
    await expect(provider.read(TARGET, timedOutSignal())).rejects.toThrow();
    expect(Date.now() - startedAbort).toBeLessThan(10_000);
  });

  it('412 proves NO patch (definite etag_mismatch); conditional PATCH is start/end ONLY', async () => {
    let ifMatch: string | null | undefined;
    let bodyKeys: string[] = [];
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => 'token',
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const headers = new Headers(init.headers);
          ifMatch = headers.get('If-Match');
          bodyKeys = Object.keys(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          ).sort();
          return new Response('{}', { status: 412 });
        }
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    expect(await provider.patch(TARGET, PATCH, { ifMatch: ETAG })).toEqual({
      status: 'definite_failure',
      code: 'etag_mismatch',
    });
    expect(ifMatch).toBe(ETAG);
    expect(bodyKeys).toEqual(['end', 'start']);
  });
});
