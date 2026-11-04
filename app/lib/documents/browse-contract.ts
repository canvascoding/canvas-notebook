import { types } from 'node:util';

export type WorkspaceBrowsePurpose = 'tree' | 'overview' | 'manifest';
export type WorkspaceBrowseRequestV1 = Readonly<{ apiVersion: 1; workspaceId: string; purpose: WorkspaceBrowsePurpose;
  path?: string; maxDepth?: number; maxEntries?: number; cursor?: string }>;
export type DecodedWorkspaceBrowseRequestV1 = Readonly<{ apiVersion: 1; workspaceId: string; purpose: WorkspaceBrowsePurpose;
  path: string; maxDepth: number; maxEntries: number; cursor: string | null }>;
const statuses = { INVALID_BROWSE_REQUEST: 400, INVALID_TREE_REQUEST: 400, WORKSPACE_TREE_CHANGED: 409 } as const;
export class WorkspaceBrowseError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof statuses) { super(code); this.name = 'WorkspaceBrowseError'; this.status = statuses[code]; }
}
const keys = new Set(['apiVersion', 'workspaceId', 'purpose', 'path', 'maxDepth', 'maxEntries', 'cursor']);
const wellFormed = (value: string) => Buffer.from(value, 'utf8').toString('utf8') === value;
function invalid(): never { throw new WorkspaceBrowseError('INVALID_BROWSE_REQUEST'); }

/** Selectors only. Authentication source, identity and permissions are never input. */
export function decodeWorkspaceBrowseRequestV1(value: unknown): DecodedWorkspaceBrowseRequestV1 {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.has(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) invalid();
  }
  const workspaceId = descriptors.workspaceId?.value, purpose = descriptors.purpose?.value;
  if (descriptors.apiVersion?.value !== 1 || typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256
    || workspaceId !== workspaceId.trim() || !wellFormed(workspaceId) || /[\u0000-\u001f\u007f]/u.test(workspaceId)
    || purpose !== 'tree' && purpose !== 'overview' && purpose !== 'manifest') invalid();
  if (purpose === 'overview' && ['path', 'maxDepth', 'maxEntries', 'cursor'].some(key => Object.hasOwn(descriptors, key))) invalid();
  const path = Object.hasOwn(descriptors, 'path') ? descriptors.path.value : '.';
  if (typeof path !== 'string' || !path || path.length > 4096 || !wellFormed(path) || path.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(path) || path !== '.' && path.split('/').some(part => !part || part.startsWith('.'))) invalid();
  const maxDepth = Object.hasOwn(descriptors, 'maxDepth') ? descriptors.maxDepth.value : 2;
  const maxEntries = Object.hasOwn(descriptors, 'maxEntries') ? descriptors.maxEntries.value : purpose === 'manifest' ? 10 : 200;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 6
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > (purpose === 'manifest' ? 20 : 500)) invalid();
  const cursor = Object.hasOwn(descriptors, 'cursor') ? descriptors.cursor.value : null;
  if (Object.hasOwn(descriptors, 'cursor') && (typeof cursor !== 'string' || !cursor || cursor.length > 20000
    || !wellFormed(cursor) || /[\u0000-\u001f\u007f]/u.test(cursor))) invalid();
  return Object.freeze({ apiVersion: 1, workspaceId, purpose, path, maxDepth, maxEntries, cursor });
}

/** Snake-case MCP arguments share the exact REST decoder, without evaluating getters. */
export function decodeMcpWorkspaceBrowseRequest(tool: 'list_knowledge_tree' | 'get_workspace_overview' | 'get_knowledge_manifest', args: unknown) {
  if (!args || typeof args !== 'object' || types.isProxy(args) || Object.getPrototypeOf(args) !== Object.prototype) invalid();
  const names: Record<string, string> = { workspace_id: 'workspaceId', path: 'path', max_depth: 'maxDepth', max_entries: 'maxEntries', cursor: 'cursor' };
  const selected: Record<string, unknown> = { apiVersion: 1, purpose: tool === 'list_knowledge_tree' ? 'tree' : tool === 'get_workspace_overview' ? 'overview' : 'manifest' };
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'string' || !Object.hasOwn(names, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(args, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    selected[names[key]] = descriptor.value;
  }
  decodeWorkspaceBrowseRequestV1(selected);
  return selected as WorkspaceBrowseRequestV1;
}
