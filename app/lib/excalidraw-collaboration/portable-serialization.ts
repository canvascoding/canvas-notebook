import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { EXCALIDRAW_FILE_SOURCE } from '../excalidraw-file';
import { EXCALIDRAW_MAX_ASSET_REFERENCES, EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import type { ExcalidrawAssetMetadata, ExcalidrawElementRecord, ExcalidrawSharedAppState } from './protocol';
import { captureExcalidrawReadonlyAssetMetadata } from './readonly-assets';
import { canonicalSceneHash, sharedExcalidrawAppState, validateExcalidrawElements,
  validateExcalidrawSceneAssetReferences, validateExcalidrawSceneReferences } from './scene';

export type PortableExcalidrawSceneSource = Readonly<{
  elements: readonly ExcalidrawElementRecord[]; appState: ExcalidrawSharedAppState;
  assets: readonly ExcalidrawAssetMetadata[]; canonicalHash: string;
}>;
export type PortableExcalidrawAssetBytes = Readonly<{ metadata: Readonly<ExcalidrawAssetMetadata>; bytes: Uint8Array }>;
export class ExcalidrawPortableSerializationError extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: 'EXCALIDRAW_PORTABLE_INVALID' | 'EXCALIDRAW_PORTABLE_TOO_LARGE') {
    super('The portable Excalidraw scene could not be serialized within its byte budget.');
    this.name = 'ExcalidrawPortableSerializationError'; this.status = code === 'EXCALIDRAW_PORTABLE_TOO_LARGE' ? 413 : 409;
  }
}
const invalid = (): never => { throw new ExcalidrawPortableSerializationError('EXCALIDRAW_PORTABLE_INVALID'); };
const large = (): never => { throw new ExcalidrawPortableSerializationError('EXCALIDRAW_PORTABLE_TOO_LARGE'); };
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
  }
  return input as Record<string, unknown>;
}
function list(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
  if (input.length > maximum) return large();
  if (Reflect.ownKeys(input).length !== input.length + 1) return invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid(); return descriptor.value;
  });
}
/** JSON.stringify emits lone surrogates as six ASCII escape bytes. Count
 * encoded bytes directly so control characters cannot multiply an allocation. */
function jsonStringBytes(value: string, maximum: number): number {
  let bytes = 2;
  if (bytes > maximum) return large();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; } else bytes += 6;
    } else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
    if (bytes > maximum) return large();
  }
  return bytes;
}
/** Exact compact/pretty2 size without constructing a JSON string. This stays
 * private to the portable codec and inspects data descriptors before values. */
function jsonBytes(input: unknown, pretty: boolean, maximumNodes = 2_000_000): number {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const charge = (size: number): void => { bytes += size; if (bytes > EXCALIDRAW_PORTABLE_MAX_BYTES) return large(); };
  const string = (value: string): void => charge(jsonStringBytes(value, EXCALIDRAW_PORTABLE_MAX_BYTES - bytes));
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > maximumNodes || depth > 40) return large();
    if (value === null) { charge(4); return; }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid(); charge(JSON.stringify(value).length); return;
    }
    if (typeof value === 'string') { string(value); return; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return invalid();
    ancestors.add(value);
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const entries = array ? list(value, 100_000) : Reflect.ownKeys(value);
    charge(2 + Math.max(0, entries.length - 1));
    if (pretty && entries.length) charge(entries.length * (1 + 2 * (depth + 1)) + 1 + 2 * depth);
    for (const entry of entries) {
      if (array) visit(entry, depth + 1);
      else {
        if (typeof entry !== 'string') return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, entry);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        string(entry); charge(pretty ? 2 : 1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  visit(input, 0); return bytes;
}
/** Bounded JSON data capture before any element validator can inspect values. */
function sceneData(input: unknown): unknown {
  jsonBytes(input, false);
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 2_000_000 || depth > 40) return large();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) return invalid(); return value; }
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return invalid();
    ancestors.add(value); let output: unknown;
    if (Array.isArray(value)) output = list(value, 100_000).map(child => visit(child, depth + 1));
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
      const record: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        Object.defineProperty(record, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      output = record;
    }
    ancestors.delete(value); return output;
  };
  return visit(input, 0);
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
function binary(input: unknown, length: number): Uint8Array {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(input, key))) return invalid();
  if (byteLength.call(input) !== length || Object.getPrototypeOf(arrayBuffer.call(input)) !== ArrayBuffer.prototype) return invalid();
  const output = new Uint8Array(length); Uint8Array.prototype.set.call(output, input as Uint8Array); return output;
}

