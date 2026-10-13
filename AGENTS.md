# Agent Guidelines (readonly fork)

This server exposes exactly three read-only MCP tools: `list-events`, `search-events`, `get-event`. There are no write, free/busy, color, current-time, calendar-listing, or account-management tools. `list-calendars` is not registered and must be rejected.

## Tool Use

- `list-events` and `search-events` require exactly one account and one exact calendar ID (`calendarId`) per request, with `pageSize <= 20` / `pageToken` pagination (one page per request).
- `calendarId` is opaque and forwarded verbatim (`primary`, an email, or an opaque calendar ID). Calendar names are not resolved; there is no name lookup.
- When only one account is connected, `account` may be omitted; when several accounts are connected, pass exactly one `account`. Ambiguous or invalid accounts are rejected before any provider call. There is no multi-account merge and no multi-calendar fan-out.
- `get-event` takes a single account, an exact calendar ID, and an event ID.
- Timezone-naive bounds use the explicit `timeZone` when given, else deterministic UTC. No calendar metadata is fetched on the MCP path.
- Never attempt writes: no create/update/delete, no respond, no batch creation, and no availability or color operations.

## Authentication

Accounts are provisioned out of band only (standalone auth command or local HTTP account page). There is no in-chat/MCP authentication, account-management, or calendar-listing tool.

## Example: Listing Events

```json
{
  "name": "list-events",
  "arguments": {
    "calendarId": "primary",
    "timeMin": "2023-10-27T00:00:00Z",
    "timeMax": "2023-10-28T00:00:00Z",
    "pageSize": 20,
    "account": "work"
  }
}
```
