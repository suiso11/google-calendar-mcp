// M6 TEST-ONLY create runner (never shipped, never production).
//
// Same production provider + MCP server factory against a local loopback
// fixture (Google-shaped events.insert). Production CLI (`src/create/cli.ts`)
// never reads the endpoint override; this runner exists ONLY for tests.

import { createGoogleCreateProvider } from "../create/google.js";
import { createCreateServer } from "../create/server.js";

export function createCreateTestRunner(options: {
  readonly endpointBase: string;
  readonly accessToken?: string;
  readonly account?: string;
  readonly credentialScope?: string;
}) {
  const provider = createGoogleCreateProvider({
    getAccessToken: () => options.accessToken ?? "test-token",
    ...(options.account !== undefined ? { account: options.account } : {}),
    endpointBase: options.endpointBase,
  });
  return createCreateServer({
    provider,
    credentialScope:
      options.credentialScope ?? "https://www.googleapis.com/auth/calendar.events",
  });
}
