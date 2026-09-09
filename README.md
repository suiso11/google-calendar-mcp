# Google Calendar MCP Server (readonly fork)

A Model Context Protocol (MCP) server that provides read-only Google Calendar integration for AI assistants like Claude.

> **Readonly-fork status:** this fork exposes exactly four MCP tools — `list-calendars`, `list-events`, `search-events`, `get-event` — and no write, free/busy, color, current-time, or account-management tools. OAuth uses `calendar.events.readonly` only. `list-calendars` / calendar-name resolution / default-timezone calendarList access remains an adoption gate pending fresh-grant validation (not claimed working). The local HTTP account page and standalone auth command are out-of-band consent only, not MCP/model tools. `list-events` and `search-events` require exactly one account and one calendar per request with `pageSize <= 20` / `pageToken` pagination.

<table>
<tr>
<td>
<h3><a href="https://cocal.io/?utm_source=google_calendar_mcp&amp;utm_medium=listing&amp;utm_campaign=release"><img src="docs/images/cocal/logo.svg" alt="Cocal" width="144"></a></h3>
<p>I built <a href="https://cocal.io/?utm_source=google_calendar_mcp&amp;utm_medium=listing&amp;utm_campaign=release">Cocal</a> as a separate hosted calendar assistant, taking this project further with a <strong>full visual calendar inside your chat with Claude.</strong> Connect your Google accounts without creating a Google Cloud project or running a server.</p>
<ul>
<li><strong>Plan across accounts.</strong> Check availability and catch conflicts across your work, personal, and shared Google Calendars in one conversation.</li>
<li><strong>Use it on desktop and mobile.</strong> See and manage your calendars in Claude on web, desktop, iOS, and Android.</li>
<li><strong>Carry your preferences into new chats.</strong> Save rules like “no meetings before 10” or which calendar to use for personal plans.</li>
</ul>
<p>
<a href="docs/images/cocal/day-view.png"><img src="docs/images/cocal/day-view.png" alt="Cocal visual calendar showing work meetings and a personal gym session together on a timeline" width="300"></a>
<a href="docs/images/cocal/event-details.png"><img src="docs/images/cocal/event-details.png" alt="Cocal event card showing attendees, timezone context, a description, and no conflicts" width="300"></a>
</p>
<p><sub>Real Cocal UI with sample calendar data. Click either screenshot to enlarge.</sub></p>
<p><strong><a href="https://cocal.io/?utm_source=google_calendar_mcp&amp;utm_medium=listing&amp;utm_campaign=release">Try Cocal →</a></strong></p>
</td>
</tr>
</table>

---

## Features

- **Read-only event queries**: List, search, and fetch event details from one calendar at a time
- **Single-account / single-calendar requests**: `list-events` and `search-events` take exactly one account and one `calendarId` (ID or name) per request
- **Cursor pagination**: `pageSize` (1-20, passed as `maxResults`) and opaque `pageToken` (`nextPageToken` passthrough, one `events.list` call per request, no auto-pagination or merging)
- **Calendar lookup helper**: `list-calendars` lists known calendars for ID/name resolution (see adoption gate note below)

## Quick Start

### Prerequisites

1. A Google Cloud project with the Calendar API enabled
2. OAuth 2.0 credentials (Desktop app type)

