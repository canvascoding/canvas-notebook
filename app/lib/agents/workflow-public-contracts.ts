import { z } from 'zod';

/** Client-safe public workflow syntax; parsing never grants source or agent access. */
export const AGENT_WORKFLOW_LIMITS = Object.freeze({ bytes: 1_048_576, packages: 32, declarations: 128, capabilities: 128, choices: 32, tools: 256 });
const text = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const resourceRef = z.string().regex(new RegExp(`^canvas-resource:${uuid}$`, 'u'));
const publishedRef = z.string().regex(new RegExp(`^canvas-package-revision:${uuid}$`, 'u'));
const connectionRef = z.string().regex(new RegExp(`^canvas-connection:${uuid}$`, 'u'));
const checksum = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().max(1_024).refine(value => !value.startsWith('/') && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'));
const toolCap = z.array(text).max(AGENT_WORKFLOW_LIMITS.tools).nullable().refine(value => value === null || new Set(value).size === value.length);
const sharedTargetSchema = z.object({ kind: z.literal('shared'), source: z.enum(['mcp', 'composio']), connectionRef,
  bindingRevision: z.number().int().positive(), mcpMapping: z.object({ kind: z.literal('manager_confirmation') }).strict().optional() }).strict();
const personalTargetSchema = z.object({ kind: z.literal('personal'), source: z.enum(['mcp', 'composio']), ownerUserId: text,
  providerRef: text, accountSelectionRef: z.string().min(1).max(8_192).optional() }).strict();
const retainedTargetSchema = z.object({ kind: z.literal('retained'),
  retainedBindingRef: z.string().regex(/^agent-workflow-retain:v1:[a-f0-9]{64}$/u) }).strict();
export const agentWorkflowTargetSchema = z.discriminatedUnion('kind', [sharedTargetSchema, personalTargetSchema, retainedTargetSchema]);
const choiceSchema = z.object({ choiceId: text, alternativeKey: text, target: agentWorkflowTargetSchema, toolCap }).strict();
const personalPolicySchema = z.object({ sources: z.array(z.enum(['mcp', 'composio'])).min(1).max(2),
  alternativeKeys: z.array(text).min(1).max(8), toolCap,
  mcpDefinitionMappings: z.array(z.object({ connector: text, serverDefinitionIds: z.array(text).min(1).max(32) }).strict()).max(8).optional() }).strict();
const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), alternativeKey: text, target: agentWorkflowTargetSchema, toolCap }).strict(),
  z.object({ mode: z.literal('selectable'), allowedChoices: z.array(choiceSchema).max(AGENT_WORKFLOW_LIMITS.choices),
    personalPolicy: personalPolicySchema.optional(), defaultChoiceId: text.optional() }).strict(),
]);
const capabilitySchema = z.object({ capabilityId: text, required: z.boolean().optional(), selection: selectionSchema }).strict();
export const agentWorkflowPackageSchema = z.object({ resourceRef, publishedRevisionRef: publishedRef, checksum,
  skillSelection: z.discriminatedUnion('kind', [z.object({ kind: z.literal('plugin') }).strict(),
    z.object({ kind: z.literal('skills'), relativeRoots: z.array(z.union([z.literal(''), relativePath])).min(1).max(128) }).strict()]),
  childRelativeRoot: relativePath.optional(), declarations: z.array(z.object({ declarationPath: relativePath,
    capabilities: z.array(capabilitySchema).max(AGENT_WORKFLOW_LIMITS.capabilities) }).strict()).max(AGENT_WORKFLOW_LIMITS.declarations) }).strict();
const configurationSchema = z.object({ version: z.literal(1), packages: z.array(agentWorkflowPackageSchema).max(AGENT_WORKFLOW_LIMITS.packages) }).strict();
export const agentWorkflowConfigurationSchema = configurationSchema;
export type AgentWorkflowTarget = z.infer<typeof agentWorkflowTargetSchema>;
export type AgentWorkflowSelection = z.infer<typeof selectionSchema>;
export type AgentWorkflowPackageConfiguration = z.infer<typeof agentWorkflowPackageSchema>;
export type AgentWorkflowConfiguration = z.infer<typeof configurationSchema>;

/** Shared canonical building blocks used by the server-only stored binding codec. */
export const agentWorkflowSchemaParts = Object.freeze({ text, relativePath, toolCap, sharedTargetSchema, personalTargetSchema, choiceSchema, personalPolicySchema });

export class AgentWorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message); this.name = 'AgentWorkflowError';
    Object.defineProperty(this, Symbol.for('canvas.agent.workflow-error.v1'), { value: true });
  }
}
export function isAgentWorkflowError(value: unknown): value is AgentWorkflowError {
  return Boolean(value && typeof value === 'object' && Reflect.get(value, Symbol.for('canvas.agent.workflow-error.v1')) === true
    && typeof Reflect.get(value, 'code') === 'string' && Number.isInteger(Reflect.get(value, 'status')));
}
export function parseAgentWorkflowConfiguration(value: unknown): AgentWorkflowConfiguration {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'A bounded workflow configuration is required.'); }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > AGENT_WORKFLOW_LIMITS.bytes) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The workflow configuration exceeds its limits.');
  const result = configurationSchema.safeParse(JSON.parse(encoded));
  if (!result.success) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The workflow configuration contains invalid or unsupported fields.');
  const packages = new Set<string>();
  for (const entry of result.data.packages) {
    const packageKey = entry.resourceRef;
    if (packages.has(packageKey)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate package bindings are not allowed.'); packages.add(packageKey);
    const declarations = new Set<string>();
    for (const declaration of entry.declarations) {
      if (declarations.has(declaration.declarationPath)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate declaration scopes are not allowed.'); declarations.add(declaration.declarationPath);
      const ids = new Set<string>();
      for (const capability of declaration.capabilities) {
        if (ids.has(capability.capabilityId)) throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'Duplicate capability bindings are not allowed.'); ids.add(capability.capabilityId);
        if (capability.selection.mode === 'selectable') {
          const choices = capability.selection.allowedChoices.map(choice => choice.choiceId);
          if (new Set(choices).size !== choices.length || capability.selection.defaultChoiceId && !choices.includes(capability.selection.defaultChoiceId)) {
            throw new AgentWorkflowError('AGENT_WORKFLOW_INVALID', 'The selectable choices are invalid.');
          }
        }
      }
    }
  }
  return result.data;
}
