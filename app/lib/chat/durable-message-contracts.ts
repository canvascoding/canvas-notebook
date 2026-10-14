import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatRequestContext } from './types';
import {
  chatExtensionSelectionInputSchema,
  chatExtensionSelectionSchema,
  type ChatExtensionSelection,
} from '@/app/lib/capabilities/extensions/contracts';
import {
  parseStoredAcceptedTurnExtensionSelection,
  type StoredAcceptedTurnExtensionSelection,
} from '@/app/lib/capabilities/extensions/accepted-turn-selection';
import { freeze } from '@/app/lib/capabilities/extensions/stored-contracts';

/** Matches the existing WebSocket inbound limit, before runtime image expansion. */
export const DURABLE_CHAT_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const identifier = z.string().min(1).max(256)
  .refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/u);
const clientMessageId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/u);
const workspaceType = z.enum(['personal', 'organization', 'team', 'project']);

/**
 * Copy JSON without invoking accessors/toJSON or accepting class instances.
 * The depth bound matches the existing private extension codec. Byte accounting
 * includes UTF-8, escaping, keys and punctuation before any schema can inspect it.
 */
function copyMessageJson(value: unknown): unknown {
  const parents = new Set<object>();
  let bytes = 0;
  const charge = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > DURABLE_CHAT_MESSAGE_MAX_BYTES) throw new Error('Message JSON exceeds its byte limit.');
  };
  const copy = (node: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('Message JSON exceeds its depth limit.');
    if (node === null || typeof node === 'string' || typeof node === 'boolean'
      || typeof node === 'number' && Number.isFinite(node)) {
      charge(JSON.stringify(node));
      return node;
    }
    if (!node || typeof node !== 'object' || parents.has(node)) throw new Error('Plain JSON is required.');
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error('Plain JSON is required.');
    if (Object.getOwnPropertySymbols(node).length) throw new Error('JSON symbols are not supported.');
    const descriptors = Object.getOwnPropertyDescriptors(node);
    const entries = Object.entries(descriptors).filter(([key]) => !(array && key === 'length'));
    if (array && entries.length !== node.length) throw new Error('Sparse JSON arrays are not supported.');
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    charge(array ? '[]' : '{}');
    parents.add(node);
    for (let index = 0; index < entries.length; index++) {
      const [key, descriptor] = entries[index];
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('JSON data properties are required.');
      if (array && key !== String(index)) throw new Error('JSON array indexes must be contiguous.');
      if (index) charge(',');
      if (!array) charge(`${JSON.stringify(key)}:`);
      const child = copy(descriptor.value, depth + 1);
      if (array) (result as unknown[]).push(child);
      else Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    parents.delete(node);
    return result;
  };
  return copy(value, 0);
}

function boundedJsonSchema<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, context) => {
    try { return copyMessageJson(value); }
    catch {
      context.addIssue({ code: 'custom', message: 'A bounded plain JSON message is required.' });
      return z.NEVER;
    }
  }, schema);
}

const contextSchema = z.object({
  channelId: z.string().optional(), userTimeZone: z.string().optional(), currentTime: z.string().optional(),
  activeFilePath: z.string().nullable().optional(), workingDirectory: z.string().optional(),
  workspace: z.object({ workspaceId: identifier, workspaceType, workspaceName: z.string(),
    workspaceDescription: z.string().optional(), organizationId: identifier.nullable().optional(),
    canWrite: z.boolean(), canDelete: z.boolean(), canShare: z.boolean(), brandContext: z.string().optional(),
  }).strict().optional(),
  planningMode: z.boolean().optional(), currentPage: z.string().optional(),
  todoContext: z.object({ todoId: identifier, title: z.string().optional(), description: z.string().nullable().optional(),
    status: z.enum(['open', 'done', 'archived']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
    categoryName: z.string().nullable().optional(), scopeKind: z.enum(['user', 'workspace']).optional(),
    workspace: z.object({ id: identifier, name: z.string(), type: workspaceType }).strict().nullable().optional(),
    assignee: z.object({ id: identifier, name: z.string().nullable(), email: z.string().nullable() }).strict().nullable().optional(),
    dueAt: z.string().nullable().optional(), sourceSessionId: identifier.nullable().optional(),
    fileLinks: z.array(z.object({ workspacePath: z.string(), label: z.string().nullable() }).strict()).optional(),
  }).strict().optional(),
  notebookContext: z.object({ activeSurface: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('browser') }).strict(), z.object({ kind: z.literal('document'), path: z.string() }).strict(),
    z.object({ kind: z.literal('email') }).strict(),
  ]).nullable(), chatPlacement: z.enum(['full', 'hidden', 'overlay', 'side']),
  openDocuments: z.array(z.object({ path: z.string(), state: z.enum(['active', 'background']) }).strict()),
  }).strict().optional(),
  studioContext: z.object({ generationId: z.string().optional(), currentOutputId: z.string().optional(),
    generationPrompt: z.string().nullable().optional(), generationPresetId: z.string().nullable().optional(),
    generationProductIds: z.array(z.string()).optional(), generationPersonaIds: z.array(z.string()).optional(),
    outputFilePath: z.string().nullable().optional(), outputMediaUrl: z.string().nullable().optional(),
    activeImagePath: z.string().nullable().optional(),
  }).strict().optional(),
  emailContext: z.object({ accountScope: z.enum(['personal', 'workspace']).optional(),
    mailboxWorkspaceId: z.string().nullable().optional(), workspaceName: z.string().nullable().optional(),
    accountEmail: z.string().optional(), accountId: z.string().optional(), filter: z.enum(['all', 'unread']).optional(),
    folder: z.string().optional(), folderName: z.string().optional(), query: z.string().optional(),
    selectedMessageDate: z.string().nullable().optional(), selectedMessageFolder: z.string().optional(),
    selectedMessageFrom: z.string().nullable().optional(), selectedMessageId: z.string().optional(),
    selectedMessageIsRead: z.boolean().nullable().optional(), selectedMessageSubject: z.string().nullable().optional(),
  }).strict().optional(),
}).strict() satisfies z.ZodType<ChatRequestContext>;

