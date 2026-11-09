/** Reserved names used only while workspace-files atomically replaces a file. */
export const INTERNAL_WORKSPACE_STAGING_SUFFIX = String.raw`\.canvas-(?:write|create)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp`;
const internalWorkspaceStagingPath = new RegExp(`${INTERNAL_WORKSPACE_STAGING_SUFFIX}$`, 'i');

export function isInternalWorkspaceStagingPath(filePath: string): boolean {
  return internalWorkspaceStagingPath.test(filePath);
}
