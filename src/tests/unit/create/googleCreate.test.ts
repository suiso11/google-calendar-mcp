// M6 dedicated create provider consumer edges (hermetic, injected fetch only).
//
// Exercises the REAL production Google create adapter
// (`src/create/google.ts`) against an injected loopback fetch — no network,
// no OAuth, no live Google:
// - body-only single POST shape { id, summary, start:{dateTime}, end:{dateTime} }
// - 409 -> definite_failure already_exists, exactly 1 POST, no resend
// - 5xx -> unknown, exactly 1 POST, no resend
// - malformed-2xx body -> unknown (proof lost), exactly 1 POST
// - account mismatch -> definite_failure auth_refused with ZERO POSTs
// - invalid id / empty title / end<=start -> definite_failure invalid_input, 0 POSTs

import { describe, expect, it } from "vitest";
import { createGoogleCreateProvider } from "../../../create/google.js";

const ID = "a".repeat(32);
const START = "2026-03-01T10:00:00Z";
const END = "2026-03-01T11:00:00Z";

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("create google provider consumer edges (M6)", () => {
  it("posts exactly once with the body-only shape", async () => {
    const seen: Array<{ url: string; body: unknown; method: string }> = [];
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      account: "work",
      fetchImpl: (async (url: unknown, init: unknown) => {
        const opts = init as { method?: string; body?: string };
        seen.push({
          url: String(url),
          body: JSON.parse(String(opts.body)),
          method: opts.method ?? "",
        });
        return okJson({ id: ID });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary", account: "work" },
      { id: ID, summary: "Team sync", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(String(seen[0]?.url)).toContain("/calendar/v3/calendars/primary/events");
    const body = seen[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["end", "id", "start", "summary"]);
    expect(body["id"]).toBe(ID);
    expect(body["summary"]).toBe("Team sync");
    expect(body["start"]).toEqual({ dateTime: START });
    expect(body["end"]).toEqual({ dateTime: END });
  });

  it("maps 409 to definite_failure with exactly one POST (no overwrite/resend)", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("conflict", { status: 409 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "definite_failure", code: "already_exists" });
    expect(calls).toBe(1);
  });

  it("maps 5xx to unknown with exactly one POST (no resend)", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("maps an unparseable 2xx body to unknown (proof lost), one POST", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("not-json{{{", { status: 200 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("rejects an account mismatch before any POST", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      account: "work",
      fetchImpl: (async () => {
        calls += 1;
        return okJson({});
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary", account: "other" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "definite_failure", code: "auth_refused" });
    expect(calls).toBe(0);
  });

  it("rejects invalid id/title/bounds before any POST", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async () => {
        calls += 1;
        return okJson({});
      }) as typeof fetch,
    });
    const base = { summary: "T", start: START, end: END };
    expect(await provider.insert({ calendarId: "primary" }, { ...base, id: "NOTHEX!!" })).toEqual({
      status: "definite_failure",
      code: "invalid_input",
    });
    expect(
      await provider.insert({ calendarId: "primary" }, { ...base, id: ID, summary: "" }),
    ).toEqual({ status: "definite_failure", code: "invalid_input" });
    expect(
      await provider.insert({ calendarId: "primary" }, { ...base, id: ID, start: END, end: START }),
    ).toEqual({ status: "definite_failure", code: "invalid_input" });
    expect(calls).toBe(0);
  });
});
