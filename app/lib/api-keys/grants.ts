import 'server-only';

import { ApiKeyAccessError, updateApiIntegrationSchema, type ApiIntegrationGrant } from './contracts';

/** The same bounded grant format is used for management and incoming access. */
export function storedGrant(row: { workspace_ids_json: string; actions_json: string }): ApiIntegrationGrant {
  try {
    return updateApiIntegrationSchema.pick({ workspaceIds: true, actions: true }).parse({
      workspaceIds: JSON.parse(row.workspace_ids_json), actions: JSON.parse(row.actions_json),
    });
  } catch {
    throw new ApiKeyAccessError('API_KEY_STATE_INVALID', 'The stored integration grants are invalid.', 503);
  }
}
