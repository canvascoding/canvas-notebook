import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentWorkflowError, parseStoredAgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import {
  EXTENSION_SELECTION_LIMITS,
  extensionSelectionIdentity,
  extensionToolCapSchema,
  standaloneExtensionSelectionSchema,
} from './contracts';

const identifier = z.string().min(1).max(256)
  .refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const toolkit = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const requirement = z.enum(['optional', 'required']);

const personalBindingSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('mcp'),
    ownerUserId: identifier,
    connectionId: uuid,
    serverDefinitionId: uuid.nullable(),
  }).strict(),
  z.object({
    source: z.literal('composio'),
    ownerUserId: identifier,
    profileId: identifier,
    toolkit,
    mode: z.enum(['local', 'managed']),
    accountBinding: z.enum(['account', 'no_auth']),
    connectedAccountId: identifier.nullable(),
  }).strict(),
]);

/** Private identities contain no endpoint, credential, account receipt or routing instructions. */
const storedTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shared'),
    source: z.enum(['mcp', 'composio']),
    connectionRef: z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
    bindingRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal('personal'),
    source: z.enum(['mcp', 'composio']),
    ownerUserId: identifier,
    providerRef: identifier,
    boundProviderRef: identifier,
    bindingFingerprint: fingerprint,
    personalBinding: personalBindingSchema,
  }).strict(),
]).superRefine((target, context) => {
  try {
    // Keep V1's existing owner/source/no_auth checks, without changing its package codec.
    parseStoredAgentWorkflowTarget(target);
  } catch {
    context.addIssue({ code: 'custom', message: 'The stored target is inconsistent.' });
    return;
  }
  if (target.kind !== 'personal') return;
  const binding = target.personalBinding;
  const expectedBase = binding.source === 'mcp'
    ? createIntegrationProviderRef({ source: 'mcp', connectionId: binding.connectionId,
      scope: { type: 'user', ownerUserId: binding.ownerUserId, resourceId: binding.connectionId } })
    : createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: binding.toolkit,
      scope: { type: 'user', ownerUserId: binding.ownerUserId, resourceId: `profile:${binding.profileId}:${binding.toolkit}` } });
  // Zod constructs the binding in the same field order as workflow-personal-bindings.
  const expectedBound = `${binding.source}:v1:personal:${createHash('sha256').update(JSON.stringify(binding)).digest('hex')}`;
  if (target.providerRef !== expectedBase || target.boundProviderRef !== expectedBound) {
    context.addIssue({ code: 'custom', message: 'Derived references must match the exact private identity.' });
  }
});
export type StoredStandaloneExtensionTarget = z.infer<typeof storedTargetSchema>;

const exactChoiceSchema = z.object({
  selection: standaloneExtensionSelectionSchema,
  target: storedTargetSchema,
  toolCap: extensionToolCapSchema,
}).strict().superRefine(({ selection, target }, context) => {
  let matches = selection.source === target.source && selection.target.kind === target.kind;
  if (selection.target.kind === 'shared') {
    matches &&= target.kind === 'shared' && target.connectionRef === selection.target.connectionRef
      && target.bindingRevision === selection.target.bindingRevision;
  } else if (target.kind !== 'personal') {
    matches = false;
  } else if (selection.kind === 'mcp') {
    matches &&= target.personalBinding.source === 'mcp'
      && selection.target.connectionRef === `mcp-personal:${target.personalBinding.connectionId}`;
  } else {
    matches &&= target.personalBinding.source === 'composio'
      && target.personalBinding.profileId === selection.target.profileId
      && target.personalBinding.toolkit === selection.toolkit
      && target.personalBinding.accountBinding === selection.target.accountBinding
      && target.personalBinding.connectedAccountId === (selection.target.accountBinding === 'account' ? selection.target.accountId : null);
  }
  if (!matches) context.addIssue({ code: 'custom', message: 'The public identity and private target must match exactly.' });
});

const personalPolicySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('composio'), toolkit, toolCap: extensionToolCapSchema }).strict(),
  z.object({ source: z.literal('mcp'), serverDefinitionIds: z.array(uuid).min(1).max(32)
    .refine(values => new Set(values).size === values.length), toolCap: extensionToolCapSchema }).strict(),
]);

