/**
 * Tests for search-events single-calendar paginated schema.
 * Schema validation uses exactly one calendarId string, optional query,
 * required timeMin/timeMax, plus optional pageSize/pageToken.
 */

import { describe, it, expect } from 'vitest';
import { ToolSchemas } from '../../../tools/registry.js';

describe('search-events Registration Flow (Schema)', () => {
  describe('Single calendarId schema validation', () => {
    it('should validate single string calendarId', () => {
      const result = ToolSchemas['search-events'].safeParse({
        calendarId: 'primary',
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      });
      expect(result.success).toBe(true);
      expect(result.data?.calendarId).toBe('primary');
    });

    it('should reject native array calendarId', () => {
      const result = ToolSchemas['search-events'].safeParse({
        calendarId: ['primary', 'work@example.com'],
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty string calendarId', () => {
      const result = ToolSchemas['search-events'].safeParse({
        calendarId: '',
        timeMin: '2024-01-01T00:00:00',
        timeMax: '2024-01-02T00:00:00'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Optional query validation', () => {
    const base = {
      calendarId: 'primary',
      timeMin: '2024-01-01T00:00:00',
      timeMax: '2024-01-02T00:00:00'
    };

    it('should accept absent query', () => {
      const result = ToolSchemas['search-events'].safeParse(base);
      expect(result.success).toBe(true);
      expect(result.data?.query).toBeUndefined();
    });

    it('should accept non-empty query', () => {
      const result = ToolSchemas['search-events'].safeParse({ ...base, query: 'Team' });
      expect(result.success).toBe(true);
      expect(result.data?.query).toBe('Team');
    });

    it('should reject empty query', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, query: '' }).success).toBe(false);
    });

    it('should reject array query', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, query: ['a', 'b'] } as any).success).toBe(false);
    });
  });

  describe('Pagination schema validation', () => {
    const base = {
      calendarId: 'primary',
      timeMin: '2024-01-01T00:00:00',
      timeMax: '2024-01-02T00:00:00'
    };

    it('should accept pageSize within 1..20', () => {
      const result = ToolSchemas['search-events'].safeParse({ ...base, pageSize: 10 });
      expect(result.success).toBe(true);
      expect(result.data?.pageSize).toBe(10);
    });

    it('should reject pageSize 0', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, pageSize: 0 }).success).toBe(false);
    });

    it('should reject pageSize 21', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, pageSize: 21 }).success).toBe(false);
    });

    it('should reject non-integer pageSize', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, pageSize: 2.5 }).success).toBe(false);
    });

    it('should accept opaque pageToken up to 2048 chars', () => {
      const token = 'a'.repeat(2048);
      const result = ToolSchemas['search-events'].safeParse({ ...base, pageToken: token });
      expect(result.success).toBe(true);
      expect(result.data?.pageToken).toBe(token);
    });

    it('should accept empty pageToken (verbatim passthrough)', () => {
      const result = ToolSchemas['search-events'].safeParse({ ...base, pageToken: '' });
      expect(result.success).toBe(true);
      expect(result.data?.pageToken).toBe('');
    });

    it('should reject pageToken over 2048 chars', () => {
      expect(ToolSchemas['search-events'].safeParse({ ...base, pageToken: 'a'.repeat(2049) }).success).toBe(false);
    });
  });
});
