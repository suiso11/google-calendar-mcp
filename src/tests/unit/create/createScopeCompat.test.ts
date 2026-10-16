// M6 create scope compatibility regression (fork PR5 review:
// "Accept every grant allowed by the shared scope validator").
//
// The create entrypoint reuses the SHARED `validateWriteCredential`
// predicate directly (not a raw literal equality), so every grant the
// shared reschedule runtime accepts is accepted here too:
// - narrow `calendar.events` token alone, with surrounding/multiple
//   ASCII whitespace, or alongside read-only extras is accepted — proven
//   end to end from a SHARED persisted grant file through runtime
//   resolution into exactly ONE loopback Google-shaped POST;
// - the same multitoken scope is accepted at the MCP `create-event`
//   server gate with exactly one provider insert;
// - readonly-only, broad-`calendar`-anywhere, and unrelated-suffix
//   scopes stay refused with ZERO inserts/POSTs.
// Hermetic: temp grant files + loopback fixtures only, no Google.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { isExactCreateScope } from "../../../create/provider.js";
import { createCreateServer } from "../../../create/server.js";
import {
  createCreateRuntimeProvider,
  resolveCreateRuntimeCredential,
} from "../../../create/cli.js";
import type { CreateProvider } from "../../../create/provider.js";

const WRITE = "https://www.googleapis.com/auth/calendar.events";
const READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";
const BROAD = "https://www.googleapis.com/auth/calendar";
const ACCOUNT = "scope-compat-acct";
const ID = "c".repeat(32);
const START = "2026-05-01T10:00:00Z";
const END = "2026-05-01T11:00:00Z";

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
  const dir = mkdtempSync(join(tmpdir(), "m6-create-scope-"));
  tempDirs.push(dir);
  return dir;
}

const fixtureClient = {
  loadClientRegistration: async () => ({
    client_id: "fixture-client",
    client_secret: "fixture-secret",
  }),
};

function seedRawGrant(tokenPath: string, scope: string): void {
  writeFileSync(
    tokenPath,
    JSON.stringify({
      [ACCOUNT]: {
        access_token: "stored-access",
        refresh_token: "stored-refresh",
        scope,
        expiry_date: Date.now() + 3_600_000,
        token_type: "Bearer",
      },
    }),
  );
}

function envFor(tokenPath: string): NodeJS.ProcessEnv {
  return {
    M5_RESCHEDULE_ACCOUNT: ACCOUNT,
    M5_RESCHEDULE_WRITE_TOKEN_PATH: tokenPath,
  } as NodeJS.ProcessEnv;
}

/** Loopback Google-shaped events.insert fixture. Records POST count. */
async function startInsertFixture(): Promise<{
  base: string;
  posts: number;
}> {
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      posts += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ID }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, get posts() { return posts; } };
}

const CREATE_ARGS = {
  calendarId: "primary",
  account: ACCOUNT,
  id: ID,
  summary: "Scope compat",
  start: START,
  end: END,
};

async function callCreateViaMcp(
  provider: CreateProvider,
  credentialScope: string,
): Promise<{ text: string; isError?: boolean }> {
  const server = createCreateServer({ provider, credentialScope });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const result = await client.callTool({
      name: "create-event",
      arguments: CREATE_ARGS,
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

describe("create scope compatibility (shared validator)", () => {
  it("accepts the narrow token with whitespace and read-only extras", () => {
    expect(isExactCreateScope(WRITE)).toBe(true);
    expect(isExactCreateScope(`  ${WRITE}  `)).toBe(true);
    expect(isExactCreateScope(`${WRITE}\t${READONLY}`)).toBe(true);
    expect(isExactCreateScope(`${READONLY} ${WRITE}`)).toBe(true);
    expect(
      isExactCreateScope(
        "https://www.googleapis.com/auth/calendar.settings.readonly",
      ),
    ).toBe(false);
  });

  it("refuses readonly-only, broad-anywhere, suffix, empty, and non-string scopes", () => {
    expect(isExactCreateScope(READONLY)).toBe(false);
    expect(isExactCreateScope(`${WRITE} ${BROAD}`)).toBe(false);
    expect(isExactCreateScope(`${BROAD} ${WRITE}`)).toBe(false);
    expect(isExactCreateScope(BROAD)).toBe(false);
    expect(isExactCreateScope(`${WRITE}.suffix`)).toBe(false);
    expect(isExactCreateScope("")).toBe(false);
    expect(isExactCreateScope(undefined)).toBe(false);
    expect(isExactCreateScope(null)).toBe(false);
    expect(isExactCreateScope(42)).toBe(false);
  });

  it("resolves a multitoken shared grant and posts exactly once (loopback)", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "tokens.json");
    seedRawGrant(tokenPath, `  ${WRITE}   ${READONLY} `);
    const resolved = await resolveCreateRuntimeCredential(
      envFor(tokenPath),
      fixtureClient,
    );
    expect(resolved.credential.grantedScope).toBe(`  ${WRITE}   ${READONLY} `);
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
      { id: ID, summary: "Compat", start: START, end: END },
    );
    expect(outcome).toEqual({ status: "succeeded" });
    expect(fx.posts).toBe(1);
  });

  it("accepts a multitoken scope at the MCP gate with one insert; refuses the rest with zero", async () => {
    const stub = (inserts: { count: number }): CreateProvider => ({
      insert: async () => {
        inserts.count += 1;
        return { status: "succeeded" };
      },
    });
    // Accepted: multitoken write + readonly extra.
    {
      const inserts = { count: 0 };
      const out = await callCreateViaMcp(stub(inserts), `${WRITE} ${READONLY}`);
      expect(JSON.parse(out.text)).toEqual({ status: "succeeded" });
      expect(out.isError).toBeUndefined();
      expect(inserts.count).toBe(1);
    }
    // Refused with ZERO inserts: readonly-only, broad+write, suffix.
    for (const scope of [
      READONLY,
      `${WRITE} ${BROAD}`,
      `${WRITE}.suffix`,
    ]) {
      const inserts = { count: 0 };
      const out = await callCreateViaMcp(stub(inserts), scope);
      expect(JSON.parse(out.text)).toEqual({
        status: "definite_failure",
        code: "auth_refused",
      });
      expect(inserts.count).toBe(0);
    }
  });
});