const common = {
  version: z.literal(1),
  kind: z.literal('standalone'),
  // An agent-scoped preference slot, never a provider or access reference.
  configurationId: identifier,
};
const bindingSchema = z.discriminatedUnion('mode', [
  z.object({
    ...common,
    mode: z.literal('fixed'),
    entry: z.object({ selection: standaloneExtensionSelectionSchema, target: storedTargetSchema,
      requirement, toolCap: extensionToolCapSchema }).strict().superRefine((entry, context) => {
      const parsed = exactChoiceSchema.safeParse({ selection: entry.selection, target: entry.target, toolCap: entry.toolCap });
      if (!parsed.success) context.addIssue({ code: 'custom', message: 'The fixed connection binding is inconsistent.' });
    }),
  }).strict(),
  z.object({
    ...common,
    mode: z.literal('selectable'),
    source: z.enum(['mcp', 'composio']),
    toolkit: toolkit.optional(),
    requirement,
    allowedChoices: z.array(z.object({ choiceId: identifier,
      selection: standaloneExtensionSelectionSchema, target: storedTargetSchema, toolCap: extensionToolCapSchema }).strict()
      .superRefine((choice, context) => {
        const parsed = exactChoiceSchema.safeParse({ selection: choice.selection, target: choice.target, toolCap: choice.toolCap });
        if (!parsed.success) context.addIssue({ code: 'custom', message: 'The selectable connection binding is inconsistent.' });
      })).max(EXTENSION_SELECTION_LIMITS.choices),
    defaultChoiceId: identifier.optional(),
    personalPolicy: personalPolicySchema.optional(),
  }).strict(),
]).superRefine((binding, context) => {
  if (binding.mode !== 'selectable') return;
  if (binding.source === 'composio' ? binding.toolkit === undefined : binding.toolkit !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only a Composio slot declares its exact toolkit.' });
  }
  const ids = new Set<string>(), identities = new Set<string>();
  for (const choice of binding.allowedChoices) {
    const identity = extensionSelectionIdentity(choice.selection);
    if (ids.has(choice.choiceId) || identities.has(identity)) {
      context.addIssue({ code: 'custom', message: 'Duplicate choices or exact connection identities are not allowed.' });
    }
    ids.add(choice.choiceId);
    identities.add(identity);
    if (choice.selection.source !== binding.source || choice.selection.kind === 'composio' && choice.selection.toolkit !== binding.toolkit) {
      context.addIssue({ code: 'custom', message: 'Each choice must match its configured source and toolkit.' });
    }
  }
  if (binding.defaultChoiceId !== undefined && !ids.has(binding.defaultChoiceId)) {
    context.addIssue({ code: 'custom', message: 'The default choice must be one of the exact configured choices.' });
  }
  const policy = binding.personalPolicy;
  if (policy && (policy.source !== binding.source || policy.source === 'composio' && policy.toolkit !== binding.toolkit)) {
    context.addIssue({ code: 'custom', message: 'The permitted personal policy must match its configured source and toolkit.' });
  }
});

function copyBoundedJson(value: unknown): unknown {
  const seen = new Set<object>();
  function check(node: unknown, depth: number): void {
    if (depth > 32) throw new Error('depth');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (!node || typeof node !== 'object' || seen.has(node)) throw new Error('json');
    const prototype = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) throw new Error('prototype');
    if (Object.getOwnPropertySymbols(node).length) throw new Error('symbols');
    seen.add(node);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      if (Array.isArray(node) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('descriptor');
      if (Array.isArray(node) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error('array');
      check(descriptor.value, depth + 1);
    }
    if (Array.isArray(node) && Object.keys(node).length !== node.length) throw new Error('sparse');
    seen.delete(node);
  }
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > EXTENSION_SELECTION_LIMITS.bytes) throw new Error('bytes');
  return JSON.parse(encoded);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Shared private-codec mechanics; neither function proves resource or actor authority. */
export { copyBoundedJson, freeze };

/** Syntax and internal consistency only. Fresh actor, source, rights and revisions are checked by actions. */
export const storedStandaloneExtensionBindingSchema = z.preprocess((value, context) => {
  try {
    return copyBoundedJson(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'A bounded private JSON connection binding is required.' });
    return z.NEVER;
  }
}, bindingSchema).transform(value => freeze(value));
export type StoredStandaloneExtensionBinding = z.infer<typeof storedStandaloneExtensionBindingSchema>;

export function parseStoredStandaloneExtensionBinding(value: unknown): StoredStandaloneExtensionBinding {
  const parsed = storedStandaloneExtensionBindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored extension binding cannot be verified.', 409);
  }
  return parsed.data;
}
