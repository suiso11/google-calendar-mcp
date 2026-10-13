import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetEventHandler } from '../../../handlers/core/GetEventHandler.js';
import { OAuth2Client } from 'google-auth-library';

// Mock the googleapis module
vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        get: vi.fn()
      }
    }))
  },
  calendar_v3: {}
}));

// Mock the field mask builder
vi.mock('../../../utils/field-mask-builder.js', () => ({
  buildSingleEventFieldMask: vi.fn((fields) => {
    if (!fields || fields.length === 0) return undefined;
    return fields.join(',');
  })
}));

describe('GetEventHandler', () => {
  let handler: GetEventHandler;
  let mockOAuth2Client: OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;
  let mockCalendar: any;

  beforeEach(() => {
    handler = new GetEventHandler();
    mockOAuth2Client = new OAuth2Client();
    mockAccounts = new Map([['test', mockOAuth2Client]]);

    // Setup mock calendar
    mockCalendar = {
      events: {
        get: vi.fn()
      }
    };

    // Mock the getCalendar method (inert provider: events only, no metadata surface)
    vi.spyOn(handler as any, 'getCalendar').mockReturnValue(mockCalendar);
  });

  describe('runTool', () => {
    it('should retrieve an event successfully', async () => {
      const mockEvent = {
        id: 'event123',
        summary: 'Test Event',
        start: { dateTime: '2025-01-15T10:00:00Z' },
        end: { dateTime: '2025-01-15T11:00:00Z' },
        status: 'confirmed'
      };

      mockCalendar.events.get.mockResolvedValue({ data: mockEvent });

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      const result = await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123'
      });

      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text);
      expect(response.event).toBeDefined();
      expect(response.event.id).toBe('event123');
      expect(response.event.summary).toBe('Test Event');
    });

    it('should forward opaque and email calendar IDs byte-for-byte', async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: { id: 'e1', summary: 'x', start: { dateTime: '2025-01-15T10:00:00Z' }, end: { dateTime: '2025-01-15T11:00:00Z' } }
      });

      for (const calendarId of ['primary', 'user@gmail.com', 'opaque-calendar-id_123']) {
        mockCalendar.events.get.mockClear();
        await handler.runTool({ calendarId, eventId: 'e1' }, mockAccounts);
        expect(mockCalendar.events.get).toHaveBeenCalledTimes(1);
        expect(mockCalendar.events.get).toHaveBeenCalledWith({
          calendarId,
          eventId: 'e1'
        });
      }
    });

    it('should forward name-like calendar IDs verbatim with no resolution', async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: { id: 'e1', summary: 'x', start: { dateTime: '2025-01-15T10:00:00Z' }, end: { dateTime: '2025-01-15T11:00:00Z' } }
      });

      await handler.runTool({ calendarId: 'Work Calendar', eventId: 'e1' }, mockAccounts);
      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: 'Work Calendar',
        eventId: 'e1'
      });
    });

    it('should select the explicitly requested account client', async () => {
      const workClient = new OAuth2Client();
      const personalClient = new OAuth2Client();
      const multi = new Map<string, OAuth2Client>([
        ['work', workClient],
        ['personal', personalClient]
      ]);
      const workCalendar = { events: { get: vi.fn().mockResolvedValue({ data: { id: 'e1', summary: 'w' } }) } };
      const personalCalendar = { events: { get: vi.fn().mockResolvedValue({ data: { id: 'e1', summary: 'p' } }) } };
      vi.spyOn(handler as any, 'getCalendar').mockImplementation((client: OAuth2Client) =>
        client === personalClient ? personalCalendar : workCalendar
      );

      const result = await handler.runTool(
        { calendarId: 'primary', eventId: 'e1', account: 'personal' },
        multi
      );
      expect(personalCalendar.events.get).toHaveBeenCalledTimes(1);
      expect(workCalendar.events.get).not.toHaveBeenCalled();
      const response = JSON.parse(result.content[0].text);
      expect(response.event.accountId).toBe('personal');
    });

    it('should reject ambiguous accounts before any provider I/O', async () => {
      const multi = new Map<string, OAuth2Client>([
        ['work', new OAuth2Client()],
        ['personal', new OAuth2Client()]
      ]);
      await expect(
        handler.runTool({ calendarId: 'primary', eventId: 'e1' }, multi)
      ).rejects.toThrow(/exactly one account/i);
      expect(mockCalendar.events.get).not.toHaveBeenCalled();
    });

    it('should reject unknown accounts before any provider I/O', async () => {
      await expect(
        handler.runTool({ calendarId: 'primary', eventId: 'e1', account: 'nope' }, mockAccounts)
      ).rejects.toThrow(/not found/i);
      expect(mockCalendar.events.get).not.toHaveBeenCalled();
    });

    it('should retrieve an event with custom fields', async () => {
      const mockEvent = {
        id: 'event123',
        summary: 'Test Event',
        start: { dateTime: '2025-01-15T10:00:00Z' },
        end: { dateTime: '2025-01-15T11:00:00Z' },
        description: 'Event description',
        colorId: '5',
        attendees: [{ email: 'test@example.com' }]
      };

      mockCalendar.events.get.mockResolvedValue({ data: mockEvent });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        fields: ['description', 'colorId', 'attendees']
      };

      const result = await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        fields: 'description,colorId,attendees'
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.event).toBeDefined();
      expect(response.event.id).toBe('event123');
      expect(response.event.description).toBe('Event description');
      expect(response.event.colorId).toBe('5');
    });

    it('should handle event not found', async () => {
      const notFoundError = new Error('Not found');
      (notFoundError as any).code = 404;
      mockCalendar.events.get.mockRejectedValue(notFoundError);

      const args = {
        calendarId: 'primary',
        eventId: 'nonexistent'
      };

      // Now throws an error instead of returning a message
      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        "Event with ID 'nonexistent' not found in calendar 'primary'."
      );
    });

    it('should handle API errors', async () => {
      const apiError = new Error('API Error');
      (apiError as any).code = 500;
      mockCalendar.events.get.mockRejectedValue(apiError);

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      // Mock handleGoogleApiError to throw a specific error
      vi.spyOn(handler as any, 'handleGoogleApiError').mockImplementation(() => {
        throw new Error('Handled API Error');
      });

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow('Handled API Error');
    });

    it('should handle null event response', async () => {
      mockCalendar.events.get.mockResolvedValue({ data: null });

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      // Now throws an error instead of returning a message
      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        "Event with ID 'event123' not found in calendar 'primary'."
      );
    });
  });

  describe('field mask integration', () => {
    it('should not include fields parameter when no fields requested', async () => {
      const mockEvent = {
        id: 'event123',
        summary: 'Test Event'
      };

      mockCalendar.events.get.mockResolvedValue({ data: mockEvent });

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123'
      });
    });

    it('should include fields parameter when fields are requested', async () => {
      const mockEvent = {
        id: 'event123',
        summary: 'Test Event',
        description: 'Test Description'
      };

      mockCalendar.events.get.mockResolvedValue({ data: mockEvent });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        fields: ['description']
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        fields: 'description'
      });
    });
  });
});
