type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> };

export async function migrateSharedComposioProfiles(database: Queryable): Promise<void> {
  await database.query('ALTER TABLE composio_connection_profiles ALTER COLUMN owner_user_id DROP NOT NULL');
  await database.query('ALTER TABLE composio_oauth_flow_states ALTER COLUMN workspace_id DROP NOT NULL');
  await database.query(`UPDATE composio_connection_profiles SET scope_type = 'user' WHERE scope_type IS NULL`);
  await database.query(`UPDATE composio_connection_profiles SET created_by_user_id = owner_user_id, updated_by_user_id = owner_user_id
    WHERE scope_type = 'user' AND created_by_user_id IS NULL`);
  await database.query(`DO $composio_shared_constraints$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'composio_profiles_ownership_check') THEN
      ALTER TABLE composio_connection_profiles ADD CONSTRAINT composio_profiles_ownership_check CHECK (
        (scope_type = 'user' AND owner_user_id IS NOT NULL AND organization_id IS NULL AND workspace_id IS NULL AND provider_mode IS NULL)
        OR (scope_type = 'organization' AND owner_user_id IS NULL AND organization_id IS NOT NULL AND workspace_id IS NULL AND is_default = 0 AND provider_mode IS NOT NULL AND provider_mode IN ('local','managed'))
        OR (scope_type = 'workspace' AND owner_user_id IS NULL AND organization_id IS NOT NULL AND workspace_id IS NOT NULL AND is_default = 0 AND provider_mode IS NOT NULL AND provider_mode IN ('local','managed'))
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'composio_profiles_revision_check') THEN
      ALTER TABLE composio_connection_profiles ADD CONSTRAINT composio_profiles_revision_check CHECK (profile_revision >= 1);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'composio_oauth_workspace_check') THEN
      ALTER TABLE composio_oauth_flow_states ADD CONSTRAINT composio_oauth_workspace_check CHECK (connection_ref IS NOT NULL OR workspace_id IS NOT NULL);
    END IF;
  END $composio_shared_constraints$`);
}
