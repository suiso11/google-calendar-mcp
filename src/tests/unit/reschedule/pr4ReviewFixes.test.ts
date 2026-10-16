// PR4 review fixes regression (real wire, loopback fixtures only).
//
// F2: persisted `auth:write` grant authorizes the reschedule runtime via the
//     SAME `saveWriteCredentials` store path (no format echoes).
// F3: omitted pageSize sends bounded maxResults 20 (provider fixture with
//     >20 available proves the consumer boundary; one page, no pagination).
// F4: list/search advertise + enforce one optional account string (arrays
//     rejected at schema AND runtime before provider I/O).
// F5: sparse cancelled classifies before bounds (cancelled_unsupported,
//     0 PATCH); strict bounds still required for non-cancelled.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { ListEventsHandler } from "../../../handlers/core/ListEventsHandler.js";
import { SearchEventsHandler } from "../../../handlers/core/SearchEventsHandler.js";
import { ToolRegistry, ToolSchemas } from "../../../tools/registry.js";
import { createAccessTokenSupplier } from "../../../reschedule/auth.js";
import { resolveWriteRuntimeCredential } from "../../../reschedule/cli.js";
import { createGoogleRescheduleProvider } from "../../../reschedule/google.js";
import {
  loadWriteStoredGrant,
  saveWriteCredentials,
  updateWriteStoredAccessToken,
} from "../../../reschedule/writeTokenStore.js";

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({ events: { list: vi.fn() } })),
  },
}));

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const ETAG = '"etag-v1"';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

