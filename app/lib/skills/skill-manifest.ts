/**
 * Skill Manifest Schema and Validation
 * 
 * Defines the structure for Canvas Notebook skill manifests.
 * Each skill is defined by a manifest.json file in /data/skills/<skill-name>/
 */

import { Type, Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// Parameter schema for tool parameters
export const ParameterSchema = Type.Object({
  type: Type.String({
    enum: ['string', 'number', 'integer', 'boolean', 'array', 'object'],
    description: 'Parameter data type'
  }),
  description: Type.String({
    description: 'Human-readable description of the parameter'
  }),
  required: Type.Optional(Type.Boolean({
    default: false,
    description: 'Whether the parameter is required'
  })),
  default: Type.Optional(Type.Any({
    description: 'Default value for the parameter'
  })),
  enum: Type.Optional(Type.Array(Type.String(), {
    description: 'Allowed values for string parameters'
  })),
  minimum: Type.Optional(Type.Number({
    description: 'Minimum value for number parameters'
  })),
  maximum: Type.Optional(Type.Number({
    description: 'Maximum value for number parameters'
  })),
  minLength: Type.Optional(Type.Number({
    description: 'Minimum length for string parameters'
  })),
  maxLength: Type.Optional(Type.Number({
    description: 'Maximum length for string parameters'
  })),
  items: Type.Optional(Type.Any({
    description: 'Schema for array items'
  })),
});

export type ParameterDefinition = Static<typeof ParameterSchema>;

// Tool definition within a skill
export const ToolSchema = Type.Object({
  name: Type.String({
    pattern: '^[a-z_][a-z0-9_]*$',
    description: 'Tool identifier (snake_case)'
  }),
  description: Type.String({
    description: 'Tool description shown to the AI agent'
  }),
  parameters: Type.Record(
    Type.String(),
    ParameterSchema,
    {
      description: 'Parameter definitions for the tool'
    }
  ),
});

export type ToolDefinition = Static<typeof ToolSchema>;

// Handler configuration
export const HandlerSchema = Type.Object({
  type: Type.String({
    enum: ['cli', 'api'],
    description: 'Type of handler'
  }),
  command: Type.Optional(Type.String({
    description: 'CLI command template (for type: cli)'
  })),
  endpoint: Type.Optional(Type.String({
    description: 'API endpoint (for type: api)'
  })),
});

export type HandlerDefinition = Static<typeof HandlerSchema>;

// Main skill manifest schema
export const SkillManifestSchema = Type.Object({
  name: Type.String({
    pattern: '^[a-z][a-z0-9-]*$',
    description: 'Skill name (kebab-case)'
  }),
  version: Type.String({
    pattern: '^\\d+\\.\\d+\\.\\d+$',
    description: 'Semantic version (e.g., 1.0.0)'
  }),
  title: Type.String({
    minLength: 1,
    maxLength: 100,
    description: 'Human-readable title'
  }),
  description: Type.String({
    minLength: 10,
    maxLength: 2000,
    description: 'Skill description with trigger phrases'
  }),
  type: Type.String({
    enum: ['cli', 'api'],
    description: 'Skill type'
  }),
  author: Type.Optional(Type.String({
    description: 'Skill author'
  })),
  created_at: Type.String({
    description: 'Creation timestamp (ISO 8601)'
  }),
  updated_at: Type.Optional(Type.String({
    description: 'Last update timestamp (ISO 8601)'
  })),
  tool: ToolSchema,
  handler: HandlerSchema,
});

export type SkillManifest = Static<typeof SkillManifestSchema>;

// Validation result
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a skill manifest against the schema
 */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  
  try {
    // Check if manifest is an object
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['Manifest must be a JSON object'] };
    }
    
    // Validate against schema
    const result = Value.Check(SkillManifestSchema, manifest);
    
    if (!result) {
      // Get detailed validation errors
      const iterator = Value.Errors(SkillManifestSchema, manifest);
      for (const error of iterator) {
        errors.push(`${error.path}: ${error.message}`);
      }
    }
    
    // Additional custom validations
    const m = manifest as Record<string, unknown>;
    
    // Check name format (kebab-case)
    if (m.name && typeof m.name === 'string') {
      if (!/^[a-z][a-z0-9-]*$/.test(m.name)) {
        errors.push('name: Must be kebab-case (lowercase letters, numbers, hyphens)');
      }
      if (m.name.startsWith('-') || m.name.endsWith('-')) {
        errors.push('name: Cannot start or end with hyphen');
      }
      if (m.name.includes('--')) {
        errors.push('name: Cannot contain consecutive hyphens');
      }
    }
    
    // Check tool.name format (snake_case)
    if (m.tool && typeof m.tool === 'object' && (m.tool as Record<string, unknown>).name) {
      const toolName = (m.tool as Record<string, unknown>).name as string;
      if (!/^[a-z_][a-z0-9_]*$/.test(toolName)) {
        errors.push('tool.name: Must be snake_case (lowercase letters, numbers, underscores)');
      }
    }
    
    // Check handler configuration matches type
    if (m.handler && typeof m.handler === 'object') {
      const handler = m.handler as Record<string, unknown>;
      if (m.type === 'cli' && !handler.command) {
        errors.push('handler.command: Required for CLI skills');
      }
      if (m.type === 'api' && !handler.endpoint) {
        errors.push('handler.endpoint: Required for API skills');
      }
    }
    
    return { valid: errors.length === 0, errors };
    
  } catch (error) {
    errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { valid: false, errors };
  }
}

/**
 * Create a default manifest for a new skill
 */
export function createDefaultManifest(
  name: string,
  title: string,
  description: string,
  type: 'cli' | 'api',
  author?: string
): SkillManifest {
  const now = new Date().toISOString();
  
  return {
    name,
    version: '1.0.0',
    title,
    description,
    type,
    author,
    created_at: now,
    tool: {
      name: name.replace(/-/g, '_'),
      description: title,
      parameters: {}
    },
    handler: {
      type,
      ...(type === 'cli' ? { command: `/data/skills/${name}/run` } : { endpoint: `/api/skills/${name}` })
    }
  };
}

/**
 * Convert manifest parameters to TypeBox schema
 */
export function manifestParamsToTypeBox(parameters: Record<string, ParameterDefinition>): Record<string, TSchema> {
  const result: Record<string, TSchema> = {};
  
  for (const [key, param] of Object.entries(parameters)) {
    let typeboxType: TSchema;
    
    switch (param.type) {
      case 'string':
        if (param.enum) {
          typeboxType = Type.String({ enum: param.enum });
        } else {
          typeboxType = Type.String({
            minLength: param.minLength,
            maxLength: param.maxLength
          });
        }
        break;
      case 'number':
        typeboxType = Type.Number({
          minimum: param.minimum,
          maximum: param.maximum
        });
        break;
      case 'integer':
        typeboxType = Type.Integer({
          minimum: param.minimum,
          maximum: param.maximum
        });
        break;
      case 'boolean':
        typeboxType = Type.Boolean();
        break;
      case 'array':
        // For array items, we use Type.Any() as a safe default since items can be any schema
        typeboxType = Type.Array(Type.Any());
        break;
      case 'object':
        typeboxType = Type.Record(Type.String(), Type.Any());
        break;
      default:
        typeboxType = Type.Any();
    }
    
    // Add description using Type.Unsafe
    if (param.description) {
      typeboxType = Type.Unsafe({ ...typeboxType as object, description: param.description });
    }
    
    // Make optional if not required
    if (!param.required) {
      typeboxType = Type.Optional(typeboxType);
    }
    
    result[key] = typeboxType;
  }
  
  return result;
}