### Google Cloud Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one.
3. Enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) for your project. Ensure that the right project is selected from the top bar before enabling the API.
4. Create OAuth 2.0 credentials:
   - Go to Credentials
   - Click "Create Credentials" > "OAuth client ID"
   - Choose "User data" for the type of data that the app will be accessing
   - Add your app name and contact information
    - Add the following scope:
      - `https://www.googleapis.com/auth/calendar.events.readonly`
    - Do not add broader Calendar scopes; this fork requests readonly event access only.
   - Select "Desktop app" as the application type (Important!)
   - Save the auth key, you'll need to add its path to the JSON in the next step
   - Add your email address as a test user under the [Audience screen](https://console.cloud.google.com/auth/audience)
      - Note: it might take a few minutes for the test user to be added. The OAuth consent will not allow you to proceed until the test user has propagated.
      - Note about test mode: While an app is in test mode the auth tokens will expire after 1 week and need to be refreshed (see Re-authentication section below).

### Installation

**Option 1: Use with npx (Recommended)**

Add to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["@cocal/google-calendar-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/your/gcp-oauth.keys.json"
      }
    }
  }
}
```

**⚠️ Important Note for npx Users**: When using npx, you **must** specify the credentials file path using the `GOOGLE_OAUTH_CREDENTIALS` environment variable.

**Option 2: Local Installation**

```bash
git clone https://github.com/nspady/google-calendar-mcp.git
cd google-calendar-mcp
npm install
npm run build
```

Then add to Claude Desktop config using the local path or by specifying the path with the `GOOGLE_OAUTH_CREDENTIALS` environment variable.

**Option 3: Docker Installation**

```bash
git clone https://github.com/nspady/google-calendar-mcp.git
cd google-calendar-mcp
cp /path/to/your/gcp-oauth.keys.json .
docker compose up
```

See the [Docker deployment guide](docs/docker.md) for detailed configuration options including HTTP transport mode.

### First Run

1. Complete consent out of band before using any calendar tool: run the standalone auth command (`npx @cocal/google-calendar-mcp auth` / `npm run auth`) or use the local HTTP account page (see [Managing Accounts](#managing-accounts)).
2. The local HTTP account UI and standalone auth command are out-of-band consent only — they are not MCP/model tools.
3. Then start the MCP server and use the four read-only tools. Unauthenticated requests fail; there is no in-chat/MCP authentication or account-management tool.

> **Adoption gate:** `list-calendars`, calendar-name resolution, and default-timezone lookup depend on calendarList access. That access remains an adoption gate pending fresh-grant validation under the readonly scope — availability is not claimed here.

### Re-authentication

If you're in test mode (default), tokens expire after 7 days. If you see authentication errors, re-run consent out of band:

**For npx users:**
```bash
export GOOGLE_OAUTH_CREDENTIALS="/path/to/your/gcp-oauth.keys.json"
npx @cocal/google-calendar-mcp auth
```

**For local installation:**
```bash
npm run auth
```

**To avoid weekly re-authentication**, publish your app to production mode (without verification):
1. Go to Google Cloud Console → "APIs & Services" → "OAuth consent screen"
2. Click "PUBLISH APP" and confirm
3. Your tokens will no longer expire after 7 days but Google will show a warning about the app being unverified. 

See [Authentication Guide](docs/authentication.md#avoiding-token-expiration) for details.

## Managing Accounts

Connect Google accounts out of band; there is no `manage-accounts` MCP/model tool in this fork.

**Standalone auth (out-of-band consent only):** For initial setup, use `npm run account auth <nickname>` (e.g., `npm run account auth work`).

**HTTP / Docker (out-of-band consent only):** Visit the local HTTP account page to manage accounts in the browser. This is a local consent UI, not an MCP/model tool.

`list-events` and `search-events` require exactly one account and one calendar per request. When several accounts are connected, pass `account`; when only one account is connected it may be omitted. There is no multi-account merge and no multi-calendar fan-out in this fork.

## Example Usage

Read-only query examples (single account, single calendar per request):

1. **List events in a time range**:
   ```
   List my work calendar events for this upcoming week.
   ```

2. Calendar analysis:
   ```
   What events do I have coming up this week that aren't part of my usual routine?
   ```
3. Check attendance:
   ```
   Which events tomorrow have attendees who have not accepted the invitation?
   ```
4. Search by text:
   ```
   Search my primary calendar for planning meetings between January 1 and January 31.
   ```
   `list-events` and `search-events` return one page per request; pass through `nextPageToken` as `pageToken` with `pageSize <= 20` for the next page.

## Available Tools

This fork exposes exactly four MCP tools. There are no create/update/delete, respond, free/busy, color, current-time, or account-management tools.

| Tool | Description |
|------|-------------|
| `list-calendars` | List known calendars for ID/name resolution (calendarList access remains an adoption gate pending fresh-grant validation) |
| `list-events` | List events from exactly one account and one calendar; paginated via `pageSize` (1-20) / `pageToken` |
| `get-event` | Get details of a specific event by ID |
| `search-events` | Search events by text query in exactly one account and one calendar over a required time range; paginated via `pageSize` (1-20) / `pageToken` |

## Documentation

- [Authentication Setup](docs/authentication.md) - Detailed Google Cloud setup
- [Advanced Usage](docs/advanced-usage.md) - Single-account queries, pagination
- [Deployment Guide](docs/deployment.md) - HTTP transport, remote access
- [Docker Guide](docs/docker.md) - Docker deployment with stdio and HTTP modes
- [Architecture](docs/architecture.md) - Technical architecture overview
- [Development](docs/development.md) - Contributing and testing
- [Testing](docs/testing.md) - Unit and integration testing guide
- [Multi-Account Updates](docs/multi-account-updates.md) - Current status and roadmap for multi-account support

## Sponsorship

If Google Calendar MCP has been useful to you and you're so inclined, I'd greatly appreciate it if you'd consider [sponsoring my open source work](https://github.com/sponsors/nspady).

Thanks! – Nate

## Configuration

**Environment Variables:**
- `GOOGLE_OAUTH_CREDENTIALS` - Path to OAuth credentials file
- `GOOGLE_CALENDAR_MCP_READONLY_TOKEN_PATH` - Custom token storage location (optional)

> **Readonly fork note:** this fork intentionally ignores broad-scope upstream token files and requires a fresh OAuth consent into a new readonly token storage location.
- `ENABLED_TOOLS` - Comma-separated list of tools to enable (see Tool Filtering below)

### Tool Filtering

You can limit which of the four tools are exposed to the AI assistant using the `--enable-tools` flag or `ENABLED_TOOLS` environment variable. This is useful for:
- **Reducing context usage**: Each tool consumes tokens from the AI's context window. Limiting tools can help preserve context for longer conversations.
- **Simplicity**: Only expose the tools your workflow actually needs.

**Via command line:**
```bash
npx @cocal/google-calendar-mcp start --enable-tools list-calendars,list-events,search-events,get-event
```

**Via environment variable in Claude Desktop config:**
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["@cocal/google-calendar-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "/path/to/credentials.json",
        "ENABLED_TOOLS": "list-calendars,list-events,search-events,get-event"
      }
    }
  }
}
```

