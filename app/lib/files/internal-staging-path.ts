/** Reserved names used only while workspace-files atomically replaces a file. */
export function isInternalWorkspaceStagingPath(filePath: string): boolean {
  return /\.canvas-(?:write|create)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(filePath);
}
