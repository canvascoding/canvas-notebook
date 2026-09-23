import 'server-only';

import { hasManagedSystemUpdateIntent } from '@/app/lib/managed/control-plane-url-policy';

import { ManualSystemUpdateBackend } from './manual-backend';
import { ManagedSystemUpdateBackend } from './managed-backend';
import { StandaloneSystemUpdateBackend } from './standalone-backend';
import type { SystemUpdateBackend } from './types';

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function resolveSystemUpdateBackend(env: NodeJS.ProcessEnv = process.env): SystemUpdateBackend {
  // A service URL alone can also support standalone integrations. The installer flag
  // and an instance credential are authoritative managed signals, including a missing token.
  if (hasManagedSystemUpdateIntent(env)) {
    return new ManagedSystemUpdateBackend(env);
  }
  if (isTruthy(env.CANVAS_STANDALONE_UPDATER_ENABLED)) return new StandaloneSystemUpdateBackend(env);
  return new ManualSystemUpdateBackend(env);
}
