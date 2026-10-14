import { z } from 'zod';
import {
  chatExtensionSelectionSchema, extensionPackageConnectionSchema, extensionSelectionEntrySchema,
  extensionSelectionIdentity, standaloneExtensionEntrySchema, EXTENSION_SELECTION_LIMITS,
  type ChatExtensionSelection, type ExtensionPackageConnection, type ExtensionSelectionEntry,
} from '@/app/lib/capabilities/extensions/contracts';

/** The body shares the inbound message's existing UTF-8 budget. Syntax is never authority. */
export const CHAT_BODY_MAX_BYTES = 4 * 1024 * 1024;
const identifier = z.string().min(1).max(256)
  .refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const bodyObjectSchema = z.object({
  version: z.literal(1),
  parts: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('extension_reference'), occurrenceId: identifier, bundleId: identifier }).strict(),
  ])),
  bundles: z.array(z.object({
    id: identifier,
    caption: z.string().min(1).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value)),
    primary: extensionSelectionEntrySchema,
    supporting: z.array(standaloneExtensionEntrySchema).max(EXTENSION_SELECTION_LIMITS.turn),
    packageConnections: z.array(extensionPackageConnectionSchema).max(EXTENSION_SELECTION_LIMITS.children),
  }).strict()),
}).strict();

export type ChatBodyV1 = z.infer<typeof bodyObjectSchema>;
export type ChatReferenceBundleV1 = ChatBodyV1['bundles'][number];
export type ChatBodyMessageContent = string | readonly (
  { type: 'text'; text: string; textSignature?: string } | { type: 'image'; data: string; mimeType: string }
)[];
type CanonicalBundle = Pick<ChatReferenceBundleV1, 'primary' | 'supporting' | 'packageConnections'>;
export type CanonicalChatBodyIntentV1 = {
  version: 1;
  parts: ({ type: 'text'; text: string } | { type: 'extension_reference'; bundleIndex: number })[];
  bundles: CanonicalBundle[];
};

