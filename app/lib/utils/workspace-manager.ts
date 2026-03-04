import path from 'path';
import { promises as fs } from 'fs';

// Nutze die Umgebungsvariable WORKSPACE_DIR oder falle auf das lokale data/workspace Verzeichnis zurück
const WORKSPACE_BASE_DIR = process.env.WORKSPACE_DIR
  ? path.resolve(process.env.WORKSPACE_DIR)
  : path.resolve(process.cwd(), 'data', 'workspace');

/**
 * Returns the absolute path for the workspace.
 * In this setup, we always use the base workspace directory to keep it consistent with the app.
 */
export function getWorkspacePath(_sessionId?: string): string {
  void _sessionId;
  // Wir ignorieren die sessionId für den Pfad, um im selben Verzeichnis wie die App zu bleiben,
  // es sei denn, wir wollen explizit Isolation (hier vom User nicht gewünscht).
  return WORKSPACE_BASE_DIR;
}

/**
 * Ensures that the workspace directory exists.
 */
export async function ensureWorkspaceExists(workspacePath: string): Promise<void> {
  try {
    await fs.mkdir(workspacePath, { recursive: true });
    console.log(`[Workspace Manager] Ensured workspace directory exists: ${workspacePath}`);
  } catch (error) {
    console.error(`[Workspace Manager] Failed to ensure workspace directory: ${workspacePath}`, error);
  }
}

/**
 * Initializes the base workspace directory.
 */
export async function initializeWorkspaceBase(): Promise<void> {
    await ensureWorkspaceExists(WORKSPACE_BASE_DIR);
}
