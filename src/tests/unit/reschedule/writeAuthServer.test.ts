// M5 separate write-consent tests: REAL loopback server, LOCAL fixtures only.
//
// The REAL `WriteAuthServer` (loopback HTTP, state + PKCE, single-use
// callback, bounded TTL, exact scope, separate 0600 token file) is exercised
// against a LOCAL OAuth fixture: a real `OAuth2Client` (real PKCE + real
// auth-URL building) whose network exchange is stubbed to return canned
// tokens. NEVER real Google auth: no live token endpoint, no browser, no
// production credentials.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it } from "vitest";
import {
  WRITE_AUTH_CALLBACK_PATH,
  WriteAuthServer,
} from "../../../reschedule/writeAuthServer.js";
import { WRITE_SCOPES, validateWriteCredential } from "../../../reschedule/provider.js";
import {
  WRITE_TOKEN_PATH_ENV,
  getDefaultWriteTokenPath,
  getWriteTokenPath,
  saveWriteCredentials,
} from "../../../reschedule/writeTokenStore.js";
import { parseWriteAuthArgs } from "../../../reschedule/writeAuthCli.js";

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const BROAD_SCOPE = `${WRITE_SCOPE} https://www.googleapis.com/auth/calendar`;
const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "../../../..");

function source(relative: string): string {
  return readFileSync(join(forkRoot, relative), "utf-8");
}

interface FixtureTokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/** Real OAuth2Client (real PKCE + URL building) with a stubbed exchange. */
function fixtureClientFactory(tokens: FixtureTokens) {
  return async (redirectUri: string): Promise<OAuth2Client> => {
    const client = new OAuth2Client(
      "fixture-client-id",
      "fixture-client-secret",
      redirectUri,
    );
    (client as unknown as { getToken: unknown }).getToken = async () => ({
      tokens,
      res: null,
    });
    return client;
  };
}

function tempTokenPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "m5-write-auth-test-"));
  return { dir, file: join(dir, "tokens.json") };
}

function cleanup(path: { dir: string }): void {
  rmSync(path.dir, { recursive: true, force: true });
}

/** GET the landing page and return its raw HTML. */
async function getLanding(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  return res.text();
}

/** Extract + decode the Google auth href from the landing page. */
function extractAuthUrl(landingHtml: string): URL {
  const match = /href="([^"]*accounts\.google\.com[^"]*)"/.exec(landingHtml);
  expect(match).not.toBeNull();
  const href = (match as RegExpExecArray)[1].replace(/&amp;/g, "&");
  return new URL(href);
}

async function startFixtureServer(
  tokens: FixtureTokens,
  tokenFile: string,
  ttlMs = 60_000,
): Promise<{ server: WriteAuthServer; port: number }> {
  const server = new WriteAuthServer({
    createOAuthClient: fixtureClientFactory(tokens),
    tokenPath: tokenFile,
    ttlMs,
  });
  const session = await server.start({ account: "write", port: 0 });
  expect(session).not.toBeNull();
  return { server, port: (session as { port: number }).port };
}

