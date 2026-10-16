export const CAPABILITY_PACKAGE_AUTHORING_MIGRATION_KEY = 'capability-package-sourcefree-authoring-v1';

/** Existing edit/fork rows retain their complete source. Only original creates may omit it. */
const authoringChanges = [
  ...['base_source_stamp', 'source_resource_ref', 'source_metadata_revision', 'source_grants_revision', 'source_package_revision', 'source_storage']
    .map(column => `ALTER TABLE capability_package_drafts ALTER COLUMN ${column} DROP NOT NULL`),
  ...['source_resource_ref', 'source_checksum', 'source_stamp']
    .map(column => `ALTER TABLE capability_package_versions ALTER COLUMN ${column} DROP NOT NULL`),
  `ALTER TABLE capability_package_drafts DROP CONSTRAINT IF EXISTS capability_package_drafts_operation_check`,
  `ALTER TABLE capability_package_drafts ADD CONSTRAINT capability_package_drafts_operation_check CHECK (operation IN ('create','edit','fork'))`,
  `ALTER TABLE capability_package_drafts DROP CONSTRAINT IF EXISTS capability_package_drafts_source_check`,
  `ALTER TABLE capability_package_drafts ADD CONSTRAINT capability_package_drafts_source_check CHECK (
    (operation = 'create' AND base_source_stamp IS NULL AND source_resource_ref IS NULL AND source_metadata_revision IS NULL
      AND source_grants_revision IS NULL AND source_package_revision IS NULL AND source_published_revision_ref IS NULL
      AND source_storage IS NULL AND source_parent_storage IS NULL AND base_package_revision = 0 AND base_published_revision_ref IS NULL)
    OR (operation IN ('edit','fork') AND base_source_stamp IS NOT NULL AND source_resource_ref IS NOT NULL
      AND source_metadata_revision IS NOT NULL AND source_grants_revision IS NOT NULL AND source_package_revision IS NOT NULL AND source_storage IS NOT NULL))`,
  `ALTER TABLE capability_package_versions DROP CONSTRAINT IF EXISTS capability_package_versions_source_check`,
  `ALTER TABLE capability_package_versions ADD CONSTRAINT capability_package_versions_source_check CHECK (
    (source_resource_ref IS NULL AND source_revision_ref IS NULL AND source_checksum IS NULL AND source_stamp IS NULL)
    OR (source_resource_ref IS NOT NULL AND source_checksum IS NOT NULL AND source_stamp IS NOT NULL))`,
] as const;

/** One statement is one PostgreSQL transaction, including its lock, constraints and receipt. */
export const CAPABILITY_PACKAGE_AUTHORING_STATEMENTS = [
  `DO $capability_package_authoring$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('canvas-data-migration:${CAPABILITY_PACKAGE_AUTHORING_MIGRATION_KEY}',0));
    IF EXISTS (SELECT 1 FROM canvas_data_migrations WHERE migration_key='${CAPABILITY_PACKAGE_AUTHORING_MIGRATION_KEY}') THEN
      RETURN;
    END IF;
    ${authoringChanges.join(';\n    ')};
    INSERT INTO canvas_data_migrations (migration_key,completed_at,metadata_json)
      VALUES ('${CAPABILITY_PACKAGE_AUTHORING_MIGRATION_KEY}',(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,
        '{"sourceFreeCreation":true,"sourceChecks":"create-null-or-derived-present"}');
  END $capability_package_authoring$;`,
] as const;
