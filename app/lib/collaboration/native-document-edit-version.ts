import 'server-only';

import { types } from 'node:util';
import { isDocumentVersionTokenV1 } from '../documents/contracts';
import { DocumentEditError } from '../documents/edit-contracts';
import type { DocumentVersionIdentityV1 } from '../documents/read-version';
import { captureIdentity } from './native-document-edit-validation';

/** Comparison data only. This cannot authorize a document connection. */
export type NativeDocumentEditVersion = Readonly<{
  identity: Readonly<DocumentVersionIdentityV1>;
  expectedVersion: string;
}>;

/** Detach caller-owned comparison data before the first queue/room await. */
export function captureNativeDocumentEditVersion(value: unknown): NativeDocumentEditVersion {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new DocumentEditError('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || keys.some(key => key !== 'identity' && key !== 'expectedVersion')) {
    throw new DocumentEditError('INVALID_REQUEST');
  }
  for (const key of ['identity', 'expectedVersion']) {
    if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) {
      throw new DocumentEditError('INVALID_REQUEST');
    }
  }
  if (!isDocumentVersionTokenV1(descriptors.expectedVersion.value)) throw new DocumentEditError('INVALID_REQUEST');
  return Object.freeze({ identity: captureIdentity(descriptors.identity.value as DocumentVersionIdentityV1),
    expectedVersion: descriptors.expectedVersion.value as string });
}
