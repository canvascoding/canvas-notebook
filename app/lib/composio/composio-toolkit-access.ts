export type ComposioToolkitAccess = {
  noAuth: boolean;
  ready: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveComposioToolkitAccess(
  toolkit: unknown,
  hasActiveConnection = false,
): ComposioToolkitAccess {
  const record = asRecord(toolkit);
  const noAuth = Boolean(record.noAuth ?? record.isNoAuth ?? record.no_auth);

  return {
    noAuth,
    ready: noAuth || hasActiveConnection,
  };
}
