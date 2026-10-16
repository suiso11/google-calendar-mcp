// M6 dedicated create MCP: SEPARATE stdio entrypoint.
//
// Identity: name `google-calendar-create`, version `1.0.0-create.1` —
// deliberately distinct from readonly (`google-calendar` /
// `3.0.0-readonly.2`) and reschedule (`google-calendar-reschedule` /
// `1.0.0-reschedule.1`). Those entrypoints, tools, scopes, and pins are
// untouched by this server.
//
// Surface: registers ONLY `create-event` (stable-id + title/start/end-only
// strict input, exact opaque selection). No list/search/get tools, no
// reschedule tool, no write auth flow at runtime.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CreateProvider,
  isExactCreateScope,
} from "./provider.js";
import {
  CREATE_MCP_NAME,
  CREATE_MCP_VERSION,
  CREATE_TOOL_NAME,
  CreateEventInputSchema,
} from "./schema.js";

export type CreateServerOptions = {
  readonly provider: CreateProvider;
  readonly credentialScope?: string;
};

export function createCreateServer(options: CreateServerOptions) {
  const server = new McpServer(
    { name: CREATE_MCP_NAME, version: CREATE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    CREATE_TOOL_NAME,
    {
      title: "Create event (title/start/end only, stable insert id)",
      description:
        "Insert one timed event with a host-derived stable id. No other fields.",
      inputSchema: CreateEventInputSchema,
    },
    async (args, extra) => {
      const signal = extra?.signal;
      const parsed = CreateEventInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "definite_failure",
                code: "invalid_input",
              }),
            },
          ],
        };
      }
      if (!isExactCreateScope(options.credentialScope)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "definite_failure",
                code: "auth_refused",
              }),
            },
          ],
        };
      }
      const input = parsed.data;
      let outcome: Awaited<ReturnType<CreateProvider["insert"]>>;
      try {
        outcome = await options.provider.insert(
          {
            calendarId: input.calendarId,
            ...(input.account !== undefined ? { account: input.account } : {}),
          },
          {
            id: input.id,
            summary: input.summary,
            start: input.start,
            end: input.end,
          },
          signal,
        );
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "transport_lost" }],
        };
      }
      if (outcome.status === "succeeded") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "succeeded" }),
            },
          ],
        };
      }
      if (outcome.status === "definite_failure") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "definite_failure",
                code: outcome.code,
              }),
            },
          ],
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

/** Bounded stdio shutdown budget (real race, not a comment). */
export const CREATE_SHUTDOWN_MS = 3000;

/** Stdio entrypoint (separate process from readonly/reschedule). */
export async function runCreateStdio(
  options: CreateServerOptions,
): Promise<void> {
  const server = createCreateServer(options);
  const transport = new StdioServerTransport();
  let closed = false;
  const closeBounded = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.race([
      (async () => {
        try {
          await transport.close();
        } catch {
          // Bounded best-effort close; never hangs shutdown.
        }
        try {
          await server.close();
        } catch {
          // Best effort.
        }
      })(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CREATE_SHUTDOWN_MS).unref?.();
      }),
    ]);
  };
  process.on("SIGINT", () => void closeBounded());
  process.on("SIGTERM", () => void closeBounded());
  await server.connect(transport);
}
