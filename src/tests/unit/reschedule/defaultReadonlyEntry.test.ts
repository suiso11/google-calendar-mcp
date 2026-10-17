// Default readonly entrypoint separation proof (scope clarification for
// reviewer discussion 4282819721 — NOT a code fix for that thread).
//
// The user explicitly authorized a SEPARATE opt-in reschedule entrypoint
// (`calendar-reschedule-mcp` / `build/reschedule-cli.js`, identity
// `google-calendar-reschedule`, ONLY tool `reschedule-event`) alongside the
// untouched DEFAULT readonly entrypoint (`google-calendar-mcp` /
// `build/index.js`, identity `google-calendar`, EXACTLY the three tools
// `list-events`, `search-events`, `get-event`). This test pins the default
// side of that separation: the default entry sources import nothing from
// `src/reschedule/`, and the default launch mapping is unchanged.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf-8");
}

describe("default readonly entrypoint stays exactly three tools", () => {
  it("default entry sources import nothing from the separate reschedule namespace", () => {
    for (const file of ["src/index.ts", "src/server.ts", "src/auth-server.ts"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/from ["']\.\/reschedule\//);
      expect(text, file).not.toMatch(/from ["']\.\.\/reschedule\//);
      expect(text, file).not.toContain("reschedule-event");
      expect(text, file).not.toContain("google-calendar-reschedule");
    }
  });

  it("default bin launch mapping is unchanged (readonly default, opt-in separate)", () => {
    const pkg = JSON.parse(source("package.json")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin["google-calendar-mcp"]).toBe("build/index.js");
    expect(pkg.bin["calendar-reschedule-mcp"]).toBe("build/reschedule-cli.js");
  });
});
