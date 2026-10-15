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
import {
  beforeWriteGuard,
  type RescheduleObservation,
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

  // The advertised JSON schema and the runtime validator are THE SAME
  // strict schema object (`RescheduleEventInputSchema`): `strictObject`
  // advertises `additionalProperties: false` on the wire AND rejects unknown
  // keys at runtime. No separate hand-written shape can drift.
  server.registerTool(
    RESCHEDULE_TOOL_NAME,
    {
      title: "Reschedule event (start/end only, conditional etag)",
      description:
        "Patch an event start/end only, guarded by the exact committed-grant etag (If-Match). No recurring split, no other fields.",
      inputSchema: RescheduleEventInputSchema,
    },
    async (args, extra) => {
      const signal = extra?.signal;
      const parsed = RescheduleEventInputSchema.safeParse(args);
      if (!parsed.success) {
        // Classified before-write outcome: explicit definite_failure payload
        // on a NON-error response (transport is intact, so the "no patch"
        // proof is delivered, not lost). `isError` is reserved for responses
        // that may have been lost (unknown, never definite).
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
      // Separate credential namespace + write authorization validation.
      // Reuses NO broad/readonly token implicitly; no auth flow is invoked.
      if (!validateWriteCredential(options.credentialScope)) {
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
      const target = {
        calendarId: input.calendarId,
        eventId: input.eventId,
        ...(input.account !== undefined ? { account: input.account } : {}),
      };
      // THE single read-before-patch (ONE GET per update): reject
      // recurrence/instances, cancelled/deleted, all-day, missing etag, and
      // every classified read error with NO patch dispatched. Read errors
      // are definite (the no-commit proof is intact — nothing was sent), so
      // they ride the NON-error definite_failure payload; `isError` stays
      // reserved for responses that may have been lost (unknown, never
      // definite). A known read failure is never reported as unknown-commit,
      // not_found, or auth unless it actually is one.
      let current: RescheduleObservation;
      try {
        current = await options.provider.read(target, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const code =
          message === "auth_refused"
            ? "auth_refused"
            : message === "not_found"
              ? "not_found"
              : message === "read_transport_lost"
                ? "read_transport_lost"
                : "invalid_input";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "definite_failure",
                code,
              }),
            },
          ],
        };
      }
      const guard = beforeWriteGuard(current);
      if (guard !== null) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "definite_failure",
                code: guard,
              }),
            },
          ],
        };
      }
      // Exact opaque etag tied to the committed grant: the provider performs
      // exactly ONE conditional patch (If-Match) reusing this observation —
      // no second GET. 412 is definite failure.
      let outcome: Awaited<ReturnType<RescheduleProvider["patch"]>>;
      try {
        outcome = await options.provider.patch(
          target,
          { start: input.start, end: input.end },
          { ifMatch: input.expectedEtag, current },
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
export const RESCHEDULE_SHUTDOWN_MS = 3000;

/** Stdio entrypoint (separate process from readonly; bounded shutdown). */
export async function runRescheduleStdio(
  options: RescheduleServerOptions,
): Promise<void> {
  const server = createRescheduleServer(options);
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
        setTimeout(resolve, RESCHEDULE_SHUTDOWN_MS).unref?.();
      }),
    ]);
  };
  process.on("SIGINT", () => void closeBounded());
  process.on("SIGTERM", () => void closeBounded());
  await server.connect(transport);
}
