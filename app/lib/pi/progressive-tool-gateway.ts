import { type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

type GatewayAction = 'search' | 'describe' | 'call';

type GatewayParams = {
  action?: GatewayAction;
  query?: string;
  operation?: string;
  arguments?: Record<string, unknown>;
};

export type ProgressiveGatewayDefinition = {
  name: string;
  label: string;
  description: string;
  operations: readonly string[];
};

export type ProgressiveGatewayMetadata = {
  definition: ProgressiveGatewayDefinition;
  operations: readonly AgentTool[];
  withAllowedOperations: (allowedOperationNames: Iterable<string>) => ProgressiveGatewayTool;
};

export type ProgressiveGatewayTool = AgentTool & {
  progressiveGateway: ProgressiveGatewayMetadata;
};

const MAX_SEARCH_RESULTS = 12;
const MAX_OPERATION_DESCRIPTION_LENGTH = 280;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown gateway error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() || '';
}

function summarizeDescription(value: string | undefined): string {
  const description = value?.trim() || 'No description available.';
  return description.length > MAX_OPERATION_DESCRIPTION_LENGTH
    ? `${description.slice(0, MAX_OPERATION_DESCRIPTION_LENGTH - 3)}...`
    : description;
}

function formatSchemaErrors(schema: TSchema, value: unknown): string {
  const errors = Array.from(Value.Errors(schema, value)).slice(0, 3);
  if (errors.length === 0) return 'Arguments do not match the operation schema.';
  return errors
    .map((error) => `${'path' in error && typeof error.path === 'string' && error.path ? error.path : '/'}: ${error.message}`)
    .join('; ');
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function findOperation(operations: readonly AgentTool[], operationName: string | undefined): AgentTool | undefined {
  const requested = normalized(operationName);
  return operations.find((operation) => normalized(operation.name) === requested);
}

function searchOperations(operations: readonly AgentTool[], query: string | undefined): AgentTool[] {
  const terms = normalized(query).split(/[^a-z0-9_]+/u).filter(Boolean);
  if (terms.length === 0) return operations.slice(0, MAX_SEARCH_RESULTS);

  return operations
    .map((operation) => {
      const haystack = normalized(`${operation.name} ${operation.label || ''} ${operation.description || ''}`);
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { operation, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
    .slice(0, MAX_SEARCH_RESULTS)
    .map((entry) => entry.operation);
}

function buildGatewayTool(
  definition: ProgressiveGatewayDefinition,
  sourceOperations: readonly AgentTool[],
  allowedOperationNames: Iterable<string>,
): ProgressiveGatewayTool {
  const allowedNames = new Set(Array.from(allowedOperationNames, (name) => name.trim()));
  const operations = sourceOperations.filter((operation) => allowedNames.has(operation.name));

  const tool: ProgressiveGatewayTool = {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    executionMode: 'sequential',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('search'),
        Type.Literal('describe'),
        Type.Literal('call'),
      ], { description: 'Gateway action. Search first when the operation is unclear, describe to load one operation schema, then call with matching arguments.' }),
      query: Type.Optional(Type.String({ description: 'Natural-language query for search. Omit to list the operations available to this agent.' })),
      operation: Type.Optional(Type.String({ description: 'Exact operation name returned by search, required for describe and call.' })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Arguments for call. They must exactly match the schema returned by describe.' })),
    }),
    execute: async (toolCallId, rawParams, signal) => {
      const params = (rawParams || {}) as GatewayParams;
      try {
        if (params.action === 'search') {
          const matches = searchOperations(operations, params.query);
          const lines = matches.length === 0
            ? ['No permitted operations matched this query.']
            : [
                `Available ${definition.label} operations:`,
                ...matches.map((operation) => `- \`${operation.name}\`: ${summarizeDescription(operation.description)}`),
                '',
                'Next step: use describe with one exact operation name to load its input schema.',
              ];
          return textResult(lines.join('\n'), {
            gateway: definition.name,
            action: 'search',
            query: params.query || null,
            operations: matches.map((operation) => ({ name: operation.name, label: operation.label, description: summarizeDescription(operation.description) })),
          });
        }

        const operation = findOperation(operations, params.operation);
        if (!operation) {
          throw new Error('This operation is not available to the active agent. Use search to see permitted operations.');
        }

        if (params.action === 'describe') {
          return textResult(
            [
              `${operation.label || operation.name} (\`${operation.name}\`)`,
              operation.description || 'No description available.',
              '',
              'Input schema:',
              JSON.stringify(operation.parameters, null, 2),
              '',
              `Next step: call \`${definition.name}\` with operation \`${operation.name}\` and arguments matching this schema.`,
            ].join('\n'),
            {
              gateway: definition.name,
              action: 'describe',
              operation: operation.name,
              schema: operation.parameters,
            },
          );
        }

        if (params.action === 'call') {
          const args = params.arguments ?? {};
          if (!isRecord(args)) {
            throw new Error('call arguments must be a JSON object.');
          }
          if (!Value.Check(operation.parameters, args)) {
            throw new Error(`Invalid arguments for ${operation.name}: ${formatSchemaErrors(operation.parameters, args)}`);
          }
          const result = await operation.execute(toolCallId, args, signal);
          return {
            ...result,
            details: isRecord(result.details)
              ? {
                  ...result.details,
                  gateway: definition.name,
                  action: 'call',
                  operation: operation.name,
                }
              : {
                  gateway: definition.name,
                  action: 'call',
                  operation: operation.name,
                  result: result.details,
                },
          };
        }

        throw new Error('action must be search, describe, or call.');
      } catch (error) {
        const message = getErrorMessage(error);
        return textResult(`Error: ${message}`, {
          gateway: definition.name,
          action: params.action || null,
          operation: params.operation || null,
          error: message,
        });
      }
    },
    progressiveGateway: {
      definition,
      operations: sourceOperations,
      withAllowedOperations: (nextAllowedOperationNames) => buildGatewayTool(definition, sourceOperations, nextAllowedOperationNames),
    },
  };

  return tool;
}

export function createProgressiveGatewayTool(
  definition: ProgressiveGatewayDefinition,
  operations: readonly AgentTool[],
): ProgressiveGatewayTool {
  const knownOperationNames = new Set(operations.map((operation) => operation.name));
  const orderedOperations = definition.operations
    .map((operationName) => operations.find((operation) => operation.name === operationName))
    .filter((operation): operation is AgentTool => Boolean(operation));

  if (orderedOperations.length !== definition.operations.length || orderedOperations.some((operation) => !knownOperationNames.has(operation.name))) {
    throw new Error(`Gateway ${definition.name} was created with unknown operations.`);
  }

  return buildGatewayTool(definition, orderedOperations, definition.operations);
}

export function isProgressiveGatewayTool(tool: AgentTool): tool is ProgressiveGatewayTool {
  return 'progressiveGateway' in tool;
}

export function getProgressiveGatewayCapabilityNames(tools: Iterable<AgentTool>): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (isProgressiveGatewayTool(tool)) {
      names.push(...tool.progressiveGateway.operations.map((operation) => operation.name));
    } else {
      names.push(tool.name);
    }
  }
  return Array.from(new Set(names));
}

