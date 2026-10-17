import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListEventsHandler } from '../../../handlers/core/ListEventsHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { convertToRFC3339 } from '../../../utils/datetime.js';

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

describe('ListEventsHandler single-calendar pagination', () => {
  const mockOAuth2Client = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' })
  } as unknown as OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;

  const handler = new ListEventsHandler();
  let mockCalendar: any;

  beforeEach(() => {
    mockAccounts = new Map([['test', mockOAuth2Client]]);
    mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'test-event',
                summary: 'Test Event',
                start: { dateTime: '2025-06-02T10:00:00Z' },
                end: { dateTime: '2025-06-02T11:00:00Z' },
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

  it('should handle single calendar ID as string with exactly one API call', async () => {
    const args = {
      calendarId: 'primary',
      timeMin: '2025-06-02T00:00:00Z',
      timeMax: '2025-06-09T23:59:59Z'
    };

    const result = await handler.runTool(args, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.timeMin).toBe('2025-06-02T00:00:00Z');
    expect(callArgs.timeMax).toBe('2025-06-09T23:59:59Z');
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.events).toBeDefined();
    expect(response.totalCount).toBe(1);
    expect(response.events[0].calendarId).toBe('primary');
    expect(response.events[0].accountId).toBe('test');
    expect(response.nextPageToken).toBeUndefined();
  });

  it('should forward email and opaque calendar IDs byte-for-byte with no metadata', async () => {
    for (const calendarId of ['user@gmail.com', 'opaque-calendar-id_123']) {
      mockCalendar.events.list.mockClear();
      mockCalendar.calendarList.list.mockClear();
      mockCalendar.calendarList.get.mockClear();
      await handler.runTool({ calendarId }, mockAccounts);
      expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
      expect(mockCalendar.events.list.mock.calls[0][0].calendarId).toBe(calendarId);
      expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
      expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
      expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
    }
  });

  it('should forward name-like calendar IDs verbatim with no resolution', async () => {
    await handler.runTool({ calendarId: 'Work Calendar' }, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.list.mock.calls[0][0].calendarId).toBe('Work Calendar');
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
  });

  it('should select the explicitly requested account client', async () => {
    const workClient = { getAccessToken: vi.fn() } as unknown as OAuth2Client;
    const personalClient = { getAccessToken: vi.fn() } as unknown as OAuth2Client;
    const multi = new Map<string, OAuth2Client>([
      ['work', workClient],
      ['personal', personalClient]
    ]);
    const result = await handler.runTool(
      { calendarId: 'primary', account: 'personal' },
      multi
    );
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    expect(mockCalendar.events.list.mock.calls[0][0].calendarId).toBe('primary');
    // The provider client must be built from the explicitly selected account
    const calendarCtorCalls = (google.calendar as any).mock.calls;
    expect(calendarCtorCalls.length).toBeGreaterThan(0);
    expect(calendarCtorCalls[calendarCtorCalls.length - 1][0].auth).toBe(personalClient);
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('should reject array calendarId', async () => {
    const args = {
      calendarId: ['primary', 'secondary@gmail.com'],
      timeMin: '2025-06-02T00:00:00Z',
      timeMax: '2025-06-09T23:59:59Z'
    } as any;

    await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(/exactly one.*calendarId/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
  });

  it('should not expand JSON-array calendarId string (single opaque ID, one API call)', async () => {
    const args = {
      calendarId: '["primary", "secondary@gmail.com"]',
      timeMin: '2025-06-02T00:00:00Z',
      timeMax: '2025-06-09T23:59:59Z'
    };

    // No array expansion: treated as one opaque calendar identifier.
    const result = await handler.runTool(args, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('["primary", "secondary@gmail.com"]');
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('should pass pageSize as maxResults exactly and pageToken verbatim', async () => {
    mockCalendar.events.list.mockResolvedValueOnce({
      data: {
        items: [],
        nextPageToken: 'opaque-cursor-123'
      }
    });
    const args = {
      calendarId: 'primary',
      timeMin: '2025-06-02T00:00:00Z',
      timeMax: '2025-06-09T23:59:59Z',
      pageSize: 5,
      pageToken: 'opaque-cursor-abc'
    };

    const result = await handler.runTool(args, mockAccounts);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.maxResults).toBe(5);
    expect(callArgs.pageToken).toBe('opaque-cursor-abc');
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.nextPageToken).toBe('opaque-cursor-123');
    expect(response.totalCount).toBe(0);
  });

  it('should propagate empty pageToken verbatim to the API', async () => {
    const args = {
      calendarId: 'primary',
      timeMin: '2025-06-02T00:00:00Z',
      pageSize: 10,
      pageToken: ''
    };

    await handler.runTool(args, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.pageToken).toBe('');
    expect(callArgs.maxResults).toBe(10);
  });

  it('should propagate empty nextPageToken verbatim in response', async () => {
    mockCalendar.events.list.mockResolvedValueOnce({
      data: { items: [], nextPageToken: '' }
    });
    const result = await handler.runTool({ calendarId: 'primary' }, mockAccounts);
    const response = JSON.parse((result.content[0] as any).text);
    expect('nextPageToken' in response).toBe(true);
    expect(response.nextPageToken).toBe('');
  });

  it('should send bounded maxResults 20 when pageSize omitted (no auto-pagination)', async () => {
    await handler.runTool({ calendarId: 'primary' }, mockAccounts);
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
      { calendarId: 'primary', account: ['work', 'personal'] } as any,
      multi
    )).rejects.toThrow(/exactly one account/i);
  });

  it('should reject omitted account when multiple credentials exist before any provider I/O', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', mockOAuth2Client],
      ['personal', mockOAuth2Client]
    ]);
    await expect(handler.runTool({ calendarId: 'primary' }, multi)).rejects.toThrow(/exactly one account/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    expect(mockCalendar.calendars.get).not.toHaveBeenCalled();
  });

  it('should reject unknown accounts before any provider I/O', async () => {
    await expect(
      handler.runTool({ calendarId: 'primary', account: 'nope' }, mockAccounts)
    ).rejects.toThrow(/not found/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
  });

  it('should preserve filters and tag account/calendar', async () => {
    const args = {
      calendarId: 'primary',
      timeMin: '2025-06-02T00:00:00Z',
      timeMax: '2025-06-09T23:59:59Z',
      fields: ['description'],
      privateExtendedProperty: ['k=v'],
      sharedExtendedProperty: ['s=v']
    };
    const result = await handler.runTool(args, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.privateExtendedProperty).toEqual(['k=v']);
    expect(callArgs.sharedExtendedProperty).toEqual(['s=v']);
    expect(callArgs.fields).toBeDefined();
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.events[0].accountId).toBe('test');
    expect(response.events[0].calendarId).toBe('primary');
  });
});

