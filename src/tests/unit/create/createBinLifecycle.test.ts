// M6 create bin lifecycle regression (fork PR5 review:
// "Start the server when invoked through the package bin").
//
// The npm `calendar-create-mcp` bin is a symlink to the bundled
// `build/create-cli.js`, and Node preserves the invoked symlink path in
// `process.argv[1]` — so an `argv[1].includes('create-cli')` guard stays
// false and the executable silently exits 0 without starting anything.
// The fix is a boring wrapper (`src/create-cli.ts` calls the exported
// `main()` unconditionally); importing `src/create/cli.ts` itself must
// NEVER start a server or exit (import-safe, no autoexec).
//
// Permanent test: when the built bundle exists, spawn the REAL production
// bin once directly and once through a `calendar-create-mcp`-named
// symlink (exact bin name), with an empty credential environment. Both
// must reach `main()` — proving it by the credential fail-closed exit
// (non-zero + the `auth_refused` marker on stderr), never a silent exit 0.
// No grants, no Google, no network: resolution refuses before any I/O.
// When the bundle was not built (`build` is not a pretest step), the file
// is skipped — the manual symlink smoke below stays mandatory.

import { execFile } from "node:child_process";
import { existsSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const builtBin = join(here, "..", "..", "..", "..", "build", "create-cli.js");
const binExists = existsSync(builtBin);

function runBin(target: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [target],
      {
        env: {
          PATH: process.env.PATH,
          HOME: tmpdir(),
        },
        timeout: 30_000,
      },
      (error, _stdout, stderr) => {
        if (error !== null && (error as { code?: unknown }).code === "ETIMEDOUT") {
          reject(error);
          return;
        }
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code?: number }).code as number)
              : 1;
        resolve({ code, stderr: String(stderr) });
      },
    );
    void child;
  });
}

describe.runIf(binExists)("create bin lifecycle (built bundle)", () => {
  it("direct bundle invocation reaches main (fail-closed, never silent)", async () => {
    const { code, stderr } = await runBin(builtBin);
    expect(code).not.toBe(0);
    expect(stderr).toContain("auth_refused");
  });

  it("symlink-named calendar-create-mcp invocation reaches main (fail-closed, never silent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-create-bin-"));
    try {
      const link = join(dir, "calendar-create-mcp");
      symlinkSync(builtBin, link);
      const { code, stderr } = await runBin(link);
      expect(code).not.toBe(0);
      expect(stderr).toContain("auth_refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("create cli module import safety", () => {
  it("importing the create module starts no server and exits nothing", async () => {
    const mod = await import("../../../create/cli.js");
    expect(typeof mod.main).toBe("function");
    expect(typeof mod.resolveCreateRuntimeCredential).toBe("function");
  });
});
