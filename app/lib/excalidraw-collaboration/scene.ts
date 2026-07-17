import crypto from 'node:crypto';

import {
  EXCALIDRAW_MAX_PATCH_ELEMENTS,
  EXCALIDRAW_MAX_SCENE_ELEMENTS,
  type ExcalidrawAssetMetadata,
  type ExcalidrawElementRecord,
  type ExcalidrawSharedAppState,
} from './protocol';

const ELEMENT_TYPES = new Set([
  'arrow', 'diamond', 'ellipse', 'embeddable', 'frame', 'freedraw', 'iframe',
  'image', 'line', 'magicframe', 'rectangle', 'selection', 'text',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_COLOR = /^(?:#[0-9A-Fa-f]{3,8}|transparent)$/u;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalSceneHash(input: {
  elements: readonly ExcalidrawElementRecord[];
  appState: ExcalidrawSharedAppState;
  assets?: readonly ExcalidrawAssetMetadata[];
}): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize({
    elements: [...input.elements].sort((left, right) => left.id.localeCompare(right.id)),
    appState: input.appState,
    assets: [...(input.assets ?? [])].sort((left, right) => left.fileId.localeCompare(right.fileId)),
  }))).digest('hex');
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeReference(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && SAFE_ID.test(value));
}

export function validateExcalidrawElement(value: unknown): ExcalidrawElementRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Excalidraw element must be an object.');
  const element = value as ExcalidrawElementRecord;
  if (!SAFE_ID.test(element.id || '')) throw new Error('Excalidraw element has an invalid id.');
  if (!ELEMENT_TYPES.has(element.type)) throw new Error(`Unsupported Excalidraw element type: ${String(element.type)}.`);
  if (!Number.isSafeInteger(element.version) || element.version < 1) throw new Error('Excalidraw element version must be a positive integer.');
  if (!Number.isSafeInteger(element.versionNonce) || element.versionNonce < 0) throw new Error('Excalidraw element versionNonce must be a non-negative integer.');
  if (typeof element.isDeleted !== 'boolean') throw new Error('Excalidraw element isDeleted must be boolean.');
  if (element.index !== undefined && element.index !== null && (typeof element.index !== 'string' || element.index.length > 128)) {
    throw new Error('Excalidraw element has an invalid fractional index.');
  }
  for (const key of ['x', 'y', 'width', 'height', 'angle', 'opacity'] as const) {
    if (key in element && !finite(element[key])) throw new Error(`Excalidraw element ${key} must be finite.`);
  }
  for (const key of ['containerId', 'frameId'] as const) {
    if (!safeReference(element[key])) throw new Error(`Excalidraw element ${key} is invalid.`);
  }
  if (element.groupIds !== undefined && (!Array.isArray(element.groupIds) || element.groupIds.some((id) => typeof id !== 'string' || !SAFE_ID.test(id)))) {
    throw new Error('Excalidraw element groupIds are invalid.');
  }
  if (element.boundElements !== undefined && element.boundElements !== null && (
    !Array.isArray(element.boundElements)
    || element.boundElements.some((binding) => !binding || typeof binding !== 'object' || !safeReference((binding as { id?: unknown }).id))
  )) throw new Error('Excalidraw bound elements are invalid.');
  for (const key of ['startBinding', 'endBinding'] as const) {
    const binding = element[key];
    if (binding !== undefined && binding !== null && (
      typeof binding !== 'object'
      || !safeReference((binding as { elementId?: unknown }).elementId)
    )) throw new Error(`Excalidraw ${key} is invalid.`);
  }
  return structuredClone(element);
}

export function validateExcalidrawElements(values: unknown, scope: 'patch' | 'scene'): ExcalidrawElementRecord[] {
  if (!Array.isArray(values)) throw new Error('Excalidraw elements must be an array.');
  const max = scope === 'patch' ? EXCALIDRAW_MAX_PATCH_ELEMENTS : EXCALIDRAW_MAX_SCENE_ELEMENTS;
  if (values.length > max) throw new Error(`Excalidraw ${scope} exceeds the ${max} element limit.`);
  const elements = values.map(validateExcalidrawElement);
  const ids = new Set<string>();
  for (const element of elements) {
    if (ids.has(element.id)) throw new Error(`Duplicate Excalidraw element id: ${element.id}.`);
    ids.add(element.id);
  }
  return elements;
}

export function sharedExcalidrawAppState(value: unknown): ExcalidrawSharedAppState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: ExcalidrawSharedAppState = {};
  if (typeof input.viewBackgroundColor === 'string' && SAFE_COLOR.test(input.viewBackgroundColor)) {
    output.viewBackgroundColor = input.viewBackgroundColor;
  }
  if (input.gridSize === null || (Number.isSafeInteger(input.gridSize) && Number(input.gridSize) >= 1 && Number(input.gridSize) <= 1_000)) {
    output.gridSize = input.gridSize as number | null;
  }
  if (Number.isSafeInteger(input.gridStep) && Number(input.gridStep) >= 1 && Number(input.gridStep) <= 100) {
    output.gridStep = Number(input.gridStep);
  }
  if (typeof input.gridModeEnabled === 'boolean') output.gridModeEnabled = input.gridModeEnabled;
  return output;
}

export function remoteElementWins(local: ExcalidrawElementRecord | undefined, remote: ExcalidrawElementRecord): boolean {
  if (!local) return true;
  return remote.version > local.version
    || (remote.version === local.version && remote.versionNonce < local.versionNonce);
}

/** Server merge mirrors the version/versionNonce winner used by Excalidraw's public reconcileElements API. */
export function mergeExcalidrawElements(
  current: readonly ExcalidrawElementRecord[],
  patch: readonly ExcalidrawElementRecord[],
): { elements: ExcalidrawElementRecord[]; accepted: ExcalidrawElementRecord[] } {
  const byId = new Map(current.map((element) => [element.id, element]));
  const accepted: ExcalidrawElementRecord[] = [];
  for (const remote of patch) {
    if (!remoteElementWins(byId.get(remote.id), remote)) continue;
    const clone = structuredClone(remote);
    byId.set(clone.id, clone);
    accepted.push(clone);
  }
  const fallbackOrder = new Map(current.map((element, index) => [element.id, index]));
  const elements = [...byId.values()].sort((left, right) => {
    const leftIndex = typeof left.index === 'string' ? left.index : '';
    const rightIndex = typeof right.index === 'string' ? right.index : '';
    if (leftIndex && rightIndex && leftIndex !== rightIndex) return leftIndex.localeCompare(rightIndex);
    if (leftIndex !== rightIndex) return leftIndex ? -1 : 1;
    return (fallbackOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (fallbackOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id);
  });
  return { elements, accepted };
}

export function validateExcalidrawSceneReferences(elements: readonly ExcalidrawElementRecord[]): void {
  const ids = new Set(elements.map((element) => element.id));
  const requireReference = (owner: string, value: unknown, field: string) => {
    if (typeof value === 'string' && !ids.has(value)) {
      throw new Error(`Excalidraw element ${owner} references missing ${field} ${value}.`);
    }
  };
  for (const element of elements) {
    requireReference(element.id, element.containerId, 'container');
    requireReference(element.id, element.frameId, 'frame');
    if (Array.isArray(element.boundElements)) {
      for (const binding of element.boundElements) {
        requireReference(element.id, (binding as { id?: unknown }).id, 'bound element');
      }
    }
    for (const key of ['startBinding', 'endBinding'] as const) {
      const binding = element[key];
      if (binding && typeof binding === 'object') {
        requireReference(element.id, (binding as { elementId?: unknown }).elementId, key);
      }
    }
  }
}
