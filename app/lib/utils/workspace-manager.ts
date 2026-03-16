import path from 'path';
import { promises as fs } from 'fs';

// Nutze die Umgebungsvariable DATA oder falle auf das lokale data Verzeichnis zurück
const DATA = process.env.DATA || path.resolve(process.cwd(), 'data');
const WORKSPACE_BASE_DIR = path.join(DATA, 'workspace');
const TEMP_BASE_DIR = path.join(DATA, 'temp');

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
 * Returns the absolute path for the temp directory.
 * Use this for temporary files during skill processing.
 */
export function getTempPath(skillName?: string): string {
  if (skillName) {
    return path.join(TEMP_BASE_DIR, 'skills', skillName);
  }
  return TEMP_BASE_DIR;
}

/**
 * Ensures that the temp directory for a skill exists.
 */
export async function ensureSkillTempExists(skillName: string): Promise<string> {
  const skillTempPath = getTempPath(skillName);
  try {
    await fs.mkdir(skillTempPath, { recursive: true });
    console.log(`[Workspace Manager] Ensured temp directory exists: ${skillTempPath}`);
    return skillTempPath;
  } catch (error) {
    console.error(`[Workspace Manager] Failed to ensure temp directory: ${skillTempPath}`, error);
    throw error;
  }
}

/**
 * Cleans up temporary files for a specific skill.
 */
export async function cleanupSkillTemp(skillName: string): Promise<void> {
  const skillTempPath = getTempPath(skillName);
  try {
    await fs.rm(skillTempPath, { recursive: true, force: true });
    console.log(`[Workspace Manager] Cleaned up temp directory: ${skillTempPath}`);
  } catch (error) {
    console.warn(`[Workspace Manager] Failed to cleanup temp directory: ${skillTempPath}`, error);
  }
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
