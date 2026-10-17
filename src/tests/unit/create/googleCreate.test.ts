// M6 dedicated create provider consumer edges (hermetic, injected fetch only).
//
// Exercises the REAL production Google create adapter
// (`src/create/google.ts`) against an injected loopback fetch — no network,
// no OAuth, no live Google:
// - body-only single POST shape { id, summary, start:{dateTime}, end:{dateTime} }
// - 409 -> definite_failure already_exists, exactly 1 POST, no resend
// - 5xx -> unknown, exactly 1 POST, no resend
// - malformed-2xx body -> unknown (proof lost), exactly 1 POST
// - unusable-2xx bodies (empty / null / array / {} / wrong-id) -> unknown,
//   exactly 1 POST, no GET auto-resolve, no resend (only the exact-id body
//   proves the commit)
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

  it.each([
    ["empty body", ""],
    ["null body", "null"],
    ["array body", "[]"],
    ["missing-id body", "{}"],
    ["wrong-id body", JSON.stringify({ id: "b".repeat(32) })],
  ])("maps an unusable 2xx %s to unknown with one POST and no resolve", async (_label, raw) => {
    const seen: string[] = [];
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async (url: unknown, init: unknown) => {
        seen.push(String((init as { method?: string }).method ?? "GET"));
        return new Response(raw, { status: 200 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    // Single POST only: no retry/resend and no GET auto-resolve.
    expect(seen).toEqual(["POST"]);
  });

  it("still succeeds on an exact-id 2xx event body with one POST", async () => {
    const seen: string[] = [];
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async (url: unknown, init: unknown) => {
        seen.push(String((init as { method?: string }).method ?? "GET"));
        return okJson({ id: ID, summary: "T" });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen).toEqual(["POST"]);
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

describe("create google provider bounded body (M6, shared helper)", () => {
  it("rejects a multi-byte 2xx body past the BYTE cap even when the char length fits, one POST", async () => {
    // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes: a body whose char
    // length fits the cap but whose byte length exceeds it must stay
    // `unknown` (byte bound enforced BEFORE decode, never text.length).
    const pad = "é".repeat(60);
    const raw = JSON.stringify({ id: ID, pad });
    const charLen = raw.length;
    const byteLen = new TextEncoder().encode(raw).byteLength;
    const cap = 128;
    expect(charLen).toBeLessThanOrEqual(cap);
    expect(byteLen).toBeGreaterThan(cap);
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      maxBodyBytes: cap,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(raw, { status: 200 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("cancels a chunked oversize 2xx stream early (no full read), one POST", async () => {
    // Lazy pull-based stream offering 64 x 8 KiB (512 KiB) against the
    // default 256 KiB cap: the provider must cancel after ~33 chunks and
    // never pull the whole stream (byte bound BEFORE buffering).
    const totalChunks = 64;
    const chunk = new TextEncoder().encode("x".repeat(8192));
    let pulls = 0;
    let cancelled = false;
    const lazy = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(lazy, { status: 200 });
      }) as typeof fetch,
    });
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(totalChunks);
  });

  it("maps a hanging 2xx body to unknown on the shared deadline (no retry, no hang)", async () => {
    let calls = 0;
    const provider = createGoogleCreateProvider({
      getAccessToken: () => "tok",
      timeoutMs: 30,
      fetchImpl: (async () => {
        calls += 1;
        // Headers delivered, body never yields: the live deadline aborts it.
        const hanging = new ReadableStream<Uint8Array>({});
        return new Response(hanging, { status: 200 });
      }) as typeof fetch,
    });
    const started = Date.now();
    const outcome = await provider.insert(
      { calendarId: "primary" },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome.status).toBe("unknown");
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
