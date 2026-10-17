import { z } from 'zod';

export const CAPABILITY_WORKFLOW_LIMITS = Object.freeze({
  bytes: 65_536, documentBytes: 262_144, capabilities: 32, alternatives: 8, requiredTools: 64, skillRefs: 64,
  mcpConnectors: 32, envNames: 64, depth: 12, nodes: 5_000,
});

export type WorkflowIntegrationAlternative =
  | { source: 'mcp'; connector: string; requiredTools?: readonly string[] }
  | { source: 'composio'; toolkit: string; requiredTools?: readonly string[] };
export type WorkflowIntegrationCapability = {
  id: string;
  application: string;
  required: boolean;
  alternatives: readonly WorkflowIntegrationAlternative[];
  /** Skill context associations, never executable dependency edges or grants. */
  skillRefs?: readonly string[];
};
export type GenericWorkflowManifestV1 = {
  version: 1;
  integrationCapabilities: readonly WorkflowIntegrationCapability[];
};
export type WorkflowManifestV1 = GenericWorkflowManifestV1;
export type WorkflowMcpConnectorDescriptor = {
  name: string;
  label?: string;
  reason?: string;
  recommended?: boolean;
  required?: boolean;
  configPath?: string;
  env?: readonly string[];
  oauth?: boolean;
};
export type SkillWorkflowManifestV1 = GenericWorkflowManifestV1 & {
  /** Only a standalone skill may declare connectors; plugin children use the parent. */
  mcpConnectors?: readonly WorkflowMcpConnectorDescriptor[];
};
/** A caller derives this path from the verified package tree, never from manifest data. */
export type WorkflowDeclaration = {
  declarationPath: string;
  workflow: GenericWorkflowManifestV1 | SkillWorkflowManifestV1;
};

export class WorkflowManifestError extends Error {
  readonly code = 'WORKFLOW_MANIFEST_INVALID';
  constructor(readonly errors: readonly string[] = ['workflow: The declaration is invalid.']) {
    super(errors.join(' '));
    this.name = 'WorkflowManifestError';
    Object.defineProperty(this, Symbol.for('canvas.workflow-manifest-error.v1'), { value: true });
  }
}
export function isWorkflowManifestError(value: unknown): value is WorkflowManifestError {
  return Boolean(value && typeof value === 'object'
    && Reflect.get(value, Symbol.for('canvas.workflow-manifest-error.v1')) === true
    && Reflect.get(value, 'code') === 'WORKFLOW_MANIFEST_INVALID');
}
function invalid(message: string): never { throw new WorkflowManifestError([message]); }

const identifier = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const application = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u);
// Regex equivalents keep these existing rules visible in generated JSON Schema.
const reference = z.string().min(1).max(128)
  .regex(/^(?!\s)(?![\s\S]*\s$)[^\u0000-\u0020\u007f/\\:]+$/u);
const toolName = z.string().min(1).max(256)
  .regex(/^(?!\s)(?![\s\S]*\s$)[^\u0000-\u0020\u007f]+$/u);
const relativePath = z.string().min(1).max(256)
  .regex(/^(?![A-Za-z]:)(?!\/)(?![\s\S]*(?:^|\/)\.\.(?:\/|$))(?![\s\S]*\/\/)(?![\s\S]*\/$)[^\\\u0000-\u001f\u007f]+$/u);
const tools = z.array(toolName).max(CAPABILITY_WORKFLOW_LIMITS.requiredTools).optional();
const alternativeSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('mcp'), connector: reference, requiredTools: tools }).strict(),
  z.object({ source: z.literal('composio'), toolkit: application, requiredTools: tools }).strict(),
]);
const capabilitySchema = z.object({ id: identifier, application, required: z.boolean().default(true),
  alternatives: z.array(alternativeSchema).min(1).max(CAPABILITY_WORKFLOW_LIMITS.alternatives),
  skillRefs: z.array(reference).max(CAPABILITY_WORKFLOW_LIMITS.skillRefs).optional(),
}).strict();
const connectorSchema = z.object({ name: reference, label: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(1024).optional(), recommended: z.boolean().optional(), required: z.boolean().optional(),
  configPath: relativePath.optional(), env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
    .max(CAPABILITY_WORKFLOW_LIMITS.envNames).optional(), oauth: z.boolean().optional(),
}).strict();
const genericSchema = z.object({ version: z.literal(1),
  integrationCapabilities: z.array(capabilitySchema).max(CAPABILITY_WORKFLOW_LIMITS.capabilities),
}).strict();
const skillSchema = genericSchema.extend({ mcpConnectors: z.array(connectorSchema)
  .max(CAPABILITY_WORKFLOW_LIMITS.mcpConnectors).optional() }).strict();

/** Shared structural contracts; semantic uniqueness and references remain in the parser below. */
export { genericSchema as workflowManifestV1Schema, connectorSchema as workflowMcpConnectorDescriptorSchema,
  application as workflowApplicationSchema, toolName as workflowToolNameSchema };

