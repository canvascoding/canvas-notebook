import type { McpAppDescriptor } from './apps-types';

const SHARED_KEYS = new Set(['version', 'connectionRef', 'toolCallId', 'toolName', 'resourceUri', 'bindingRevision']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const SHARED_REF = /^canvas-connection:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Transport identity only. Parsing a descriptor never issues execution authority. */
export function readMcpAppDescriptor(value: unknown): McpAppDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const app = value as Record<string, unknown>;
  if (typeof app.toolName !== 'string' || !app.toolName || app.toolName.length > 256
    || typeof app.resourceUri !== 'string' || app.resourceUri.length > 4096 || !/^ui:\/\/[^\s]+$/u.test(app.resourceUri)) return null;
  if (app.version === 1) {
    if (typeof app.connectionId !== 'string' || !UUID.test(app.connectionId)) return null;
    return { version: 1, connectionId: app.connectionId, toolName: app.toolName, resourceUri: app.resourceUri };
  }
  if (app.version !== 2 || Object.keys(app).length !== SHARED_KEYS.size
    || !Object.keys(app).every(key => SHARED_KEYS.has(key))
    || typeof app.connectionRef !== 'string' || !SHARED_REF.test(app.connectionRef)
    || typeof app.toolCallId !== 'string' || !app.toolCallId.trim() || app.toolCallId.length > 256 || CONTROL_CHARACTERS.test(app.toolCallId)
    || !app.toolName.trim() || typeof app.bindingRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(app.bindingRevision)) return null;
  return { version: 2, connectionRef: app.connectionRef, toolCallId: app.toolCallId, toolName: app.toolName,
    resourceUri: app.resourceUri, bindingRevision: app.bindingRevision };
}

/** Private server proofs remain in persistence only, including nested event envelopes. */
export function stripMcpAppAuthority(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result = value.map(stripMcpAppAuthority);
    return result.some((entry, index) => entry !== value[index]) ? result : value;
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'mcpAppAuthority') { changed = true; continue; }
    result[key] = stripMcpAppAuthority(entry);
    if (result[key] !== entry) changed = true;
  }
  return changed ? result : value;
}
