import 'server-only';

import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';

/**
 * Live collaboration is a Postgres runtime capability. Licensing is enforced
 * when multi-user access is granted, while document access remains governed by
 * the authenticated workspace permissions.
 */
export function liveCollaborationRuntimeAvailable(
  databaseProvider: DatabaseProvider = getDatabaseProvider(),
): boolean {
  return databaseProvider === 'postgres';
}
