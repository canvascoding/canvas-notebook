import 'server-only';

import { types } from 'node:util';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';

const MAX_PLAN_BYTES = 16 * 1024 * 1024;

/** Bounded data capture only; callers retain their own plan and error contracts. */
export function captureWorkspaceOperationNativePlanData(input: unknown,
  reject: (reason: 'invalid' | 'too-large') => never): unknown {
  let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 400_000 || depth > 40) reject('too-large');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) reject('invalid'); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > MAX_PLAN_BYTES) reject('too-large'); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value)
      || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) reject('invalid');
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) reject('invalid');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('invalid');
        return visit(descriptor.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('invalid');
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
