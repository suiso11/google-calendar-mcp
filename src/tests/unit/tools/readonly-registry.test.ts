import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry } from '../../../tools/registry.js';
import { ListCalendarsHandler } from '../../../handlers/core/ListCalendarsHandler.js';
import { ListEventsHandler } from '../../../handlers/core/ListEventsHandler.js';
import { SearchEventsHandler } from '../../../handlers/core/SearchEventsHandler.js';
import { GetEventHandler } from '../../../handlers/core/GetEventHandler.js';

/**
 * Readonly tool surface tests.
 *
 * The readonly server exposes exactly four tools; every write,
 * auxiliary, or account-management name must be rejected.
 */
const READONLY_TOOLS = ['list-calendars', 'list-events', 'search-events', 'get-event'];
const REJECTED_TOOLS = [
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

describe('Readonly tool surface', () => {
  let mockServer: McpServer;
  let registeredTools: Array<{ name: string }>;

  beforeEach(() => {
    mockServer = new McpServer({ name: 'test', version: '1.0.0' });
    registeredTools = [];

    mockServer.registerTool = vi.fn((name: string, _definition: any, _handler: any) => {
      registeredTools.push({ name });
      return { name } as any;
    });
  });

  it('should expose exactly the four readonly tool names', () => {
    expect([...ToolRegistry.getAvailableToolNames()].sort()).toEqual([...READONLY_TOOLS].sort());
  });

  it('should return exactly the four readonly schemas', () => {
    const tools = ToolRegistry.getToolsWithSchemas();
    expect(tools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('should register exactly the four readonly tools by default', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));
    expect(registeredTools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());
  });

  it('should allow enabledTools to select a subset of the four', async () => {
    await ToolRegistry.registerAll(
      mockServer,
      async () => ({ content: [] }),
      { transport: { type: 'stdio' }, enabledTools: ['list-events', 'get-event'] }
    );
    expect(registeredTools.map(t => t.name).sort()).toEqual(['get-event', 'list-events']);
  });

  it('should reject every write/non-approved/manage tool name', () => {
    for (const name of REJECTED_TOOLS) {
      expect(() => ToolRegistry.validateToolNames([name])).toThrow(/Invalid tool name/);
    }
  });

  it('should reject write tools passed via enabledTools', async () => {
    await expect(
      ToolRegistry.registerAll(
        mockServer,
        async () => ({ content: [] }),
        { transport: { type: 'stdio' }, enabledTools: ['list-events', 'create-event'] }
      )
    ).rejects.toThrow(/Invalid tool name\(s\): create-event/);
  });

  it('should register only readonly handlers', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    // Assert via the registry's private runtime definitions that only the
    // four readonly handler classes are wired.
    const runtimeTools = (ToolRegistry as any).tools as Array<{ name: string; handler: new () => unknown }>;
    expect(runtimeTools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());
    for (const tool of runtimeTools) {
      expect([ListCalendarsHandler, ListEventsHandler, SearchEventsHandler, GetEventHandler]).toContain(tool.handler);
    }
  });

  it('should preserve fractional bounds through the actual registered SDK callback (inert provider)', async () => {
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    mockServer.registerTool = vi.fn((name: string, _definition: any, cb: any) => {
      callbacks.set(name, cb);
      registeredTools.push({ name });
      return { name } as any;
    });
    let seenArgs: any = null;
    await ToolRegistry.registerAll(mockServer, async (_handler: any, args: any) => {
      seenArgs = args;
      return { content: [] };
    });

    // list-events: schema.parse + handlerFunction path with fractional explicit bounds
    const listCb = callbacks.get('list-events')!;
    const timeMin = '2026-01-01T00:00:00.123456789+09:00';
    const timeMax = '2026-01-31T23:59:59.999999999Z';
    await listCb({ calendarId: 'primary', timeMin, timeMax });
    expect(seenArgs.timeMin).toBe(timeMin);
    expect(seenArgs.timeMax).toBe(timeMax);

    // search-events: schema.parse path with .1 fractional Z bounds
    const searchCb = callbacks.get('search-events')!;
    await searchCb({ calendarId: 'primary', timeMin: '2026-01-01T00:00:00.1Z', timeMax: '2026-01-31T23:59:59.1Z' });
    expect(seenArgs.timeMin).toBe('2026-01-01T00:00:00.1Z');
    expect(seenArgs.timeMax).toBe('2026-01-31T23:59:59.1Z');
  });
});
