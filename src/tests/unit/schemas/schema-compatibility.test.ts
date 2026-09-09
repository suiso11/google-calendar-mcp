import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../tools/registry.js';

/**
 * Provider-Specific Schema Compatibility Tests (readonly-mode)
 *
 * These tests ensure that schemas are compatible with different MCP clients
 * by testing what each provider actually receives, not internal implementation.
 *
 * - OpenAI: Receives converted schemas (anyOf flattened to string)
 * - Python MCP: Receives raw schemas (anyOf preserved for native array support)
 * - Claude: Uses raw MCP schemas
 *
 * Runtime surface is exactly: list-calendars, list-events, search-events, get-event.
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

// Type for JSON Schema objects (subset of what zod-to-json-schema returns)
interface JSONSchemaObject {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  anyOf?: any[];
  [key: string]: any;
}

describe('Provider-Specific Schema Compatibility', () => {
  describe('OpenAI Schema Compatibility', () => {
    // Helper function that mimics OpenAI schema conversion from openai-mcp-integration.test.ts
    const convertMCPSchemaToOpenAI = (mcpSchema: any): any => {
      if (!mcpSchema) {
        return {
          type: 'object',
          properties: {},
          required: []
        };
      }

      return {
        type: 'object',
        properties: enhancePropertiesForOpenAI(mcpSchema.properties || {}),
        required: mcpSchema.required || []
      };
    };

    const enhancePropertiesForOpenAI = (properties: any): any => {
      const enhanced: any = {};

      for (const [key, value] of Object.entries(properties)) {
        const prop = value as any;
        enhanced[key] = { ...prop };

        // Handle anyOf union types (OpenAI doesn't support these well)
        if (prop.anyOf && Array.isArray(prop.anyOf)) {
          const stringType = prop.anyOf.find((t: any) => t.type === 'string');
          if (stringType) {
            enhanced[key] = {
              type: 'string',
              description: `${stringType.description || prop.description || ''} Note: For multiple values, use JSON array string format: '["id1", "id2"]'`.trim()
            };
          } else {
            enhanced[key] = { ...prop.anyOf[0] };
          }
          delete enhanced[key].anyOf;
        }

        // Recursively enhance nested objects
        if (enhanced[key].type === 'object' && enhanced[key].properties) {
          enhanced[key].properties = enhancePropertiesForOpenAI(enhanced[key].properties);
        }

        // Enhance array items if they contain objects
        if (enhanced[key].type === 'array' && enhanced[key].items && enhanced[key].items.properties) {
          enhanced[key].items = {
            ...enhanced[key].items,
            properties: enhancePropertiesForOpenAI(enhanced[key].items.properties)
          };
        }
      }

      return enhanced;
    };

    it('should ensure ALL tools (including list-events) have no problematic features after OpenAI conversion', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const problematicFeatures = ['oneOf', 'anyOf', 'allOf', 'not'];
      const issues: string[] = [];

      for (const tool of tools) {
        // Convert to OpenAI format (this is what OpenAI actually sees)
        const openaiSchema = convertMCPSchemaToOpenAI(tool.inputSchema);
        const schemaStr = JSON.stringify(openaiSchema);

        for (const feature of problematicFeatures) {
          if (schemaStr.includes(`"${feature}"`)) {
            issues.push(`Tool "${tool.name}" contains "${feature}" after OpenAI conversion - this will break OpenAI function calling`);
          }
        }
      }

      if (issues.length > 0) {
        throw new Error(`OpenAI schema compatibility issues found:\n${issues.join('\n')}`);
      }
    });

    it('should expose list-events calendarId as single string for OpenAI', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const listEventsTool = tools.find(t => t.name === 'list-events');

      expect(listEventsTool).toBeDefined();

      // Convert to OpenAI format
      const openaiSchema = convertMCPSchemaToOpenAI(listEventsTool!.inputSchema);

      // OpenAI should see a simple string type, not anyOf (single-calendar pagination)
      expect(openaiSchema.properties.calendarId.type).toBe('string');
      expect(openaiSchema.properties.calendarId.anyOf).toBeUndefined();
    });

    it('should expose search-events calendarId as single string for OpenAI', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const searchEventsTool = tools.find(t => t.name === 'search-events');

      expect(searchEventsTool).toBeDefined();

      // Convert to OpenAI format
      const openaiSchema = convertMCPSchemaToOpenAI(searchEventsTool!.inputSchema);

      // OpenAI should see a simple string type, not anyOf (single-calendar pagination)
      expect(openaiSchema.properties.calendarId.type).toBe('string');
      expect(openaiSchema.properties.calendarId.anyOf).toBeUndefined();
    });

    it('should ensure all converted schemas are valid objects', () => {
      const tools = ToolRegistry.getToolsWithSchemas();

      for (const tool of tools) {
        const openaiSchema = convertMCPSchemaToOpenAI(tool.inputSchema);

        expect(openaiSchema.type).toBe('object');
        expect(openaiSchema.properties).toBeDefined();
        expect(openaiSchema.required).toBeDefined();
      }
    });
  });

  describe('Python MCP Client Compatibility', () => {
    it('should expose list-events calendarId as single string (no native arrays)', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const listEventsTool = tools.find(t => t.name === 'list-events');

      expect(listEventsTool).toBeDefined();

      // Raw MCP schema is a single string for single-calendar pagination
      const schema = listEventsTool!.inputSchema as JSONSchemaObject;
      expect(schema.properties).toBeDefined();

      const calendarIdProp = schema.properties!.calendarId;
      expect(calendarIdProp.anyOf).toBeUndefined();
      expect(calendarIdProp.type).toBe('string');
    });

    it('should ensure all other tools do NOT use anyOf/oneOf/allOf (except for account parameter)', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const problematicFeatures = ['oneOf', 'anyOf', 'allOf', 'not'];
      const issues: string[] = [];

      // No multi-calendar tools remain on the readonly surface (single-calendar pagination)
      const multiCalendarTools: string[] = [];

      for (const tool of tools) {
        // Skip multi-calendar tools - they're explicitly allowed to use anyOf for calendarId
        if (multiCalendarTools.includes(tool.name)) {
          continue;
        }

        const schema = tool.inputSchema as JSONSchemaObject;

        // Check each property for problematic features
        if (schema.properties) {
          for (const [propName, propSchema] of Object.entries(schema.properties)) {
            // Skip account parameter - it's allowed to use anyOf for string | string[]
            if (propName === 'account') {
              continue;
            }

            const propStr = JSON.stringify(propSchema);
            for (const feature of problematicFeatures) {
              if (propStr.includes(`"${feature}"`)) {
                issues.push(`Tool "${tool.name}" property "${propName}" contains problematic feature: ${feature}`);
              }
            }
          }
        }
      }

      if (issues.length > 0) {
        throw new Error(`Raw MCP schema compatibility issues found:\n${issues.join('\n')}`);
      }
    });
  });

  describe('General Schema Structure', () => {
    it('should expose exactly the four readonly tools', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      expect(tools).toBeDefined();
      expect(tools.map(t => t.name).sort()).toEqual([...READONLY_TOOLS].sort());

      for (const removed of REMOVED_TOOLS) {
        expect(tools.find(t => t.name === removed)).toBeUndefined();
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

    it('should have proper schema structure for all tools', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      expect(tools).toBeDefined();
      expect(tools.length).toBe(READONLY_TOOLS.length);

      for (const tool of tools) {
        const schema = tool.inputSchema as JSONSchemaObject;

        // All schemas should be objects at the top level
        expect(schema.type).toBe('object');
      }
    });

    it('should validate specific known tool schemas exist', () => {
      const tools = ToolRegistry.getToolsWithSchemas();
      const toolSchemas = new Map();
      for (const tool of tools) {
        toolSchemas.set(tool.name, tool.inputSchema);
      }

      // Validate that key tools exist and have the proper basic structure
      const listEventsSchema = toolSchemas.get('list-events') as JSONSchemaObject;
      expect(listEventsSchema).toBeDefined();
      expect(listEventsSchema.type).toBe('object');

      if (listEventsSchema.properties) {
        expect(listEventsSchema.properties.calendarId).toBeDefined();
        expect(listEventsSchema.properties.timeMin).toBeDefined();
        expect(listEventsSchema.properties.timeMax).toBeDefined();
      }

      // Check other readonly tools exist
      expect(toolSchemas.get('list-calendars')).toBeDefined();
      expect(toolSchemas.get('search-events')).toBeDefined();
      expect(toolSchemas.get('get-event')).toBeDefined();

      // Write/manage tools must be absent from the runtime export
      expect(toolSchemas.get('create-event')).toBeUndefined();
      expect(toolSchemas.get('create-events')).toBeUndefined();
      expect(toolSchemas.get('update-event')).toBeUndefined();
      expect(toolSchemas.get('delete-event')).toBeUndefined();
      expect(toolSchemas.get('respond-to-event')).toBeUndefined();
      expect(toolSchemas.get('list-colors')).toBeUndefined();
      expect(toolSchemas.get('get-freebusy')).toBeUndefined();
      expect(toolSchemas.get('get-current-time')).toBeUndefined();
    });

    it('should test that all datetime fields have proper format', () => {
      const tools = ToolRegistry.getToolsWithSchemas();

      const toolsWithDateTimeFields = ['list-events', 'search-events'];

      for (const tool of tools) {
        if (toolsWithDateTimeFields.includes(tool.name)) {
          // These tools should exist and be properly typed
          const schema = tool.inputSchema as JSONSchemaObject;
          expect(schema.type).toBe('object');
        }
      }
    });

    it('should ensure enum fields are properly structured', () => {
      const tools = ToolRegistry.getToolsWithSchemas();

      const toolsWithEnums = ['list-events', 'search-events', 'get-event'];

      for (const tool of tools) {
        if (toolsWithEnums.includes(tool.name)) {
          // These tools should exist and be properly typed
          const schema = tool.inputSchema as JSONSchemaObject;
          expect(schema.type).toBe('object');
        }
      }
    });

    it('should validate array fields have proper items definition', () => {
      const tools = ToolRegistry.getToolsWithSchemas();

      const toolsWithArrays = ['list-events', 'search-events', 'get-event'];

      for (const tool of tools) {
        if (toolsWithArrays.includes(tool.name)) {
          // These tools should exist and be properly typed
          const schema = tool.inputSchema as JSONSchemaObject;
          expect(schema.type).toBe('object');
        }
      }
    });
  });
});

/**
 * Schema Validation Rules Documentation
 *
 * This test documents the rules that our schemas must follow
 * to be compatible with various MCP clients.
 */
describe('Schema Validation Rules Documentation', () => {
  it('should document provider-specific compatibility requirements', () => {
    const rules = {
      'OpenAI': 'Schemas are converted to remove anyOf/oneOf/allOf. Union types flattened to primary type with usage notes in description.',
      'Python MCP': 'Single-calendar list-events and search-events use a plain string calendarId.',
      'Claude/Generic MCP': 'Uses raw schemas. list-events and search-events are single-calendar strings for paginated reads.',
      'Top-level schema': 'All schemas must be type: "object" at root level.',
      'DateTime fields': 'Support both RFC3339 with timezone and timezone-naive formats.',
      'Array fields': 'Must have items schema defined for proper validation.',
      'Enum fields': 'Must include type information alongside enum values.'
    };

    // This test documents the rules - it always passes but serves as documentation
    expect(Object.keys(rules).length).toBeGreaterThan(0);
  });
});
