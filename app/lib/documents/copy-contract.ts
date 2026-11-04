import { types } from 'node:util';
import { captureBoundedMcpToolJson, type JsonRecord } from '../mcp/server/bounded-tool-json';
import { decodeDirectMcpWorkspaceCopyRequestV1, WORKSPACE_COPY_REQUEST_MAX_BYTES, WorkspaceCopyToolError } from '../mcp/server/workspace-copy-tool-contract';

/** Caller identity data only; never an operation lookup or authorization. */
export function selectApiKeyCopyOperationId(value: unknown, source: 'request' | 'mcp'): string | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, source === 'request' ? 'operationId' : 'operation_id');
  const id: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(id) ? id : undefined;
}

/** REST uses camelCase; both entrances share the existing strict native V1
 * Copy decoder, bounds and resolved-root semantics. No legacy body fallback. */
export function decodeApiKeyWorkspaceCopyRequest(value: unknown, source: 'request' | 'mcp') {
  const selected = selectApiKeyCopyOperationId(value, source);
  const invalid = (): never => { throw new WorkspaceCopyToolError('INVALID_REQUEST', selected); };
  let wire = value;
  if (source === 'request') {
    const row = captureBoundedMcpToolJson(value, WORKSPACE_COPY_REQUEST_MAX_BYTES, invalid,
      () => { throw new WorkspaceCopyToolError('COPY_TOO_LARGE', selected); }, true);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid();
    const fields: Record<string, string> = { apiVersion: 'api_version', action: 'action', sourceWorkspaceId: 'source_workspace_id',
      destinationWorkspaceId: 'destination_workspace_id', operationId: 'operation_id', planId: 'plan_id', selections: 'selections',
      renameOnCollision: 'rename_on_collision', destinationDirectory: 'destination_directory' };
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
    wire = mapped;
  }
  const request = decodeDirectMcpWorkspaceCopyRequestV1(wire);
  if (source === 'mcp' && request.action !== 'status') {
    const hidden = (value: string) => value !== '' && value.split('/').some(segment => segment.startsWith('.'));
    if (request.selections.some(item => hidden(item.sourcePath) || hidden(item.destinationPath))
      || request.destinationDirectory !== undefined && hidden(request.destinationDirectory)) {
      throw new WorkspaceCopyToolError('ACCESS_DENIED', selected);
    }
  }
  return request;
}
