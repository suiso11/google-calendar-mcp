import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../../../config/TransportConfig.js';
import { ToolRegistry } from '../../../tools/registry.js';

describe('Tool Filtering', () => {
  describe('parseArgs', () => {
    const originalEnv = process.env;
    const originalExit = process.exit;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
      process.exit = originalExit;
    });

    it('should parse --enable-tools from CLI arguments', () => {
      const config = parseArgs(['--enable-tools', 'list-events,search-events']);
      expect(config.enabledTools).toEqual(['list-events', 'search-events']);
    });

    it('should parse ENABLED_TOOLS from environment variable', () => {
      process.env.ENABLED_TOOLS = 'list-events,get-event,search-events';
      const config = parseArgs([]);
      expect(config.enabledTools).toEqual(['list-events', 'get-event', 'search-events']);
    });

    it('should trim whitespace from tool names', () => {
      const config = parseArgs(['--enable-tools', ' list-events , search-events ']);
      expect(config.enabledTools).toEqual(['list-events', 'search-events']);
    });

    it('should filter out empty strings', () => {
      const config = parseArgs(['--enable-tools', 'list-events,,search-events,']);
      expect(config.enabledTools).toEqual(['list-events', 'search-events']);
    });

    it('should return undefined when no tool filtering specified', () => {
      const config = parseArgs([]);
      expect(config.enabledTools).toBeUndefined();
    });

    it('should prefer CLI args over environment variables', () => {
      process.env.ENABLED_TOOLS = 'get-event';
      const config = parseArgs(['--enable-tools', 'list-events']);
      expect(config.enabledTools).toEqual(['list-events']);
    });

    it('should error when --enable-tools parses to an empty list', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

      expect(() => parseArgs(['--enable-tools', ', ,'])).toThrow(/process\.exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should error when ENABLED_TOOLS parses to an empty list', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

      process.env.ENABLED_TOOLS = ',,';
      expect(() => parseArgs([])).toThrow(/process\.exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('ToolRegistry.validateToolNames', () => {
    it('should not throw for valid readonly tool names', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['list-events', 'list-calendars', 'search-events', 'get-event']);
      }).not.toThrow();
    });

    it('should not throw for a subset of the readonly tools', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['list-events', 'get-event']);
      }).not.toThrow();
    });

    it('should reject manage-accounts', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['manage-accounts', 'list-events']);
      }).toThrow(/Invalid tool name\(s\): manage-accounts/);
    });

    it('should reject every write/non-approved tool', () => {
      const rejected = [
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
      for (const name of rejected) {
        expect(() => {
          ToolRegistry.validateToolNames([name]);
        }).toThrow(new RegExp(`Invalid tool name\\(s\\): ${name.replace('-', '\\-')}`));
      }
    });

    it('should throw for invalid tool names', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['list-events', 'invalid-tool']);
      }).toThrow(/Invalid tool name\(s\): invalid-tool/);
    });

    it('should include available tools in error message', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['nonexistent-tool']);
      }).toThrow(/Available tools:/);
    });

    it('should list multiple invalid tools', () => {
      expect(() => {
        ToolRegistry.validateToolNames(['foo', 'bar', 'list-events']);
      }).toThrow(/Invalid tool name\(s\): foo, bar/);
    });
  });

  describe('ToolRegistry.getAvailableToolNames', () => {
    it('should return exactly the readonly tool set by default', () => {
      const toolNames = ToolRegistry.getAvailableToolNames();

      expect([...toolNames].sort()).toEqual(
        ['get-event', 'list-calendars', 'list-events', 'search-events']
      );
    });

    it('should not expose write/manage/non-approved tools', () => {
      const toolNames = ToolRegistry.getAvailableToolNames();

      for (const name of [
        'create-event',
        'create-events',
        'update-event',
        'delete-event',
        'respond-to-event',
        'list-colors',
        'get-freebusy',
        'get-current-time',
        'manage-accounts',
      ]) {
        expect(toolNames).not.toContain(name);
      }
    });

    it('should return an array', () => {
      const toolNames = ToolRegistry.getAvailableToolNames();
      expect(Array.isArray(toolNames)).toBe(true);
    });
  });

});
