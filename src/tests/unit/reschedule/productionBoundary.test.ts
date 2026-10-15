// Fork production-boundary tests: immutable endpoint, exact scope, 3xx proof.
//
// - Shipped CLI (`src/reschedule/cli.ts`) contains NO test endpoint/auth
//   bypass env (`M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE`,
//   `M5_RESCHEDULE_TEST_ENDPOINT_BASE`, `M5_RESCHEDULE_FORK_CLI`); production
//   always uses the FIXED Google URL.
// - Test-only runner (`tests/helpers/rescheduleTestRunner.ts`) exercises the
//   SAME production provider + MCP server factory (import identity check).
// - Least-privilege scope: ONLY `calendar.events` validates; broad
//   `calendar` and all readonly scopes are refused.
// - Refresh-response scope (when the server reports one) must carry the
//   exact write scope or the refresh is refused.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAccessTokenSupplier } from "../../../reschedule/auth.js";
import {
  GOOGLE_API_BASE,
  validateWriteCredential,
} from "../../../reschedule/provider.js";
import * as testRunner from "../../helpers/rescheduleTestRunner.js";
import * as google from "../../../reschedule/google.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(
  join(here, "../../../reschedule/cli.ts"),
  "utf-8",
);

describe("production boundary (shipped CLI immutable, exact scope)", () => {
  it("shipped CLI has no test endpoint/auth bypass env", () => {
    // Doc mentions are allowed; what is forbidden is READING the flags.
    for (const flag of [
      "process.env.M5_RESCHEDULE_TEST_ALLOW_ENDPOINT_OVERRIDE",
      "process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE",
      "process.env.M5_RESCHEDULE_FORK_CLI",
    ]) {
      expect(cliSource, flag).not.toContain(flag);
    }
    expect(cliSource).toContain("FIXED Google URL");
  });

  it("test runner exercises the SAME production provider + server factory", () => {
    expect(testRunner.createGoogleRescheduleProvider).toBe(
      google.createGoogleRescheduleProvider,
    );
    expect(typeof testRunner.createTestRescheduleServer).toBe("function");
  });

  it("production default endpoint is the immutable Google host", () => {
    expect(GOOGLE_API_BASE).toBe("https://www.googleapis.com");
  });

  it("exact least-privilege scope: only calendar.events validates", () => {
    expect(
      validateWriteCredential("https://www.googleapis.com/auth/calendar.events"),
    ).toBe(true);
    expect(
      validateWriteCredential(
        "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events",
      ),
    ).toBe(true);
    // Broad calendar scope is NOT accepted implicitly.
    expect(
      validateWriteCredential("https://www.googleapis.com/auth/calendar"),
    ).toBe(false);
    for (const readonlyScope of [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.settings.readonly",
      "",
    ]) {
      expect(validateWriteCredential(readonlyScope)).toBe(false);
    }
    // Substring spoof cannot pass.
    expect(
      validateWriteCredential(
        "https://www.googleapis.com/auth/calendar.events.foo",
      ),
    ).toBe(false);
  });

  it("refresh response scope is verified when the server reports one", async () => {
    async function refreshWithScope(reported: unknown): Promise<string> {
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            access_token: "new-token",
            expires_in: 3600,
            ...(reported !== undefined ? { scope: reported } : {}),
          }),
          { status: 200 },
        )) as typeof fetch;
      const supplier = createAccessTokenSupplier({
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh",
        grantedScope: "https://www.googleapis.com/auth/calendar.events",
        account: "test-account",
        fetchImpl,
      });
      await supplier.refreshIfExpired();
      return supplier.getAccessToken();
    }
    // No reported scope: accepted (nothing to verify).
    await expect(refreshWithScope(undefined)).resolves.toBe("new-token");
    // Exact write scope reported: accepted.
    await expect(
      refreshWithScope("https://www.googleapis.com/auth/calendar.events"),
    ).resolves.toBe("new-token");
    // Readonly/broad scope reported: refused (config alone is not a grant).
    await expect(
      refreshWithScope(
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ),
    ).rejects.toThrow("auth_refused");
    await expect(
      refreshWithScope("https://www.googleapis.com/auth/calendar"),
    ).rejects.toThrow("auth_refused");
  });
});
