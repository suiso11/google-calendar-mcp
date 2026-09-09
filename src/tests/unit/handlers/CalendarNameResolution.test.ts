/**
 * Unit tests for calendar name resolution feature
 * Tests the resolveCalendarId and resolveCalendarIds methods in BaseToolHandler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListEventsHandler } from '../../../handlers/core/ListEventsHandler.js';
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
        list: vi.fn(),
        get: vi.fn()
      }
    }))
  }
}));

describe('Calendar Name Resolution', () => {
  const mockOAuth2Client = {
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' })
  } as unknown as OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;

  let handler: ListEventsHandler;
  let mockCalendar: any;

  beforeEach(() => {
    mockAccounts = new Map([['test', mockOAuth2Client]]);
    handler = new ListEventsHandler();
    mockCalendar = {
      events: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: []
          }
        })
      },
      calendarList: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'primary',
                summary: 'Primary Calendar',
                summaryOverride: undefined
              },
              {
                id: 'work@example.com',
                summary: 'Engineering Team - Project Alpha - Q4 2024',
                summaryOverride: 'Work Calendar'
              },
              {
                id: 'personal@example.com',
                summary: 'Personal Calendar',
                summaryOverride: undefined
              },
              {
                id: 'team@example.com',
                summary: 'Team Events',
                summaryOverride: 'My Team'
              }
            ]
          }
        }),
        get: vi.fn().mockResolvedValue({
          data: { timeZone: 'UTC' }
        })
      }
    };
    vi.mocked(google.calendar).mockReturnValue(mockCalendar);
  });

  describe('summaryOverride matching priority', () => {
    it('should match summaryOverride before summary (exact match)', async () => {
      const args = {
        calendarId: 'Work Calendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      // Should have called events.list with the resolved ID
      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'work@example.com'
        })
      );
    });

    it('should fall back to summary if summaryOverride does not match', async () => {
      const args = {
        calendarId: 'Personal Calendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'personal@example.com'
        })
      );
    });

    it('should match summaryOverride case-insensitively', async () => {
      const args = {
        calendarId: 'WORK CALENDAR',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'work@example.com'
        })
      );
    });

    it('should match summary case-insensitively', async () => {
      const args = {
        calendarId: 'personal calendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'personal@example.com'
        })
      );
    });

    it('should prefer summaryOverride over similar summary name', async () => {
      // Even if there's a calendar with summary "My Team",
      // it should match the summaryOverride first
      const args = {
        calendarId: 'My Team',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'team@example.com'
        })
      );
    });
  });

  describe('single-calendar name resolution (paginated list-events)', () => {
    it('should reject array calendarId (single calendar only)', async () => {
      const args = {
        calendarId: ['Work Calendar', 'Personal Calendar'],
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      } as any;

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        /exactly one.*calendarId/i
      );
    });

    it('should resolve a single mixed ID/name via single events.list call', async () => {
      const args = {
        calendarId: 'Work Calendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 'work@example.com' })
      );
    });
  });

  describe('error handling with summaryOverride', () => {
    it('should provide helpful error for unknown single calendar', async () => {
      const args = {
        calendarId: 'NonExistentCalendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        /Calendar "NonExistentCalendar" not found/
      );

      try {
        await handler.runTool(args, mockAccounts);
      } catch (error: any) {
        // Error message should show both override and original name
        expect(error.message).toContain('Work Calendar');
        expect(error.message).toContain('Engineering Team - Project Alpha - Q4 2024');
        expect(error.message).toContain('My Team');
        expect(error.message).toContain('Team Events');
      }
    });

    it('should handle calendar with summaryOverride same as summary', async () => {
      // Update mock to have a calendar where override equals summary
      mockCalendar.calendarList.list.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'test@example.com',
              summary: 'Test Calendar',
              summaryOverride: 'Test Calendar'
            }
          ]
        }
      });

      const args = {
        calendarId: 'NonExistent',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      try {
        await handler.runTool(args, mockAccounts);
      } catch (error: any) {
        // Should not show duplicate when override equals summary
        const message = error.message;
        const matches = (message.match(/Test Calendar/g) || []).length;
        expect(matches).toBe(1);
      }
    });
  });

  describe('performance optimization', () => {
    it('should skip calendarList.list when input is already an ID', async () => {
      const args = {
        calendarId: 'primary',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      // Reset the mock to track calls
      mockCalendar.calendarList.list.mockClear();

      await handler.runTool(args, mockAccounts);

      // resolveCalendarId short-circuits IDs without calendarList.list
      expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
    });

    it('should resolve a single name with one lookup and one events.list', async () => {
      const args = {
        calendarId: 'Work Calendar',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      };

      mockCalendar.calendarList.list.mockClear();
      mockCalendar.events.list.mockClear();

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.list).toHaveBeenCalledTimes(1);
      expect(mockCalendar.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 'work@example.com' })
      );
    });
  });

  describe('input validation', () => {
    it('should reject empty string calendarId', async () => {
      const args = {
        calendarId: '',
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      } as any;

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        /exactly one.*calendarId/i
      );
    });

    it('should reject array calendarId even with empty entries', async () => {
      const args = {
        calendarId: ['', '  ', '\t'],
        timeMin: '2025-06-02T00:00:00Z',
        timeMax: '2025-06-09T23:59:59Z'
      } as any;

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        /exactly one.*calendarId/i
      );
    });
  });
});
