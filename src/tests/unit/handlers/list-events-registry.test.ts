/**
 * Tests for list-events single-calendar paginated registration flow.
 * Schema validation → handlerFunction → handler execution uses exactly
 * one calendarId string plus optional pageSize/pageToken.
 */

import { describe, it, expect } from 'vitest';
import { ToolSchemas, ToolRegistry } from '../../../tools/registry.js';

// Get the handlerFunction for testing the full flow
const toolDefinition = (ToolRegistry as any).tools?.find((t: any) => t.name === 'list-events');
const handlerFunction = toolDefinition?.handlerFunction;

describe('list-events Registration Flow (Schema + HandlerFunction)', () => {
  describe('Single calendarId schema validation', () => {
    it('should validate single string calendarId', () => {
      const input = {
        calendarId: 'primary',
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      };

      const result = ToolSchemas['list-events'].safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data?.calendarId).toBe('primary');
    });

    it('should reject native array calendarId', () => {
      const input = {
        calendarId: ['primary', 'work@example.com'],
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      };

      const result = ToolSchemas['list-events'].safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject empty string calendarId', () => {
      const input = {
        calendarId: '',
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      };

      const result = ToolSchemas['list-events'].safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('Pagination schema validation', () => {
    it('should accept pageSize within 1..20', () => {
      const result = ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageSize: 10
      });
      expect(result.success).toBe(true);
      expect(result.data?.pageSize).toBe(10);
    });

    it('should reject pageSize 0', () => {
      expect(ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageSize: 0
      }).success).toBe(false);
    });

    it('should reject pageSize 21', () => {
      expect(ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageSize: 21
      }).success).toBe(false);
    });

    it('should reject non-integer pageSize', () => {
      expect(ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageSize: 2.5
      }).success).toBe(false);
    });

    it('should accept opaque pageToken up to 2048 chars', () => {
      const token = 'a'.repeat(2048);
      const result = ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageToken: token
      });
      expect(result.success).toBe(true);
      expect(result.data?.pageToken).toBe(token);
    });

    it('should accept empty pageToken (verbatim passthrough)', () => {
      const result = ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageToken: ''
      });
      expect(result.success).toBe(true);
      expect(result.data?.pageToken).toBe('');
    });

    it('should reject pageToken over 2048 chars', () => {
      expect(ToolSchemas['list-events'].safeParse({
        calendarId: 'primary',
        pageToken: 'a'.repeat(2049)
      }).success).toBe(false);
    });
  });

  // HandlerFunction tests - second step after schema validation
  if (!handlerFunction) {
    console.warn('⚠️  handlerFunction not found - skipping handler tests');
  } else {
    describe('HandlerFunction preprocessing (second step)', () => {
      it('should pass through single calendar string with pagination', async () => {
        const input = {
          calendarId: 'primary',
          timeMin: '2024-01-01T00:00:00',
          timeMax: '2024-01-02T00:00:00',
          pageSize: 5,
          pageToken: 'opaque-123'
        };

        const result = await handlerFunction(input);
        expect(result.calendarId).toBe('primary');
        expect(result.pageSize).toBe(5);
        expect(result.pageToken).toBe('opaque-123');
      });

      it('should pass through empty pageToken verbatim', async () => {
        const result = await handlerFunction({
          calendarId: 'primary',
          pageToken: ''
        });
        expect(result.pageToken).toBe('');
      });

      it('should preserve single account parameter', async () => {
        const result = await handlerFunction({
          account: 'work',
          calendarId: 'primary',
          timeMin: '2024-01-01T00:00:00',
          timeMax: '2024-01-02T00:00:00'
        });
        expect(result.account).toBe('work');
      });

      it('should preserve undefined account when not provided', async () => {
        const result = await handlerFunction({
          calendarId: 'primary',
          timeMin: '2024-01-01T00:00:00',
          timeMax: '2024-01-02T00:00:00'
        });
        expect(result.account).toBeUndefined();
      });
    });
  }
});
