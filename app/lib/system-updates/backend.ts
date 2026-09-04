import 'server-only';

import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';

import { ManualSystemUpdateBackend } from './manual-backend';
import { ManagedSystemUpdateBackend } from './managed-backend';
import { StandaloneSystemUpdateBackend } from './standalone-backend';
import type { SystemUpdateBackend } from './types';

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function resolveSystemUpdateBackend(env: NodeJS.ProcessEnv = process.env): SystemUpdateBackend {
  if (isManagedControlPlaneAvailable()) {
    return new ManagedSystemUpdateBackend(env);
  }
  if (isTruthy(env.CANVAS_STANDALONE_UPDATER_ENABLED)) return new StandaloneSystemUpdateBackend(env);
  return new ManualSystemUpdateBackend(env);
}
