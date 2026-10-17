import type { ExcalidrawAgentSceneAction } from './agent-operations';
import { EXCALIDRAW_MAX_MESSAGE_BYTES } from './protocol';
import { validateExcalidrawElement } from './scene';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';

export const EXCALIDRAW_API_MAX_REQUEST_BYTES = EXCALIDRAW_MAX_MESSAGE_BYTES;

export class ExcalidrawApiInputError extends Error {
  readonly code = 'INVALID_EXCALIDRAW_REQUEST';
  readonly status = 400;
}

export type ExcalidrawCreateInput = { workspaceId?: string; path: string; idempotencyKey: string };
export type ExcalidrawGetInput = { workspaceId?: string; documentId?: string; path?: string };
export type ExcalidrawEditInput = ExcalidrawGetInput & { documentId: string; lifecycleGeneration: number;
  observedSceneSequence: number; actions: ExcalidrawAgentSceneAction[]; idempotencyKey: string };

function invalid(message: string): never { throw new ExcalidrawApiInputError(message); }

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A JSON object is required.');
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { invalid('The request must contain serializable JSON data.'); }
  if (Buffer.byteLength(serialized, 'utf8') > EXCALIDRAW_API_MAX_REQUEST_BYTES) {
    throw Object.assign(new ExcalidrawApiInputError('The Excalidraw request must not exceed 1 MiB.'), { status: 413 });
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !allowed.includes(key))) invalid('The request contains unsupported fields. Actor identity is supplied by Canvas.');
  return object;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name} must contain 1–${max} characters.`);
  return value;
}

function optionalText(input: Record<string, unknown>, name: string, max: number): string | undefined {
  return input[name] === undefined ? undefined : text(input[name], name, max);
}

function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(`${name} must be an integer of at least ${minimum}.`);
  return Number(value);
}

function idempotencyKey(input: Record<string, unknown>, defaults: { idempotencyKey?: string }): string {
  return text(input.idempotencyKey === undefined ? defaults.idempotencyKey : input.idempotencyKey, 'idempotencyKey', 500);
}

export function parseExcalidrawCreateInput(value: unknown, defaults: { idempotencyKey?: string } = {}): ExcalidrawCreateInput {
  const input = record(value, ['workspaceId', 'path', 'idempotencyKey']);
  return { workspaceId: optionalText(input, 'workspaceId', 200), path: text(input.path, 'path', 1024),
    idempotencyKey: idempotencyKey(input, defaults) };
}

export function parseExcalidrawGetInput(value: unknown): ExcalidrawGetInput {
  const input = record(value, ['workspaceId', 'documentId', 'path']);
  const result = { workspaceId: optionalText(input, 'workspaceId', 200),
    documentId: optionalText(input, 'documentId', 200), path: optionalText(input, 'path', 1024) };
  if (!result.documentId && !result.path) invalid('documentId or path is required.');
  return result;
}

export function parseExcalidrawEditInput(value: unknown, defaults: { idempotencyKey?: string } = {}): ExcalidrawEditInput {
  const input = record(value, ['workspaceId', 'documentId', 'path', 'lifecycleGeneration', 'observedSceneSequence', 'actions', 'idempotencyKey']);
  if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 500) invalid('actions must contain 1–500 element actions.');
  const targets = new Set<string>();
  const actions = input.actions.map((raw): ExcalidrawAgentSceneAction => {
    const action = record(raw, ['type', 'element', 'elementId', 'expectedVersion', 'expectedVersionNonce']);
    if (!['create', 'update', 'delete'].includes(String(action.type))) invalid('Each action must be create, update or delete.');
    const allowed = action.type === 'create' ? ['type', 'element']
      : action.type === 'update' ? ['type', 'elementId', 'expectedVersion', 'expectedVersionNonce', 'element']
        : ['type', 'elementId', 'expectedVersion', 'expectedVersionNonce'];
    if (Object.keys(action).some(key => !allowed.includes(key))) invalid('The action contains unsupported fields.');
    let element;
    if (action.type !== 'delete') {
      try { element = validateExcalidrawElement(action.element); }
      catch (error) { invalid(error instanceof Error ? error.message : 'The Excalidraw element is invalid.'); }
    }
    const target = action.type === 'create' ? element!.id : text(action.elementId, 'elementId', 128);
    if (targets.has(target)) invalid('Each element may be targeted only once per operation.');
    targets.add(target);
    if (action.type === 'create') return { type: 'create', element: element! };
    const expected = { elementId: target, expectedVersion: integer(action.expectedVersion, 'expectedVersion', 1),
      expectedVersionNonce: integer(action.expectedVersionNonce, 'expectedVersionNonce', 0) };
    if (action.type === 'delete') return { type: 'delete', ...expected };
    if (element!.id !== target) invalid('The update element ID must match elementId.');
    return { type: 'update', ...expected, element: element! };
  });
  return { workspaceId: optionalText(input, 'workspaceId', 200), documentId: text(input.documentId, 'documentId', 200),
    path: optionalText(input, 'path', 1024), lifecycleGeneration: integer(input.lifecycleGeneration, 'lifecycleGeneration', 1),
    observedSceneSequence: integer(input.observedSceneSequence, 'observedSceneSequence', 0), actions,
    idempotencyKey: idempotencyKey(input, defaults) };
}

export function excalidrawOperationFeedback<T extends { status: string; documentUrl: string }>(operation: T) {
  const reviewAvailable = readDocumentReviewAvailability().documentReviewEnabled;
  const reviewRequired = operation.status === 'needs_review';
  return { ...operation, reviewRequired, reviewAvailable,
    conflictHint: reviewRequired
      ? 'The changes have not been applied. Read the current scene again and submit updated actions with current element versions and a new idempotency key.' : null,
    reviewHint: reviewRequired && reviewAvailable
      ? 'The experimental Review Center is enabled. Open the document to accept or reject this proposal.' : null };
}
