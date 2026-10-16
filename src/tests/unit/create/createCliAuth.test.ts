// M6 create CLI persisted-grant auth (hermetic, no network, no Google).
//
// Mirrors the reschedule persisted-grant contract through the SHARED
// write runtime resolution (`src/create/cli.ts` reuses
// `resolveWriteRuntimeCredential` + `createAccessTokenSupplier` +
// `updateWriteStoredAccessToken` — there is NO `M6_CREATE_*` credential
// namespace):
// - positive: temp grant file (exact `calendar.events` scope,
//   future-expiry access) + injected client registration resolves from
//   the store, the factory authorizes WITHOUT any refresh network, and
//   exactly ONE Google-shaped POST carries the stored bearer + the
//   body-only shape; the other account entry is preserved and the file
//   stays 0600;
// - refresh: an expired access token triggers ONE loopback OAuth refresh
//   (test seam ONLY) whose token is used for the single POST AND
//   persisted back into the SAME per-account file (other accounts kept);
// - negatives (missing account, readonly-only scope, broad scope
//   alongside the exact token, grant for another account, partial env
//   credential WITH a valid grant file present, write/readonly
//   token-path collision, missing client registration) all refuse with
//   `auth_refused`, ZERO POSTs, and a byte-identical grant file;
// - the obsolete `M6_CREATE_*` namespace is dead: setting it changes
//   nothing (resolution still reads ONLY `M5_RESCHEDULE_*` + the shared
//   grant file).

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  createCreateRuntimeProvider,
  resolveCreateRuntimeCredential,
} from "../../../create/cli.js";
import { saveWriteCredentials } from "../../../reschedule/writeTokenStore.js";

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
const BROAD_SCOPE = "https://www.googleapis.com/auth/calendar";
const ACCOUNT = "create-acct";
const OTHER_ACCOUNT = "other-acct";
const ID = "b".repeat(32);
const START = "2026-04-01T10:00:00Z";
const END = "2026-04-01T11:00:00Z";

let tempDirs: string[] = [];
let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  servers = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m6-create-cli-auth-"));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(tokenPath: string, extra: Record<string, string> = {}) {
  return {
    M5_RESCHEDULE_ACCOUNT: ACCOUNT,
    M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath,
    ...extra,
  } as NodeJS.ProcessEnv;
}

const fixtureClient = {
  loadClientRegistration: async () => ({
    client_id: "fixture-client",
    client_secret: "fixture-secret",
  }),
};

async function seedGrant(
  tokenPath: string,
  account: string,
  scope: string,
  accessToken = "stored-access",
  expiresInMs = 3_600_000,
) {
  // Invalid scopes (readonly-only, broad) are refused BY `save` itself, so
  // those negative fixtures are written raw in the exact production file
  // shape to prove the LOADER also refuses them.
  if (scope !== WRITE_SCOPE) {
    const current: Record<string, unknown> = {};
    try {
      const raw = readFileSync(tokenPath, "utf-8");
      Object.assign(current, JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // Absent/unparseable: start from an empty store.
    }
    current[account] = {
      access_token: accessToken,
      refresh_token: "stored-refresh",
      scope,
      expiry_date: Date.now() + expiresInMs,
      token_type: "Bearer",
    };
    writeFileSync(tokenPath, JSON.stringify(current, null, 2));
    return;
  }
  await saveWriteCredentials(
    account,
    {
      access_token: accessToken,
      refresh_token: "stored-refresh",
      scope,
      expiry_date: Date.now() + expiresInMs,
      token_type: "Bearer",
    },
    tokenPath,
  );
}

/** Loopback Google-shaped events.insert fixture. Records POST count/bodies. */
async function startInsertFixture(): Promise<{
  base: string;
  posts: Array<{ auth: string | null; body: unknown }>;
}> {
  const posts: Array<{ auth: string | null; body: unknown }> = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        posts.push({
          auth:
            typeof req.headers.authorization === "string"
              ? req.headers.authorization
              : null,
          body: JSON.parse(raw),
        });
      } catch {
        posts.push({ auth: null, body: raw });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ID }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, posts };
}

