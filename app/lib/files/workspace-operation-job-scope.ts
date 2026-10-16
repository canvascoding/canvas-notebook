import path from 'node:path';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { isCanonicalWorkspacePath } from '@/app/lib/workspaces/path-identity';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';

const keys = ['version', 'workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId',
  'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy'] as const;
const nullableIds = ['organizationId', 'customerId', 'projectId', 'ownerUserId'] as const;
const invalid = (): never => { throw new TypeError('Invalid workspace operation job scope.'); };
const plain = (input: unknown): input is Record<string, unknown> => Boolean(input)
  && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype;

function data(input: Record<string, unknown>, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return optional ? undefined : invalid();
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return invalid();
  return descriptor.value;
}

function id(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(input);
}

/** Parse exact primitive data without normalizing case, path spelling or whitespace. */
export function parseWorkspaceOperationJobScope(input: unknown): WorkspaceOperationJobScope {
  if (!plain(input) || Reflect.ownKeys(input).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(input, key))) return invalid();
  const captured = Object.fromEntries(keys.map(key => [key, data(input, key)]));
  if (captured.version !== 1 || !id(captured.workspaceId)
    || !['personal', 'organization', 'team', 'project'].includes(captured.workspaceType as string)
    || nullableIds.some(key => captured[key] !== null && !id(captured[key]))
    || typeof captured.rootPath !== 'string' || captured.rootPath.length > 4096
    || !path.isAbsolute(captured.rootPath) || !captured.rootPath.startsWith('/')
    || !isCanonicalWorkspacePath(captured.rootPath.slice(1), true)
    || captured.rootRelativePath !== null && !isCanonicalWorkspacePath(captured.rootRelativePath, true)
    || typeof captured.legacy !== 'boolean') return invalid();
  return Object.freeze(captured) as WorkspaceOperationJobScope;
}

/** Namespace capture only: permissions, actor, status, FS and database proofs are separate. */
export function captureWorkspaceOperationJobScope(workspace: WorkspaceContext): WorkspaceOperationJobScope {
  if (!plain(workspace)) return invalid();
  const captured: Record<string, unknown> = { version: 1 };
  for (const key of keys.filter(key => key !== 'version')) {
    const optional = key === 'rootRelativePath' || nullableIds.some(candidate => candidate === key);
    const value = data(workspace, key, optional);
    captured[key] = optional && (value === undefined || value === null) ? null : value;
  }
  return parseWorkspaceOperationJobScope(captured);
}

export function workspaceOperationJobScopeMatches(scope: unknown, workspace: WorkspaceContext): boolean {
  try {
    const bound = parseWorkspaceOperationJobScope(scope), current = captureWorkspaceOperationJobScope(workspace);
    return keys.every(key => bound[key] === current[key]);
  } catch { return false; }
}
