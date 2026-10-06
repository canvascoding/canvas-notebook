import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const INTEGRATION_CONTRACT_VERSION = 1 as const;
export const INTEGRATION_MAX_PAGE_SIZE = 50;

export type IntegrationSource = 'mcp' | 'composio';
export type IntegrationProviderState = 'ready' | 'setup_required' | 'auth_required' | 'disabled' | 'degraded' | 'unknown';
export type IntegrationOperation = 'list_providers' | 'search_providers' | 'list_tools' | 'search_tools' | 'describe' | 'call';

/** Trusted server context, never populated from model-supplied arguments. */
export type IntegrationExecutionContext = {
  actorUserId: string;
  organizationId?: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
  /** Set only from a verified persisted runtime session, never from model arguments. */
  sessionId?: string | null;
  policyRevision: string;
};

export type IntegrationProviderScope =
  | { type: 'user'; resourceId: string; ownerUserId: string }
  | { type: 'organization'; resourceId: string; organizationId: string }
  | { type: 'workspace'; resourceId: string; organizationId: string; workspaceId: string };

/** null is unrestricted, [] denies all. Independent restrictions always intersect. */
export type IntegrationPolicy = {
  allowedSources: readonly IntegrationSource[] | null;
  allowedProviderRefs: readonly string[] | null;
  allowedApplications: readonly string[] | null;
  allowedToolNames: readonly string[] | null;
  allowedOperations: readonly string[] | null;
};

const sourceSchema = Type.Union([Type.Literal('mcp'), Type.Literal('composio')]);
const stateSchema = Type.Union([
  Type.Literal('ready'), Type.Literal('setup_required'), Type.Literal('auth_required'),
  Type.Literal('disabled'), Type.Literal('degraded'), Type.Literal('unknown'),
]);
const referenceSchema = Type.String({ minLength: 1, maxLength: 256 });
const paginationProperties = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: INTEGRATION_MAX_PAGE_SIZE })),
};
const providerFilterProperties = {
  source: Type.Optional(sourceSchema),
  state: Type.Optional(stateSchema),
  application: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  pluginRef: Type.Optional(referenceSchema),
  capabilityRef: Type.Optional(referenceSchema),
};
const requestVersion = { version: Type.Optional(Type.Literal(INTEGRATION_CONTRACT_VERSION)) };

/** Each action has its own required arguments; unsupported fields are rejected. */
export const IntegrationRequestSchema = Type.Union([
  Type.Object({
    ...requestVersion, action: Type.Literal('list'), target: Type.Literal('providers'),
    ...providerFilterProperties, ...paginationProperties,
  }, { additionalProperties: false }),
  Type.Object({
    ...requestVersion, action: Type.Literal('search'), target: Type.Literal('providers'),
    query: Type.String({ minLength: 1, maxLength: 512 }),
    ...providerFilterProperties, ...paginationProperties,
  }, { additionalProperties: false }),
  Type.Object({
    ...requestVersion, action: Type.Literal('list'), target: Type.Literal('tools'),
    providerRef: referenceSchema, ...paginationProperties,
  }, { additionalProperties: false }),
  Type.Object({
    ...requestVersion, action: Type.Literal('search'), target: Type.Literal('tools'),
    providerRef: referenceSchema, query: Type.String({ minLength: 1, maxLength: 512 }),
    ...paginationProperties,
  }, { additionalProperties: false }),
  Type.Object({ ...requestVersion, action: Type.Literal('describe'), toolRef: referenceSchema }, { additionalProperties: false }),
  Type.Object({
    ...requestVersion, action: Type.Literal('call'), toolRef: referenceSchema, schemaRef: referenceSchema,
    arguments: Type.Record(Type.String(), Type.Unknown()),
  }, { additionalProperties: false }),
]);

export type IntegrationRequest = Static<typeof IntegrationRequestSchema>;
export type IntegrationProviderRequest = Extract<IntegrationRequest, { target: 'providers' }>;
export type IntegrationToolRequest = Extract<IntegrationRequest, { target: 'tools' }>;
export type IntegrationNextAction =
  | { kind: 'gateway'; request: IntegrationRequest; label: string }
  | {
    kind: 'input_required';
    label: string;
    request: { action: 'call'; toolRef: string; schemaRef: string };
    requiredArguments: readonly string[];
  }
  | { kind: 'setup'; href: string; label: string };