function copyBodyJson(value: unknown): unknown {
  const parents = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  const charge = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > CHAT_BODY_MAX_BYTES) throw new Error('The chat body exceeds its UTF-8 byte limit.');
  };
  const copy = (node: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('The chat body exceeds its depth limit.');
    if (node === null || typeof node === 'string' || typeof node === 'boolean'
      || typeof node === 'number' && Number.isFinite(node)) {
      charge(JSON.stringify(node)); return node;
    }
    if (!node || typeof node !== 'object' || parents.has(node)) throw new Error('Plain body JSON is required.');
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error('Plain body JSON is required.');
    if (Object.getOwnPropertySymbols(node).length) throw new Error('Body symbols are not supported.');
    const descriptors = Object.getOwnPropertyDescriptors(node);
    const entries = Object.entries(descriptors).filter(([key]) => !(array && key === 'length'));
    if (array && entries.length !== node.length) throw new Error('Sparse body arrays are not supported.');
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    charge(array ? '[]' : '{}'); parents.add(node);
    for (let index = 0; index < entries.length; index += 1) {
      const [key, descriptor] = entries[index];
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Body data properties are required.');
      if (array && key !== String(index)) throw new Error('Body array indexes must be contiguous.');
      if (index) charge(',');
      if (!array) charge(`${JSON.stringify(key)}:`);
      const child = copy(descriptor.value, depth + 1);
      if (array) (result as unknown[]).push(child);
      else Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    parents.delete(node); return result;
  };
  return copy(value, 0);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function distinct<T>(values: readonly T[]): T[] {
  return [...new Map(values.map(value => [canonicalJson(value), value])).values()];
}
function ordered<T>(values: readonly T[]): T[] {
  return distinct(values).sort((left, right) => {
    const a = canonicalJson(left), b = canonicalJson(right); return a < b ? -1 : a > b ? 1 : 0;
  });
}
function bundleIntent(bundle: ChatReferenceBundleV1): CanonicalBundle {
  return { primary: bundle.primary, supporting: ordered(bundle.supporting), packageConnections: ordered(bundle.packageConnections) };
}

function assertProjectionBudget(body: ChatBodyV1): void {
  const encoder = new TextEncoder();
  const captionBytes = new Map(body.bundles.map(bundle => [bundle.id, encoder.encode(bundle.caption).byteLength]));
  let bytes = 0;
  for (const part of body.parts) {
    bytes += part.type === 'text' ? encoder.encode(part.text).byteLength : captionBytes.get(part.bundleId) ?? 0;
    if (bytes > CHAT_BODY_MAX_BYTES) throw new Error('The projected chat body exceeds its UTF-8 byte limit.');
  }
}

/** Check both sides of the dependency graph, then reuse the existing turn envelope and limits. */
function selectionForBody(body: ChatBodyV1): ChatExtensionSelection | null {
  const bundles = new Map<string, ChatReferenceBundleV1>();
  for (const bundle of body.bundles) {
    if (bundles.has(bundle.id)) throw new Error('Body bundle IDs must be unique.');
    bundles.set(bundle.id, bundle);
    const primary = bundle.primary.selection;
    if (primary.kind !== 'plugin' && primary.kind !== 'skill') {
      if (bundle.supporting.length || bundle.packageConnections.length) throw new Error('Standalone references cannot hide dependencies.');
      continue;
    }
    const supporting = new Set(bundle.supporting.map(entry => canonicalJson(entry.selection)));
    const mapped = new Set<string>();
    for (const mapping of bundle.packageConnections) {
      if (canonicalJson(mapping.package) !== canonicalJson(primary.package)) throw new Error('A bundle mapping must use its primary exact package pin.');
      const connection = canonicalJson(mapping.connectionSelection);
      if (!supporting.has(connection)) throw new Error('Each bundle mapping requires its exact supporting selection.');
      mapped.add(connection);
    }
    for (const support of supporting) {
      if (!mapped.has(support)) throw new Error('Each supporting selection requires an explicit bundle mapping.');
    }
  }
  const occurrences = new Set<string>(), referenced = new Set<string>();
  const entries = new Map<string, ExtensionSelectionEntry>();
  const mappings = new Map<string, ExtensionPackageConnection>();
  for (const part of body.parts) {
    if (part.type === 'text') continue;
    if (occurrences.has(part.occurrenceId)) throw new Error('Body occurrence IDs must be unique.');
    occurrences.add(part.occurrenceId);
    const bundle = bundles.get(part.bundleId);
    if (!bundle) throw new Error('Each inline reference requires its exact bundle.');
    if (referenced.has(bundle.id)) continue;
    referenced.add(bundle.id);
    for (const entry of [bundle.primary, ...ordered(bundle.supporting)]) {
      const identity = extensionSelectionIdentity(entry.selection), previous = entries.get(identity);
      if (previous && canonicalJson(previous) !== canonicalJson(entry)) throw new Error('Conflicting complete selections cannot share an exact identity.');
      if (!previous) entries.set(identity, entry);
    }
    for (const mapping of ordered(bundle.packageConnections)) {
      const slot = canonicalJson([mapping.package, mapping.declarationPath, mapping.capabilityId]);
      const previous = mappings.get(slot);
      if (previous && canonicalJson(previous) !== canonicalJson(mapping)) throw new Error('A package slot cannot have conflicting mappings.');
      mappings.set(slot, mapping);
    }
  }
  if (referenced.size !== bundles.size) throw new Error('Unreferenced body bundles are not allowed.');
  if (!entries.size) return null;
  return chatExtensionSelectionSchema.parse({ version: 1, origin: 'turn_reference', selections: [...entries.values()],
    ...(mappings.size ? { packageConnections: [...mappings.values()] } : {}) });
}

export const chatBodyV1Schema = z.preprocess((value, context) => {
  try { return copyBodyJson(value); }
  catch {
    context.addIssue({ code: 'custom', message: 'A bounded plain JSON chat body is required.' }); return z.NEVER;
  }
}, bodyObjectSchema.superRefine((body, context) => {
  try { selectionForBody(body); assertProjectionBudget(body); }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid body selection graph.' }); }
}).transform(body => freeze({ ...body, bundles: body.bundles.map(bundle => ({ ...bundle,
  supporting: distinct(bundle.supporting), packageConnections: distinct(bundle.packageConnections) })) })));

export function parseChatBody(value: unknown): ChatBodyV1 { return chatBodyV1Schema.parse(value); }
export function projectChatBodyText(value: ChatBodyV1): string {
  const body = parseChatBody(value), bundles = new Map(body.bundles.map(bundle => [bundle.id, bundle]));
  return body.parts.map(part => part.type === 'text' ? part.text : bundles.get(part.bundleId)!.caption).join('');
}
export function deriveChatBodySelection(value: ChatBodyV1): ChatExtensionSelection | null {
  return freeze(selectionForBody(parseChatBody(value)));
}
export function canonicalChatBodyIntent(value: ChatBodyV1): CanonicalChatBodyIntentV1 {
  const body = parseChatBody(value), bundles = new Map(body.bundles.map(bundle => [bundle.id, bundle]));
  const parts: CanonicalChatBodyIntentV1['parts'] = [];
  const normalized: CanonicalBundle[] = [], indexes = new Map<string, number>(), bundleIndexes = new Map<string, number>();
  for (const part of body.parts) {
    if (part.type === 'extension_reference') {
      let index = bundleIndexes.get(part.bundleId);
      if (index === undefined) {
        const bundle = bundleIntent(bundles.get(part.bundleId)!), key = canonicalJson(bundle);
        index = indexes.get(key);
        if (index === undefined) { index = normalized.length; indexes.set(key, index); normalized.push(bundle); }
        bundleIndexes.set(part.bundleId, index);
      }
      parts.push({ type: part.type, bundleIndex: index });
    } else if (part.text) {
      const previous = parts[parts.length - 1];
      if (previous?.type === 'text') previous.text += part.text;
      else parts.push({ type: 'text', text: part.text });
    }
  }
  return freeze({ version: 1, parts, bundles: normalized });
}
export function assertChatBodyContent(body: ChatBodyV1, content: ChatBodyMessageContent): void {
  const expected = projectChatBodyText(body), actual = copyBodyJson(content);
  if (typeof actual === 'string' ? actual !== expected : !Array.isArray(actual)
    || actual[0]?.type !== 'text' || actual[0]?.text !== expected) {
    throw new Error('The original message text must exactly match its inline body projection.');
  }
}
export function assertChatBodySelection(body: ChatBodyV1, selection: ChatExtensionSelection | null): void {
  const expected = deriveChatBodySelection(body);
  const actual = selection === null ? null : chatExtensionSelectionSchema.parse(copyBodyJson(selection));
  const normalized = (value: ChatExtensionSelection | null) => value?.selections.length
    ? { selections: ordered(value.selections), packageConnections: ordered(value.packageConnections ?? []) } : null;
  if (canonicalJson(normalized(expected)) !== canonicalJson(normalized(actual))) {
    throw new Error('The turn selection must exactly match the inline body and its mapped dependencies.');
  }
}