describe('ListEventsHandler - Timezone Handling', () => {
  let handler: ListEventsHandler;
  let mockOAuth2Client: OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;
  let mockCalendar: any;

  beforeEach(() => {
    handler = new ListEventsHandler();
    mockOAuth2Client = {} as OAuth2Client;
    mockAccounts = new Map([['test', mockOAuth2Client]]);
    mockCalendar = {
      events: {
        list: vi.fn()
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

  describe('convertToRFC3339 timezone interpretation', () => {
    it('should correctly convert timezone-naive datetime to Los Angeles time', () => {
      // Test the core issue: timezone-naive datetime should be interpreted in the target timezone
      const datetime = '2025-01-01T10:00:00';
      const timezone = 'America/Los_Angeles';

      const result = convertToRFC3339(datetime, timezone);

      // In January 2025, Los Angeles is UTC-8 (PST)
      // 10:00 AM PST = 18:00 UTC
      // The result should be '2025-01-01T18:00:00Z'
      expect(result).toBe('2025-01-01T18:00:00Z');
    });

    it('should correctly convert timezone-naive datetime to New York time', () => {
      const datetime = '2025-01-01T10:00:00';
      const timezone = 'America/New_York';

      const result = convertToRFC3339(datetime, timezone);

      // In January 2025, New York is UTC-5 (EST)
      // 10:00 AM EST = 15:00 UTC
      expect(result).toBe('2025-01-01T15:00:00Z');
    });

    it('should correctly convert timezone-naive datetime to London time', () => {
      const datetime = '2025-01-01T10:00:00';
      const timezone = 'Europe/London';

      const result = convertToRFC3339(datetime, timezone);

      // In January 2025, London is UTC+0 (GMT)
      // 10:00 AM GMT = 10:00 UTC
      expect(result).toBe('2025-01-01T10:00:00Z');
    });

    it('should handle DST transitions correctly', () => {
      // Test during DST period
      const datetime = '2025-07-01T10:00:00';
      const timezone = 'America/Los_Angeles';

      const result = convertToRFC3339(datetime, timezone);

      // In July 2025, Los Angeles is UTC-7 (PDT)
      // 10:00 AM PDT = 17:00 UTC
      expect(result).toBe('2025-07-01T17:00:00Z');
    });

    it('should leave timezone-aware datetime unchanged', () => {
      const datetime = '2025-01-01T10:00:00-08:00';
      const timezone = 'America/Los_Angeles';

      const result = convertToRFC3339(datetime, timezone);

      // Should remain unchanged since it already has timezone info
      expect(result).toBe('2025-01-01T10:00:00-08:00');
    });
  });

  describe('ListEventsHandler timezone parameter usage', () => {
    beforeEach(() => {
      // Mock successful events list response (no calendar metadata available)
      mockCalendar.events.list.mockResolvedValue({
        data: { items: [] }
      });
    });

    it('should use timeZone parameter to interpret timezone-naive timeMin/timeMax', async () => {
      const args = {
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00',
        timeMax: '2025-01-01T18:00:00',
        timeZone: 'America/Los_Angeles'
      };

      await handler.runTool(args, mockAccounts);

      // Verify that the calendar.events.list was called with correctly converted times
      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: 'primary',
        timeMin: '2025-01-01T18:00:00Z', // 10:00 AM PST = 18:00 UTC
        timeMax: '2025-01-02T02:00:00Z', // 18:00 PM PST = 02:00 UTC next day
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });
      expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
    });

    it('should preserve timezone-aware timeMin/timeMax regardless of timeZone parameter', async () => {
      const args = {
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00-08:00',
        timeMax: '2025-01-01T18:00:00-08:00',
        timeZone: 'America/New_York' // Different timezone, should be ignored
      };

      await handler.runTool(args, mockAccounts);

      // Verify that the original timezone-aware times are preserved
      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00-08:00',
        timeMax: '2025-01-01T18:00:00-08:00',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });
    });

    it('should fall back to deterministic UTC when timeZone parameter not provided', async () => {
      const args = {
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00',
        timeMax: '2025-01-01T18:00:00'
        // No timeZone parameter: deterministic UTC, no calendar metadata lookup
      };

      await handler.runTool(args, mockAccounts);

      // Verify UTC is used for conversion with no metadata I/O
      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00Z',
        timeMax: '2025-01-01T18:00:00Z',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });
      expect(mockCalendar.calendarList.get).not.toHaveBeenCalled();
      expect(mockCalendar.calendarList.list).not.toHaveBeenCalled();
    });

    it('should handle UTC timezone correctly', async () => {
      const args = {
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00',
        timeMax: '2025-01-01T18:00:00',
        timeZone: 'UTC'
      };

      await handler.runTool(args, mockAccounts);

      // Verify that UTC times are handled correctly
      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: 'primary',
        timeMin: '2025-01-01T10:00:00Z',
        timeMax: '2025-01-01T18:00:00Z',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });
    });
  });

  describe('Fractional seconds provider bounds (byte-for-byte)', () => {
    beforeEach(() => {
      mockCalendar.events.list.mockResolvedValue({ data: { items: [] } });
    });

    it('should forward explicit-offset fractional bounds to events.list unchanged', async () => {
      const timeMin = '2026-01-01T00:00:00.123456789+09:00';
      const timeMax = '2026-01-31T23:59:59.999999999Z';
      await handler.runTool({ calendarId: 'primary', timeMin, timeMax }, mockAccounts);
      const callArgs = mockCalendar.events.list.mock.calls[0][0];
      expect(callArgs.timeMin).toBe(timeMin);
      expect(callArgs.timeMax).toBe(timeMax);
    });

    it('should forward .1 fractional Z bounds without truncation', async () => {
      const timeMin = '2026-01-01T00:00:00.1Z';
      const timeMax = '2026-01-31T23:59:59.1Z';
      await handler.runTool({ calendarId: 'primary', timeMin, timeMax }, mockAccounts);
      const callArgs = mockCalendar.events.list.mock.calls[0][0];
      expect(callArgs.timeMin).toBe(timeMin);
      expect(callArgs.timeMax).toBe(timeMax);
    });

    it('should preserve naive fraction digits through UTC fallback conversion', async () => {
      await handler.runTool({
        calendarId: 'primary',
        timeMin: '2026-01-01T00:00:00.123456',
        timeMax: '2026-01-31T23:59:59.999999999',
      }, mockAccounts);
      const callArgs = mockCalendar.events.list.mock.calls[0][0];
      expect(callArgs.timeMin).toBe('2026-01-01T00:00:00.123456Z');
      expect(callArgs.timeMax).toBe('2026-01-31T23:59:59.999999999Z');
    });
  });
});
