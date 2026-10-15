// M5 review-findings regression tests (fork PR3, commit 4f9c06d).
//
// Ground-truth findings from reviewer `chatgpt-codex-connector[bot]`
// (review 5532918829), implemented WITHOUT re-running live flows:
//   (A) discussion 4282819734 — wildcard/list etags rejected + exact
//       committed-grant equality before PATCH (server AND direct provider
//       calls), 412 still proves a GET→PATCH race with no apply/resend.
//   (B) discussion 4282819746 — strict calendar-date validation (Feb 30,
//       leap/non-leap, month lengths, offsets, start<end; valid leap /
//       fraction / offset instants still pass).
//   (C) discussion 4282819759 — broad `.../auth/calendar` scope refused even
//       with the exact token present (startup + refresh), refused refresh
//       persists no token file.
//   (D) discussion 4282819777 — preflight GET 429/500 keeps the dedicated
//       redacted `read_upstream_error` (definite, 0 PATCH), distinct from
//       `invalid_input`; main failure outcomes unchanged.
//
// All provider tests use the REAL production adapter
// (`createGoogleRescheduleProvider`) with injected `fetchImpl` only: no
// network, no Google, no OAuth, no secrets.

import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createAccessTokenSupplier } from "../../../reschedule/auth.js";
import {
  createGoogleRescheduleProvider,
} from "../../../reschedule/google.js";
import {
  isExactEtagCandidate,
  validateWriteCredential,
} from "../../../reschedule/provider.js";
import type { RescheduleObservation } from "../../../reschedule/provider.js";
import { createRescheduleServer } from "../../../reschedule/server.js";
import {
  RescheduleEventInputSchema,
  isStrictCalendarInstant,
} from "../../../reschedule/schema.js";

const TARGET = { calendarId: "primary", eventId: "evt-1" } as const;
const PATCH = {
  start: "2026-03-01T10:00:00Z",
  end: "2026-03-01T11:00:00Z",
} as const;
const ETAG = '"etag-v1"';
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const BROAD_SCOPE = "https://www.googleapis.com/auth/calendar";

function timedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    etag: ETAG,
    status: "confirmed",
    start: { dateTime: "2026-02-01T10:00:00Z" },
    end: { dateTime: "2026-02-01T11:00:00Z" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CURRENT: RescheduleObservation = {
  etag: ETAG,
  status: "confirmed",
  start: "2026-02-01T10:00:00Z",
  end: "2026-02-01T11:00:00Z",
  recurring: false,
  allDay: false,
};

/** Call the reschedule tool through a real in-memory MCP client+server. */
async function callViaMcp(
  provider: Parameters<typeof createRescheduleServer>[0]["provider"],
  args: Record<string, unknown>,
  credentialScope: string = WRITE_SCOPE,
): Promise<{ text: string; isError?: boolean }> {
  const server = createRescheduleServer({ provider, credentialScope });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const result = await client.callTool({
      name: "reschedule-event",
      arguments: args,
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    return {
      text: content[0]?.text ?? "",
      ...(result.isError === true ? { isError: true as const } : {}),
    };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calendarId: "primary",
    eventId: "evt-1",
    start: PATCH.start,
    end: PATCH.end,
    expectedEtag: ETAG,
    ...overrides,
  };
}

describe("review (A): wildcard/list/stale etags never dispatch", () => {
  it("direct provider patch: wildcard/list/mismatch return etag_mismatch with 0 PATCH", async () => {
    for (const ifMatch of ["*", '"etag-v1", "etag-v2"', "W/\"a\", \"b\""]) {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") patchCalls += 1;
          return jsonResponse(timedEvent());
        }) as typeof fetch,
      });
      const outcome = await provider.patch(TARGET, PATCH, {
        ifMatch,
        current: CURRENT,
      });
      expect(outcome, ifMatch).toEqual({
        status: "definite_failure",
        code: "etag_mismatch",
      });
      expect(patchCalls, ifMatch).toBe(0);
    }
    // Stale-but-well-formed etag: general inequality also refuses (0 PATCH).
    let stalePatchCalls = 0;
    const staleProvider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") stalePatchCalls += 1;
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    expect(
      await staleProvider.patch(TARGET, PATCH, {
        ifMatch: '"stale-etag"',
        current: CURRENT,
      }),
    ).toEqual({ status: "definite_failure", code: "etag_mismatch" });
    expect(stalePatchCalls).toBe(0);
  });

  it("direct provider patch: exact opaque quoted etag dispatches exactly one PATCH", async () => {
    let patchCalls = 0;
    let ifMatch: string | null | undefined;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          ifMatch = new Headers(init.headers).get("If-Match");
          return new Response("{}", { status: 200 });
        }
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    expect(
      await provider.patch(TARGET, PATCH, { ifMatch: ETAG, current: CURRENT }),
    ).toEqual({ status: "succeeded" });
    expect(patchCalls).toBe(1);
    expect(ifMatch).toBe(ETAG);
    expect(isExactEtagCandidate(ETAG)).toBe(true);
    expect(isExactEtagCandidate("*")).toBe(false);
  });

  it("server: wildcard/list/mismatch etags are etag_mismatch with 0 PATCH; exact succeeds", async () => {
    for (const expectedEtag of ["*", '"etag-v1", "etag-v2"', '"stale-etag"']) {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            patchCalls += 1;
            return new Response("{}", { status: 200 });
          }
          return jsonResponse(timedEvent());
        }) as typeof fetch,
      });
      const result = await callViaMcp(provider, baseArgs({ expectedEtag }));
      expect(JSON.parse(result.text), expectedEtag).toEqual({
        status: "definite_failure",
        code: "etag_mismatch",
      });
      expect(patchCalls, expectedEtag).toBe(0);
    }
    // Exact match: one PATCH, success.
    let okPatchCalls = 0;
    const okProvider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          okPatchCalls += 1;
          return new Response("{}", { status: 200 });
        }
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    expect(JSON.parse((await callViaMcp(okProvider, baseArgs())).text)).toEqual(
      { status: "succeeded" },
    );
    expect(okPatchCalls).toBe(1);
  });

  it("race after read: 412 is definite etag_mismatch with no apply and no resend", async () => {
    let patchCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          return new Response("{}", { status: 412 });
        }
        return jsonResponse(timedEvent());
      }) as typeof fetch,
    });
    const result = await callViaMcp(provider, baseArgs());
    expect(JSON.parse(result.text)).toEqual({
      status: "definite_failure",
      code: "etag_mismatch",
    });
    // Exactly the pre-read GET + the single refused PATCH: no resend.
    expect(patchCalls).toBe(1);
  });
});

