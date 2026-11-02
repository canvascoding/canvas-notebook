import { createHash } from 'node:crypto';
import { types } from 'node:util';

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
}

/** Observation only: never classifies permission, retryability or recovery.
 * Accessors, proxies, messages, stacks, paths and credentials are not exposed.
 * A bounded native Error message is fingerprinted so its original throw site
 * can be identified locally after a public boundary has normalized the error. */
export function captureCollaborationDiagnosticCause(error: unknown): Readonly<{ code: string; fingerprint?: string }> {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return Object.freeze({ code: 'UNCLASSIFIED' });
  const observedCode = ownData(error, 'code');
  const code = typeof observedCode === 'string' && observedCode.length <= 100
    && /^(?:[0-9]{2}[A-Z0-9]{3}|(?:NATIVE|COLLABORATION|ROOM_OWNER|PRINCIPAL|WORKSPACE|FILE_LIFECYCLE|MCP)_[A-Z0-9_]+|SQLITE_BUSY|SQLITE_LOCKED)$/u.test(observedCode)
    ? observedCode : types.isNativeError(error) ? 'NATIVE_ERROR' : 'UNCLASSIFIED';
  const message = types.isNativeError(error) ? ownData(error, 'message') : undefined;
  const fingerprint = typeof message === 'string' && Buffer.byteLength(message, 'utf8') <= 4096
    ? createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 16) : undefined;
  return Object.freeze({ code, ...(fingerprint ? { fingerprint } : {}) });
}
