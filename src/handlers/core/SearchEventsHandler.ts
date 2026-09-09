import { CallToolResult, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { buildListFieldMask } from "../../utils/field-mask-builder.js";
import { createStructuredResponse } from "../../utils/response-builder.js";
import { SearchEventsResponse, StructuredEvent, convertGoogleEventToStructured } from "../../types/structured-responses.js";

interface SearchEventsArgs {
    calendarId: string;
    query?: string;
    timeMin: string;
    timeMax: string;
    timeZone?: string;
    fields?: string[];
    privateExtendedProperty?: string[];
    sharedExtendedProperty?: string[];
    account?: string | string[];
    pageSize?: number;
    pageToken?: string;
}

export class SearchEventsHandler extends BaseToolHandler {
    async runTool(args: SearchEventsArgs, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        // Enforce exactly one selected account (single-calendar pagination is cursor-scoped).
        if (accounts.size === 0) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'No authenticated accounts available. Please run authentication first.'
            );
        }
        const accountIds = this.normalizeAccountIds(args.account);
        if (accountIds.length > 1) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                `search-events supports exactly one account per request. Got ${accountIds.length} accounts.`
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
                    `search-events requires exactly one account. Multiple accounts available (${available}). Specify the 'account' parameter.`
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
                'search-events requires exactly one non-empty calendarId string.'
            );
        }

        // Resolve exactly that one calendar (ID passthrough or single name lookup).
        const calendarId = await this.resolveCalendarId(client, rawCalendarId);
        const calendar = this.getCalendar(client);

        // Normalize time range to RFC3339 format using calendar's timezone as fallback.
        const { timeMin, timeMax } = await this.normalizeTimeRange(
            client, calendarId, args.timeMin, args.timeMax, args.timeZone
        );

        const fieldMask = buildListFieldMask(args.fields);

        try {
            // Exactly one events.list call; no auto-pagination, no batch, no merge.
            const response = await calendar.events.list({
                calendarId,
                ...(args.query !== undefined && { q: args.query }),
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
                ...(fieldMask && { fields: fieldMask }),
                ...(args.privateExtendedProperty && { privateExtendedProperty: args.privateExtendedProperty as any }),
                ...(args.sharedExtendedProperty && { sharedExtendedProperty: args.sharedExtendedProperty as any }),
                ...(args.pageSize !== undefined && { maxResults: args.pageSize }),
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

            const searchResponse: SearchEventsResponse = {
                events: structuredEvents,
                totalCount: structuredEvents.length,
                ...(args.query !== undefined && { query: args.query }),
                calendarId,
                ...(typeof response.data.nextPageToken === 'string' && { nextPageToken: response.data.nextPageToken }),
                timeRange: {
                    start: timeMin || '',
                    end: timeMax || ''
                }
            };

            return createStructuredResponse(searchResponse);
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw this.handleGoogleApiError(error);
        }
    }
}
