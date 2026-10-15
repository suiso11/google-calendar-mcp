// M5 all-day → timed conversion tests (REAL production adapter, injected fetch).
//
// Valid all-day sources (strict YYYY-MM-DD bounds, exclusive end > start)
// CONVERT to timed: exactly ONE conditional PATCH with `date: null`
// clearing + new `dateTime`, exact If-Match, start/end keys only.
// Malformed all-day sources (bad date, end <= start, mixed timed/date)
// are `invalid_input` with NO patch dispatched. Timed path keeps the exact
// prior shape (no extra keys). No network, no Google, no OAuth.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createGoogleRescheduleProvider,
  normalizeGoogleObservation,
} from "../../../reschedule/google.js";
import {
  beforeWriteGuard,
  isStrictCalendarDate,
  isValidAllDaySource,
} from "../../../reschedule/provider.js";
import type { RescheduleObservation } from "../../../reschedule/provider.js";
import { createRescheduleServer } from "../../../reschedule/server.js";

const TARGET = { calendarId: "primary", eventId: "evt-allday-1" } as const;
const ETAG = '"etag-allday-1"';
const PATCH = {
  start: "2026-10-16T15:00:00+09:00",
  end: "2026-10-16T16:00:00+09:00",
} as const;
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function allDayEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-allday-1",
    etag: ETAG,
    status: "confirmed",
    start: { date: "2026-10-16" },
    end: { date: "2026-10-17" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callViaMcp(
  provider: Parameters<typeof createRescheduleServer>[0]["provider"],
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const server = createRescheduleServer({
    provider,
    credentialScope: WRITE_SCOPE,
  });
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

describe("all-day → timed conversion (strict bounds + date:null clearing)", () => {
  it("strict date validation rejects rollover dates, accepts leap day", () => {
    expect(isStrictCalendarDate("2026-02-30")).toBe(false);
    expect(isStrictCalendarDate("2023-02-29")).toBe(false);
    expect(isStrictCalendarDate("2024-02-29")).toBe(true);
    expect(isStrictCalendarDate("2026-13-01")).toBe(false);
    expect(isStrictCalendarDate("2026-10-16")).toBe(true);
    expect(isStrictCalendarDate("2026-10-16T15:00:00+09:00")).toBe(false);
  });

  it("normalizer retains valid all-day bounds, rejects malformed", () => {
    const obs = normalizeGoogleObservation(allDayEvent(), "evt-allday-1");
    expect(obs.allDay).toBe(true);
    expect(obs.start).toBe("");
    expect(obs.end).toBe("");
    expect(obs).toMatchObject({
      startDate: "2026-10-16",
      endDate: "2026-10-17",
    });
    // Rollover / reversed / mixed shapes are malformed (no patch path).
    expect(() =>
      normalizeGoogleObservation(
        allDayEvent({ start: { date: "2026-02-30" } }),
        "evt-allday-1",
      ),
    ).toThrow("malformed_response");
    expect(() =>
      normalizeGoogleObservation(
        allDayEvent({
          start: { date: "2026-10-17" },
          end: { date: "2026-10-16" },
        }),
        "evt-allday-1",
      ),
    ).toThrow("malformed_response");
    expect(() =>
      normalizeGoogleObservation(
        allDayEvent({ end: { dateTime: "2026-10-16T11:00:00Z" } }),
        "evt-allday-1",
      ),
    ).toThrow("malformed_response");
  });

  it("beforeWriteGuard permits valid all-day, rejects malformed with invalid_input", () => {
    const valid: RescheduleObservation = {
      etag: ETAG,
      status: "confirmed",
      start: "",
      end: "",
      recurring: false,
      allDay: true,
      startDate: "2026-10-16",
      endDate: "2026-10-17",
    };
    expect(isValidAllDaySource(valid)).toBe(true);
    expect(beforeWriteGuard(valid)).toBeNull();
    const bad: RescheduleObservation = {
      ...valid,
      endDate: "2026-10-16",
    };
    expect(beforeWriteGuard(bad)).toBe("invalid_input");
  });

  it("valid all-day converts: ONE PATCH with date:null + dateTime, exact If-Match", async () => {
    let patchCalls = 0;
    let ifMatch: string | null | undefined;
    let parsedBody: Record<string, unknown> | undefined;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          ifMatch = new Headers(init.headers).get("If-Match");
          parsedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response("{}", { status: 200 });
        }
        return jsonResponse(allDayEvent());
      }) as typeof fetch,
    });
    const outcome = await provider.patch(TARGET, PATCH, { ifMatch: ETAG });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(patchCalls).toBe(1);
    expect(ifMatch).toBe(ETAG);
    expect(Object.keys(parsedBody ?? {}).sort()).toEqual(["end", "start"]);
    expect(parsedBody?.["start"]).toEqual({
      date: null,
      dateTime: PATCH.start,
    });
    expect(parsedBody?.["end"]).toEqual({
      date: null,
      dateTime: PATCH.end,
    });
  });

  it("timed source keeps dateTime-only body (no extra date key)", async () => {
    let parsedBody: Record<string, unknown> | undefined;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          parsedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response("{}", { status: 200 });
        }
        return jsonResponse({
          id: "evt-allday-1",
          etag: ETAG,
          status: "confirmed",
          start: { dateTime: "2026-02-01T10:00:00Z" },
          end: { dateTime: "2026-02-01T11:00:00Z" },
        });
      }) as typeof fetch,
    });
    expect(await provider.patch(TARGET, PATCH, { ifMatch: ETAG })).toEqual({
      status: "succeeded",
    });
    expect(parsedBody?.["start"]).toEqual({ dateTime: PATCH.start });
    expect(parsedBody?.["end"]).toEqual({ dateTime: PATCH.end });
  });

  it("invalid all-day dispatches NO patch (direct + server paths)", async () => {
    for (const get of [
      () =>
        jsonResponse(
          allDayEvent({ start: { date: "2026-02-30" } }),
        ),
      () =>
        jsonResponse(
          allDayEvent({
            start: { date: "2026-10-17" },
            end: { date: "2026-10-16" },
          }),
        ),
    ]) {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") patchCalls += 1;
          return get();
        }) as typeof fetch,
      });
      expect(await provider.patch(TARGET, PATCH, { ifMatch: ETAG })).toEqual({
        status: "definite_failure",
        code: "invalid_input",
      });
      expect(patchCalls).toBe(0);
    }
    // Server path: malformed all-day read is definite invalid_input, no PATCH.
    let serverPatchCalls = 0;
    const serverProvider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") serverPatchCalls += 1;
        return jsonResponse(allDayEvent({ start: { date: "bad-date" } }));
      }) as typeof fetch,
    });
    const result = await callViaMcp(serverProvider, {
      calendarId: "primary",
      eventId: "evt-allday-1",
      start: PATCH.start,
      end: PATCH.end,
      expectedEtag: ETAG,
    });
    expect(JSON.parse(result.text)).toEqual({
      status: "definite_failure",
      code: "invalid_input",
    });
    expect(serverPatchCalls).toBe(0);
  });

  it("server path converts valid all-day end-to-end (single PATCH, date:null)", async () => {
    let patchCalls = 0;
    let parsedBody: Record<string, unknown> | undefined;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          parsedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response("{}", { status: 200 });
        }
        return jsonResponse(allDayEvent());
      }) as typeof fetch,
    });
    const result = await callViaMcp(provider, {
      calendarId: "primary",
      eventId: "evt-allday-1",
      start: PATCH.start,
      end: PATCH.end,
      expectedEtag: ETAG,
    });
    expect(JSON.parse(result.text)).toEqual({ status: "succeeded" });
    expect(patchCalls).toBe(1);
    expect(parsedBody?.["start"]).toEqual({
      date: null,
      dateTime: PATCH.start,
    });
  });

  it("412 after conversion dispatch is still definite etag_mismatch (no resend)", async () => {
    let patchCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          return new Response("{}", { status: 412 });
        }
        return jsonResponse(allDayEvent());
      }) as typeof fetch,
    });
    expect(await provider.patch(TARGET, PATCH, { ifMatch: ETAG })).toEqual({
      status: "definite_failure",
      code: "etag_mismatch",
    });
    expect(patchCalls).toBe(1);
  });
});