const contentSchema = z.union([z.string(), z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() }).strict(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).strict(),
]))]);
const userMessageSchema = z.object({ role: z.literal('user'), content: contentSchema, timestamp: z.number().finite() }).strict();
const modeSchema = z.enum(['message', 'steer']);
const admissionRequestSchema = z.object({
  userId: identifier, sessionId: identifier, clientMessageId,
  expectedAgentId: identifier.optional(), expectedWorkspaceId: identifier.optional(),
  message: userMessageSchema,
  context: contextSchema.nullable().optional().transform(value => value ?? {}),
  mode: modeSchema.default('message'),
  selection: chatExtensionSelectionInputSchema.nullable().optional()
    .transform(value => value?.selections.length ? value : null),
}).strict();
export type CapturedChatMessageAdmissionRequest = z.infer<typeof admissionRequestSchema>;

/** Capture the original request before reading any caller-owned field. Syntax only; never source authority. */
export function captureChatMessageAdmissionRequest(value: unknown): CapturedChatMessageAdmissionRequest {
  return freeze(boundedJsonSchema(admissionRequestSchema).parse(value));
}

const acceptedSelectionSchema = z.unknown().transform((value, context): StoredAcceptedTurnExtensionSelection | null => {
  if (value === null) return null;
  try {
    const parsed = parseStoredAcceptedTurnExtensionSelection(value);
    return parsed.publicSelection.selections.length ? parsed : null;
  } catch {
    context.addIssue({ code: 'custom', message: 'An exact receipt-free private selection is required.' });
    return z.NEVER;
  }
});
const storedMessageSchema = z.object({
  version: z.literal(1), kind: z.literal('accepted_chat_message'),
  identity: z.object({ userId: identifier, sessionId: identifier, agentId: identifier, workspaceId: identifier,
    organizationId: identifier.nullable(), projectId: identifier.nullable() }).strict(),
  serverMessageId: uuid, clientMessageId, mode: modeSchema,
  message: userMessageSchema,
  context: contextSchema, extensionSelection: acceptedSelectionSchema,
}).strict().superRefine((value, context) => {
  const workspace = value.context.workspace;
  if (workspace && (workspace.workspaceId !== value.identity.workspaceId
    || workspace.organizationId !== undefined && workspace.organizationId !== value.identity.organizationId)) {
    context.addIssue({ code: 'custom', path: ['context', 'workspace'], message: 'The context and stored message identity must agree.' });
  }
  for (const binding of value.extensionSelection?.privateFixedBindings ?? []) {
    if (binding.entry.target.kind === 'personal' && binding.entry.target.ownerUserId !== value.identity.userId) {
      context.addIssue({ code: 'custom', path: ['extensionSelection'], message: 'A personal selection must match the stored actor identity.' });
    }
  }
});

/** Syntax and internal consistency only: this parsed value is never a runtime/source authority handle. */
export const storedAcceptedChatMessageSchema = boundedJsonSchema(storedMessageSchema).transform(value => freeze(value));
export type StoredAcceptedChatMessage = z.infer<typeof storedAcceptedChatMessageSchema>;
export function parseStoredAcceptedChatMessage(value: unknown): StoredAcceptedChatMessage {
  return storedAcceptedChatMessageSchema.parse(value);
}

/** Strip only validated intake receipts; no decryption, source lookup or authority is performed. */
export function receiptFreeChatExtensionSelection(input: unknown): ChatExtensionSelection | null {
  if (input === undefined || input === null) return null;
  const parsed = chatExtensionSelectionInputSchema.parse(copyMessageJson(input));
  const selection = chatExtensionSelectionSchema.parse({ version: 1, origin: 'turn_reference',
    selections: parsed.selections.map(({ selection, requirement, toolCap }) => ({ selection, requirement, toolCap })),
    ...(parsed.packageConnections === undefined ? {} : { packageConnections: parsed.packageConnections }),
  });
  return selection.selections.length ? freeze(selection) : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

const intentSchema = z.object({ content: contentSchema, context: contextSchema.nullable(), mode: modeSchema,
  selection: chatExtensionSelectionSchema.nullable() }).strict();
export type CanonicalMessageIntent = z.infer<typeof intentSchema>;

/** Capture validated public intent before any await. This frozen value grants no source authority. */
export function parseCanonicalMessageIntent(value: unknown): CanonicalMessageIntent {
  const parsed = boundedJsonSchema(intentSchema).parse(value);
  return freeze({ ...parsed, context: parsed.context ?? {}, selection: parsed.selection?.selections.length ? parsed.selection : null });
}

/** Hash exact user intent, excluding renewable receipts, time and refreshed workspace presentation/permissions. */
export function canonicalMessageIntentHash(input: CanonicalMessageIntent): string {
  const parsed = parseCanonicalMessageIntent(input);
  const context: Record<string, unknown> = parsed.context ? Object.fromEntries(Object.entries(parsed.context)
    .filter(([key]) => key !== 'currentTime' && key !== 'userTimeZone' && key !== 'workspace')) : {};
  if (parsed.context?.workspace) context.workspace = { workspaceId: parsed.context.workspace.workspaceId };
  const intent = { content: parsed.content, context, mode: parsed.mode,
    selection: parsed.selection?.selections.length ? parsed.selection : null };
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}