**Available tool names:** `list-calendars`, `list-events`, `search-events`, `get-event`

When tool filtering is active, only the selected subset of the four tools is registered. Any other name (including upstream write, free/busy, color, current-time, or account-management names) is rejected as an invalid tool name.

If the list is empty or contains only commas, the server will fail to start with an error.

If an invalid tool name is specified, the server will fail to start with an error listing all available tools.

## Security

- OAuth tokens are stored securely in your system's config directory
- Credentials never leave your local machine
- All calendar operations require explicit user consent

### Troubleshooting

1. **OAuth Credentials File Not Found:**
   - For npx users: You **must** specify the credentials file path using `GOOGLE_OAUTH_CREDENTIALS`
   - Verify file paths are absolute and accessible

2. **Authentication Errors:**
   - Ensure your credentials file contains credentials for a **Desktop App** type
   - Verify your user email is added as a **Test User** in the Google Cloud OAuth Consent screen
   - Try deleting saved tokens and re-authenticating
   - Check that no other process is blocking ports 3500-3505

3. **Build Errors:**
   - Run `npm install && npm run build` again
   - Check Node.js version (use LTS)
   - Delete the `build/` directory and run `npm run build`
4. **"Something went wrong" screen during browser authentication**
   - Run the auth command manually (see [Re-authentication](#re-authentication) above)
   - Use a Chromium-based browser. Test app authentication may not work on some non-Chromium browsers.

5. **"User Rate Limit Exceeded" errors**
   - This typically occurs when your OAuth credentials are missing project information
   - Ensure your `gcp-oauth.keys.json` file includes `project_id`
   - Re-download credentials from Google Cloud Console if needed
   - The file should have format: `{"installed": {"project_id": "your-project-id", ...}}`

## License

MIT

## Support

- [GitHub Issues](https://github.com/nspady/google-calendar-mcp/issues)
- [Documentation](docs/)
