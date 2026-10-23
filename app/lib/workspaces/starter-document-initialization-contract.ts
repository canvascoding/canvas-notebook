/** Public status only. Contains no filesystem paths, session IDs or native state. */
export type WorkspaceStarterInitializationResult = Readonly<{
  version: 1;
  workspaceId: string;
  status: 'completed' | 'pending' | 'blocked' | 'not_required';
  code?: string;
  operationId?: string;
  requestId?: string;
}>;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export function parseWorkspaceStarterInitializationResult(value: unknown): WorkspaceStarterInitializationResult | null {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !['version', 'workspaceId', 'status', 'code', 'operationId', 'requestId'].includes(String(key)))) return null;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  if (['version', 'workspaceId', 'status'].some(key => !Object.hasOwn(value, key))) return null;
  const result = value as WorkspaceStarterInitializationResult;
  if (result.version !== 1 || typeof result.workspaceId !== 'string' || !result.workspaceId || result.workspaceId.length > 256
    || result.workspaceId !== result.workspaceId.trim() || /[\u0000-\u001f\u007f]/u.test(result.workspaceId)
    || !['completed', 'pending', 'blocked', 'not_required'].includes(result.status)
    || result.code !== undefined && (typeof result.code !== 'string' || !/^WORKSPACE_STARTER_[A-Z_]{1,80}$/u.test(result.code))
    || result.operationId !== undefined && (typeof result.operationId !== 'string' || !uuid.test(result.operationId))
    || result.requestId !== undefined && (typeof result.requestId !== 'string' || !uuid.test(result.requestId))
    || (result.operationId === undefined) !== (result.requestId === undefined)) return null;
  return Object.freeze({ version: 1, workspaceId: result.workspaceId, status: result.status,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.operationId === undefined ? {} : { operationId: result.operationId, requestId: result.requestId }) });
}