function assertBoundedPortableJson(value: unknown): void {
  const queue = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const accountBytes = (value: string) => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > CAPABILITY_WORKFLOW_LIMITS.bytes) invalid('workflow: The declaration exceeds its size limit.');
  };
  while (queue.length) {
    const entry = queue.pop()!;
    if (++nodes > CAPABILITY_WORKFLOW_LIMITS.nodes || entry.depth > CAPABILITY_WORKFLOW_LIMITS.depth) invalid('workflow: The declaration exceeds its limits.');
    if (typeof entry.value === 'string') { accountBytes(entry.value); continue; }
    if (entry.value === null || typeof entry.value === 'boolean') continue;
    if (typeof entry.value === 'number' && Number.isFinite(entry.value)) continue;
    if (typeof entry.value !== 'object' || !entry.value || seen.has(entry.value)) invalid('workflow: A bounded JSON declaration is required.');
    seen.add(entry.value);
    if (!Array.isArray(entry.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry.value))) invalid('workflow: A JSON declaration is required.');
    for (const key in entry.value) {
      if (!Object.hasOwn(entry.value, key)) continue;
      if (nodes + queue.length >= CAPABILITY_WORKFLOW_LIMITS.nodes) invalid('workflow: The declaration exceeds its limits.');
      accountBytes(key);
      queue.push({ value: (entry.value as Record<string, unknown>)[key], depth: entry.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > CAPABILITY_WORKFLOW_LIMITS.bytes) invalid('workflow: The declaration exceeds its size limit.');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`workflow: Duplicate ${field} are not allowed.`);
}

export function parseWorkflowManifest(value: unknown, options: { allowMcpConnectors: true }): SkillWorkflowManifestV1;
export function parseWorkflowManifest(value: unknown, options?: { allowMcpConnectors?: false }): GenericWorkflowManifestV1;
export function parseWorkflowManifest(value: unknown, options: { allowMcpConnectors?: boolean } = {}): SkillWorkflowManifestV1 {
  assertBoundedPortableJson(value);
  const parsed = (options.allowMcpConnectors ? skillSchema : genericSchema).safeParse(value);
  if (!parsed.success) throw new WorkflowManifestError(parsed.error.issues.slice(0, 8)
    .map(issue => `workflow${issue.path.length ? `.${issue.path.join('.')}` : ''}: Invalid field or value.`));
  const manifest: SkillWorkflowManifestV1 = parsed.data;
  unique(manifest.integrationCapabilities.map(capability => capability.id), 'capability IDs');
  unique(manifest.mcpConnectors?.map(connector => connector.name) ?? [], 'MCP connector names');
  for (const connector of manifest.mcpConnectors ?? []) unique(connector.env ?? [], 'environment names');
  for (const capability of manifest.integrationCapabilities) {
    unique(capability.alternatives.map(alternative => alternative.source === 'mcp'
      ? `mcp:${alternative.connector}` : `composio:${alternative.toolkit}`), 'alternatives');
    unique(capability.skillRefs ?? [], 'skill references');
    for (const alternative of capability.alternatives) unique(alternative.requiredTools ?? [], 'required tools');
  }
  return freeze(manifest);
}

export function validateWorkflowConnectorReferences(workflow: GenericWorkflowManifestV1,
  mcpConnectors: readonly { name: string }[],
): void {
  for (const capability of workflow.integrationCapabilities) {
    for (const alternative of capability.alternatives) {
      if (alternative.source === 'mcp' && mcpConnectors.filter(connector => connector.name === alternative.connector).length !== 1) {
        invalid('workflow: Each MCP alternative must reference exactly one package connector.');
      }
    }
  }
}

/** Uses only actual package-local declarations and parsed skill inventory. */
export function validateWorkflowReferences(workflow: SkillWorkflowManifestV1, context: {
  mcpConnectors: readonly { name: string }[];
  skillNames: readonly string[];
  allowMcpConnectors: boolean;
}): void {
  if (!context.allowMcpConnectors && workflow.mcpConnectors !== undefined) invalid('workflow.mcpConnectors: Only standalone skills may declare connectors.');
  validateWorkflowConnectorReferences(workflow, context.mcpConnectors);
  for (const capability of workflow.integrationCapabilities) {
    for (const name of capability.skillRefs ?? []) {
      if (context.skillNames.filter(skill => skill === name).length !== 1) invalid('workflow: Each skill reference must identify exactly one package skill.');
    }
  }
}

/** Group readiness alone grants no tools and does not replace legacy connector requirements. */
export function evaluateWorkflowRequirementGroups(workflow: GenericWorkflowManifestV1,
  isAlternativeReady: (capability: WorkflowIntegrationCapability, alternative: WorkflowIntegrationAlternative) => boolean,
): { ready: boolean; capabilities: Array<{ id: string; required: boolean; ready: boolean; availableAlternatives: number[] }> } {
  const capabilities = workflow.integrationCapabilities.map(capability => {
    const availableAlternatives = capability.alternatives.flatMap((alternative, index) => isAlternativeReady(capability, alternative) ? [index] : []);
    return { id: capability.id, required: capability.required, ready: availableAlternatives.length > 0, availableAlternatives };
  });
  return { ready: capabilities.every(capability => !capability.required || capability.ready), capabilities };
}
