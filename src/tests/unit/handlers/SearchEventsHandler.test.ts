import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchEventsHandler } from '../../../handlers/core/SearchEventsHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// Mock googleapis globally. calendarList/calendars metadata endpoints throw so
// any metadata I/O on the MCP path fails the test (0-metadata proof).
const metadataError = () => {
  throw new Error('metadata I/O is not allowed on the events readonly path');
};
vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        list: vi.fn()
      },
      calendarList: {
        get: vi.fn(() => {
          throw new Error('metadata I/O is not allowed on the events readonly path');
        }),
        list: vi.fn(() => {
          throw new Error('metadata I/O is not allowed on the events readonly path');
        })
      },
      calendars: {
        get: vi.fn(() => {
          throw new Error('metadata I/O is not allowed on the events readonly path');
        })
      }
    }))
  }
}));

describe('SearchEventsHandler single-calendar pagination', () => {
  const mockOAuth2Client = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' })
  } as unknown as OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;

  const handler = new SearchEventsHandler();
  let mockCalendar: any;

  const baseArgs = {
    calendarId: 'primary',
    timeMin: '2025-01-01T00:00:00Z',
    timeMax: '2025-01-31T23:59:59Z'
  };

  beforeEach(() => {
    mockAccounts = new Map([['test', mockOAuth2Client]]);
    mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'event1',
                etag: '"etag-1"',
                summary: 'Team Meeting',
                start: { dateTime: '2025-01-15T10:00:00Z' },
                end: { dateTime: '2025-01-15T11:00:00Z' }
              }
            ]
          }
        })
      },
      calendarList: {
        get: vi.fn(metadataError),
        list: vi.fn(metadataError)
      },
      calendars: {
        get: vi.fn(metadataError)
      }
    };
    vi.mocked(google.calendar).mockReturnValue(mockCalendar);
  });

  it('should search with query text using exactly one API call', async () => {
    const result = await handler.runTool({ ...baseArgs, query: 'Team' }, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.q).toBe('Team');
    expect(callArgs.singleEvents).toBe(true);
    expect(callArgs.orderBy).toBe('startTime');
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.events).toHaveLength(1);
    expect(response.totalCount).toBe(1);
    expect(response.query).toBe('Team');
    expect(response.calendarId).toBe('primary');
    expect(response.events[0].etag).toBe('"etag-1"');
    expect(response.events[0].calendarId).toBe('primary');
    expect(response.events[0].accountId).toBe('test');
    expect(response.timeRange).toBeDefined();
  });

  it('should forward email, opaque, and name-like calendar IDs verbatim with no metadata', async () => {
    for (const calendarId of ['user@gmail.com', 'opaque-calendar-id_123', 'Work Calendar']) {
      mockCalendar.events.list.mockClear();
      mockCalendar.calendarList.list.mockClear();
      mockCalendar.calendarList.get.mockClear();
      mockCalendar.calendars.get.mockClear();
      await handler.runTool({ ...baseArgs, query: 'Team', calendarId }, mockAccounts);
      expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
      expect(mockCalendar.events.list.mock.calls[0][0].calendarId).toBe(calendarId);
      expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
      expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
      expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
    }
  });

  it('should select the explicitly requested account client', async () => {
    const workClient = { getAccessToken: vi.fn() } as unknown as OAuth2Client;
    const personalClient = { getAccessToken: vi.fn() } as unknown as OAuth2Client;
    const multi = new Map<string, OAuth2Client>([
      ['work', workClient],
      ['personal', personalClient]
    ]);
    await handler.runTool({ ...baseArgs, query: 'Team', account: 'work' }, multi);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const calendarCtorCalls = (google.calendar as any).mock.calls;
    expect(calendarCtorCalls.length).toBeGreaterThan(0);
    expect(calendarCtorCalls[calendarCtorCalls.length - 1][0].auth).toBe(workClient);
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
  });

  it('should omit q and query when query is absent (optional query)', async () => {
    const result = await handler.runTool({ ...baseArgs }, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect('q' in callArgs).toBe(false);
    const response = JSON.parse((result.content[0] as any).text);
    expect('query' in response).toBe(false);
    expect(response.calendarId).toBe('primary');
  });

  it('should reject array calendarId without calling the API', async () => {
    await expect(handler.runTool(
      { ...baseArgs, query: 'Team', calendarId: ['primary', 'other'] } as any,
      mockAccounts
    )).rejects.toThrow(/exactly one.*calendarId/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
  });

  it('should not expand JSON-array calendarId string (single opaque ID, one API call)', async () => {
    const result = await handler.runTool(
      { ...baseArgs, query: 'Team', calendarId: '["primary", "secondary@gmail.com"]' },
      mockAccounts
    );
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('["primary", "secondary@gmail.com"]');
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('should pass pageSize as maxResults exactly and pageToken verbatim, surfacing nextPageToken', async () => {
    mockCalendar.events.list.mockResolvedValueOnce({
      data: { items: [], nextPageToken: 'opaque-cursor-123' }
    });
    const result = await handler.runTool(
      { ...baseArgs, query: 'Team', pageSize: 5, pageToken: 'opaque-cursor-abc' },
      mockAccounts
    );
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.maxResults).toBe(5);
    expect(callArgs.pageToken).toBe('opaque-cursor-abc');
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.nextPageToken).toBe('opaque-cursor-123');
    expect(response.totalCount).toBe(0);
    expect(response.events).toHaveLength(0);
  });

  it('should propagate empty pageToken verbatim to the API', async () => {
    await handler.runTool(
      { ...baseArgs, query: 'Team', pageSize: 10, pageToken: '' },
      mockAccounts
    );
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.pageToken).toBe('');
    expect(callArgs.maxResults).toBe(10);
  });

  it('should propagate empty nextPageToken verbatim even for an empty page', async () => {
    mockCalendar.events.list.mockResolvedValueOnce({
      data: { items: [], nextPageToken: '' }
    });
    const result = await handler.runTool({ ...baseArgs, query: 'Team' }, mockAccounts);
    const response = JSON.parse((result.content[0] as any).text);
    expect('nextPageToken' in response).toBe(true);
    expect(response.nextPageToken).toBe('');
    expect(response.totalCount).toBe(0);
  });

  it('should send bounded maxResults 20 when pageSize omitted (no auto-pagination)', async () => {
    await handler.runTool({ ...baseArgs, query: 'Team' }, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.maxResults).toBe(20);
    expect('pageToken' in callArgs).toBe(false);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
  });

  it('should reject multiple accounts', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', mockOAuth2Client],
      ['personal', mockOAuth2Client]
    ]);
    await expect(handler.runTool(
      { ...baseArgs, query: 'Team', account: ['work', 'personal'] } as any,
      multi
    )).rejects.toThrow(/exactly one account/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
  });

  it('should reject omitted account when multiple credentials exist before any provider I/O', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', mockOAuth2Client],
      ['personal', mockOAuth2Client]
    ]);
    await expect(handler.runTool({ ...baseArgs, query: 'Team' }, multi)).rejects.toThrow(/exactly one account/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
  });

  it('should reject unknown accounts before any provider I/O', async () => {
    await expect(
      handler.runTool({ ...baseArgs, query: 'Team', account: 'nope' }, mockAccounts)
    ).rejects.toThrow(/not found/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
  });

  it('should use explicit timeZone with no metadata, defaulting to UTC otherwise', async () => {
    await handler.runTool({
      calendarId: 'primary',
      query: 'Meeting',
      timeMin: '2025-01-01T00:00:00',
      timeMax: '2025-01-31T23:59:59',
      timeZone: 'America/Los_Angeles',
      fields: ['description'],
      privateExtendedProperty: ['k=v'],
      sharedExtendedProperty: ['s=v']
    }, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.q).toBe('Meeting');
    expect(callArgs.timeMin).toBe('2025-01-01T08:00:00Z');
    expect(callArgs.timeMax).toBe('2025-02-01T07:59:59Z');
    expect(callArgs.privateExtendedProperty).toEqual(['k=v']);
    expect(callArgs.sharedExtendedProperty).toEqual(['s=v']);
    expect(callArgs.fields).toBeDefined();
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();

    mockCalendar.events.list.mockClear();
    await handler.runTool({
      calendarId: 'primary',
      query: 'Meeting',
      timeMin: '2025-01-01T00:00:00',
      timeMax: '2025-01-31T23:59:59'
    }, mockAccounts);
    const utcArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(utcArgs.timeMin).toBe('2025-01-01T00:00:00Z');
    expect(utcArgs.timeMax).toBe('2025-01-31T23:59:59Z');
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
  });

  it('should handle API errors', async () => {
    const apiError = new Error('Bad Request');
    (apiError as any).code = 400;
    mockCalendar.events.list.mockRejectedValue(apiError);
    vi.spyOn(handler as any, 'handleGoogleApiError').mockImplementation(() => {
      throw new Error('Bad Request');
    });
    await expect(handler.runTool({ ...baseArgs, query: 'Meeting' }, mockAccounts)).rejects.toThrow('Bad Request');
  });

  describe('Fractional seconds provider bounds (byte-for-byte)', () => {
    it('should forward explicit-offset fractional bounds to events.list unchanged', async () => {
      const timeMin = '2026-01-01T00:00:00.123456789+09:00';
      const timeMax = '2026-01-31T23:59:59.999999999Z';
      await handler.runTool({ ...baseArgs, query: 'Team', timeMin, timeMax }, mockAccounts);
      const callArgs = mockCalendar.events.list.mock.calls[0][0];
      expect(callArgs.timeMin).toBe(timeMin);
      expect(callArgs.timeMax).toBe(timeMax);
    });

    it('should forward negative-offset fractional bounds without reconstruction', async () => {
      const timeMin = '2026-01-01T00:00:00.5-05:00';
      const timeMax = '2026-01-31T23:59:59.123456-05:00';
      await handler.runTool({ ...baseArgs, query: 'Team', timeMin, timeMax }, mockAccounts);
      const callArgs = mockCalendar.events.list.mock.calls[0][0];
      expect(callArgs.timeMin).toBe(timeMin);
      expect(callArgs.timeMax).toBe(timeMax);
    });
  });
});
