import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';

const KEY = Symbol.for('canvas.excalidraw-publication.v1');
type Publication = { active: boolean };
type Storage = AsyncLocalStorage<ReadonlyMap<string, Publication>>;

export class ExcalidrawPublicationRequiredError extends Error {
  readonly code = 'EXCALIDRAW_SCENE_SERVICE_REQUIRED';
  readonly status = 409;
  constructor() {
    super('Excalidraw documents must be changed through the scene service. Use create_excalidraw_scene, get_excalidraw_scene and edit_excalidraw_scene.');
  }
}

function storage(): Storage {
  const registry = globalThis as unknown as Record<symbol, Storage | undefined>;
  return registry[KEY] ??= new AsyncLocalStorage();
}

function scopeKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${normalizeWorkspaceRelativePath(path)}`;
}

/** Never accepted from a request: the scene coordinator grants a short-lived publication scope. */
export async function withExcalidrawPublication<T>(workspaceId: string, path: string, operation: () => Promise<T>): Promise<T> {
  const publication = { active: true };
  const context = new Map(storage().getStore());
  context.set(scopeKey(workspaceId, path), publication);
  try { return await storage().run(context, operation); }
  finally { publication.active = false; }
}

export function assertExcalidrawPublicationAllowed(workspaceId: string, path: string): void {
  if (!normalizeWorkspaceRelativePath(path).toLowerCase().endsWith('.excalidraw')) return;
  if (!storage().getStore()?.get(scopeKey(workspaceId, path))?.active) throw new ExcalidrawPublicationRequiredError();
}
