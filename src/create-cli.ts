// M6 dedicated create MCP executable wrapper (production bin entrypoint).
//
// Thin boring wrapper: calls the exported `main()` from `./create/cli.js`
// UNCONDITIONALLY (no `process.argv[1]` guard). npm installs the
// `calendar-create-mcp` bin as a symlink to the bundled
// `build/create-cli.js`, and Node preserves the invoked symlink path in
// `process.argv[1]` — a guard matching `create-cli` would stay false and
// the advertised executable would exit silently without starting a server.
// Importing `./create/cli.js` anywhere else (tests, harnesses) stays
// side-effect free because that module never auto-executes.
import { main } from "./create/cli.js";

await main();
