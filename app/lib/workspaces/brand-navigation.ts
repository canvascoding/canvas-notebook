export function workspaceBrandDesignHref(workspaceId: string): string {
  const params = new URLSearchParams({
    tab: 'brand-design',
    scope: 'workspace',
    workspaceId,
  });
  return `/settings?${params.toString()}`;
}