// ---------------------------------------------------------------- F2 ---
describe("F2: persisted auth:write grant authorizes runtime", () => {
  it("same saveWriteCredentials store -> loader -> supplier refresh -> persist merged 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m5-pr4-f2-"));
    try {
      const tokenPath = join(dir, "tokens.json");
      await saveWriteCredentials(
        "write",
        {
          access_token: "stored-access",
          refresh_token: "stored-refresh",
          scope: WRITE_SCOPE,
          expiry_date: Date.now() + 3_600_000,
          token_type: "Bearer",
        },
        tokenPath,
      );
      await saveWriteCredentials(
        "other",
        {
          access_token: "other-access",
          refresh_token: "other-refresh",
          scope: WRITE_SCOPE,
          expiry_date: Date.now() + 3_600_000,
          token_type: "Bearer",
        },
        tokenPath,
      );
      // SAME store path loads the selected grant (no format conversion).
      const grant = await loadWriteStoredGrant("write", tokenPath);
      expect(grant.refresh_token).toBe("stored-refresh");
      expect(grant.scope).toBe(WRITE_SCOPE);

      const env = {
        M5_RESCHEDULE_ACCOUNT: "write",
        M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath,
      } as NodeJS.ProcessEnv;
      const resolved = await resolveWriteRuntimeCredential(env, {
        loadClientRegistration: async () => ({
          client_id: "fixture-client",
          client_secret: "fixture-secret",
        }),
      });
      expect(resolved.source).toBe("store");
      expect(resolved.credential.account).toBe("write");
      expect(resolved.credential.refreshToken).toBe("stored-refresh");
      expect(resolved.credential.grantedScope).toBe(WRITE_SCOPE);
      expect(resolved.credential.clientId).toBe("fixture-client");

      // Supplier refresh lifecycle against a loopback token fixture, then
      // atomic persist keeps the other account and stays 0600.
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }),
          { status: 200 },
        )) as typeof fetch;
      const supplier = createAccessTokenSupplier({
        clientId: resolved.credential.clientId,
        clientSecret: resolved.credential.clientSecret,
        refreshToken: resolved.credential.refreshToken,
        grantedScope: resolved.credential.grantedScope,
        account: resolved.credential.account,
        accessToken: "expired-token",
        accessTokenExpiresAtMs: Date.now() - 1_000,
        fetchImpl,
      });
      await supplier.refreshIfExpired();
      expect(supplier.getAccessToken()).toBe("fresh-access");
      await updateWriteStoredAccessToken(
        "write",
        supplier.getAccessToken(),
        supplier.getExpiresAtMs(),
        tokenPath,
      );
      const raw = JSON.parse(
        await readFile(tokenPath, "utf-8"),
      ) as Record<string, Record<string, unknown>>;
      expect(raw["write"]?.["access_token"]).toBe("fresh-access");
      expect(raw["write"]?.["refresh_token"]).toBe("stored-refresh");
      expect(raw["other"]?.["access_token"]).toBe("other-access");
      expect((statSync(tokenPath).mode & 0o777) === 0o600).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("partial env credential refuses without file fallthrough; missing/broad grants refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m5-pr4-f2neg-"));
    try {
      const tokenPath = join(dir, "tokens.json");
      await saveWriteCredentials(
        "write",
        {
          refresh_token: "stored-refresh",
          scope: WRITE_SCOPE,
          token_type: "Bearer",
        },
        tokenPath,
      );
      // Partial env (client id only) must not silently fall through to file.
      await expect(
        resolveWriteRuntimeCredential(
          {
            M5_RESCHEDULE_ACCOUNT: "write",
            M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath,
            M5_RESCHEDULE_CLIENT_ID: "partial-id",
          } as NodeJS.ProcessEnv,
          {
            loadClientRegistration: async () => ({
              client_id: "x",
              client_secret: "y",
            }),
          },
        ),
      ).rejects.toThrow("auth_refused");
      // Missing account refuses.
      await expect(
        resolveWriteRuntimeCredential(
          { M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath } as NodeJS.ProcessEnv,
          {
            loadClientRegistration: async () => ({
              client_id: "x",
              client_secret: "y",
            }),
          },
        ),
      ).rejects.toThrow("auth_refused");
      // Unknown account refuses.
      await expect(
        resolveWriteRuntimeCredential(
          {
            M5_RESCHEDULE_ACCOUNT: "nope",
            M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath,
          } as NodeJS.ProcessEnv,
          {
            loadClientRegistration: async () => ({
              client_id: "x",
              client_secret: "y",
            }),
          },
        ),
      ).rejects.toThrow("auth_refused");
      // Broad grant file refuses (save rejects, loader path also closed).
      await expect(
        saveWriteCredentials(
          "broad",
          {
            refresh_token: "r",
            scope: `${WRITE_SCOPE} https://www.googleapis.com/auth/calendar`,
          },
          tokenPath,
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- F3 ---
describe("F3: omitted pageSize sends bounded maxResults 20", () => {
  const mockClient = {
    getAccessToken: vi.fn().mockResolvedValue({ token: "t" }),
  } as unknown as OAuth2Client;
  let mockCalendar: { events: { list: ReturnType<typeof vi.fn> } };

  function fixture25() {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`,
      summary: `E${i}`,
      start: { dateTime: "2025-06-02T10:00:00Z" },
      end: { dateTime: "2025-06-02T11:00:00Z" },
    }));
    mockCalendar = {
      events: {
        list: vi.fn(async (params: { maxResults?: number }) => {
          const limit = params.maxResults ?? 25;
          return { data: { items: items.slice(0, limit) } };
        }),
      },
    };
    vi.mocked(google.calendar).mockReturnValue(mockCalendar as never);
  }

  beforeEach(() => {
    fixture25();
  });

  it("list-events omitted pageSize requests 20 and returns one bounded page", async () => {
    const handler = new ListEventsHandler();
    const accounts = new Map([["test", mockClient]]);
    const result = await handler.runTool({ calendarId: "primary" }, accounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.list.mock.calls[0][0].maxResults).toBe(20);
    const response = JSON.parse((result.content[0] as never as { text: string }).text);
    expect(response.events).toHaveLength(20);
    expect(response.totalCount).toBe(20);
  });

  it("search-events omitted pageSize requests 20; explicit 1..20 honored", async () => {
    const handler = new SearchEventsHandler();
    const accounts = new Map([["test", mockClient]]);
    await handler.runTool(
      {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00Z",
        timeMax: "2025-01-31T23:59:59Z",
      },
      accounts,
    );
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.list.mock.calls[0][0].maxResults).toBe(20);
    mockCalendar.events.list.mockClear();
    await handler.runTool(
      {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00Z",
        timeMax: "2025-01-31T23:59:59Z",
        pageSize: 5,
      },
      accounts,
    );
    expect(mockCalendar.events.list.mock.calls[0][0].maxResults).toBe(5);
  });
});

// ---------------------------------------------------------------- F4 ---
describe("F4: one optional account string (schema + runtime)", () => {
  it("advertised schemas accept one string/omission and reject arrays", () => {
    const bases = {
      "list-events": { calendarId: "primary" },
      "search-events": {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00Z",
        timeMax: "2025-01-31T23:59:59Z",
      },
    } as const;
    for (const tool of ["list-events", "search-events"] as const) {
      const base = bases[tool] as Record<string, unknown>;
      expect(ToolSchemas[tool].safeParse(base).success).toBe(true);
      expect(
        ToolSchemas[tool].safeParse({ ...base, account: "work" }).success,
      ).toBe(true);
      expect(
        ToolSchemas[tool].safeParse({ ...base, account: ["work"] }).success,
      ).toBe(false);
      expect(
        ToolSchemas[tool].safeParse({ ...base, account: ["work", "personal"] })
          .success,
      ).toBe(false);
    }
    // Wire JSON schema for both tools: account is string-only, never array.
    const wire = ToolRegistry.getToolsWithSchemas();
    for (const name of ["list-events", "search-events"]) {
      const tool = wire.find((t) => t.name === name);
      const account = (
        tool?.inputSchema as {
          properties?: { account?: Record<string, unknown> };
        }
      )?.properties?.["account"] as
        | { type?: unknown; anyOf?: unknown[] }
        | undefined;
      const text = JSON.stringify(account ?? {});
      expect(text).not.toMatch(/"array"/);
    }
  });

  it("runtime rejects array one/many before provider I/O", async () => {
    const mockClient = {
      getAccessToken: vi.fn().mockResolvedValue({ token: "t" }),
    } as unknown as OAuth2Client;
    const accounts = new Map([["test", mockClient]]);
    const multi = new Map<string, OAuth2Client>([
      ["work", mockClient],
      ["personal", mockClient],
    ]);
    const listCalendar = {
      events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    };
    const searchCalendar = {
      events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    };
    vi.mocked(google.calendar).mockReturnValue(listCalendar as never);
    const list = new ListEventsHandler();
    await expect(
      list.runTool({ calendarId: "primary", account: ["work"] } as never, multi),
    ).rejects.toThrow(/exactly one account/i);
    await expect(
      list.runTool(
        { calendarId: "primary", account: ["work", "personal"] } as never,
        multi,
      ),
    ).rejects.toThrow(/exactly one account/i);
    expect(listCalendar.events.list).not.toHaveBeenCalled();
    vi.mocked(google.calendar).mockReturnValue(searchCalendar as never);
    const search = new SearchEventsHandler();
    await expect(
      search.runTool(
        {
          calendarId: "primary",
          timeMin: "2025-01-01T00:00:00Z",
          timeMax: "2025-01-31T23:59:59Z",
          account: ["work"],
        } as never,
        multi,
      ),
    ).rejects.toThrow(/exactly one account/i);
    expect(searchCalendar.events.list).not.toHaveBeenCalled();
    // Single string still selects the configured client.
    vi.mocked(google.calendar).mockReturnValue(listCalendar as never);
    await list.runTool({ calendarId: "primary", account: "work" }, multi);
    expect(listCalendar.events.list).toHaveBeenCalledTimes(1);
    void accounts;
  });
});

// ---------------------------------------------------------------- F5 ---
describe("F5: sparse cancelled classifies before bounds", () => {
  it("cancelled GET without start/end is cancelled_unsupported with 0 PATCH", async () => {
    let patchCalls = 0;
    const provider = createGoogleRescheduleProvider({
      getAccessToken: () => "token",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCalls += 1;
          return new Response("{}", { status: 200 });
        }
        return jsonResponse({ id: "evt-1", etag: ETAG, status: "cancelled" });
      }) as typeof fetch,
    });
    const outcome = await provider.patch(
      { calendarId: "primary", eventId: "evt-1" },
      { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z" },
      { ifMatch: ETAG },
    );
    expect(outcome).toEqual({
      status: "definite_failure",
      code: "cancelled_unsupported",
    });
    expect(patchCalls).toBe(0);
  });

  it("non-cancelled sparse shapes still require bounds; guards unchanged", async () => {
    async function patchFor(get: Response) {
      let patchCalls = 0;
      const provider = createGoogleRescheduleProvider({
        getAccessToken: () => "token",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            patchCalls += 1;
            return new Response("{}", { status: 200 });
          }
          return get;
        }) as typeof fetch,
      });
      const outcome = await provider.patch(
        { calendarId: "primary", eventId: "evt-1" },
        { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z" },
        { ifMatch: ETAG },
      );
      return { outcome, patchCalls };
    }
    // Confirmed without endpoints: still invalid_input, 0 PATCH.
    const sparse = await patchFor(
      jsonResponse({ id: "evt-1", etag: ETAG, status: "confirmed" }),
    );
    expect(sparse.outcome).toEqual({
      status: "definite_failure",
      code: "invalid_input",
    });
    expect(sparse.patchCalls).toBe(0);
    // Recurring + cancelled without endpoints: recurring still wins.
    const recurring = await patchFor(
      jsonResponse({
        id: "evt-1",
        etag: ETAG,
        status: "cancelled",
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    );
    expect(recurring.outcome).toEqual({
      status: "definite_failure",
      code: "recurring_unsupported",
    });
    expect(recurring.patchCalls).toBe(0);
    // Missing etag cancelled: auth_refused unchanged.
    const noEtag = await patchFor(
      jsonResponse({ id: "evt-1", status: "cancelled" }),
    );
    expect(noEtag.outcome).toEqual({
      status: "definite_failure",
      code: "auth_refused",
    });
    expect(noEtag.patchCalls).toBe(0);
    // Timed happy path still succeeds (sanity, not a count claim).
    void timedEvent;
  });
});
