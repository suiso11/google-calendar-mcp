// M5 dedicated reschedule MCP: SEPARATE stdio entrypoint.
//
// Identity: name `google-calendar-reschedule`, version
// `1.0.0-reschedule.1` — deliberately distinct from the readonly
// entrypoint (`google-calendar` / `3.0.0-readonly.2`). The readonly
// entrypoint, tools, scopes, and pin are untouched by this server.
//
// Surface: registers ONLY `reschedule-event` (start/end-only strict input,
// exact opaque selection, committed-grant etag). No list/search/get tools,
// no readonly surface, no write auth flow at runtime (no OAuth consent, no
// scope activation, no token reuse from the readonly namespace).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  beforeWriteGuard,
  type RescheduleProvider,
  validateWriteCredential,
} from "./provider.js";
import {
  RESCHEDULE_MCP_NAME,
  RESCHEDULE_MCP_VERSION,
  RESCHEDULE_TOOL_NAME,
  RescheduleEventInputSchema,
} from "./schema.js";

export type RescheduleServerOptions = {
  readonly provider: RescheduleProvider;
  /**
   * Write credential scope for the SEPARATE namespace (e.g. from
   * `M5_RESCHEDULE_CALENDAR_SCOPE`). Readonly scopes are refused; no OAuth
   * flow is ever started here.
   */
  readonly credentialScope?: string;
};

export function createRescheduleServer(options: RescheduleServerOptions) {
  const server = new McpServer(
    { name: RESCHEDULE_MCP_NAME, version: RESCHEDULE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    RESCHEDULE_TOOL_NAME,
    {
      title: "Reschedule event (start/end only, conditional etag)",
      description:
        "Patch an event start/end only, guarded by the exact committed-grant etag (If-Match). No recurring split, no other fields.",
      inputSchema: {
        calendarId: z.string().min(1).max(512),
        eventId: z.string().min(1).max(1024),
        account: z.string().min(1).max(512).optional(),
        start: z.string().min(1).max(128),
        end: z.string().min(1).max(128),
        expectedEtag: z.string().min(1).max(256),
      },
    },
    async (args) => {
      const parsed = RescheduleEventInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "invalid_input" }],
        };
      }
      // Separate credential namespace + write authorization validation.
      // Reuses NO broad/readonly token implicitly; no auth flow is invoked.
      if (!validateWriteCredential(options.credentialScope)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "auth_refused" }],
        };
      }
      const input = parsed.data;
      const target = {
        calendarId: input.calendarId,
        eventId: input.eventId,
        ...(input.account !== undefined ? { account: input.account } : {}),
      };
      // Read-before-patch: reject recurrence/instances, cancelled/deleted,
      // all-day, missing etag with NO patch dispatched.
      let current;
      try {
        current = await options.provider.read(target);
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "transport_lost" }],
        };
      }
      const guard = beforeWriteGuard(current);
      if (guard !== null) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: guard }],
        };
      }
      // Exact opaque etag tied to the committed grant: the provider performs
      // exactly ONE conditional patch (If-Match); 412 is definite failure.
      let outcome;
      try {
        outcome = await options.provider.patch(
          target,
          { start: input.start, end: input.end },
          { ifMatch: input.expectedEtag },
        );
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "transport_lost" }],
        };
      }
      if (outcome.status === "succeeded") {
        return {
          content: [{ type: "text" as const, text: "succeeded" }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: outcome.code }],
      };
    },
  );

  return server;
}

/** Stdio entrypoint (separate process from readonly; bounded shutdown). */
export async function runRescheduleStdio(
  options: RescheduleServerOptions,
): Promise<void> {
  const server = createRescheduleServer(options);
  const transport = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    try {
      await transport.close();
    } catch {
      // Bounded best-effort close; never hangs shutdown.
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(transport);
}
