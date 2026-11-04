import { types } from 'node:util';
import { captureBoundedMcpToolJson, type JsonRecord } from '../mcp/server/bounded-tool-json';
import { decodeDirectMcpWorkspaceMoveRequestV1, decodeDirectMcpWorkspaceDeleteRequestV1,
  WorkspacePathToolError, WORKSPACE_PATH_REQUEST_MAX_BYTES,
  type DecodedDirectMcpWorkspaceMoveRequestV1, type DecodedDirectMcpWorkspaceDeleteRequestV1 } from '../mcp/server/workspace-path-tool-contract';

/** Caller identity data only; selection never borrows authority or looks up a job. */
export function selectApiKeyPathOperationId(value: unknown, source: 'request' | 'mcp'): string | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, source === 'request' ? 'operationId' : 'operation_id');
  const id: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(id) ? id : undefined;
}

function pathWireRequest(value: unknown, source: 'request' | 'mcp'): unknown {
  if (source === 'mcp') return value;
  const selected = selectApiKeyPathOperationId(value, source);
  const invalid = (): never => { throw new WorkspacePathToolError('INVALID_REQUEST', selected); };
  const row = captureBoundedMcpToolJson(value, WORKSPACE_PATH_REQUEST_MAX_BYTES, invalid,
    () => { throw new WorkspacePathToolError('PATH_TOO_LARGE', selected); }, true);
  if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid();
  const fields: Record<string, string> = { apiVersion: 'api_version', action: 'action', workspaceId: 'workspace_id',
    operationId: 'operation_id', planId: 'plan_id', selections: 'selections', path: 'path' };
  if (Object.keys(row).some(key => !Object.hasOwn(fields, key))) return invalid();
  const mapped: JsonRecord = {};
  for (const [key, item] of Object.entries(row)) mapped[fields[key]] = item;
  if (Object.hasOwn(row, 'selections')) {
    if (!Array.isArray(row.selections)) return invalid();
    mapped.selections = row.selections.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2
        || !Object.hasOwn(item, 'sourcePath') || !Object.hasOwn(item, 'destinationPath')) return invalid();
      return { source_path: item.sourcePath, destination_path: item.destinationPath };
    });
  }
  return mapped;
}

function assertMcpVisiblePaths(request: DecodedDirectMcpWorkspaceMoveRequestV1 | DecodedDirectMcpWorkspaceDeleteRequestV1,
  source: 'request' | 'mcp'): void {
  if (source !== 'mcp' || request.action === 'status') return;
  const paths = 'selections' in request ? request.selections.flatMap(item => [item.sourcePath, item.destinationPath]) : [request.path];
  if (paths.some(value => value.split('/').some(segment => segment.startsWith('.')))) {
    throw new WorkspacePathToolError('ACCESS_DENIED', request.action === 'preview' ? undefined : request.operationId);
  }
}

/** Both transports retain the existing strict native-only V1 action decoder. */
export function decodeApiKeyWorkspaceMoveRequest(value: unknown, source: 'request' | 'mcp') {
  const request = decodeDirectMcpWorkspaceMoveRequestV1(pathWireRequest(value, source));
  assertMcpVisiblePaths(request, source); return request;
}
export function decodeApiKeyWorkspaceDeleteRequest(value: unknown, source: 'request' | 'mcp') {
  const request = decodeDirectMcpWorkspaceDeleteRequestV1(pathWireRequest(value, source));
  assertMcpVisiblePaths(request, source); return request;
}