describe("separate write consent (local fixtures only)", () => {
  it("issues the exact least-privilege scope with an exact loopback redirect", async () => {
    const tmp = tempTokenPath();
    try {
      const { server, port } = await startFixtureServer(
        { access_token: "a", refresh_token: "r", scope: WRITE_SCOPE },
        tmp.file,
      );
      try {
        const authUrl = extractAuthUrl(await getLanding(port));
        expect(authUrl.hostname).toBe("accounts.google.com");
        const scopes = (authUrl.searchParams.get("scope") ?? "").split(" ");
        expect(scopes).toEqual([WRITE_SCOPE]);
        expect(validateWriteCredential(scopes.join(" "))).toBe(true);
        expect(authUrl.searchParams.get("redirect_uri")).toBe(
          `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}`,
        );
        expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
        expect(authUrl.searchParams.get("state")).toBeTruthy();
        const raw = await getLanding(port);
        expect(raw).not.toContain("readonly");
      } finally {
        await server.stop();
      }
    } finally {
      cleanup(tmp);
    }
  });

  it("rejects a missing code with 400 and keeps the flow usable", async () => {
    const tmp = tempTokenPath();
    try {
      const { server, port } = await startFixtureServer(
        { access_token: "a", refresh_token: "r", scope: WRITE_SCOPE },
        tmp.file,
      );
      try {
        const authUrl = extractAuthUrl(await getLanding(port));
        const state = authUrl.searchParams.get("state") as string;
        const bad = await fetch(
          `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?state=${state}`,
        );
        expect(bad.status).toBe(400);
        const good = await fetch(
          `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=fixture-code&state=${state}`,
        );
        expect(good.status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      cleanup(tmp);
    }
  });

  it("rejects wrong or missing state with 403", async () => {
    const tmp = tempTokenPath();
    try {
      const { server, port } = await startFixtureServer(
        { access_token: "a", refresh_token: "r", scope: WRITE_SCOPE },
        tmp.file,
      );
      try {
        const wrong = await fetch(
          `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=x&state=wrong`,
        );
        expect(wrong.status).toBe(403);
        const missing = await fetch(
          `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=x`,
        );
        expect(missing.status).toBe(403);
      } finally {
        await server.stop();
      }
    } finally {
      cleanup(tmp);
    }
  });

  it("is single-use: replaying a consumed callback is rejected", async () => {
    const tmp = tempTokenPath();
    try {
      const { server, port } = await startFixtureServer(
        { access_token: "a", refresh_token: "r", scope: WRITE_SCOPE },
        tmp.file,
      );
      try {
        const authUrl = extractAuthUrl(await getLanding(port));
        const state = authUrl.searchParams.get("state") as string;
        const callback = `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=one-time&state=${state}`;
        expect((await fetch(callback)).status).toBe(200);
        expect((await fetch(callback)).status).toBe(403);
      } finally {
        await server.stop();
      }
    } finally {
      cleanup(tmp);
    }
  });

  it("refuses broad, readonly, or absent granted scopes without persisting", async () => {
    for (const scope of [BROAD_SCOPE, READONLY_SCOPE, undefined]) {
      const tmp = tempTokenPath();
      try {
        const tokens: FixtureTokens = { access_token: "a", refresh_token: "r" };
        if (scope !== undefined) {
          tokens.scope = scope;
        }
        const { server, port } = await startFixtureServer(tokens, tmp.file);
        try {
          const authUrl = extractAuthUrl(await getLanding(port));
          const state = authUrl.searchParams.get("state") as string;
          const res = await fetch(
            `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=x&state=${state}`,
          );
          expect(res.status).toBe(500);
          expect(() => statSync(tmp.file)).toThrow();
        } finally {
          await server.stop();
        }
      } finally {
        cleanup(tmp);
      }
    }
  });

  it("persists the grant to the separate path with owner-only mode", async () => {
    const tmp = tempTokenPath();
    try {
      const { server, port } = await startFixtureServer(
        {
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          scope: WRITE_SCOPE,
          token_type: "Bearer",
        },
        tmp.file,
      );
      try {
        const authUrl = extractAuthUrl(await getLanding(port));
        const state = authUrl.searchParams.get("state") as string;
        expect(
          (
            await fetch(
              `http://127.0.0.1:${port}${WRITE_AUTH_CALLBACK_PATH}?code=x&state=${state}`,
            )
          ).status,
        ).toBe(200);
        expect(statSync(tmp.file).mode & 0o777).toBe(0o600);
        const stored = JSON.parse(readFileSync(tmp.file, "utf-8")) as Record<
          string,
          { scope?: unknown; refresh_token?: unknown }
        >;
        expect(Object.keys(stored)).toEqual(["write"]);
        expect(stored["write"]?.scope).toBe(WRITE_SCOPE);
        expect(typeof stored["write"]?.refresh_token).toBe("string");
      } finally {
        await server.stop();
      }
    } finally {
      cleanup(tmp);
    }
  });

  it("closes itself when the bounded window expires", async () => {
    const tmp = tempTokenPath();
    try {
      const server = new WriteAuthServer({
        createOAuthClient: fixtureClientFactory({
          access_token: "a",
          refresh_token: "r",
          scope: WRITE_SCOPE,
        }),
        tokenPath: tmp.file,
        ttlMs: 200,
      });
      const session = await server.start({ account: "write", port: 0 });
      expect(session).not.toBeNull();
      const port = (session as { port: number }).port;
      const done = server.waitForDone();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      await expect(done).resolves.toBe(false);
    } finally {
      cleanup(tmp);
    }
  });

  it("resolves an isolated default token path with env override", () => {
    expect(getDefaultWriteTokenPath()).toContain("google-calendar-mcp-write");
    expect(getDefaultWriteTokenPath()).not.toContain("readonly");
    expect(
      getWriteTokenPath({ [WRITE_TOKEN_PATH_ENV]: "/tmp/custom-write.json" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/custom-write.json");
  });

  it("store refuses invalid grants directly (no file, fixed errors)", async () => {
    const tmp = tempTokenPath();
    try {
      await expect(
        saveWriteCredentials(
          "write",
          { scope: READONLY_SCOPE, refresh_token: "r" },
          tmp.file,
        ),
      ).rejects.toThrow("write consent refused");
      await expect(
        saveWriteCredentials(
          "write",
          { scope: WRITE_SCOPE, refresh_token: "" },
          tmp.file,
        ),
      ).rejects.toThrow("write consent refused");
      await expect(
        saveWriteCredentials(
          "write",
          { scope: WRITE_SCOPE, refresh_token: "r" },
          tmp.file,
        ),
      ).resolves.toBeUndefined();
      // A corrupt existing file refuses rather than clobbering.
      chmodSync(tmp.file, 0o600);
      readFileSync(tmp.file, "utf-8");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tmp.file, "not-json{");
      await expect(
        saveWriteCredentials(
          "write",
          { scope: WRITE_SCOPE, refresh_token: "r2" },
          tmp.file,
        ),
      ).rejects.toThrow("write consent refused");
    } finally {
      cleanup(tmp);
    }
  });

  it("CLI arg parsing clamps TTL and rejects unknown args", () => {
    expect(parseWriteAuthArgs([]).ttlMs).toBe(12 * 60 * 1000);
    expect(parseWriteAuthArgs(["--ttl-minutes", "99"]).ttlMs).toBe(30 * 60 * 1000);
    expect(parseWriteAuthArgs(["--ttl-minutes", "0"]).ttlMs).toBe(60 * 1000);
    expect(parseWriteAuthArgs(["--port", "3500"]).port).toBe(3500);
    expect(parseWriteAuthArgs(["--no-browser"]).openBrowser).toBe(false);
    expect(() => parseWriteAuthArgs(["--bogus"])).toThrow("unknown argument");
    expect(() => parseWriteAuthArgs(["--port", "abc"])).toThrow("invalid port");
  });

  it("separate namespace: consent sources never touch readonly credential paths or scopes", () => {
    for (const file of [
      "src/reschedule/writeAuthServer.ts",
      "src/reschedule/writeTokenStore.ts",
    ]) {
      const text = source(file);
      expect(text, file).not.toContain("calendar.events.readonly");
      expect(text, file).not.toContain("calendar.readonly");
      expect(text, file).not.toContain("calendar.settings.readonly");
      expect(text, file).not.toContain("google-calendar-mcp-readonly");
      expect(text, file).not.toContain("GOOGLE_CALENDAR_MCP_READONLY");
      expect(text, file).not.toContain("READONLY_CALENDAR_SCOPES");
      expect(text, file).not.toContain("TokenManager");
      expect(text, file).not.toContain("auth/tokenManager");
      expect(text, file).not.toContain("auth/utils");
      expect(text, file).not.toContain("loadSavedTokens");
      expect(text, file).not.toContain("setCredentials");
    }
    const cli = source("src/reschedule/writeAuthCli.ts");
    expect(cli).toContain("refuse when the write path equals the readonly path");
    expect(cli).not.toContain("loadSavedTokens");
    expect(cli).not.toContain("setCredentials");
  });

  it("shipped readonly entrypoints stay untouched by the consent addition", () => {
    for (const file of ["src/index.ts", "src/server.ts", "src/auth-server.ts"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/from ["']\.\/reschedule\//);
      expect(text, file).not.toContain("write-auth");
      expect(text, file).not.toContain(WRITE_SCOPE);
    }
    expect(WRITE_SCOPES).toEqual([WRITE_SCOPE]);
  });
});