export function withAllowedProgressiveGatewayOperations(
  tool: AgentTool,
  allowedOperationNames: Iterable<string>,
): AgentTool | null {
  if (!isProgressiveGatewayTool(tool)) return tool;
  const allowed = new Set(allowedOperationNames);
  const permitted = tool.progressiveGateway.operations
    .map((operation) => operation.name)
    .filter((operationName) => allowed.has(operationName));
  return permitted.length > 0 ? tool.progressiveGateway.withAllowedOperations(permitted) : null;
}

export const PROGRESSIVE_GATEWAY_DEFINITIONS: readonly ProgressiveGatewayDefinition[] = [
  {
    name: 'agent_manage',
    label: 'Managing agents',
    description: 'On-demand gateway for creating and changing complete personal or organization agents. Use search, describe, then call. Mutations require explicit user intent and enforce the same scope, permission, policy, revision, storage, confirmation, and audit rules as the UI/API.',
    operations: [
      'create_agent',
      'update_agent_profile',
      'update_agent_runtime',
      'update_agent_capabilities',
      'update_agent_file',
      'set_agent_grant',
      'remove_agent_grant',
      'preview_agent_deletion',
      'delete_agent',
    ],
  },
  {
    name: 'canvas_extensions',
    label: 'Managing Canvas extensions',
    description: 'On-demand gateway for personal Canvas plugins and skills. Use search to discover permitted operations, describe to load exactly one input schema, then call to execute it. Plugin and skill permissions are enforced for every operation.',
    operations: [
      'create_canvas_plugin_draft',
      'inspect_canvas_plugin',
      'install_canvas_plugin_from_workspace',
      'update_canvas_plugin_from_workspace',
      'set_canvas_plugin_enabled',
      'remove_canvas_plugin',
      'create_canvas_skill_draft',
      'inspect_canvas_skill',
      'install_canvas_skill_from_workspace',
      'update_canvas_skill_from_workspace',
      'discard_canvas_skill_draft',
    ],
  },
  {
    name: 'studio',
    label: 'Using Studio',
    description: 'On-demand gateway for Studio library discovery, sound, and bulk generation. Image and video generation are dedicated direct tools so independent requests can run concurrently.',
    operations: [
      'studio_generate_sound',
      'studio_bulk_generate',
      'studio_list_products',
      'studio_list_personas',
      'studio_list_styles',
      'studio_list_presets',
    ],
  },
  {
    name: 'pdf',
    label: 'Working with PDFs',
    description: 'On-demand gateway for creating workspace PDFs from Markdown, converting PDFs to semantic Markdown, splitting PDFs, and editing PDF page order, deletion, or rotation. Use search, describe, then call so only the needed PDF schema is loaded into context.',
    operations: [
      'create_pdf',
      'pdf_to_markdown',
      'split_pdf',
      'edit_pdf_pages',
    ],
  },
  {
    name: 'automation_manage',
    label: 'Managing automations',
    description: 'On-demand gateway for creating, updating, deleting, and manually triggering automations. Use search, describe, then call. Read-only automation inspection remains available as dedicated planning-safe tools.',
    operations: [
      'create_automation_job',
      'update_automation_job',
      'delete_automation_job',
      'trigger_automation_job',
    ],
  },
  {
    name: 'composio',
    label: 'Using connected apps',
    description: 'On-demand gateway for Composio-connected external apps. Use search, describe, then call. Connection management and external-tool schemas are disclosed only when needed.',
    operations: [
      'COMPOSIO_SEARCH_TOOLS',
      'COMPOSIO_GET_TOOL_SCHEMAS',
      'composio_execute',
      'COMPOSIO_MANAGE_CONNECTIONS',
    ],
  },
] as const;

export function collapseProgressiveToolGroups(tools: readonly AgentTool[]): AgentTool[] {
  const operationsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const groupedOperationNames = new Set(PROGRESSIVE_GATEWAY_DEFINITIONS.flatMap((definition) => definition.operations));
  const emittedGateways = new Set<string>();
  const result: AgentTool[] = [];

  for (const tool of tools) {
    const definition = PROGRESSIVE_GATEWAY_DEFINITIONS.find((candidate) => candidate.operations.includes(tool.name));
    if (!definition) {
      result.push(tool);
      continue;
    }
    if (emittedGateways.has(definition.name)) continue;

    const operations = definition.operations
      .map((operationName) => operationsByName.get(operationName))
      .filter((operation): operation is AgentTool => Boolean(operation));
    if (operations.length !== definition.operations.length) {
      result.push(tool);
      continue;
    }

    emittedGateways.add(definition.name);
    result.push(createProgressiveGatewayTool(definition, operations));
  }

  return result.filter((tool) => !groupedOperationNames.has(tool.name));
}
