import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { ToolRegistry } from '../../../tools/registry.js';

/**
 * Readonly events surface tests (3-tool exact-ID cutover).
 *
 * The readonly server exposes exactly three MCP tools: list-events,
 * search-events, get-event. list-calendars, every write name, and every
 * auxiliary/account-management name must be rejected. The registered SDK
 * callbacks invoke the actual handlers against an inert provider fixture
 * (events succeed; calendarList/calendars metadata throw), proving the MCP
 * path performs zero metadata I/O.
 */
const REJECTED_TOOLS = [
  'list-calendars',
  'create-event',
  'create-events',
  'update-event',
  'delete-event',
  'respond-to-event',
  'list-colors',
  'get-freebusy',
  'get-current-time',
  'manage-accounts',
];

const metadataError = () => {
  throw new Error('metadata I/O is not allowed on the events readonly path');
};

vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn()
  },
  calendar_v3: {}
}));

describe('Readonly events surface', () => {
  let mockCalendar: any;
  let singleAccount: Map<string, OAuth2Client>;

  beforeEach(() => {
    singleAccount = new Map([['test', new OAuth2Client()]]);
    mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'event1',
                summary: 'Team Meeting',
                start: { dateTime: '2025-01-15T10:00:00Z' },
                end: { dateTime: '2025-01-15T11:00:00Z' }
              }
            ]
          }
        }),
        get: vi.fn().mockResolvedValue({
          data: {
            id: 'event1',
            summary: 'Team Meeting',
            start: { dateTime: '2025-01-15T10:00:00Z' },
            end: { dateTime: '2025-01-15T11:00:00Z' }
          }
        })
      },
      calendarList: {
        list: vi.fn(metadataError),
        get: vi.fn(metadataError)
      },
      calendars: {
        get: vi.fn(metadataError)
      }
    };
    vi.mocked(google.calendar).mockReturnValue(mockCalendar);
  });

  async function registerRealWire(accounts: Map<string, OAuth2Client>) {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const original = server.registerTool.bind(server);
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, definition: any, cb: any) => {
      callbacks.set(name, cb);
      return (original as any)(name, definition, cb);
    });
    await ToolRegistry.registerAll(server, async (handler: any, args: any) => {
      return handler.runTool(args, accounts);
    });
    return { server, callbacks };
  }

  function expectZeroMetadata() {
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
  }

  it('should reject list-calendars and every write/non-approved/manage tool name', () => {
    for (const name of REJECTED_TOOLS) {
      expect(() => ToolRegistry.validateToolNames([name])).toThrow(/Invalid tool name/);
    }
  });

  it('should reject write tools passed via enabledTools', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    await expect(
      ToolRegistry.registerAll(
        server,
        async () => ({ content: [] }),
        { transport: { type: 'stdio' }, enabledTools: ['list-events', 'create-event'] }
      )
    ).rejects.toThrow(/Invalid tool name\(s\): create-event/);
  });

  it('should reject list-calendars passed via enabledTools with zero provider calls', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    await expect(
      ToolRegistry.registerAll(
        server,
        async () => ({ content: [] }),
        { transport: { type: 'stdio' }, enabledTools: ['list-events', 'list-calendars'] }
      )
    ).rejects.toThrow(/Invalid tool name\(s\): list-calendars/);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.events.get).not.toHaveBeenCalled();
    expectZeroMetadata();
  });

  it('should expose no list-calendars callback on the real SDK wire', async () => {
    const { callbacks } = await registerRealWire(singleAccount);
    expect(callbacks.get('list-calendars')).toBeUndefined();
    expect(callbacks.get('list-events')).toBeDefined();
    expect(callbacks.get('search-events')).toBeDefined();
    expect(callbacks.get('get-event')).toBeDefined();
  });

  it('should run list-events through the real wire with one page and zero metadata', async () => {
    const { callbacks } = await registerRealWire(singleAccount);
    const timeMin = '2026-01-01T00:00:00.123456789+09:00';
    const timeMax = '2026-01-31T23:59:59.999999999Z';
    const result = await callbacks.get('list-events')!({
      calendarId: 'primary',
      timeMin,
      timeMax
    });
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.timeMin).toBe(timeMin);
    expect(callArgs.timeMax).toBe(timeMax);
    expectZeroMetadata();
    const response = JSON.parse(result.content[0].text);
    expect(response.events).toHaveLength(1);
    expect(response.totalCount).toBe(1);
  });

  it('should run search-events and get-event through the real wire with zero metadata', async () => {
    const { callbacks } = await registerRealWire(singleAccount);
    const searchResult = await callbacks.get('search-events')!({
      calendarId: 'user@gmail.com',
      query: 'Team',
      timeMin: '2026-01-01T00:00:00.1Z',
      timeMax: '2026-01-31T23:59:59.1Z',
      timeZone: 'UTC'
    });
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.list.mock.calls[0][0].calendarId).toBe('user@gmail.com');
    expectZeroMetadata();
    const searchResponse = JSON.parse(searchResult.content[0].text);
    expect(searchResponse.events).toHaveLength(1);

    const getResult = await callbacks.get('get-event')!({
      calendarId: 'opaque-calendar-id_123',
      eventId: 'event1'
    });
    expect(mockCalendar.events.get).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.get).toHaveBeenCalledWith({
      calendarId: 'opaque-calendar-id_123',
      eventId: 'event1'
    });
    expectZeroMetadata();
    const getResponse = JSON.parse(getResult.content[0].text);
    expect(getResponse.event.id).toBe('event1');
  });

  it('should reject ambiguous accounts on the real wire before any provider I/O', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', new OAuth2Client()],
      ['personal', new OAuth2Client()]
    ]);
    const { callbacks } = await registerRealWire(multi);
    await expect(callbacks.get('list-events')!({ calendarId: 'primary' })).rejects.toThrow(
      /exactly one account/i
    );
    await expect(
      callbacks.get('search-events')!({
        calendarId: 'primary',
        timeMin: '2025-01-01T00:00:00Z',
        timeMax: '2025-01-31T23:59:59Z'
      })
    ).rejects.toThrow(/exactly one account/i);
    await expect(
      callbacks.get('get-event')!({ calendarId: 'primary', eventId: 'event1' })
    ).rejects.toThrow(/exactly one account/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.events.get).not.toHaveBeenCalled();
    expectZeroMetadata();
  });

  it('should preserve fractional bounds through the actual registered SDK callback (inert provider)', async () => {
    const { callbacks } = await registerRealWire(singleAccount);

    // list-events: schema.parse path with fractional explicit bounds
    const timeMin = '2026-01-01T00:00:00.123456789+09:00';
    const timeMax = '2026-01-31T23:59:59.999999999Z';
    await callbacks.get('list-events')!({ calendarId: 'primary', timeMin, timeMax });
    const listArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(listArgs.timeMin).toBe(timeMin);
    expect(listArgs.timeMax).toBe(timeMax);

    // search-events: schema.parse path with .1 fractional Z bounds
    await callbacks.get('search-events')!({
      calendarId: 'primary',
      timeMin: '2026-01-01T00:00:00.1Z',
      timeMax: '2026-01-31T23:59:59.1Z'
    });
    const searchArgs = mockCalendar.events.list.mock.calls[1][0];
    expect(searchArgs.timeMin).toBe('2026-01-01T00:00:00.1Z');
    expect(searchArgs.timeMax).toBe('2026-01-31T23:59:59.1Z');
    expectZeroMetadata();
  });
});