/** Pure portable serialization from explicit data and owned bytes. It never
 * loads an asset, changes last-reference clocks or creates publication rights. */
export function serializePortableExcalidrawSceneFromReadonlyAssets(source: PortableExcalidrawSceneSource,
  inputAssets: readonly PortableExcalidrawAssetBytes[]): string {
  try {
    const input = object(source, ['elements', 'appState', 'assets', 'canonicalHash']);
    const captured = object(sceneData(input), ['elements', 'appState', 'assets', 'canonicalHash']);
    const elements = validateExcalidrawElements(captured.elements, 'scene');
    const appState = sharedExcalidrawAppState(captured.appState);
    if (!captured.appState || typeof captured.appState !== 'object' || Array.isArray(captured.appState)
      || !isDeepStrictEqual(appState, captured.appState)) return invalid();
    const metadata = list(captured.assets, EXCALIDRAW_MAX_ASSET_REFERENCES).map(captureExcalidrawReadonlyAssetMetadata);
    if (new Set(metadata.map(asset => asset.fileId)).size !== metadata.length
      || typeof captured.canonicalHash !== 'string' || canonicalSceneHash({ elements, appState, assets: metadata }) !== captured.canonicalHash) return invalid();
    validateExcalidrawSceneReferences(elements); validateExcalidrawSceneAssetReferences(elements, metadata);
    const requested = list(inputAssets, EXCALIDRAW_MAX_ASSET_REFERENCES);
    if (requested.length !== metadata.length) return invalid();
    const supplied = new Map<string, Record<string, unknown>>();
    for (const raw of requested) {
      const entry = object(raw, ['metadata', 'bytes']), header = captureExcalidrawReadonlyAssetMetadata(entry.metadata);
      if (supplied.has(header.fileId)) return invalid(); supplied.set(header.fileId, { metadata: header, bytes: entry.bytes });
    }
    const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number; lastRetrieved: number; version: number }> = Object.create(null);
    let base64Bytes = 0;
    for (const header of metadata) {
      if (!isDeepStrictEqual(supplied.get(header.fileId)?.metadata, header)) return invalid();
      files[header.fileId] = { id: header.fileId, mimeType: header.mimeType, dataURL: `data:${header.mimeType};base64,`,
        created: header.createdAt, lastRetrieved: header.createdAt, version: header.version };
      base64Bytes += Math.ceil(header.sizeBytes / 3) * 4;
      if (base64Bytes > EXCALIDRAW_PORTABLE_MAX_BYTES) return large();
    }
    const scene = { type: 'excalidraw', version: 2, source: EXCALIDRAW_FILE_SOURCE, elements, appState, files };
    // The portable envelope adds two values to the already bounded source.
    if (jsonBytes(scene, true, 2_000_002) + base64Bytes > EXCALIDRAW_PORTABLE_MAX_BYTES) return large();
    for (const header of metadata) {
      const bytes = binary(supplied.get(header.fileId)!.bytes, header.sizeBytes);
      if (createHash('sha256').update(bytes).digest('hex') !== header.contentHash) return invalid();
      files[header.fileId].dataURL += Buffer.from(bytes).toString('base64');
    }
    const content = JSON.stringify(scene, null, 2);
    if (Buffer.byteLength(content) > EXCALIDRAW_PORTABLE_MAX_BYTES) return large(); return content;
  } catch (error) {
    if (error instanceof ExcalidrawPortableSerializationError) throw error;
    const status = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status')?.value : undefined;
    if (status === 413) return large(); return invalid();
  }
}
