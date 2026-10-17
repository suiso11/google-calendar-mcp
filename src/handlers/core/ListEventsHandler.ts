import { CallToolResult, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { buildListFieldMask } from "../../utils/field-mask-builder.js";
import { convertToRFC3339 } from "../../utils/datetime.js";
import { createStructuredResponse } from "../../utils/response-builder.js";
import { ListEventsResponse, StructuredEvent, convertGoogleEventToStructured } from "../../types/structured-responses.js";

interface ListEventsArgs {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  timeZone?: string;
  fields?: string[];
  privateExtendedProperty?: string[];
  sharedExtendedProperty?: string[];
  account?: string;
  pageSize?: number;
  pageToken?: string;
}

export class ListEventsHandler extends BaseToolHandler {
    async runTool(args: ListEventsArgs, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        // Enforce exactly one selected account (single-calendar pagination is cursor-scoped).
        if (accounts.size === 0) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'No authenticated accounts available. Please run authentication first.'
            );
        }
        if (Array.isArray(args.account)) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'list-events requires exactly one account string (arrays are rejected).'
            );
        }
        const accountIds = this.normalizeAccountIds(args.account);
        if (accountIds.length > 1) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                `list-events supports exactly one account per request. Got ${accountIds.length} accounts.`
            );
        }

        let accountId: string;
        let client: OAuth2Client;
        if (accountIds.length === 1) {
            client = this.getClientForAccount(accountIds[0], accounts);
            accountId = accountIds[0].toLowerCase();
        } else {
            if (accounts.size !== 1) {
                const available = Array.from(accounts.keys()).join(', ');
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `list-events requires exactly one account. Multiple accounts available (${available}). Specify the 'account' parameter.`
                );
            }
            const entry = Array.from(accounts.entries())[0];
            accountId = entry[0];
            client = entry[1];
        }

        // Enforce exactly one non-empty calendarId string (arrays/JSON arrays rejected by schema).
        const rawCalendarId = args.calendarId as unknown;
        if (typeof rawCalendarId !== 'string' || rawCalendarId.length === 0) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'list-events requires exactly one non-empty calendarId string.'
            );
        }

        // Exact configured calendarId is opaque: forwarded byte-for-byte with no
        // name resolution and no calendarList/calendars metadata I/O.
        const calendarId = rawCalendarId;
        const calendar = this.getCalendar(client);

        // Timezone precedence: explicit timeZone, else deterministic UTC.
        // No calendar metadata lookup; naive bounds convert via convertToRFC3339
        // (explicit-offset/fractional inputs pass through byte-for-byte).
        const timezone = args.timeZone || 'UTC';
        const timeMin = args.timeMin ? convertToRFC3339(args.timeMin, timezone) : undefined;
        const timeMax = args.timeMax ? convertToRFC3339(args.timeMax, timezone) : undefined;

        const fieldMask = buildListFieldMask(args.fields);

        try {
            // Exactly one events.list call; no auto-pagination, no batch, no merge.
            // Bounded page: omitted pageSize defaults to 20 so the provider
            // never returns its larger default page. Valid 1..20 is honored
            // (schema-enforced); output stays one page.
            const response = await calendar.events.list({
                calendarId,
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: args.pageSize ?? 20,
                ...(fieldMask && { fields: fieldMask }),
                ...(args.privateExtendedProperty && { privateExtendedProperty: args.privateExtendedProperty as any }),
                ...(args.sharedExtendedProperty && { sharedExtendedProperty: args.sharedExtendedProperty as any }),
                ...(args.pageToken !== undefined && { pageToken: args.pageToken })
            });

            const tagged = (response.data.items || []).map(event => ({
                ...event,
                calendarId,
                accountId
            }));

            // Chronological order (API already orders by startTime; sort defensively).
            this.sortEventsByStartTime(tagged);

            const structuredEvents: StructuredEvent[] = tagged.map(event =>
                convertGoogleEventToStructured(event, event.calendarId, event.accountId)
            );

            const listResponse: ListEventsResponse = {
                events: structuredEvents,
                totalCount: structuredEvents.length,
                ...(typeof response.data.nextPageToken === 'string' && { nextPageToken: response.data.nextPageToken })
            };

            return createStructuredResponse(listResponse);
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw this.handleGoogleApiError(error);
        }
    }
}
