import type { ChatBodyV1 } from './chat-body-contracts';
import type { ChatExtensionSelectionInput } from '@/app/lib/capabilities/extensions/contracts';

/** Explicit message intent and target fences, separate from descriptive prompt context. */
export type ChatMessageSubmissionOptions = {
  body?: ChatBodyV1;
  selection?: ChatExtensionSelectionInput | null;
  expectedAgentId?: string;
  expectedWorkspaceId?: string;
};

export function isValidChatClientMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/u.test(value);
}

/** Reconcile legacy nested and envelope IDs without manufacturing a new logical send. */
export function resolveChatClientMessageId(outer: unknown, nested: unknown): string {
  if ((outer !== undefined && !isValidChatClientMessageId(outer))
    || (nested !== undefined && !isValidChatClientMessageId(nested))
    || (outer === undefined && nested === undefined)
    || (outer !== undefined && nested !== undefined && outer !== nested)) {
    throw Object.assign(new Error('A stable, consistent client message ID is required.'),
      { code: 'INVALID_CLIENT_MESSAGE_ID', statusCode: 400 });
  }
  return (outer ?? nested) as string;
}

/** Capture transport JSON without evaluating accessors or serializing caller-owned objects. */
export function captureChatTransportJson<T>(value: T): T {
  const ancestors = new Set<object>(), encoder = new TextEncoder();
  let bytes = 0;
  const charge = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('Message transport JSON exceeds its byte limit.');
  };
  const copy = (node: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('Message transport JSON exceeds its depth limit.');
    if (node === null || typeof node === 'string' || typeof node === 'boolean'
      || typeof node === 'number' && Number.isFinite(node)) { charge(JSON.stringify(node)); return node; }
    if (!node || typeof node !== 'object' || ancestors.has(node)) throw new Error('Plain message JSON is required.');
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)
      || Object.getOwnPropertySymbols(node).length) throw new Error('Plain message JSON is required.');
    const descriptors = Object.getOwnPropertyDescriptors(node);
    const entries = Object.entries(descriptors).filter(([key]) => !(array && key === 'length'));
    if (array && entries.length !== node.length) throw new Error('Contiguous message arrays are required.');
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    ancestors.add(node); charge(array ? '[]' : '{}');
    for (let index = 0; index < entries.length; index++) {
      const [key, descriptor] = entries[index];
      if (!('value' in descriptor) || !descriptor.enumerable || array && key !== String(index))
        throw new Error('Enumerable message JSON data properties are required.');
      if (index) charge(',');
      if (!array) charge(`${JSON.stringify(key)}:`);
      const child = copy(descriptor.value, depth + 1);
      if (array) (result as unknown[]).push(child);
      else Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(node); return result;
  };
  return copy(value, 0) as T;
}
