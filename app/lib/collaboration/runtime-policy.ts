import 'server-only';


/**
 * Live collaboration is a Postgres runtime capability. Licensing is enforced
 * when multi-user access is granted, while document access remains governed by
 * the authenticated workspace permissions.
 */
export function liveCollaborationRuntimeAvailable(): boolean {
  return true;
}
