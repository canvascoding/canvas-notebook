import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';

const STATE_KEY = Symbol.for('canvas.office-publication-context.v1');
type Publication = { active: boolean };
type PublicationStorage = AsyncLocalStorage<ReadonlyMap<string, Publication>>;

export class OfficePublicationRequiredError extends Error {
  readonly code = 'OFFICE_PUBLICATION_REQUIRED';
  readonly status = 409;

  constructor() {
    super('Word documents must be saved through the document publication service.');
    this.name = 'OfficePublicationRequiredError';
  }
}

function publicationStorage(): PublicationStorage {
  const registry = globalThis as unknown as Record<symbol, PublicationStorage | undefined>;
  return registry[STATE_KEY] ??= new AsyncLocalStorage();
}

function publicationKey(workspaceId: string, filePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(filePath);
  if (!workspaceId.trim() || normalized === '.') {
    throw new Error('A valid workspace and relative document path are required for publication.');
  }
  return `${workspaceId}\0${normalized}`;
}

/** The shared save service grants this capability only after validating a DOCX. */
export async function withOfficePublication<T>(workspaceId: string, filePath: string, operation: () => Promise<T>): Promise<T> {
  const storage = publicationStorage();
  const key = publicationKey(workspaceId, filePath);
  const inherited = storage.getStore();
  const publication: Publication = { active: true };
  const context = new Map(inherited);
  context.set(key, publication);
  try {
    return await storage.run(context, operation);
  } finally {
    publication.active = false;
  }
}

export function assertOfficePublicationAllowed(workspaceId: string, filePath: string): void {
  if (!normalizeWorkspaceRelativePath(filePath).toLowerCase().endsWith('.docx')) return;
  if (!publicationStorage().getStore()?.get(publicationKey(workspaceId, filePath))?.active) {
    throw new OfficePublicationRequiredError();
  }
}
