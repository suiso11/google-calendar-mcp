// M5 SEPARATE write-consent CLI (out-of-band user consent only, no writes).
//
// `npm run auth:write` starts the REAL loopback consent server from
// `./writeAuthServer.js` and blocks until the user approves at Google or
// the bounded window expires. It performs NO calendar read/write, enables
// NO production write flags, and selects NO test event: after a grant is
// stored, a named TEST event plus explicit approval is still required.
//
// Isolation guard: refuse when the resolved write token path equals the
// readonly token path, so the separate consent can never overwrite the
// existing readonly grants.

import { resolve } from "node:path";
import { getSecureTokenPath } from "../auth/utils.js";
import { validateAccountId } from "../auth/paths.js";
import {
  WRITE_AUTH_DEFAULT_TTL_MS,
  WriteAuthServer,
} from "./writeAuthServer.js";
import { getWriteTokenPath } from "./writeTokenStore.js";

export interface WriteAuthCliOptions {
  readonly account: string;
  readonly port?: number;
  readonly ttlMs: number;
  readonly openBrowser: boolean;
}

const TTL_MIN_MINUTES = 1;
const TTL_MAX_MINUTES = 30;

export function parseWriteAuthArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WriteAuthCliOptions {
  let account = env.M5_RESCHEDULE_ACCOUNT ?? "write";
  let port: number | undefined;
  let ttlMs = WRITE_AUTH_DEFAULT_TTL_MS;
  let openBrowser = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--account" && index + 1 < argv.length) {
      index += 1;
      const value = argv[index];
      if (value !== undefined) {
        account = value;
      }
    } else if (arg === "--port" && index + 1 < argv.length) {
      index += 1;
      const parsed = Number(argv[index]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error("write-auth: invalid port");
      }
      port = parsed;
    } else if (arg === "--ttl-minutes" && index + 1 < argv.length) {
      index += 1;
      const parsed = Number(argv[index]);
      if (!Number.isFinite(parsed)) {
        throw new Error("write-auth: invalid ttl");
      }
      const clamped = Math.min(
        TTL_MAX_MINUTES,
        Math.max(TTL_MIN_MINUTES, Math.floor(parsed)),
      );
      ttlMs = clamped * 60 * 1000;
    } else if (arg === "--no-browser") {
      openBrowser = false;
    } else if (arg === "--open-browser") {
      openBrowser = true;
    } else {
      throw new Error("write-auth: unknown argument");
    }
  }
  return { account, port, ttlMs, openBrowser };
}

export async function runWriteAuthCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let options: WriteAuthCliOptions;
  try {
    options = parseWriteAuthArgs(argv, env);
    validateAccountId(options.account);
  } catch {
    process.stderr.write("write-auth: invalid account or arguments\n");
    process.exit(2);
    return;
  }
  // Isolation guard: refuse when the write path equals the readonly path.
  const writePath = getWriteTokenPath(env);
  let readonlyPath = "";
  try {
    readonlyPath = getSecureTokenPath();
  } catch {
    readonlyPath = "";
  }
  if (readonlyPath !== "" && resolve(writePath) === resolve(readonlyPath)) {
    process.stderr.write(
      "write-auth: write token path must differ from the readonly token path\n",
    );
    process.exit(2);
    return;
  }
  const server = new WriteAuthServer({ ttlMs: options.ttlMs, tokenPath: writePath });
  process.on("SIGINT", () => {
    void server.cancel();
  });
  const session = await server.start({
    account: options.account,
    port: options.port,
    openBrowser: options.openBrowser,
  });
  if (session === null) {
    process.stderr.write("write-auth: could not start the consent server\n");
    process.exit(1);
    return;
  }
  const ok = await server.waitForDone();
  if (ok) {
    process.stderr.write(
      "write-auth: consent recorded; a named TEST event plus approval is still required before any write\n",
    );
    process.exit(0);
  } else {
    process.stderr.write("write-auth: consent window closed without approval\n");
    process.exit(1);
  }
}
