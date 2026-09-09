import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry, ToolSchemas } from '../../../tools/registry.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tool Registration Tests (readonly-mode)
 *
 * The runtime registry exposes exactly four readonly tools:
 * list-calendars, list-events, search-events, get-event.
 */

const READONLY_TOOLS = [
  'list-calendars',
  'list-events',
  'search-events',
  'get-event',
] as const;

const REMOVED_TOOLS = [
  'list-colors',
  'create-event',
  'create-events',
  'update-event',
  'delete-event',
  'get-freebusy',
  'get-current-time',
  'respond-to-event',
];

describe('Tool Registration', () => {
  let mockServer: McpServer;
  let registeredTools: Array<{
    name: string;
    title: string;
    description: string;
    annotations: Record<string, unknown>;
    inputSchema: any;
  }>;

  beforeEach(() => {
    mockServer = new McpServer({ name: 'test', version: '1.0.0' });
    registeredTools = [];

    // Mock the registerTool method to capture registered tools
    mockServer.registerTool = vi.fn((name: string, definition: any, _handler: any) => {
      registeredTools.push({
        name,
        title: definition.title,
        description: definition.description,
        annotations: definition.annotations,
        inputSchema: definition.inputSchema
      });
      // Return a mock RegisteredTool
      return { name, description: definition.description } as any;
    });
  });

  it('should register all tools successfully without errors', async () => {
    // This should not throw any errors
    await expect(
      ToolRegistry.registerAll(mockServer, async () => ({ content: [] }))
    ).resolves.not.toThrow();
  });

  it('should register exactly the four readonly tools', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    expect(registeredTools).toHaveLength(READONLY_TOOLS.length);
    expect(registeredTools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());
  });

  it('should register all expected tool names', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const expectedTools = Object.keys(ToolSchemas).filter((name): name is (typeof READONLY_TOOLS)[number] =>
      (READONLY_TOOLS as readonly string[]).includes(name)
    );
    expect(expectedTools.sort()).toEqual([...READONLY_TOOLS].sort());
    const registeredToolNames = registeredTools.map(t => t.name);

    for (const expectedTool of expectedTools) {
      expect(registeredToolNames).toContain(expectedTool);
    }
  });

  it('should not register write/manage tools', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const registeredToolNames = registeredTools.map(t => t.name);
    for (const removed of REMOVED_TOOLS) {
      expect(registeredToolNames).not.toContain(removed);
    }

    expect(ToolRegistry.getAvailableToolNames().sort()).toEqual([...READONLY_TOOLS].sort());
    expect(() => ToolRegistry.validateToolNames(['create-event'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['update-event'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['delete-event'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['respond-to-event'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['get-freebusy'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['list-colors'])).toThrow();
    expect(() => ToolRegistry.validateToolNames(['get-current-time'])).toThrow();
  });

  it('should register titles and annotations for all tools', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const expectedTitles: Record<string, string> = {
      'list-calendars': 'List Calendars',
      'list-events': 'List Calendar Events',
      'search-events': 'Search Calendar Events',
      'get-event': 'Get Event Details',
    };

    const expectedAnnotations: Record<string, Record<string, boolean>> = {
      'list-calendars': { readOnlyHint: true, openWorldHint: false },
      'list-events': { readOnlyHint: true, openWorldHint: false },
      'search-events': { readOnlyHint: true, openWorldHint: false },
      'get-event': { readOnlyHint: true, openWorldHint: false },
    };

    expect(registeredTools).toHaveLength(READONLY_TOOLS.length);
    for (const tool of registeredTools) {
      expect(tool.title).toBe(expectedTitles[tool.name]);
      expect(tool.title.trim().length).toBeGreaterThan(0);
      expect(tool.annotations).toEqual(expectedAnnotations[tool.name]);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it('should have valid input schemas for all tools', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    for (const tool of registeredTools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');

      // Every readonly tool schema shape must be non-empty
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it('should properly extract schema for list-events single calendarId', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const listEventsTool = registeredTools.find(t => t.name === 'list-events');
    expect(listEventsTool).toBeDefined();

    const schema = listEventsTool!.inputSchema;
    expect(schema).toBeDefined();

    // The key test: schema should not be empty for list-events
    expect(Object.keys(schema).length).toBeGreaterThan(0);

    // Check for key list-events specific properties in the Zod shape
    expect(schema).toHaveProperty('calendarId');
    expect(schema).toHaveProperty('timeMin');
    expect(schema).toHaveProperty('timeMax');
  });

  it('should compare list-events with search-events to ensure both have proper schemas', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const listEventsTool = registeredTools.find(t => t.name === 'list-events');
    const searchEventsTool = registeredTools.find(t => t.name === 'search-events');

    expect(listEventsTool).toBeDefined();
    expect(searchEventsTool).toBeDefined();

    // Both should have similar basic structure
    const listSchema = listEventsTool!.inputSchema;
    const searchSchema = searchEventsTool!.inputSchema;

    // Both should have non-empty schemas
    expect(Object.keys(listSchema).length).toBeGreaterThan(0);
    expect(Object.keys(searchSchema).length).toBeGreaterThan(0);

    // Both should have calendarId in their Zod shapes
    expect(listSchema).toHaveProperty('calendarId');
    expect(searchSchema).toHaveProperty('calendarId');

    // Search should have the query property that list does not require
    expect(searchSchema).toHaveProperty('query');

    // Both should carry time range fields
    expect(listSchema).toHaveProperty('timeMin');
    expect(searchSchema).toHaveProperty('timeMin');
  });

  it('should handle all complex schemas properly', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    // Tools with union/preprocessed shapes on the readonly surface
    const complexTools = ['search-events'];

    for (const toolName of complexTools) {
      const tool = registeredTools.find(t => t.name === toolName);
      expect(tool).toBeDefined();

      const schema = tool!.inputSchema;
      expect(schema).toBeDefined();

      // Should not be empty - this was the original bug class
      expect(Object.keys(schema).length).toBeGreaterThan(0);
    }
  });

  it('should validate that tools can be retrieved via getToolsWithSchemas()', () => {
    const tools = ToolRegistry.getToolsWithSchemas();

    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());

    for (const removed of REMOVED_TOOLS) {
      expect(tools.find(t => t.name === removed)).toBeUndefined();
    }

    // Check that list-events is present and has a valid schema
    const listEventsTool = tools.find(t => t.name === 'list-events');
    expect(listEventsTool).toBeDefined();
    expect(listEventsTool!.inputSchema).toBeDefined();

    // The inputSchema should be a valid JSON Schema object
    expect(typeof listEventsTool!.inputSchema).toBe('object');
    expect((listEventsTool!.inputSchema as any).type).toBe('object');
  });

  it('should ensure all datetime fields have proper validation', async () => {
    await ToolRegistry.registerAll(mockServer, async () => ({ content: [] }));

    const toolsWithDatetime = ['list-events', 'search-events'];

    for (const toolName of toolsWithDatetime) {
      const tool = registeredTools.find(t => t.name === toolName);
      expect(tool).toBeDefined();

      const schema = tool!.inputSchema;
      expect(Object.keys(schema).length).toBeGreaterThan(0);

      // Both readonly range tools carry time bounds
      expect(schema).toHaveProperty('timeMin');
      expect(schema).toHaveProperty('timeMax');
    }
  });

  it('should catch schema extraction issues early', async () => {
    // Test the schema extraction method directly
    const listEventsSchema = ToolSchemas['list-events'];
    expect(listEventsSchema).toBeDefined();

    // This should not throw an error
    const extractedShape = (ToolRegistry as any).extractSchemaShape(listEventsSchema);
    expect(extractedShape).toBeDefined();
    expect(typeof extractedShape).toBe('object');

    // Should have the expected properties
    expect(extractedShape).toHaveProperty('calendarId');
    expect(extractedShape).toHaveProperty('timeMin');
    expect(extractedShape).toHaveProperty('timeMax');
  });
});

/**
 * Schema Extraction Edge Cases
 *
 * Tests to ensure the extractSchemaShape method handles various Zod schema types
 */
describe('Schema Extraction Edge Cases', () => {
  it('should handle regular ZodObject schemas', () => {
    const simpleSchema = ToolSchemas['list-calendars'];
    const extractedShape = (ToolRegistry as any).extractSchemaShape(simpleSchema);
    expect(extractedShape).toBeDefined();
  });

  it('should handle union schemas', () => {
    const unionSchema = ToolSchemas['search-events'];
    const extractedShape = (ToolRegistry as any).extractSchemaShape(unionSchema);
    expect(extractedShape).toBeDefined();
    expect(typeof extractedShape).toBe('object');
  });

  it('should handle nested schema structures', () => {
    const complexSchema = ToolSchemas['search-events'];
    const extractedShape = (ToolRegistry as any).extractSchemaShape(complexSchema);
    expect(extractedShape).toBeDefined();
    expect(typeof extractedShape).toBe('object');
  });
});
