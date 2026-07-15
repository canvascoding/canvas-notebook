import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createAtomicTempPath,
  resolveUserSettingsDir,
} from '@/app/lib/runtime-data-paths';

export type CapabilityPreferenceRecord = {
  enabled: boolean;
  revision: number;
  updatedAt: string;
};

export type CapabilityPreferenceRegistry = {
  version: 1;
  updatedAt: string;
  preferences: Record<string, CapabilityPreferenceRecord>;
};

export class CapabilityPreferenceConflictError extends Error {
  readonly code = 'CAPABILITY_PREFERENCE_REVISION_CONFLICT';
  readonly status = 409;

  constructor() {
    super('Capability preference changed since it was inspected.');
    this.name = 'CapabilityPreferenceConflictError';
  }
}

const preferenceMutationTails = new Map<string, Promise<void>>();

async function withPreferenceMutation<T>(userId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = preferenceMutationTails.get(userId) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(mutation);
  const tail = operation.then(() => undefined, () => undefined);
  preferenceMutationTails.set(userId, tail);
  try {
    return await operation;
  } finally {
    if (preferenceMutationTails.get(userId) === tail) {
      preferenceMutationTails.delete(userId);
    }
  }
}

function preferencePath(userId: string): string {
  return path.join(resolveUserSettingsDir(userId), 'capabilities.json');
}

function emptyRegistry(): CapabilityPreferenceRegistry {
  return { version: 1, updatedAt: new Date().toISOString(), preferences: {} };
}

export async function readCapabilityPreferences(userId: string): Promise<CapabilityPreferenceRegistry> {
  try {
    const parsed = JSON.parse(await fs.readFile(preferencePath(userId), 'utf8')) as CapabilityPreferenceRegistry;
    if (parsed.version === 1 && parsed.preferences && typeof parsed.preferences === 'object') return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[CapabilityPreferences] Failed to read preferences:', error);
    }
  }
  return emptyRegistry();
}

export async function setCapabilityPreference(input: {
  userId: string;
  resourceId: string;
  enabled: boolean;
  expectedRevision?: number | null;
}): Promise<CapabilityPreferenceRecord> {
  return withPreferenceMutation(input.userId, async () => {
    const registry = await readCapabilityPreferences(input.userId);
    const current = registry.preferences[input.resourceId];
    if (input.expectedRevision != null && (current?.revision || 0) !== input.expectedRevision) {
      throw new CapabilityPreferenceConflictError();
    }
    const record = {
      enabled: input.enabled,
      revision: (current?.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    registry.preferences[input.resourceId] = record;
    registry.updatedAt = record.updatedAt;
    const targetPath = preferencePath(input.userId);
    const tempPath = createAtomicTempPath(targetPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, targetPath);
    return record;
  });
}
