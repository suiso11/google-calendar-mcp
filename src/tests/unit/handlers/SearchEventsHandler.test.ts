import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchEventsHandler } from '../../../handlers/core/SearchEventsHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// Mock googleapis globally
vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        list: vi.fn()
      },
      calendarList: {
        get: vi.fn(),
        list: vi.fn()
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
        get: vi.fn().mockResolvedValue({ data: { timeZone: 'UTC' } }),
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              { id: 'primary', summary: 'Primary Calendar' },
              { id: 'work@example.com', summary: 'Work Calendar' }
            ]
          }
        })
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

  it('should omit maxResults/pageToken when not provided (no auto-pagination)', async () => {
    await handler.runTool({ ...baseArgs, query: 'Team' }, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect('maxResults' in callArgs).toBe(false);
    expect('pageToken' in callArgs).toBe(false);
    expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
  });

  it('should reject multiple accounts', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', mockOAuth2Client],
      ['personal', mockOAuth2Client]
    ]);
    await expect(handler.runTool(
      { ...baseArgs, query: 'Team', account: ['work', 'personal'] },
      multi
    )).rejects.toThrow(/exactly one account/i);
    expect(mockCalendar.events.list).not.toHaveBeenCalled();
  });

  it('should reject omitted account when multiple credentials exist', async () => {
    const multi = new Map<string, OAuth2Client>([
      ['work', mockOAuth2Client],
      ['personal', mockOAuth2Client]
    ]);
    await expect(handler.runTool({ ...baseArgs, query: 'Team' }, multi)).rejects.toThrow(/exactly one account/i);
  });

  it('should preserve time normalization, timeRange, fields and extended filters', async () => {
    const result = await handler.runTool({
      calendarId: 'primary',
      query: 'Meeting',
      timeMin: '2025-01-01T00:00:00',
      timeMax: '2025-01-31T23:59:59',
      fields: ['description'],
      privateExtendedProperty: ['k=v'],
      sharedExtendedProperty: ['s=v']
    }, mockAccounts);
    const callArgs = mockCalendar.events.list.mock.calls[0][0];
    expect(callArgs.q).toBe('Meeting');
    expect(callArgs.timeMin).toBe('2025-01-01T00:00:00Z');
    expect(callArgs.timeMax).toBe('2025-01-31T23:59:59Z');
    expect(callArgs.privateExtendedProperty).toEqual(['k=v']);
    expect(callArgs.sharedExtendedProperty).toEqual(['s=v']);
    expect(callArgs.fields).toBeDefined();
    const response = JSON.parse((result.content[0] as any).text);
    expect(response.timeRange.start).toBe('2025-01-01T00:00:00Z');
    expect(response.timeRange.end).toBe('2025-01-31T23:59:59Z');
    expect(response.events[0].accountId).toBe('test');
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
});