/** Loopback OAuth token fixture: serves exactly one refresh response. */
async function startTokenFixture(response: unknown): Promise<{
  url: string;
  calls: { count: number };
}> {
  const calls = { count: 0 };
  const server = createServer((req, res) => {
    calls.count += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, calls };
}

describe("create CLI shared persisted-grant auth (M6)", () => {
  it("resolves the store grant and posts once with the stored bearer (no refresh network)", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "tokens.json");
    await seedGrant(tokenPath, ACCOUNT, WRITE_SCOPE);
    await seedGrant(tokenPath, OTHER_ACCOUNT, WRITE_SCOPE, "other-access");
    const resolved = await resolveCreateRuntimeCredential(
      baseEnv(tokenPath),
      fixtureClient,
    );
    expect(resolved.source).toBe("store");
    expect(resolved.credential.account).toBe(ACCOUNT);
    expect(resolved.credential.refreshToken).toBe("stored-refresh");
    expect(resolved.credential.grantedScope).toBe(WRITE_SCOPE);
    expect(resolved.credential.clientId).toBe("fixture-client");

    const failFetch = (async () => {
      throw new Error("no network expected");
    }) as typeof fetch;
    const runtime = await createCreateRuntimeProvider(resolved, {
      fetchImpl: failFetch,
    });
    expect(runtime.credentialScope).toBe(WRITE_SCOPE);

    const fx = await startInsertFixture();
    const provider = (
      await createCreateRuntimeProvider(
        { ...resolved },
        { fetchImpl: failFetch, endpointBase: fx.base },
      )
    ).provider;
    const outcome = await provider.insert(
      { calendarId: "primary", account: ACCOUNT },
      { id: ID, summary: "Kickoff", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(fx.posts).toHaveLength(1);
    expect(fx.posts[0]?.auth).toBe("Bearer stored-access");
    const body = fx.posts[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["end", "id", "start", "summary"]);
    expect(body["id"]).toBe(ID);
  });

  it("refreshes an expired token via the loopback OAuth fixture and persists it (other accounts kept, 0600)", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "tokens.json");
    await seedGrant(tokenPath, ACCOUNT, WRITE_SCOPE, "expired-access", -60_000);
    await seedGrant(tokenPath, OTHER_ACCOUNT, WRITE_SCOPE, "other-access");
    const resolved = await resolveCreateRuntimeCredential(
      baseEnv(tokenPath),
      fixtureClient,
    );
    const tokenFx = await startTokenFixture({
      access_token: "fresh-access",
      expires_in: 3600,
    });
    const fx = await startInsertFixture();
    const runtime = await createCreateRuntimeProvider(resolved, {
      tokenEndpoint: tokenFx.url,
      endpointBase: fx.base,
    });
    expect(tokenFx.calls.count).toBe(1);
    const outcome = await runtime.provider.insert(
      { calendarId: "primary", account: ACCOUNT },
      { id: ID, summary: "Kickoff", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(fx.posts).toHaveLength(1);
    expect(fx.posts[0]?.auth).toBe("Bearer fresh-access");
    const raw = JSON.parse(readFileSync(tokenPath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw[ACCOUNT]?.["access_token"]).toBe("fresh-access");
    expect(raw[ACCOUNT]?.["refresh_token"]).toBe("stored-refresh");
    expect(raw[OTHER_ACCOUNT]?.["access_token"]).toBe("other-access");
    expect((statSync(tokenPath).mode & 0o777) === 0o600).toBe(true);
  });

  it("refuses negatives with 0 POSTs and a byte-identical grant file", async () => {
    async function refusedCase(
      name: string,
      setup: (tokenPath: string) => Promise<void>,
      envExtra: (tokenPath: string) => Record<string, string>,
      deps: typeof fixtureClient = fixtureClient,
    ) {
      const dir = tempDir();
      const tokenPath = join(dir, "tokens.json");
      await setup(tokenPath);
      const before = readFileSync(tokenPath, "utf-8");
      const env = baseEnv(tokenPath, envExtra(tokenPath));
      await expect(
        resolveCreateRuntimeCredential(env, deps),
      ).rejects.toThrow("auth_refused");
      expect(readFileSync(tokenPath, "utf-8")).toBe(before);
      void name;
    }
    const valid = (tokenPath: string) =>
      seedGrant(tokenPath, ACCOUNT, WRITE_SCOPE);
    // Missing account.
    {
      const dir = tempDir();
      const tokenPath = join(dir, "tokens.json");
      await valid(tokenPath);
      const before = readFileSync(tokenPath, "utf-8");
      await expect(
        resolveCreateRuntimeCredential(
          { M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath } as NodeJS.ProcessEnv,
          fixtureClient,
        ),
      ).rejects.toThrow("auth_refused");
      expect(readFileSync(tokenPath, "utf-8")).toBe(before);
    }
    // Readonly-only grant.
    await refusedCase(
      "readonly",
      (p) => seedGrant(p, ACCOUNT, READONLY_SCOPE),
      () => ({}),
    );
    // Broad scope alongside the exact token.
    await refusedCase(
      "broad",
      (p) => seedGrant(p, ACCOUNT, `${WRITE_SCOPE} ${BROAD_SCOPE}`),
      () => ({}),
    );
    // Grant stored under another account.
    await refusedCase(
      "wrong-account",
      (p) => seedGrant(p, OTHER_ACCOUNT, WRITE_SCOPE),
      () => ({}),
    );
    // Partial env credential WITH a valid grant file present.
    await refusedCase("partial-env", valid, () => ({
      M5_RESCHEDULE_CLIENT_ID: "partial-client-id",
    }));
    // Write/readonly token-path collision.
    await refusedCase("collision", valid, (p) => ({
      GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH: p,
    }));
    // Missing OAuth client registration.
    await refusedCase(
      "no-client",
      valid,
      () => ({}),
      {
        loadClientRegistration: async () => {
          throw new Error("no client file");
        },
      },
    );
  });

  it("ignores the obsolete M6_CREATE_* namespace entirely", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "tokens.json");
    await seedGrant(tokenPath, ACCOUNT, WRITE_SCOPE);
    const resolved = await resolveCreateRuntimeCredential(
      baseEnv(tokenPath, {
        M6_CREATE_GRANTED_SCOPE: "https://example.invalid/scope",
        M6_CREATE_ACCESS_TOKEN: "m6-fake-token",
        M6_CREATE_ACCOUNT: "m6-acct",
        M6_CREATE_TOKEN_PATH: join(dir, "m6-tokens.json"),
      }),
      fixtureClient,
    );
    expect(resolved.source).toBe("store");
    expect(resolved.credential.account).toBe(ACCOUNT);
    expect(resolved.tokenPath).toBe(tokenPath);
    const fx = await startInsertFixture();
    const failFetch = (async () => {
      throw new Error("no network expected");
    }) as typeof fetch;
    const runtime = await createCreateRuntimeProvider(resolved, {
      fetchImpl: failFetch,
      endpointBase: fx.base,
    });
    const outcome = await runtime.provider.insert(
      { calendarId: "primary", account: ACCOUNT },
      { id: ID, summary: "T", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(fx.posts[0]?.auth).toBe("Bearer stored-access");
  });

  it("never reads M6_CREATE_TOKEN_PATH: a missing shared grant refuses even with M6 vars set", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "tokens.json");
    writeFileSync(tokenPath, JSON.stringify({}));
    const before = readFileSync(tokenPath, "utf-8");
    await expect(
      resolveCreateRuntimeCredential(
        baseEnv(tokenPath, {
          M6_CREATE_ACCESS_TOKEN: "m6-fake-token",
          M6_CREATE_GRANTED_SCOPE: WRITE_SCOPE,
        }),
        fixtureClient,
      ),
    ).rejects.toThrow("auth_refused");
    expect(readFileSync(tokenPath, "utf-8")).toBe(before);
  });
});