describe("review (B): strict calendar dates (no Date.parse rollover)", () => {
  it("rejects nonexistent dates: Feb 30, non-leap Feb 29, 31st of 30-day months", () => {
    expect(isStrictCalendarInstant("2023-02-30T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-02-29T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-04-31T10:00:00+02:00")).toBe(false);
    expect(isStrictCalendarInstant("2023-13-01T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-00-10T10:00:00Z")).toBe(false);
    expect(isStrictCalendarInstant("2023-01-32T10:00:00Z")).toBe(false);
    expect(
      RescheduleEventInputSchema.safeParse({
        calendarId: "primary",
        eventId: "e",
        start: "2023-02-30T10:00:00Z",
        end: "2023-02-30T11:00:00Z",
        expectedEtag: ETAG,
      }).success,
    ).toBe(false);
  });

  it("accepts real boundaries: leap Feb 29, fractions, offsets; enforces start<end", () => {
    expect(isStrictCalendarInstant("2024-02-29T10:00:00Z")).toBe(true);
    expect(isStrictCalendarInstant("2024-02-29T10:00:00.123456789Z")).toBe(true);
    expect(isStrictCalendarInstant("2024-02-29T10:00:00+05:30")).toBe(true);
    expect(isStrictCalendarInstant("2023-12-31T23:59:59-08:00")).toBe(true);
    expect(
      RescheduleEventInputSchema.safeParse({
        calendarId: "primary",
        eventId: "e",
        start: "2024-02-29T10:00:00Z",
        end: "2024-02-29T11:00:00.5Z",
        expectedEtag: ETAG,
      }).success,
    ).toBe(true);
    // start<end preserved (reversed range still rejected).
    expect(
      RescheduleEventInputSchema.safeParse({
        calendarId: "primary",
        eventId: "e",
        start: "2024-02-29T11:00:00Z",
        end: "2024-02-29T10:00:00Z",
        expectedEtag: ETAG,
      }).success,
    ).toBe(false);
  });
});

describe("review (C): broad write scope refused even with the exact token", () => {
  it("startup validation refuses broad scope mixed with the exact token", () => {
    expect(validateWriteCredential(WRITE_SCOPE)).toBe(true);
    expect(
      validateWriteCredential(`${WRITE_SCOPE} ${BROAD_SCOPE}`),
    ).toBe(false);
    expect(
      validateWriteCredential(`${BROAD_SCOPE} ${WRITE_SCOPE}`),
    ).toBe(false);
    expect(validateWriteCredential(BROAD_SCOPE)).toBe(false);
  });

  it("refresh response carrying the broad scope is refused and persists no token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m5-scope-"));
    const tokenFile = join(dir, "write-token.json");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: "new-token",
          expires_in: 3600,
          scope: `${WRITE_SCOPE} ${BROAD_SCOPE}`,
        }),
        { status: 200 },
      )) as typeof fetch;
    const supplier = createAccessTokenSupplier({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      grantedScope: WRITE_SCOPE,
      account: "test-account",
      tokenFile,
      fetchImpl,
    });
    await expect(supplier.refreshIfExpired()).rejects.toThrow("auth_refused");
    expect(existsSync(tokenFile)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("review (D): preflight GET 429/500 keeps a dedicated upstream code", () => {
  it.each([429, 500])(
    "server maps preflight GET %i to read_upstream_error with 0 PATCH (distinct from invalid_input)",
    async (status) => {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            patchCalls += 1;
            return new Response("{}", { status: 200 });
          }
          return new Response("{}", { status });
        }) as typeof fetch,
      });
      const result = await callViaMcp(provider, baseArgs());
      expect(JSON.parse(result.text)).toEqual({
        status: "definite_failure",
        code: "read_upstream_error",
      });
      expect(patchCalls).toBe(0);
      // Direct provider path agrees (definite, no dispatch).
      let directPatchCalls = 0;
      const direct = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            directPatchCalls += 1;
            return new Response("{}", { status: 200 });
          }
          return new Response("{}", { status });
        }) as typeof fetch,
      });
      expect(await direct.patch(TARGET, PATCH, { ifMatch: ETAG })).toEqual({
        status: "definite_failure",
        code: "read_upstream_error",
      });
      expect(directPatchCalls).toBe(0);
    },
  );

  it("invalid input still maps to invalid_input (main outcomes unchanged)", async () => {
    expect(
      RescheduleEventInputSchema.safeParse(
        baseArgs({ start: "not-a-date" }),
      ).success,
    ).toBe(false);
    let patchCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    const result = await callViaMcp(provider, baseArgs());
    expect(JSON.parse(result.text)).toEqual({
      status: "definite_failure",
      code: "not_found",
    });
    expect(patchCalls).toBe(0);
  });
});
