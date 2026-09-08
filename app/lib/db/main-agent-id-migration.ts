import { LEGACY_MAIN_AGENT_ID, MAIN_AGENT_ID } from '@/app/lib/agents/main-agent';

export const MAIN_AGENT_ID_MIGRATION_KEY = 'main-agent-id-bradley-v1';

type PgQueryable = {
  query: (queryText: string, values?: unknown[]) => Promise<unknown>;
};

/** Migrates persisted references to the canonical main-agent ID in PostgreSQL. */
export async function migratePostgresMainAgentId(pool: PgQueryable): Promise<void> {
  await pool.query(`
    DO $main_agent_id_migration$
    DECLARE
      target record;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM agents WHERE agent_id = '${MAIN_AGENT_ID}' AND type != 'main'
      ) THEN
        RAISE EXCEPTION 'Cannot migrate the main agent to ${MAIN_AGENT_ID}: that ID belongs to a non-main agent.';
      END IF;

      IF EXISTS (SELECT 1 FROM agents WHERE agent_id = '${LEGACY_MAIN_AGENT_ID}')
        AND NOT EXISTS (SELECT 1 FROM agents WHERE agent_id = '${MAIN_AGENT_ID}') THEN
        INSERT INTO agents (
          agent_id, name, icon_id, type, removable,
          default_provider_installation_id, default_provider, default_model, default_thinking,
          enabled_tools_json, relevant_skills_json, relevant_connections_json,
          access_policy, scope_type, organization_id, owner_user_id, created_by_user_id,
          revision, created_at, updated_at
        )
        SELECT
          '${MAIN_AGENT_ID}', name, icon_id, type, removable,
          default_provider_installation_id, default_provider, default_model, default_thinking,
          enabled_tools_json, relevant_skills_json, relevant_connections_json,
          access_policy, scope_type, organization_id, owner_user_id, created_by_user_id,
          revision, created_at, updated_at
        FROM agents
        WHERE agent_id = '${LEGACY_MAIN_AGENT_ID}';
      END IF;

      FOR target IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'character')
          AND (
            column_name = 'agent_id'
            OR right(column_name, 9) = '_agent_id'
            OR column_name IN ('actor_id', 'service_actor_id')
          )
          AND NOT (table_name = 'agents' AND column_name = 'agent_id')
        ORDER BY table_name, ordinal_position
      LOOP
        EXECUTE format(
          'UPDATE %I SET %I = $1 WHERE %I = $2',
          target.table_name,
          target.column_name,
          target.column_name
        ) USING '${MAIN_AGENT_ID}', '${LEGACY_MAIN_AGENT_ID}';
      END LOOP;

      DELETE FROM agents WHERE agent_id = '${LEGACY_MAIN_AGENT_ID}';

      FOR target IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_default LIKE '%${LEGACY_MAIN_AGENT_ID}%'
          AND (
            column_name = 'agent_id'
            OR right(column_name, 9) = '_agent_id'
            OR column_name IN ('actor_id', 'service_actor_id')
          )
      LOOP
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %L',
          target.table_name,
          target.column_name,
          '${MAIN_AGENT_ID}'
        );
      END LOOP;

      INSERT INTO canvas_data_migrations (migration_key, completed_at, metadata_json)
      VALUES (
        '${MAIN_AGENT_ID_MIGRATION_KEY}',
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
        '{"from":"${LEGACY_MAIN_AGENT_ID}","to":"${MAIN_AGENT_ID}"}'
      )
      ON CONFLICT (migration_key) DO NOTHING;
    END
    $main_agent_id_migration$;
  `);
}
