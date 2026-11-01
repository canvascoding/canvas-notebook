import 'server-only';
import { types } from 'node:util';
import type { ApiKeyDocumentCreateOrigin } from './document-read-principal';

export const apiKeyCreateOriginKeys = Object.freeze(['kind', 'userId', 'integrationId', 'instanceId', 'credentialId',
  'workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId', 'ownerUserId', 'rootPath',
  'rootRelativePath', 'legacy', 'status', 'schema', 'schemaOid', 'databaseOid', 'searchPath', 'purpose', 'entryPoint'] as const);

/** Strict historical scalar data only. No record, including a valid one,
 * authenticates a credential or grants a current database phase. */
export function captureApiKeyDocumentCreateOrigin(value: unknown): ApiKeyDocumentCreateOrigin | null {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== apiKeyCreateOriginKeys.length || keys.some(key => typeof key !== 'string'
    || !apiKeyCreateOriginKeys.includes(key as typeof apiKeyCreateOriginKeys[number]))) return null;
  const row: Record<string, unknown> = {};
  for (const key of apiKeyCreateOriginKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    row[key] = descriptor.value as unknown;
  }
  const text = (v: unknown, maximum: number, minimum = 1): v is string => typeof v === 'string' && v.length >= minimum && v.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(v) && Buffer.from(v, 'utf8').toString('utf8') === v;
  const id = (v: unknown) => text(v, 256) && v === v.trim();
  if (row.kind !== 'api_key' || !['create', 'import'].includes(row.purpose as string)
    || row.entryPoint !== 'request' && row.entryPoint !== 'mcp' || row.legacy !== false || row.status !== 'active'
    || !['personal', 'organization', 'team', 'project'].includes(row.workspaceType as string)
    || !['userId', 'integrationId', 'instanceId', 'credentialId', 'workspaceId'].every(key => id(row[key]))
    || !['organizationId', 'customerId', 'projectId', 'ownerUserId'].every(key => row[key] === null || id(row[key]))
    || !text(row.rootPath, 8192) || !text(row.rootRelativePath, 4096, 0) || !text(row.searchPath, 4096)
    || !text(row.schema, 63) || Buffer.byteLength(row.schema, 'utf8') > 63
    || !['schemaOid', 'databaseOid'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) > 0)) return null;
  return Object.freeze(row) as ApiKeyDocumentCreateOrigin;
}

/** Current permission must be proved separately. Rotation and another entry
 * point retain ownership; original credential attribution is never rewritten. */
export function sameApiKeyDocumentCreateOwner(original: ApiKeyDocumentCreateOrigin, current: ApiKeyDocumentCreateOrigin): boolean {
  return apiKeyCreateOriginKeys.every(key => key === 'credentialId' || key === 'entryPoint' || original[key] === current[key]);
}
