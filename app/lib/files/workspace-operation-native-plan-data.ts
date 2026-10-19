import 'server-only';

import { types } from 'node:util';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';

const MAX_PLAN_BYTES = 16 * 1024 * 1024;

/** Exact JSON string size without allocating its escaped serialization. */
function serializedStringBytes(value: string, maximum: number, reject: (reason: 'invalid' | 'too-large') => never): number {
  let bytes = Buffer.byteLength(value) + 2;
  if (bytes > maximum) reject('too-large');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes++;
    else if (code <= 0x1f) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
      else bytes += 3; // JSON escapes the lone surrogate; UTF-8 counts U+FFFD.
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 3;
    if (bytes > maximum) reject('too-large');
  }
  return bytes;
}

/** Bounded data capture only; callers retain their own plan and error contracts. */
export function captureWorkspaceOperationNativePlanData(input: unknown,
  reject: (reason: 'invalid' | 'too-large') => never, serializedByteLimit?: number): unknown {
  if (serializedByteLimit !== undefined && (!Number.isSafeInteger(serializedByteLimit)
    || serializedByteLimit < 1 || serializedByteLimit > MAX_PLAN_BYTES)) reject('invalid');
  let serializedRemaining = serializedByteLimit ?? Infinity;
  const charge = (bytes: number): void => { serializedRemaining -= bytes; if (serializedRemaining < 0) reject('too-large'); };
  let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 400_000 || depth > 40) reject('too-large');
    if (value === null || typeof value === 'boolean') {
      if (serializedByteLimit !== undefined) charge(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) reject('invalid');
      if (serializedByteLimit !== undefined) charge(Buffer.byteLength(String(value)));
      return value;
    }
    if (typeof value === 'string') {
      if (serializedByteLimit !== undefined) charge(serializedStringBytes(value, serializedRemaining, reject));
      bytes += Buffer.byteLength(value); if (bytes > MAX_PLAN_BYTES) reject('too-large'); return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value)
      || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) reject('invalid');
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) reject('invalid');
      if (serializedByteLimit !== undefined) charge(2 + Math.max(0, value.length - 1));
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('invalid');
        return visit(descriptor.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    let fields = 0;
    if (serializedByteLimit !== undefined) charge(2);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('invalid');
      if (serializedByteLimit !== undefined) charge(serializedStringBytes(key, serializedRemaining, reject) + 1 + (fields++ ? 1 : 0));
      bytes += Buffer.byteLength(key); if (bytes > MAX_PLAN_BYTES) reject('too-large');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const value = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PLAN_BYTES) reject('too-large');
  return value;
}

/** Complete native inventory projection; this grants no mutation authority. */
export function workspaceOperationNativePlanSnapshot(observation: Pick<WorkspaceLinkSourceAuthorityObservation, 'stage'>,
  reject: () => never): NativeWorkspaceLinkSnapshot {
  const { stage } = observation;
  if (!stage.coverage.complete || stage.coverage.gaps.length || stage.sources.some(source => source.kind !== 'native')) reject();
  const body = { contractVersion: 2 as const, workspaceId: stage.workspaceId, namespace: stage.namespace,
    documents: stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []), coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
