// M6 TEST-ONLY create stdio entrypoint (unshipped child-process target).
// Takes the loopback fixture base ONLY from `--endpoint-base <url>` argv
// (never env, never production) and drives the SAME production provider +
// MCP server factory via `runTestCreateStdio` (which resolves the REAL
// persisted grant from the child process env through the SAME production
// resolution). Not referenced by `bin`, `files`, or `scripts/build.js`;
// never bundled into `build/create-cli.js`.
import { runTestCreateStdio } from "./createTestRunner.js";

function endpointBase(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--endpoint-base" && index + 1 < argv.length) {
      const value = argv[index + 1];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "";
}

const base = endpointBase(process.argv.slice(2));
if (base.length === 0) {
  console.error("test create stdio runner: --endpoint-base <url> is required");
  process.exit(2);
}

await runTestCreateStdio(base);
