/** A provider response may confirm readiness; a return marker or missing auth requirement cannot. */
export function isSharedConnectionConnected(source: 'mcp' | 'composio', value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (source === 'mcp') {
    return Reflect.get(value, 'configured') === true && (Reflect.get(value, 'code') === null || Reflect.get(value, 'code') === undefined)
      && (Reflect.get(value, 'requiresAuth') === false || Reflect.get(value, 'requiresAuth') === true && Reflect.get(value, 'authorized') === true);
  }
  const status: unknown = Reflect.get(value, 'status');
  return Boolean(status && typeof status === 'object' && !Array.isArray(status) && Reflect.get(status, 'connected') === true);
}
