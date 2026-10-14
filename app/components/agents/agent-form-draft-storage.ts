import { z } from 'zod';
import type { AgentExtensionConfigurationTarget } from '@/app/lib/agents/extension-options-contracts';

const text = z.string().max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const file = z.string().max(64 * 1024);
/** Explicit form fields only. Extension/account receipts have their own rechecked chooser lifecycle. */
export const agentFormDraftFieldsSchema = z.object({
  name: z.string().max(256).optional(), iconId: text.optional(), selectedTemplateId: text.optional(),
  modelOverrideEnabled: z.boolean().optional(),
  modelDraft: z.object({ providerInstallationId: text, providerId: text, modelId: text,
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) }).nullable().optional(),
  toolsOverrideEnabled: z.boolean().optional(), customEnabledTools: z.array(text).max(512).nullable().optional(),
  fileDrafts: z.object({ 'AGENTS.md': file.optional(), 'MEMORY.md': file.optional(),
    'SOUL.md': file.optional(), 'TOOLS.md': file.optional() }).optional(),
});
export type AgentFormDraftFields = z.infer<typeof agentFormDraftFieldsSchema>;
export type AgentFormDraftScope = {
  actorId?: string | null; workspaceId: string | null; organizationId?: string | null; projectId?: string | null;
  target: AgentExtensionConfigurationTarget;
};
export type AgentFormDraftRead = { state: 'none' | 'invalid' | 'expired' | 'conflict' }
  | { state: 'ready'; fields: AgentFormDraftFields; savedAt: number; expiresAt: number };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Options = { storage?: StorageLike | null; now?: number };
const PREFIX = 'canvas.agent-form-draft:v1:';
export const AGENT_FORM_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const record = z.object({ version: z.literal(1), namespace: z.string(), savedAt: revision, expiresAt: revision,
  expectedRevision: revision.nullable(), expectedWorkflowRevision: revision.nullable(), fields: agentFormDraftFieldsSchema });

function scopeIdentity(scope: AgentFormDraftScope): string | null {
  if (!scope.actorId?.trim()) return null;
  const identity = [scope.actorId, scope.workspaceId, scope.organizationId ?? null, scope.projectId ?? null,
    scope.target.kind, scope.target.kind === 'existing' ? scope.target.agentId : scope.target.scopeType];
  if (identity.some(value => value !== null && (value.trim() !== value || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)))) return null;
  return JSON.stringify(identity);
}
function storageFor(options: Options): StorageLike | null {
  if (options.storage !== undefined) return options.storage;
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function base(scope: AgentFormDraftScope) {
  return scope.target.kind === 'existing'
    ? { expectedRevision: scope.target.expectedRevision, expectedWorkflowRevision: scope.target.expectedWorkflowRevision }
    : { expectedRevision: null, expectedWorkflowRevision: null };
}

/** Local display draft only. Its values never establish current server authority. */
export function writeAgentFormDraft(scope: AgentFormDraftScope, fields: AgentFormDraftFields, options: Options = {}): boolean {
  const namespace = scopeIdentity(scope), storage = storageFor(options), parsed = agentFormDraftFieldsSchema.safeParse(fields);
  if (!namespace || !storage || !parsed.success) return false;
  const now = options.now ?? Date.now();
  const candidate = record.safeParse({ version: 1, namespace, ...base(scope), savedAt: now,
    expiresAt: now + AGENT_FORM_DRAFT_TTL_MS, fields: parsed.data });
  if (!candidate.success) return false;
  const serialized = JSON.stringify(candidate.data);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) return false;
  try { storage.setItem(PREFIX + namespace, serialized); return true; } catch { return false; }
}

export function readAgentFormDraft(scope: AgentFormDraftScope, options: Options = {}): AgentFormDraftRead {
  const namespace = scopeIdentity(scope), storage = storageFor(options);
  if (!namespace || !storage) return { state: 'none' };
  const key = PREFIX + namespace;
  let serialized: string | null;
  try { serialized = storage.getItem(key); } catch { return { state: 'none' }; }
  if (serialized === null) return { state: 'none' };
  const discard = (state: 'invalid' | 'expired'): AgentFormDraftRead => {
    try { storage.removeItem(key); } catch { /* A disabled local store must not break the form. */ }
    return { state };
  };
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) return discard('invalid');
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { return discard('invalid'); }
  const parsed = record.safeParse(raw), now = options.now ?? Date.now();
  if (!parsed.success || parsed.data.namespace !== namespace || parsed.data.savedAt > now + 5 * 60 * 1000
    || parsed.data.expiresAt !== parsed.data.savedAt + AGENT_FORM_DRAFT_TTL_MS) return discard('invalid');
  if (parsed.data.expiresAt <= now) return discard('expired');
  const expected = base(scope);
  if (parsed.data.expectedRevision !== expected.expectedRevision
    || parsed.data.expectedWorkflowRevision !== expected.expectedWorkflowRevision) return { state: 'conflict' };
  return { state: 'ready', fields: parsed.data.fields, savedAt: parsed.data.savedAt, expiresAt: parsed.data.expiresAt };
}

export function clearAgentFormDraft(scope: AgentFormDraftScope, options: Options = {}): void {
  const namespace = scopeIdentity(scope), storage = storageFor(options);
  if (!namespace || !storage) return;
  try { storage.removeItem(PREFIX + namespace); } catch { /* Saving an Agent does not depend on local storage. */ }
}
