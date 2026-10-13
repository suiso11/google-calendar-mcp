import { CallToolResult, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { calendar_v3 } from 'googleapis';
import { buildSingleEventFieldMask } from "../../utils/field-mask-builder.js";
import { createStructuredResponse } from "../../utils/response-builder.js";
import { GetEventResponse, convertGoogleEventToStructured } from "../../types/structured-responses.js";

interface GetEventArgs {
    calendarId: string;
    eventId: string;
    fields?: string[];
    account?: string;
}

export class GetEventHandler extends BaseToolHandler {
    async runTool(args: GetEventArgs, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        // No accounts available
        if (accounts.size === 0) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'No authenticated accounts available. Please run authentication first.'
            );
        }

        // Exactly one account: explicit normalized ID, or the sole configured key.
        // Rejects (invalid account / multi-account ambiguity) before any provider I/O.
        let accountId: string;
        let oauth2Client: OAuth2Client;
        if (args.account) {
            oauth2Client = this.getClientForAccount(args.account, accounts);
            accountId = args.account.toLowerCase();
        } else {
            if (accounts.size !== 1) {
                const available = Array.from(accounts.keys()).join(', ');
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `get-event requires exactly one account. Multiple accounts available (${available}). Specify the 'account' parameter.`
                );
            }
            const entry = Array.from(accounts.entries())[0];
            accountId = entry[0];
            oauth2Client = entry[1];
        }

        // Exact configured calendarId is opaque: forwarded byte-for-byte with no
        // name resolution and no calendarList/calendars metadata I/O.
        const rawCalendarId = args.calendarId as unknown;
        if (typeof rawCalendarId !== 'string' || rawCalendarId.length === 0) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                'get-event requires exactly one non-empty calendarId string.'
            );
        }
        const resolvedCalendarId = rawCalendarId;

        try {
            // Get the event with the exact calendar ID
            const argsWithResolvedCalendar = { ...args, calendarId: resolvedCalendarId };
            const event = await this.getEvent(oauth2Client, argsWithResolvedCalendar);

            if (!event) {
                throw new Error(`Event with ID '${args.eventId}' not found in calendar '${resolvedCalendarId}'.`);
            }

            const response: GetEventResponse = {
                event: convertGoogleEventToStructured(event, resolvedCalendarId, accountId)
            };

            return createStructuredResponse(response);
        } catch (error) {
            throw this.handleGoogleApiError(error);
        }
    }

    private async getEvent(
        client: OAuth2Client,
        args: GetEventArgs
    ): Promise<calendar_v3.Schema$Event | null> {
        const calendar = this.getCalendar(client);
        
        const fieldMask = buildSingleEventFieldMask(args.fields);
        
        try {
            const response = await calendar.events.get({
                calendarId: args.calendarId,
                eventId: args.eventId,
                ...(fieldMask && { fields: fieldMask })
            });
            
            return response.data;
        } catch (error: any) {
            // Handle 404 as a not found case
            if (error?.code === 404 || error?.response?.status === 404) {
                return null;
            }
            throw error;
        }
    }
}
