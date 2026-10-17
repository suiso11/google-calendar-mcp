// M5 TEST-ONLY stdio entrypoint (unshipped child-process target).
// Reads `M5_RESCHEDULE_TEST_ENDPOINT_BASE` ONLY here (never in the shipped
// production CLI) and drives the SAME production provider + MCP server
// factory via `runTestRescheduleStdio`. Not referenced by `bin`, `files`,
// or `scripts/build.js`; never bundled into `build/reschedule-cli.js`.
import { runTestRescheduleStdio } from "./rescheduleTestRunner.js";

const base = process.env.M5_RESCHEDULE_TEST_ENDPOINT_BASE ?? "";
if (base.length === 0) {
  console.error("test stdio runner: M5_RESCHEDULE_TEST_ENDPOINT_BASE not set");
  process.exit(2);
}

await runTestRescheduleStdio(base);