export type IntegrationProviderDescriptor = {
  providerRef: string;
  source: IntegrationSource;
  /** Only supplied by verified catalogue or connector metadata; never inferred from a label. */
  application?: string;
  aliases?: readonly string[];
  displayName: string;
  description?: string;
  scope: IntegrationProviderScope;
  connection?: { displayName: string; effective: boolean };
  state: IntegrationProviderState;
  configured: boolean;
  requiresAuth: boolean | 'unknown';
  authorized: boolean | 'unknown';
  health: 'healthy' | 'unhealthy' | 'unknown';
  canExecute: boolean;
  checkedAt: string | null;
  statusSource: 'configuration' | 'live' | 'cache' | 'provider';
  pluginRefs: readonly string[];
  skillRefs: readonly string[];
  capabilityRefs?: readonly string[];
  matchReasons: readonly string[];
  nextActions: readonly IntegrationNextAction[];
};

export type IntegrationProviderError = {
  source: IntegrationSource;
  providerRef?: string;
  code: string;
  /** Safe product message, without credentials, raw provider response or foreign identifiers. */
  message: string;
  retryable: boolean;
};

export type IntegrationSourceSnapshot = {
  source: IntegrationSource;
  providers: readonly IntegrationProviderDescriptor[];
  complete: boolean;
  providerErrors: readonly IntegrationProviderError[];
  /** Changes when provider identities, bindings or catalogue visibility change. */
  revision: string;
};

export type IntegrationProviderPage = {
  version: typeof INTEGRATION_CONTRACT_VERSION;
  target: 'providers';
  providers: IntegrationProviderDescriptor[];
  complete: boolean;
  sources: Array<{ source: IntegrationSource; complete: boolean }>;
  providerErrors: IntegrationProviderError[];
  nextCursor: string | null;
  nextActions: IntegrationNextAction[];
};

export type IntegrationToolDescriptor = {
  toolRef: string;
  providerRef: string;
  name: string;
  description: string;
  effect?: 'read' | 'write' | 'unknown';
  skillRefs: readonly string[];
  matchReasons: readonly string[];
  nextActions: readonly IntegrationNextAction[];
};

export type IntegrationToolPage = {
  version: typeof INTEGRATION_CONTRACT_VERSION;
  target: 'tools';
  providerRef: string;
  tools: IntegrationToolDescriptor[];
  complete: boolean;
  providerErrors: IntegrationProviderError[];
  nextCursor: string | null;
  nextActions: IntegrationNextAction[];
};

export type IntegrationToolSchema = {
  version: typeof INTEGRATION_CONTRACT_VERSION;
  toolRef: string;
  providerRef: string;
  schemaRef: string;
  toolVersion: string | null;
  inputSchema: Record<string, unknown> | boolean;
  outputSchema?: Record<string, unknown> | boolean;
  skillRefs: readonly string[];
  nextActions: readonly IntegrationNextAction[];
};

export type IntegrationErrorCode =
  | 'invalid_request' | 'invalid_cursor' | 'provider_unavailable' | 'provider_denied'
  | 'tool_not_found' | 'tool_denied' | 'binding_changed' | 'schema_changed'
  | 'invalid_arguments' | 'schema_unsupported' | 'outcome_unknown';

export type IntegrationErrorResult = {
  version: typeof INTEGRATION_CONTRACT_VERSION;
  error: { code: IntegrationErrorCode; message: string; retryable: boolean };
  nextActions: IntegrationNextAction[];
};

export class IntegrationContractError extends Error {
  constructor(readonly code: IntegrationErrorCode, message: string) {
    super(message);
    this.name = 'IntegrationContractError';
    Object.defineProperty(this, Symbol.for('canvas.integration.contract-error.v1'), { value: true });
  }
}

export function parseIntegrationRequest(value: unknown): IntegrationRequest {
  if (!Value.Check(IntegrationRequestSchema, value)) {
    throw new IntegrationContractError('invalid_request', 'Use a supported integration action with its required arguments.');
  }
  if ('query' in value && typeof value.query === 'string' && !value.query.trim()) {
    throw new IntegrationContractError('invalid_request', 'Search requires a non-empty query.');
  }
  return value;
}
