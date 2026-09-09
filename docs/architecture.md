# Architecture Overview

## Transport Layer

- **stdio** (default): Direct process communication for Claude Desktop
- **HTTP**: RESTful API with SSE for remote deployment

## Authentication System

OAuth 2.0 with refresh tokens, readonly `calendar.events.readonly` scope only, and secure storage. Accounts are provisioned out of band via the standalone auth command or the local HTTP account page; there is no account-management MCP/model tool.

## Handler Architecture

- `src/handlers/core/` - Individual tool handlers extending `BaseToolHandler`
- `src/tools/registry.ts` - Auto-registration, schemas (Zod), and type definitions

## Request Flow

```
Client → Transport → Schema Validation → Handler → Google API → Response
```

## MCP Tools

This readonly fork exposes exactly four MCP tools for read-only calendar queries. There are no write, free/busy, color, current-time, or account-management tools.

### Available Tools

- `list-calendars` - List known calendars for ID/name resolution (calendarList access remains an adoption gate pending fresh-grant validation; availability is not claimed)
- `list-events` - List events from exactly one account and one calendar; paginated via `pageSize` (1-20) / `pageToken`
- `search-events` - Search events by text query in exactly one account and one calendar over a required time range; paginated via `pageSize` (1-20) / `pageToken`
- `get-event` - Get details of a specific event by ID (single account, single calendar)

`list-events` and `search-events` require exactly one account and one calendar per request. There is no multi-account merge and no multi-calendar fan-out.

## Key Features

- **Auto-registration**: Handlers automatically discovered
- **Read-only**: No create/update/delete or respond operations
- **Single account/calendar per request**: No merged or fan-out queries
- **Cursor pagination**: `pageSize` (1-20) with opaque `pageToken` passthrough
- **Rate limiting**: Respects Google Calendar quotas