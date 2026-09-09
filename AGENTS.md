# Agent Guidelines (readonly fork)

This server exposes exactly four read-only MCP tools: `list-calendars`, `list-events`, `search-events`, `get-event`. There are no write, free/busy, color, current-time, or account-management tools.

## Tool Use

- `list-events` and `search-events` require exactly one account and one calendar (`calendarId`) per request, with `pageSize <= 20` / `pageToken` pagination (one page per request).
- When only one account is connected, `account` may be omitted; when several accounts are connected, pass exactly one `account`. There is no multi-account merge and no multi-calendar fan-out.
- `get-event` takes a single account, calendar, and event ID.
- `list-calendars` is a lookup helper for ID/name resolution (calendarList access remains an adoption gate pending fresh-grant validation; availability is not claimed).
- Never attempt writes: no create/update/delete, no respond, no batch creation, and no availability or color operations.

## Authentication

Accounts are provisioned out of band only (standalone auth command or local HTTP account page). There is no in-chat/MCP authentication or account-management tool.

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
