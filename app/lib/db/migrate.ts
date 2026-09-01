import type Database from 'better-sqlite3';

import { STUDIO_WORKSPACE_BACKFILL_STATEMENTS } from './studio-workspace-migration';

export const TEAM_SEAT_LEGACY_MIGRATION_KEY = 'team-seat-memberships-v1';
export const TEAM_SEAT_LEGACY_MIGRATION_REASON = 'Legacy organization access backfill (non-billable).';
export const TEAM_SEAT_LEGACY_MIGRATION_METADATA =
  '{"migrationKey":"team-seat-memberships-v1","billableOperation":false}';

/**
 * Runs all database migrations synchronously.
 * Safe to call multiple times — all operations are idempotent.
 *
 * Add new tables via CREATE TABLE IF NOT EXISTS.
 * Add new columns via the ALTER TABLE section at the bottom.
 */
export function runMigrations(sqlite: InstanceType<typeof Database>): void {
  // Enable WAL mode — allows concurrent readers without blocking, reduces lock contention
  sqlite.exec('PRAGMA journal_mode = WAL;');

  // ── Base schema (CREATE TABLE IF NOT EXISTS = safe for fresh + existing DBs) ──

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      email_verified INTEGER NOT NULL,
      image TEXT,
      role TEXT,
      banned INTEGER,
      ban_reason TEXT,
      ban_expires INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      impersonated_by TEXT,
      user_id TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS mobile_push_devices (
      id TEXT PRIMARY KEY NOT NULL,
      installation_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      auth_session_id TEXT NOT NULL,
      expo_push_token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      app_variant TEXT NOT NULL DEFAULT 'production',
      enabled INTEGER NOT NULL DEFAULT 1,
      agent_response_ready INTEGER NOT NULL DEFAULT 1,
      todo_attention INTEGER NOT NULL DEFAULT 1,
      studio_completed INTEGER NOT NULL DEFAULT 1,
      failure_attention INTEGER NOT NULL DEFAULT 1,
      automation_run_status INTEGER NOT NULL DEFAULT 0,
      preview_enabled INTEGER NOT NULL DEFAULT 0,
      last_registered_at INTEGER NOT NULL,
      last_delivery_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (auth_session_id) REFERENCES session(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_user_enabled
      ON mobile_push_devices (user_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_auth_session
      ON mobile_push_devices (auth_session_id);

    CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      expo_ticket_id TEXT UNIQUE,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_receipt_check_at INTEGER,
      receipt_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES mobile_push_devices(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_receipt_poll
      ON mobile_push_deliveries (status, next_receipt_check_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_user
      ON mobile_push_deliveries (user_id, created_at);

    CREATE TABLE IF NOT EXISTS mobile_inbox_read_states (
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      dismissed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workspace_id, item_key),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_inbox_read_workspace
      ON mobile_inbox_read_states (user_id, workspace_id, read_at);

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      issuer TEXT NOT NULL DEFAULT 'local:credential',
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_issuer_account_id
      ON account (issuer, account_id);
    CREATE INDEX IF NOT EXISTS idx_account_user_provider
      ON account (user_id, provider_id);

    CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT,
      provider_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      policy_json TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      account_scope TEXT NOT NULL DEFAULT 'personal',
      organization_id TEXT,
      connected_by_user_id TEXT,
      automation_enabled_at INTEGER,
      workspace_id TEXT,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL,
      bcc_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      is_html INTEGER NOT NULL DEFAULT 0,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      provider_draft_id TEXT,
      workspace_id TEXT,
      mailbox_id TEXT,
      inbox_case_id TEXT,
      origin TEXT NOT NULL DEFAULT 'manual',
      origin_automation_job_id TEXT,
      origin_run_id TEXT,
      origin_agent_id TEXT,
      outbox_status TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      assigned_user_id TEXT,
      editing_by_user_id TEXT,
      editing_started_at INTEGER,
      sent_by_user_id TEXT,
      sent_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS jwks (
      id TEXT PRIMARY KEY NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_client (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL UNIQUE,
      client_secret TEXT,
      client_discovery_id TEXT,
      disabled INTEGER DEFAULT 0,
      skip_consent INTEGER,
      enable_end_session INTEGER,
      subject_type TEXT,
      scopes TEXT,
      client_credentials_scopes TEXT,
      user_id TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      name TEXT,
      uri TEXT,
      icon TEXT,
      contacts TEXT,
      tos TEXT,
      policy TEXT,
      software_id TEXT,
      software_version TEXT,
      software_statement TEXT,
      redirect_uris TEXT NOT NULL,
      post_logout_redirect_uris TEXT,
      backchannel_logout_uri TEXT,
      backchannel_logout_session_required INTEGER,
      token_endpoint_auth_method TEXT,
      application_type TEXT,
      jwks TEXT,
      jwks_uri TEXT,
      grant_types TEXT,
      response_types TEXT,
      public INTEGER,
      type TEXT,
      require_pkce INTEGER,
      dpop_bound_access_tokens INTEGER,
      reference_id TEXT,
      metadata TEXT,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_client_user
      ON oauth_client (user_id);

    CREATE TABLE IF NOT EXISTS oauth_resource (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      access_token_ttl INTEGER,
      refresh_token_ttl INTEGER,
      signing_algorithm TEXT,
      signing_key_id TEXT,
      allowed_scopes TEXT,
      custom_claims TEXT,
      dpop_bound_access_tokens_required INTEGER,
      disabled INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      policy_version INTEGER DEFAULT 1,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_client_resource (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER,
      UNIQUE (client_id, resource_id),
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (resource_id) REFERENCES oauth_resource(identifier) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_client_assertion (
      id TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh_token (
      id TEXT PRIMARY KEY NOT NULL,
      token TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      session_id TEXT,
      user_id TEXT NOT NULL,
      reference_id TEXT,
      authorization_code_id TEXT,
      resources TEXT,
      requested_user_info_claims TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER,
      rotated_at INTEGER,
      rotation_replay_response TEXT,
      rotation_replay_expires_at INTEGER,
      auth_time INTEGER,
      confirmation TEXT,
      scopes TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_client
      ON oauth_refresh_token (client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_session
      ON oauth_refresh_token (session_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_user
      ON oauth_refresh_token (user_id);

    CREATE TABLE IF NOT EXISTS oauth_access_token (
      id TEXT PRIMARY KEY NOT NULL,
      token TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      session_id TEXT,
      user_id TEXT,
      reference_id TEXT,
      authorization_code_id TEXT,
      resources TEXT,
      requested_user_info_claims TEXT,
      refresh_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      confirmation TEXT,
      scopes TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (refresh_id) REFERENCES oauth_refresh_token(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_access_token_client
      ON oauth_access_token (client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_access_token_session
      ON oauth_access_token (session_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_access_token_user
      ON oauth_access_token (user_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_access_token_refresh
      ON oauth_access_token (refresh_id);

    -- Direct MCP uses self-contained JWT access tokens. Keep only a digest of
    -- an explicitly revoked token so a single token can be made inactive
    -- without revoking the browser session or other OAuth grants.
    CREATE TABLE IF NOT EXISTS mcp_revoked_access_token (
      token_hash TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_revoked_access_token_expiry
      ON mcp_revoked_access_token (expires_at);

    -- Revokes one user's Direct MCP grant while preserving the public OAuth
    -- client for other users. A timestamp lets a subsequent reauthorization
    -- issue a new bearer token for the same browser session.
    CREATE TABLE IF NOT EXISTS mcp_direct_grant_revocation (
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      revoked_at INTEGER NOT NULL,
      PRIMARY KEY (client_id, session_id, user_id),
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_direct_grant_revocation_user_client
      ON mcp_direct_grant_revocation (user_id, client_id);

    -- A Direct MCP connection starts with no workspace data access. Rows here
    -- are an explicit user-selected allowlist and are checked in addition to
    -- Canvas's current workspace ACL for every tool invocation.
    CREATE TABLE IF NOT EXISTS mcp_direct_workspace_grant (
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (client_id, user_id, workspace_id),
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_direct_workspace_grant_user_client
      ON mcp_direct_workspace_grant (user_id, client_id);

    -- Workspace managers opt workspaces into Direct MCP before users can add
    -- them to an individual OAuth client connection. Absence means disabled.
    CREATE TABLE IF NOT EXISTS mcp_direct_workspace_setting (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      enabled_by_user_id TEXT NOT NULL,
      enabled_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (enabled_by_user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_consent (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT,
      reference_id TEXT,
      resources TEXT,
      requested_user_info_claims TEXT,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_consent_client
      ON oauth_consent (client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_consent_user
      ON oauth_consent (user_id);

    CREATE TABLE IF NOT EXISTS canvas_organization_settings (
      organization_id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      deployment_mode TEXT NOT NULL DEFAULT 'single_user',
      team_features_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS organization_brand_profiles (
      organization_id TEXT PRIMARY KEY NOT NULL,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_customers (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      metadata_json TEXT,
      created_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_projects (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      customer_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT,
      metadata_json TEXT,
      created_by_user_id TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES canvas_customers(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_project_members (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      can_read INTEGER NOT NULL DEFAULT 1,
      can_write INTEGER NOT NULL DEFAULT 0,
      can_manage INTEGER NOT NULL DEFAULT 0,
      invited_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES canvas_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL,
      owner_user_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      root_relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      workspace_icon TEXT NOT NULL DEFAULT 'user-round',
      status TEXT NOT NULL DEFAULT 'active',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES user(id),
      FOREIGN KEY (customer_id) REFERENCES canvas_customers(id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES canvas_projects(id) ON DELETE CASCADE,
      CHECK (type != 'project' OR project_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS upload_access_grants (
      file_id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT,
      storage_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      category TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_upload_access_owner ON upload_access_grants (owner_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_upload_access_workspace ON upload_access_grants (workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS workspace_brand_profiles (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_workspace_members (
      organization_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      can_read INTEGER NOT NULL DEFAULT 1,
      can_write INTEGER NOT NULL DEFAULT 0,
      can_manage INTEGER NOT NULL DEFAULT 0,
      invited_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS composio_connection_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      composio_user_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS composio_workspace_profile_overrides (
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workspace_id),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES composio_connection_profiles(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS composio_oauth_flow_states (
      state_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      composio_user_id TEXT NOT NULL,
      toolkit_slug TEXT NOT NULL,
      return_path TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES composio_connection_profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_trash_entries (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      owner_user_id TEXT,
      original_path TEXT NOT NULL,
      trash_relative_path TEXT NOT NULL,
      entry_name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      directory_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'trashed',
      deleted_by_user_id TEXT,
      restored_by_user_id TEXT,
      purged_by_user_id TEXT,
      deleted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      restored_at INTEGER,
      purged_at INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_by_actor_type TEXT NOT NULL DEFAULT 'user',
      source_session_id TEXT,
      base_revision_id TEXT,
      lineage_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_file_metadata (
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, path)
    );

    CREATE TABLE IF NOT EXISTS workspace_file_user_states (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, user_id, path)
    );

    -- Paths can be reused after a file is deleted. A lineage keeps the active
    -- revision stream tied to a stable file identity instead of the path.
    CREATE TABLE IF NOT EXISTS file_collaboration_lineages (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      trash_entry_id TEXT
    );

    CREATE TABLE IF NOT EXISTS file_locks (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      path TEXT NOT NULL,
      revision_id TEXT,
      locked_by_user_id TEXT,
      locked_by_session_id TEXT,
      lock_type TEXT NOT NULL DEFAULT 'edit',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collaboration_documents (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL,
      path TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'yjs',
      state_version INTEGER NOT NULL DEFAULT 0,
      snapshot_revision_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collaboration_events (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL,
      actor_user_id TEXT,
      actor_session_id TEXT,
      sequence INTEGER NOT NULL,
      payload_ref TEXT,
      payload_hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_user_permissions (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      can_write_team_workspace INTEGER NOT NULL DEFAULT 0,
      can_create_public_links INTEGER NOT NULL DEFAULT 1,
      can_create_team_automations INTEGER NOT NULL DEFAULT 0,
      can_share_plugins_and_skills INTEGER NOT NULL DEFAULT 0,
      can_export INTEGER NOT NULL DEFAULT 0,
      can_delete_team_files INTEGER NOT NULL DEFAULT 0,
      can_delete_studio_assets INTEGER NOT NULL DEFAULT 1,
      can_manage_backups INTEGER NOT NULL DEFAULT 0,
      can_manage_organization_memory INTEGER NOT NULL DEFAULT 0,
      can_migrate_database INTEGER NOT NULL DEFAULT 0,
      can_enable_knowledge INTEGER NOT NULL DEFAULT 0,
      can_recover_workspaces INTEGER NOT NULL DEFAULT 0,
      disabled_at INTEGER,
      archived_at INTEGER,
      offboarded_by_user_id TEXT,
      offboarding_reason TEXT,
      offboarding_report_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (offboarded_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS canvas_data_migrations (
      migration_key TEXT PRIMARY KEY NOT NULL,
      completed_at INTEGER NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS team_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      candidate_email TEXT NOT NULL,
      display_name TEXT,
      user_id TEXT,
      role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member', 'external')),
      status TEXT NOT NULL
        CHECK (status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
      external_invitation_id TEXT,
      control_plane_operation_id TEXT,
      invited_by_user_id TEXT,
      invited_at INTEGER,
      accepted_at INTEGER,
      activated_at INTEGER,
      suspended_at INTEGER,
      removed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status != 'active' OR (user_id IS NOT NULL AND accepted_at IS NOT NULL)),
      CHECK (status NOT IN ('invited', 'approval_required', 'billing_pending') OR user_id IS NULL),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE RESTRICT,
      FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS team_membership_transitions (
      id TEXT PRIMARY KEY NOT NULL,
      membership_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      from_status TEXT
        CHECK (from_status IS NULL OR from_status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
      to_status TEXT NOT NULL
        CHECK (to_status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
      actor_user_id TEXT,
      source TEXT NOT NULL,
      reason TEXT,
      external_operation_id TEXT,
      membership_revision INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS team_membership_invitations (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      membership_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      email_snapshot TEXT NOT NULL,
      role_snapshot TEXT NOT NULL
        CHECK (role_snapshot IN ('admin', 'member', 'external')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      invited_by_user_id TEXT,
      expires_at INTEGER NOT NULL,
      accepted_request_id TEXT,
      accepted_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status != 'accepted' OR (accepted_request_id IS NOT NULL AND accepted_at IS NOT NULL)),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS team_membership_sync_state (
      organization_id TEXT PRIMARY KEY NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 0,
      current_observed_quantity INTEGER NOT NULL DEFAULT 0,
      latest_snapshot_hash TEXT,
      latest_snapshot_generated_at INTEGER,
      last_local_change_at INTEGER,
      acknowledged_revision INTEGER NOT NULL DEFAULT 0,
      acknowledged_snapshot_id TEXT,
      acknowledged_snapshot_hash TEXT,
      acknowledged_at INTEGER,
      control_plane_protocol_version TEXT,
      control_plane_observed_quantity INTEGER,
      approved_quantity INTEGER,
      billed_quantity INTEGER,
      licensed_quantity INTEGER,
      expected_licensed_quantity INTEGER,
      entitlements_version INTEGER,
      billing_status TEXT,
      drift_status TEXT,
      reconciliation_status TEXT,
      reconciliation_action TEXT,
      reconciliation_reason TEXT,
      reconciliation_seat_limit INTEGER
        CHECK (reconciliation_seat_limit IS NULL OR reconciliation_seat_limit >= 1),
      reconciliation_support_required INTEGER NOT NULL DEFAULT 0,
      reconciled_at INTEGER,
      next_report_at INTEGER,
      last_sync_error_code TEXT,
      last_sync_error TEXT,
      last_sync_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        current_revision >= 0
        AND acknowledged_revision >= 0
        AND acknowledged_revision <= current_revision
      ),
      CHECK (current_observed_quantity >= 0),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS team_seat_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      dedupe_key TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      membership_id TEXT,
      membership_revision INTEGER,
      operation_kind TEXT NOT NULL
        CHECK (operation_kind IN ('membership_snapshot', 'seat_prepare', 'seat_execute', 'license_refresh')),
      operation_type TEXT
        CHECK (operation_type IS NULL OR operation_type IN ('team_upgrade', 'member_create', 'invitation_accept', 'member_remove', 'reconcile')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'canceled')),
      request_json TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT,
      control_plane_operation_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 10,
      next_attempt_at INTEGER,
      last_attempt_at INTEGER,
      last_error_code TEXT,
      last_error TEXT,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS capability_policies (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('skill', 'plugin')),
      resource_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('organization', 'role', 'workspace', 'project', 'user')),
      target_id TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('optional', 'default-enabled', 'required', 'blocked')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE RESTRICT,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ai_provider_installations (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL,
      credential_scope TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unverified',
      config_json TEXT,
      source_revision TEXT,
      last_synced_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      verified_at INTEGER,
      verified_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (verified_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_provider_models (
      organization_id TEXT NOT NULL,
      provider_installation_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_provider_default INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      thinking_levels_json TEXT NOT NULL DEFAULT '["off"]',
      metadata_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_installation_id, model_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (provider_installation_id) REFERENCES ai_provider_installations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_runtime_defaults (
      organization_id TEXT PRIMARY KEY NOT NULL,
      provider_installation_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      thinking_level TEXT NOT NULL DEFAULT 'off',
      catalog_revision INTEGER NOT NULL DEFAULT 0,
      migration_state TEXT NOT NULL DEFAULT 'uninitialized',
      legacy_source_hash TEXT,
      updated_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (provider_installation_id) REFERENCES ai_provider_installations(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_workspace_model_policies (
      organization_id TEXT NOT NULL,
      workspace_id TEXT PRIMARY KEY NOT NULL,
      allowed_models_json TEXT,
      default_provider_installation_id TEXT,
      default_provider_id TEXT,
      default_model_id TEXT,
      default_thinking_level TEXT,
      allow_user_credentials INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_user_model_preferences (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      provider_installation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_level TEXT NOT NULL DEFAULT 'off',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workspace_id, agent_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_user_workspace_provider_grants (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider_installation_id TEXT NOT NULL,
      allowed_execution_modes_json TEXT NOT NULL DEFAULT '["interactive"]',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      revision INTEGER NOT NULL DEFAULT 1,
      granted_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, workspace_id, agent_id, provider_installation_id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_installation_id) REFERENCES ai_provider_installations(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_installations_org_binding ON ai_provider_installations (organization_id, provider_id, credential_scope);
    CREATE INDEX IF NOT EXISTS idx_ai_provider_installations_org_enabled ON ai_provider_installations (organization_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_ai_provider_installations_org_status ON ai_provider_installations (organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_ai_provider_models_provider_enabled ON ai_provider_models (organization_id, provider_installation_id, enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_models_provider_default ON ai_provider_models (provider_installation_id) WHERE is_provider_default = 1;
    CREATE INDEX IF NOT EXISTS idx_ai_workspace_model_policies_org ON ai_workspace_model_policies (organization_id);
    CREATE INDEX IF NOT EXISTS idx_ai_user_model_preferences_org_user ON ai_user_model_preferences (organization_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_user_model_preferences_workspace ON ai_user_model_preferences (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ai_user_workspace_provider_grants_org_user ON ai_user_workspace_provider_grants (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_ai_user_workspace_provider_grants_workspace ON ai_user_workspace_provider_grants (workspace_id, status);

    CREATE TABLE IF NOT EXISTS pi_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      client_request_id TEXT,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT,
      title TEXT,
      title_generation_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_text TEXT,
      summary_updated_at INTEGER,
      summary_through_timestamp INTEGER,
      summary_through_sequence INTEGER,
      summary_revision INTEGER NOT NULL DEFAULT 0,
      system_prompt_snapshot TEXT,
      system_prompt_snapshot_hash TEXT,
      system_prompt_snapshot_created_at INTEGER,
      last_message_at INTEGER,
      last_viewed_at INTEGER,
      archived_at INTEGER,
      channel_id TEXT NOT NULL DEFAULT 'app',
      channel_session_key TEXT,
      session_kind TEXT NOT NULL DEFAULT 'conversation' CHECK (session_kind IN ('conversation', 'delegation_worker')),
      parent_session_id TEXT,
      delegation_id TEXT,
      delegation_depth INTEGER NOT NULL DEFAULT 0 CHECK (delegation_depth IN (0, 1)),
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT,
      workspace_name TEXT,
      workspace_root_relative_path TEXT,
      runtime_provider_installation_id TEXT,
      runtime_catalog_revision INTEGER,
      runtime_policy_revision INTEGER,
      runtime_selection_source TEXT,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS pi_session_compaction_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      pi_session_db_id INTEGER NOT NULL,
      attempt_ordinal INTEGER NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual', 'automation')),
      state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'no_op', 'deferred', 'failed', 'aborted', 'stale', 'timed_out')),
      reason_code TEXT,
      base_summary_revision INTEGER NOT NULL,
      committed_summary_revision INTEGER,
      base_through_sequence INTEGER,
      committed_through_sequence INTEGER,
      message_sequence_checkpoint INTEGER NOT NULL,
      contract_fingerprint TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      before_estimated_tokens INTEGER,
      after_estimated_tokens INTEGER,
      before_estimated_bytes INTEGER,
      after_estimated_bytes INTEGER,
      protected_unit_count INTEGER,
      summarized_unit_count INTEGER,
      omitted_unit_count INTEGER,
      started_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      completed_at INTEGER,
      retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (pi_session_db_id) REFERENCES pi_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pi_compaction_attempts_session_started
      ON pi_session_compaction_attempts (pi_session_db_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_pi_compaction_attempts_state_deadline
      ON pi_session_compaction_attempts (state, deadline_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_compaction_attempts_active_session
      ON pi_session_compaction_attempts (pi_session_db_id) WHERE state = 'running';

    CREATE TABLE IF NOT EXISTS pi_delegations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      worker_session_id TEXT NOT NULL,
      requested_session_id TEXT,
      target_agent_id TEXT,
      worker_type TEXT NOT NULL CHECK (worker_type IN ('ephemeral', 'managed')),
      goal TEXT NOT NULL,
      context TEXT,
      worker_role TEXT,
      toolsets_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      result_status TEXT,
      result_text TEXT,
      error_text TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')),
      delivery_error_text TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pi_delegations_user_created ON pi_delegations (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_delegations_source_session ON pi_delegations (user_id, source_session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_delegations_status_created ON pi_delegations (status, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_delegations_delivery ON pi_delegations (delivery_status, completed_at);
    CREATE INDEX IF NOT EXISTS idx_pi_delegations_worker_session ON pi_delegations (user_id, worker_session_id);

    CREATE TABLE IF NOT EXISTS pi_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      pi_session_db_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (pi_session_db_id) REFERENCES pi_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS pi_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      fingerprint TEXT NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      session_title_snapshot TEXT,
      assistant_timestamp INTEGER NOT NULL,
      stop_reason TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      input_cost REAL NOT NULL,
      output_cost REAL NOT NULL,
      cache_read_cost REAL NOT NULL,
      cache_write_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon_id TEXT NOT NULL DEFAULT 'bot',
      type TEXT NOT NULL DEFAULT 'main',
      removable INTEGER NOT NULL DEFAULT 0,
      default_provider_installation_id TEXT,
      default_provider TEXT,
      default_model TEXT,
      default_thinking TEXT,
      enabled_tools_json TEXT,
      relevant_skills_json TEXT,
      relevant_connections_json TEXT,
      access_policy TEXT NOT NULL DEFAULT 'legacy',
      scope_type TEXT NOT NULL DEFAULT 'user',
      organization_id TEXT,
      owner_user_id TEXT,
      created_by_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_members (
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      can_use INTEGER NOT NULL DEFAULT 1,
      can_edit INTEGER NOT NULL DEFAULT 0,
      can_manage INTEGER NOT NULL DEFAULT 0,
      invited_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, user_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_grants (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('organization', 'role', 'workspace', 'project', 'user')),
      target_id TEXT NOT NULL,
      can_use INTEGER NOT NULL DEFAULT 1,
      can_edit INTEGER NOT NULL DEFAULT 0,
      can_manage INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_capability_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('skill', 'plugin', 'connection')),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('system', 'organization', 'user')),
      resource_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT,
      requirement TEXT NOT NULL DEFAULT 'optional' CHECK (requirement IN ('optional', 'required')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_user_preferences (
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, user_id),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todo_categories (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS todo_items (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      created_by_user_id TEXT,
      assignee_user_id TEXT,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT NOT NULL DEFAULT 'personal',
      scope_kind TEXT NOT NULL DEFAULT 'user',
      category_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      icon_key TEXT,
      due_at INTEGER,
      remind_at INTEGER,
      reminder_sent_at INTEGER,
      reminder_error TEXT,
      source_type TEXT NOT NULL DEFAULT 'user',
      source_agent_id TEXT,
      source_session_id TEXT,
      seen_at INTEGER,
      completed_at INTEGER,
      completion_comment TEXT,
      follow_up_sent_at INTEGER,
      follow_up_error TEXT,
      email_notification_sent_at INTEGER,
      email_notification_error TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (assignee_user_id) REFERENCES user(id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES todo_categories(id)
    );

    CREATE TABLE IF NOT EXISTS todo_read_states (
      user_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, todo_id),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (todo_id) REFERENCES todo_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todo_file_links (
      id TEXT PRIMARY KEY NOT NULL,
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT NOT NULL DEFAULT 'personal',
      workspace_path TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES todo_items(id),
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS todo_email_reply_watchers (
      id TEXT PRIMARY KEY NOT NULL,
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      reply_token TEXT NOT NULL,
      outbound_message_id TEXT,
      source_agent_id TEXT,
      source_session_id TEXT,
      locale TEXT NOT NULL DEFAULT 'de',
      sent_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES todo_items(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todo_email_reply_events (
      id TEXT PRIMARY KEY NOT NULL,
      watcher_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      thread_id TEXT,
      folder TEXT,
      from_address TEXT,
      subject TEXT,
      received_at INTEGER,
      reply_text TEXT,
      status TEXT NOT NULL,
      error TEXT,
      dispatched_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (watcher_id) REFERENCES todo_email_reply_watchers(id) ON DELETE CASCADE,
      FOREIGN KEY (todo_id) REFERENCES todo_items(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS public_file_shares (
      id TEXT PRIMARY KEY NOT NULL,
      token TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      token_preview TEXT NOT NULL,
      short_code TEXT UNIQUE,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT,
      workspace_root_relative_path TEXT,
      workspace_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_identity TEXT NOT NULL,
      target_revision_policy TEXT NOT NULL DEFAULT 'latest',
      last_known_revision TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_user_id TEXT NOT NULL,
      created_by_agent_id TEXT,
      source_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      security_mode TEXT NOT NULL DEFAULT 'strict',
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      revoked_reason TEXT,
      password_enabled INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      created_by_user_id TEXT,
      knowledge_store TEXT NOT NULL,
      visibility TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_title TEXT,
      content_hash TEXT,
      parser_provider TEXT NOT NULL DEFAULT 'native',
      parser_version TEXT,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      policy_decision TEXT NOT NULL DEFAULT 'metadata-only',
      source_acl_version INTEGER NOT NULL DEFAULT 1,
      index_version INTEGER NOT NULL DEFAULT 1,
      embedding_index_status TEXT NOT NULL DEFAULT 'disabled',
      database_provider TEXT NOT NULL DEFAULT 'sqlite',
      metadata_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_access_checked_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      knowledge_store TEXT NOT NULL,
      visibility TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      text TEXT,
      markdown TEXT,
      metadata_json TEXT,
      content_hash TEXT,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      policy_decision TEXT NOT NULL DEFAULT 'metadata-only',
      source_acl_version INTEGER NOT NULL DEFAULT 1,
      index_version INTEGER NOT NULL DEFAULT 1,
      embedding_index_status TEXT NOT NULL DEFAULT 'disabled',
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      metadata_json TEXT,
      input_hash TEXT,
      output_hash TEXT,
      artifact_ref TEXT,
      secret_ref TEXT,
      secret_scope TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS direct_mcp_request_history (
      id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      server_version TEXT,
      flow_ref TEXT,
      phase TEXT NOT NULL,
      http_method TEXT NOT NULL,
      operation TEXT,
      tool_name TEXT,
      outcome TEXT NOT NULL,
      status_code INTEGER,
      code TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      job_scope TEXT NOT NULL DEFAULT 'personal:legacy:legacy',
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT NOT NULL DEFAULT 'personal',
      owner_user_id TEXT,
      responsible_user_id TEXT,
      service_actor_id TEXT,
      approved_by_user_id TEXT,
      last_edited_by_user_id TEXT,
      prompt TEXT NOT NULL,
      preferred_skill TEXT NOT NULL,
      workspace_context_paths_json TEXT NOT NULL,
      target_output_path TEXT,
      schedule_kind TEXT NOT NULL,
      schedule_config_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_run_status TEXT,
      created_by_user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      delivery_mode TEXT NOT NULL DEFAULT 'web',
      delivery_channel_id TEXT,
      delivery_session_mode TEXT NOT NULL DEFAULT 'new_session',
      delivery_session_id TEXT,
      delivery_channel_session_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      job_type TEXT NOT NULL DEFAULT 'default',
      trigger_kind TEXT NOT NULL DEFAULT 'schedule',
      result_policy TEXT NOT NULL DEFAULT 'deliver_all',
      event_config_json TEXT,
      channel_id TEXT,
      composio_trigger_id TEXT,
      composio_trigger_slug TEXT,
      composio_toolkit_slug TEXT,
      composio_connected_account_id TEXT,
      composio_profile_id TEXT,
      composio_user_id TEXT,
      webhook_trigger_config_json TEXT,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (owner_user_id) REFERENCES user(id),
      FOREIGN KEY (responsible_user_id) REFERENCES user(id),
      FOREIGN KEY (composio_profile_id) REFERENCES composio_connection_profiles(id),
      FOREIGN KEY (approved_by_user_id) REFERENCES user(id),
      FOREIGN KEY (last_edited_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      job_scope TEXT NOT NULL DEFAULT 'personal:legacy:legacy',
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT NOT NULL DEFAULT 'personal',
      actor_type TEXT NOT NULL DEFAULT 'user',
      actor_user_id TEXT,
      service_actor_id TEXT,
      trigger_type TEXT NOT NULL,
      scheduled_for INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      attempt_number INTEGER NOT NULL,
      output_dir TEXT,
      target_output_path TEXT,
      effective_target_output_path TEXT,
      log_path TEXT,
      result_path TEXT,
      error_message TEXT,
      pi_session_id TEXT,
      result_text TEXT,
      events_log TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS composio_webhook_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT,
      webhook_id TEXT,
      trigger_id TEXT,
      job_id TEXT,
      run_id TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      metadata_json TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS automation_webhook_triggers (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      secret_preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rotated_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS automation_webhook_events (
      id TEXT PRIMARY KEY NOT NULL,
      webhook_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_id TEXT,
      idempotency_key TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      metadata_json TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (webhook_id) REFERENCES automation_webhook_triggers(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_hint_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      hint_key TEXT NOT NULL,
      page TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      dismissed_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS page_onboarding_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      page TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS onboarding_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      completed_at INTEGER NOT NULL,
      completed_by TEXT,
      method TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS license_certs (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      cert TEXT NOT NULL,
      plan TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS license_public_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      kid TEXT,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'control_plane',
      fetched_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      scope TEXT,
      email TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_valid INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS studio_products (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      created_by_user_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'organization',
      name TEXT NOT NULL,
      description TEXT,
      thumbnail_path TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS studio_product_images (
      id TEXT PRIMARY KEY NOT NULL,
      product_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      source_type TEXT NOT NULL,
      source_url TEXT,
      sort_order INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (product_id) REFERENCES studio_products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_personas (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      created_by_user_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'organization',
      name TEXT NOT NULL,
      description TEXT,
      thumbnail_path TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS studio_persona_images (
      id TEXT PRIMARY KEY NOT NULL,
      persona_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      source_type TEXT NOT NULL,
      source_url TEXT,
      sort_order INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_styles (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      created_by_user_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'organization',
      name TEXT NOT NULL,
      description TEXT,
      thumbnail_path TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS studio_style_images (
      id TEXT PRIMARY KEY NOT NULL,
      style_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      source_type TEXT NOT NULL,
      source_url TEXT,
      sort_order INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (style_id) REFERENCES studio_styles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_presets (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      created_by_user_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'user',
      is_default INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      blocks TEXT NOT NULL,
      preview_image_path TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_generations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      created_by_user_id TEXT,
      workspace_id TEXT,
      mode TEXT NOT NULL,
      prompt TEXT,
      raw_prompt TEXT,
      studio_preset_id TEXT,
      studio_preset_name TEXT,
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      idempotency_key TEXT,
      bulk_job_id TEXT,
      pi_session_id TEXT,
      source_generation_id TEXT,
      metadata TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (studio_preset_id) REFERENCES studio_presets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS studio_generation_outputs (
      id TEXT PRIMARY KEY NOT NULL,
      generation_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      created_by_user_id TEXT,
      workspace_id TEXT,
      variation_index INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'image',
      file_path TEXT NOT NULL,
      file_name TEXT,
      media_url TEXT,
      file_size INTEGER,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_generation_products (
      generation_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, product_id),
      FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES studio_products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_generation_personas (
      generation_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, persona_id),
      FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_generation_styles (
      generation_id TEXT NOT NULL,
      style_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, style_id),
      FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (style_id) REFERENCES studio_styles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS studio_bulk_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      customer_id TEXT,
      project_id TEXT,
      created_by_user_id TEXT,
      workspace_id TEXT,
      name TEXT,
      studio_preset_id TEXT,
      additional_prompt TEXT,
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      versions_per_product INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      total_line_items INTEGER NOT NULL,
      completed_line_items INTEGER NOT NULL DEFAULT 0,
      failed_line_items INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (studio_preset_id) REFERENCES studio_presets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS studio_bulk_job_line_items (
      id TEXT PRIMARY KEY NOT NULL,
      bulk_job_id TEXT NOT NULL,
      product_id TEXT,
      persona_id TEXT,
      style_id TEXT,
      studio_preset_id TEXT,
      custom_prompt TEXT,
      generation_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (bulk_job_id) REFERENCES studio_bulk_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES studio_products(id) ON DELETE SET NULL,
      FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON DELETE SET NULL,
      FOREIGN KEY (style_id) REFERENCES studio_styles(id) ON DELETE SET NULL,
      FOREIGN KEY (studio_preset_id) REFERENCES studio_presets(id) ON DELETE SET NULL,
      FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON DELETE SET NULL
    );
  `);

  // Older imported databases may predate columns that are used by indexes below.
  // Add those compatibility columns before index creation so restores can migrate
  // from older Canvas versions without failing halfway through startup.
  addColumns(sqlite, 'automation_jobs', {
    next_run_at: 'INTEGER',
  });

  addColumns(sqlite, 'mobile_push_devices', {
    todo_attention: 'INTEGER NOT NULL DEFAULT 1',
    studio_completed: 'INTEGER NOT NULL DEFAULT 1',
    failure_attention: 'INTEGER NOT NULL DEFAULT 1',
    automation_run_status: 'INTEGER NOT NULL DEFAULT 0',
    preview_enabled: 'INTEGER NOT NULL DEFAULT 0',
  });

  addColumns(sqlite, 'mobile_inbox_read_states', {
    dismissed_at: 'INTEGER',
  });

  addColumns(sqlite, 'organization_user_permissions', {
    can_manage_organization_memory: 'INTEGER NOT NULL DEFAULT 0',
    status: "TEXT NOT NULL DEFAULT 'active'",
    disabled_at: 'INTEGER',
    archived_at: 'INTEGER',
    offboarded_by_user_id: 'TEXT',
    offboarding_reason: 'TEXT',
    offboarding_report_json: 'TEXT',
  });

  addColumns(sqlite, 'studio_products', { workspace_id: 'TEXT' });
  addColumns(sqlite, 'studio_personas', { workspace_id: 'TEXT' });
  addColumns(sqlite, 'studio_styles', { workspace_id: 'TEXT' });
  addColumns(sqlite, 'studio_presets', { workspace_id: 'TEXT' });

  addColumns(sqlite, 'pi_delegations', {
    requested_session_id: 'TEXT',
  });

  addColumns(sqlite, 'pi_sessions', {
    session_kind: "TEXT NOT NULL DEFAULT 'conversation'",
    parent_session_id: 'TEXT',
    delegation_id: 'TEXT',
    delegation_depth: 'INTEGER NOT NULL DEFAULT 0',
  });
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_kind_created ON pi_sessions (user_id, session_kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_delegation ON pi_sessions (user_id, delegation_id);
  `);

  addColumns(sqlite, 'canvas_workspaces', {
    customer_id: 'TEXT',
    project_id: 'TEXT',
    description: "TEXT NOT NULL DEFAULT ''",
    workspace_icon: "TEXT NOT NULL DEFAULT 'user-round'",
    is_default: 'INTEGER NOT NULL DEFAULT 0',
  });

  sqlite.exec(`
    UPDATE canvas_workspaces
    SET type = 'organization', is_default = 0, updated_at = CASE WHEN updated_at IS NULL THEN created_at ELSE updated_at END
    WHERE type = 'team'
      AND (
        LENGTH(root_relative_path) - LENGTH(REPLACE(root_relative_path, '/', '')) = 3
        OR root_relative_path IS NULL
        OR root_relative_path = ''
      );

    UPDATE canvas_workspaces
    SET is_default = 1
    WHERE type = 'personal'
      AND owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM canvas_workspaces older
        WHERE older.type = 'personal'
          AND older.owner_user_id = canvas_workspaces.owner_user_id
          AND (
            older.created_at < canvas_workspaces.created_at
            OR (older.created_at = canvas_workspaces.created_at AND older.id < canvas_workspaces.id)
          )
      );

    UPDATE canvas_workspaces
    SET is_default = 0
    WHERE type = 'organization';
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_canvas_workspaces_project_id_required_insert
    BEFORE INSERT ON canvas_workspaces
    WHEN NEW.type = 'project' AND NEW.project_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'project workspace requires project_id');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_canvas_workspaces_project_id_required_update
    BEFORE UPDATE OF type, project_id ON canvas_workspaces
    WHEN NEW.type = 'project' AND NEW.project_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'project workspace requires project_id');
    END;
  `);

  addColumns(sqlite, 'workspace_trash_entries', {
    customer_id: 'TEXT',
    project_id: 'TEXT',
  });

  addColumns(sqlite, 'studio_generations', {
    studio_preset_name: 'TEXT',
    idempotency_key: 'TEXT',
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'studio_products', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_personas', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_styles', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_presets', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'user'",
  });

  addColumns(sqlite, 'studio_generation_outputs', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'studio_bulk_jobs', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'todo_items', {
    created_by_user_id: 'TEXT',
    assignee_user_id: 'TEXT',
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
    scope_kind: "TEXT NOT NULL DEFAULT 'user'",
    completion_comment: 'TEXT',
    follow_up_sent_at: 'INTEGER',
    follow_up_error: 'TEXT',
    email_notification_sent_at: 'INTEGER',
    email_notification_error: 'TEXT',
    icon_key: 'TEXT',
    remind_at: 'INTEGER',
    reminder_sent_at: 'INTEGER',
    reminder_error: 'TEXT',
  });

  addColumns(sqlite, 'todo_file_links', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
  });

  sqlite.exec(`
    UPDATE todo_items
    SET scope_kind = CASE
      WHEN workspace_id IS NOT NULL THEN 'workspace'
      ELSE 'user'
    END
    WHERE scope_kind IS NULL
      OR scope_kind NOT IN ('user', 'workspace')
      OR (scope_kind = 'user' AND workspace_id IS NOT NULL);

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_products
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org)),
      visibility = CASE
        WHEN COALESCE(organization_id, (SELECT organization_id FROM primary_org)) IS NULL THEN 'user'
        ELSE COALESCE(visibility, 'organization')
      END
    WHERE created_by_user_id IS NULL OR organization_id IS NULL OR visibility IS NULL;

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_personas
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org)),
      visibility = CASE
        WHEN COALESCE(organization_id, (SELECT organization_id FROM primary_org)) IS NULL THEN 'user'
        ELSE COALESCE(visibility, 'organization')
      END
    WHERE created_by_user_id IS NULL OR organization_id IS NULL OR visibility IS NULL;

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_styles
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org)),
      visibility = CASE
        WHEN COALESCE(organization_id, (SELECT organization_id FROM primary_org)) IS NULL THEN 'user'
        ELSE COALESCE(visibility, 'organization')
      END
    WHERE created_by_user_id IS NULL OR organization_id IS NULL OR visibility IS NULL;

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_presets
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org)),
      visibility = COALESCE(visibility, CASE WHEN user_id IS NULL THEN 'default' ELSE 'user' END)
    WHERE created_by_user_id IS NULL OR organization_id IS NULL OR visibility IS NULL;

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_generations
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org))
    WHERE created_by_user_id IS NULL OR organization_id IS NULL;

    UPDATE studio_generation_outputs
    SET
      created_by_user_id = COALESCE(
        created_by_user_id,
        (
          SELECT COALESCE(studio_generations.created_by_user_id, studio_generations.user_id)
          FROM studio_generations
          WHERE studio_generations.id = studio_generation_outputs.generation_id
        )
      ),
      organization_id = COALESCE(
        organization_id,
        (
          SELECT studio_generations.organization_id
          FROM studio_generations
          WHERE studio_generations.id = studio_generation_outputs.generation_id
        )
      ),
      workspace_id = COALESCE(
        workspace_id,
        (
          SELECT studio_generations.workspace_id
          FROM studio_generations
          WHERE studio_generations.id = studio_generation_outputs.generation_id
        )
      )
    WHERE created_by_user_id IS NULL OR organization_id IS NULL OR workspace_id IS NULL;

    WITH primary_org AS (
      SELECT organization_id
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    )
    UPDATE studio_bulk_jobs
    SET
      created_by_user_id = COALESCE(created_by_user_id, user_id),
      organization_id = COALESCE(organization_id, (SELECT organization_id FROM primary_org))
    WHERE created_by_user_id IS NULL OR organization_id IS NULL;

    UPDATE email_accounts
    SET is_primary = 0
    WHERE status != 'active';

    WITH ranked_primary_accounts AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY updated_at DESC, id DESC
        ) AS primary_rank
      FROM email_accounts
      WHERE status = 'active'
        AND is_primary = 1
    )
    UPDATE email_accounts
    SET is_primary = 0
    WHERE id IN (
      SELECT id
      FROM ranked_primary_accounts
      WHERE primary_rank > 1
    );

    UPDATE email_accounts
    SET is_primary = 1
    WHERE status = 'active'
      AND id IN (
        SELECT fallback.id
        FROM email_accounts fallback
        WHERE fallback.status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM email_accounts current_primary
            WHERE current_primary.user_id = fallback.user_id
              AND current_primary.status = 'active'
              AND current_primary.is_primary = 1
          )
          AND fallback.id = (
            SELECT newest.id
            FROM email_accounts newest
            WHERE newest.user_id = fallback.user_id
              AND newest.status = 'active'
            ORDER BY newest.updated_at DESC, newest.id DESC
            LIMIT 1
          )
      );
  `);

  // ── Indexes ──────────────────────────────────────────────────────────────────

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
    CREATE UNIQUE INDEX IF NOT EXISTS session_token_unique ON session (token);
    CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts (user_id);
    CREATE INDEX IF NOT EXISTS idx_email_accounts_user_status ON email_accounts (user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_user_provider_email ON email_accounts (user_id, provider, email_address);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_user_primary ON email_accounts (user_id) WHERE is_primary = 1;
    CREATE INDEX IF NOT EXISTS idx_email_drafts_user ON email_drafts (user_id);
    CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON email_drafts (account_id);
    CREATE INDEX IF NOT EXISTS idx_email_drafts_user_status ON email_drafts (user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_usage_events_fingerprint ON pi_usage_events (fingerprint);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_created_at ON pi_usage_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_session_created_at ON pi_usage_events (session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_provider_created_at ON pi_usage_events (provider, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_model_created_at ON pi_usage_events (model, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_assistant_timestamp ON pi_usage_events (user_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_session_assistant_timestamp ON pi_usage_events (session_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_provider_assistant_timestamp ON pi_usage_events (provider, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_model_assistant_timestamp ON pi_usage_events (model, assistant_timestamp);
    CREATE TABLE IF NOT EXISTS composio_webhook_subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      subscription_id TEXT NOT NULL UNIQUE,
      webhook_url TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      secret_preview TEXT,
      event_types TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      rotated_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_webhook_subscriptions_subscription_id ON composio_webhook_subscriptions (subscription_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_webhook_events_event_id ON composio_webhook_events (event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_webhook_events_webhook_id ON composio_webhook_events (webhook_id);
    CREATE INDEX IF NOT EXISTS idx_composio_webhook_events_trigger ON composio_webhook_events (trigger_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_composio_webhook_events_job ON composio_webhook_events (job_id, received_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_webhook_triggers_job ON automation_webhook_triggers (job_id);
    CREATE INDEX IF NOT EXISTS idx_automation_webhook_triggers_status ON automation_webhook_triggers (status);
    CREATE INDEX IF NOT EXISTS idx_automation_webhook_events_webhook_received ON automation_webhook_events (webhook_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_automation_webhook_events_job_received ON automation_webhook_events (job_id, received_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_webhook_events_event ON automation_webhook_events (webhook_id, event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_webhook_events_idempotency ON automation_webhook_events (webhook_id, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_hint_state_user_hint ON user_hint_state (user_id, hint_key);
    CREATE INDEX IF NOT EXISTS idx_user_hint_state_user_page ON user_hint_state (user_id, page);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_onboarding_state_user_page ON page_onboarding_state (user_id, page);
    CREATE INDEX IF NOT EXISTS idx_page_onboarding_state_user_completed ON page_onboarding_state (user_id, completed);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens (provider);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_valid ON oauth_tokens (provider, is_valid);
    CREATE INDEX IF NOT EXISTS idx_license_certs_instance ON license_certs (instance_id);
    CREATE INDEX IF NOT EXISTS idx_license_certs_instance_id_desc ON license_certs (instance_id, id DESC);

    -- Deduplicate license certs that were repeatedly inserted by older code.
    -- Keep the newest row per (instance_id, cert) so the unique index below can be created.
    DELETE FROM license_certs
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM license_certs
      GROUP BY instance_id, cert
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_license_certs_instance_cert ON license_certs (instance_id, cert);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_license_public_keys_fingerprint ON license_public_keys (fingerprint);
    CREATE INDEX IF NOT EXISTS idx_license_public_keys_fetched_at ON license_public_keys (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_user ON studio_products (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_products_organization ON studio_products (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_project ON studio_products (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_workspace ON studio_products (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_creator ON studio_products (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_created ON studio_products (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_product_images_product ON studio_product_images (product_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_user ON studio_personas (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_organization ON studio_personas (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_project ON studio_personas (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_workspace ON studio_personas (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_creator ON studio_personas (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_created ON studio_personas (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_persona_images_persona ON studio_persona_images (persona_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_user ON studio_styles (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_organization ON studio_styles (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_project ON studio_styles (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_workspace ON studio_styles (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_creator ON studio_styles (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_created ON studio_styles (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_style_images_style ON studio_style_images (style_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_user ON studio_presets (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_organization ON studio_presets (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_project ON studio_presets (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_workspace ON studio_presets (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_creator ON studio_presets (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_category ON studio_presets (category);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_created ON studio_presets (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_user ON studio_generations (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_organization ON studio_generations (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_project ON studio_generations (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_creator ON studio_generations (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_workspace ON studio_generations (workspace_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_generations_idempotency ON studio_generations (user_id, workspace_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_status ON studio_generations (status);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_created ON studio_generations (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_generation ON studio_generation_outputs (generation_id);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_organization ON studio_generation_outputs (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_project ON studio_generation_outputs (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_creator ON studio_generation_outputs (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_workspace ON studio_generation_outputs (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_created ON studio_generation_outputs (created_at);
    CREATE INDEX IF NOT EXISTS idx_gen_products_generation ON studio_generation_products (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_products_product ON studio_generation_products (product_id);
    CREATE INDEX IF NOT EXISTS idx_gen_personas_generation ON studio_generation_personas (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_personas_persona ON studio_generation_personas (persona_id);
    CREATE INDEX IF NOT EXISTS idx_gen_styles_generation ON studio_generation_styles (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_styles_style ON studio_generation_styles (style_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_user ON studio_bulk_jobs (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_organization ON studio_bulk_jobs (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_project ON studio_bulk_jobs (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_creator ON studio_bulk_jobs (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_workspace ON studio_bulk_jobs (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_status ON studio_bulk_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_created ON studio_bulk_jobs (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_bulk_job ON studio_bulk_job_line_items (bulk_job_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_status ON studio_bulk_job_line_items (status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_id ON agents (agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_members_org_user ON agent_members (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_members_agent_status ON agent_members (agent_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_grants_binding ON agent_grants (agent_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_agent_grants_org_target ON agent_grants (organization_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_agent_grants_agent ON agent_grants (agent_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_capability_bindings_binding ON agent_capability_bindings (agent_id, resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_agent_capability_bindings_agent_type ON agent_capability_bindings (agent_id, resource_type);
    CREATE INDEX IF NOT EXISTS idx_agent_capability_bindings_resource ON agent_capability_bindings (resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_agent_user_preferences_user ON agent_user_preferences (user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_pi_messages_session_timestamp ON pi_messages (pi_session_db_id, timestamp, id);
    CREATE INDEX IF NOT EXISTS idx_todo_categories_user_sort ON todo_categories (user_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_todo_categories_user_archived ON todo_categories (user_id, is_archived);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_status_updated ON todo_items (user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_due ON todo_items (user_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_reminder_due ON todo_items (status, remind_at, reminder_sent_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_seen ON todo_items (user_id, seen_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_source_session ON todo_items (user_id, source_session_id);
    CREATE INDEX IF NOT EXISTS idx_todo_items_org_workspace_status ON todo_items (organization_id, workspace_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_scope_workspace_status ON todo_items (scope_kind, workspace_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_project_status ON todo_items (project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_assignee_status ON todo_items (assignee_user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_category ON todo_items (category_id);
    CREATE INDEX IF NOT EXISTS idx_todo_read_states_user_read ON todo_read_states (user_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_todo_read_states_todo ON todo_read_states (todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_todo ON todo_file_links (todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_user_path ON todo_file_links (user_id, workspace_path);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_workspace_path ON todo_file_links (organization_id, workspace_id, workspace_path);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_project_path ON todo_file_links (project_id, workspace_path);
    CREATE INDEX IF NOT EXISTS idx_todo_email_reply_watchers_status_checked ON todo_email_reply_watchers (status, last_checked_at);
    CREATE INDEX IF NOT EXISTS idx_todo_email_reply_watchers_todo ON todo_email_reply_watchers (todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_email_reply_watchers_user_status ON todo_email_reply_watchers (user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_email_reply_watchers_token ON todo_email_reply_watchers (reply_token);
    CREATE INDEX IF NOT EXISTS idx_todo_email_reply_events_watcher_created ON todo_email_reply_events (watcher_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_todo_email_reply_events_todo_created ON todo_email_reply_events (todo_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_email_reply_events_message ON todo_email_reply_events (watcher_id, account_id, provider_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_file_shares_token_hash ON public_file_shares (token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_file_shares_token ON public_file_shares (token);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_status ON public_file_shares (status);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_workspace_path ON public_file_shares (workspace_path);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_user_status ON public_file_shares (created_by_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_expires_at ON public_file_shares (expires_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_store_status ON knowledge_sources (knowledge_store, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_org_workspace ON knowledge_sources (organization_id, workspace_id, knowledge_store, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_user_store ON knowledge_sources (user_id, knowledge_store, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_workspace_path ON knowledge_sources (workspace_id, source_path);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_content_hash ON knowledge_sources (content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_source_chunk ON knowledge_chunks (source_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_org_workspace ON knowledge_chunks (organization_id, workspace_id, knowledge_store, embedding_index_status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_user_store ON knowledge_chunks (user_id, knowledge_store, embedding_index_status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_policy ON knowledge_chunks (policy_decision, scan_status, embedding_index_status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_content_hash ON knowledge_chunks (content_hash);
    CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_org_created ON audit_events (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_workspace_created ON audit_events (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_user_created ON audit_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_entity_created ON audit_events (entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_source_action_created ON audit_events (source, action, created_at);
    CREATE INDEX IF NOT EXISTS idx_direct_mcp_request_history_created ON direct_mcp_request_history (created_at);
    CREATE INDEX IF NOT EXISTS idx_direct_mcp_request_history_expires ON direct_mcp_request_history (expires_at);
  `);

  if (tableExists(sqlite, 'ai_sessions') && tableExists(sqlite, 'ai_messages')) {
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_created ON ai_sessions (user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_session ON ai_sessions (user_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_session_created ON ai_messages (ai_session_db_id, created_at, id);
    `);
  }

  // ── Column additions for existing volumes ────────────────────────────────────
  // Each block adds columns that were missing from older schema versions.
  // ALTER TABLE ADD COLUMN is idempotent here because we check PRAGMA table_info first.

  addColumns(sqlite, 'direct_mcp_request_history', {
    server_version: 'TEXT',
  });

  addColumns(sqlite, 'agents', {
    scope_type: "TEXT NOT NULL DEFAULT 'user'",
    organization_id: 'TEXT',
    owner_user_id: 'TEXT',
    created_by_user_id: 'TEXT',
    revision: 'INTEGER NOT NULL DEFAULT 1',
  });

  addColumns(sqlite, 'oauth_client', {
    client_discovery_id: 'TEXT',
    client_credentials_scopes: 'TEXT',
    backchannel_logout_uri: 'TEXT',
    backchannel_logout_session_required: 'INTEGER',
    application_type: 'TEXT',
    jwks: 'TEXT',
    jwks_uri: 'TEXT',
    dpop_bound_access_tokens: 'INTEGER',
  });

  // Better Auth's JWT plugin persists the signing algorithm and curve with
  // each key. These nullable columns preserve compatibility with legacy key
  // rows, which Better Auth treats as using its configured default algorithm.
  addColumns(sqlite, 'jwks', {
    alg: 'TEXT',
    crv: 'TEXT',
  });

  // Better Auth 1.7+ requires an `issuer` column on the account table. Existing
  // credential rows are defaulted to the synthetic local credential issuer so
  // email/password sign-in keeps working after the upgrade.
  addColumns(sqlite, 'account', {
    issuer: "TEXT NOT NULL DEFAULT 'local:credential'",
  });
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_issuer_account_id
      ON account (issuer, account_id);
    CREATE INDEX IF NOT EXISTS idx_account_user_provider
      ON account (user_id, provider_id);
  `);

  addColumns(sqlite, 'oauth_refresh_token', {
    authorization_code_id: 'TEXT',
    resources: 'TEXT',
    requested_user_info_claims: 'TEXT',
    rotated_at: 'INTEGER',
    rotation_replay_response: 'TEXT',
    rotation_replay_expires_at: 'INTEGER',
    confirmation: 'TEXT',
  });

  addColumns(sqlite, 'oauth_access_token', {
    authorization_code_id: 'TEXT',
    resources: 'TEXT',
    requested_user_info_claims: 'TEXT',
    confirmation: 'TEXT',
  });

  addColumns(sqlite, 'oauth_consent', {
    resources: 'TEXT',
    requested_user_info_claims: 'TEXT',
  });

  addColumns(sqlite, 'pi_sessions', {
    title_generation_state: 'TEXT',
    last_message_at: 'INTEGER',
    last_viewed_at: 'INTEGER',
    archived_at: 'INTEGER',
    thinking_level: 'TEXT',
    summary_through_sequence: 'INTEGER',
    summary_revision: 'INTEGER NOT NULL DEFAULT 0',
    runtime_provider_installation_id: 'TEXT',
    runtime_catalog_revision: 'INTEGER',
    runtime_policy_revision: 'INTEGER',
    runtime_selection_source: 'TEXT',
    client_request_id: 'TEXT',
  });

  addColumns(sqlite, 'ai_provider_installations', {
    source_revision: 'TEXT',
    last_synced_at: 'INTEGER',
  });

  addColumns(sqlite, 'pi_messages', {
    sequence: 'INTEGER NOT NULL DEFAULT 0',
  });

  addColumns(sqlite, 'pi_session_compaction_attempts', {
    attempt_ordinal: 'INTEGER NOT NULL DEFAULT 0',
  });
  sqlite.exec(`
    WITH ranked_attempts AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY pi_session_db_id
               ORDER BY started_at ASC, created_at ASC, id ASC
             ) AS next_ordinal
      FROM pi_session_compaction_attempts
    )
    UPDATE pi_session_compaction_attempts
    SET attempt_ordinal = (
      SELECT next_ordinal FROM ranked_attempts
      WHERE ranked_attempts.id = pi_session_compaction_attempts.id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_compaction_attempts_session_ordinal
      ON pi_session_compaction_attempts (pi_session_db_id, attempt_ordinal);
  `);

  sqlite.exec(`
    WITH ordered_messages AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY pi_session_db_id
          ORDER BY id
        ) AS next_sequence
      FROM pi_messages
    )
    UPDATE pi_messages
    SET sequence = (
      SELECT next_sequence
      FROM ordered_messages
      WHERE ordered_messages.id = pi_messages.id
    )
    WHERE sequence IS NULL OR sequence = 0;

    CREATE INDEX IF NOT EXISTS idx_pi_messages_session_sequence ON pi_messages (pi_session_db_id, sequence, id);
  `);

  addColumns(sqlite, 'automation_jobs', {
    target_output_path: 'TEXT',
  });

  addColumns(sqlite, 'email_drafts', {
    attachments_json: "TEXT NOT NULL DEFAULT '[]'",
  });

  addColumns(sqlite, 'file_revisions', {
    lineage_id: 'TEXT',
  });

  addColumns(sqlite, 'file_collaboration_lineages', {
    trash_entry_id: 'TEXT',
  });

  sqlite.exec(`
    UPDATE todo_items
    SET created_by_user_id = user_id
    WHERE created_by_user_id IS NULL;
  `);

  addColumns(sqlite, 'automation_runs', {
    target_output_path: 'TEXT',
    effective_target_output_path: 'TEXT',
    events_log: 'TEXT',
    metadata_json: 'TEXT',
    result_text: 'TEXT',
  });

  addColumns(sqlite, 'studio_generation_outputs', {
    variation_index: 'INTEGER NOT NULL DEFAULT 0',
    type: "TEXT NOT NULL DEFAULT 'image'",
    file_name: 'TEXT',
    media_url: 'TEXT',
    is_favorite: 'INTEGER NOT NULL DEFAULT 0',
    metadata: 'TEXT',
  });

  addColumns(sqlite, 'studio_bulk_job_line_items', {
    style_id: 'TEXT',
    studio_preset_id: 'TEXT',
    custom_prompt: 'TEXT',
  });

  for (const statement of STUDIO_WORKSPACE_BACKFILL_STATEMENTS) {
    sqlite.exec(statement);
  }

  addColumns(sqlite, 'public_file_shares', {
    short_code: 'TEXT',
    security_mode: "TEXT NOT NULL DEFAULT 'strict'",
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    workspace_root_relative_path: 'TEXT',
    target_revision_policy: "TEXT NOT NULL DEFAULT 'latest'",
    last_known_revision: 'TEXT',
    revoked_reason: 'TEXT',
    password_enabled: 'INTEGER NOT NULL DEFAULT 0',
    password_hash: 'TEXT',
  });

  addColumns(sqlite, 'knowledge_sources', {
    customer_id: 'TEXT',
    project_id: 'TEXT',
  });

  addColumns(sqlite, 'knowledge_chunks', {
    customer_id: 'TEXT',
    project_id: 'TEXT',
  });

  addColumns(sqlite, 'audit_events', {
    customer_id: 'TEXT',
    project_id: 'TEXT',
  });

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_file_shares_short_code ON public_file_shares (short_code);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_workspace_id_path ON public_file_shares (workspace_id, workspace_path, status);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_org_status ON public_file_shares (organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_project_status ON public_file_shares (project_id, status);
  `);

  addColumns(sqlite, 'pi_sessions', {
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
    channel_id: "TEXT NOT NULL DEFAULT 'app'",
    channel_session_key: 'TEXT',
    system_prompt_snapshot: 'TEXT',
    system_prompt_snapshot_hash: 'TEXT',
    system_prompt_snapshot_created_at: 'INTEGER',
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    workspace_name: 'TEXT',
    workspace_root_relative_path: 'TEXT',
  });

  addColumns(sqlite, 'email_accounts', {
    account_scope: "TEXT NOT NULL DEFAULT 'personal'",
    organization_id: 'TEXT',
    connected_by_user_id: 'TEXT',
    automation_enabled_at: 'INTEGER',
    workspace_id: 'TEXT',
  });

  sqlite.exec(`
    UPDATE email_accounts
    SET account_scope = COALESCE(NULLIF(account_scope, ''), 'personal'),
        connected_by_user_id = COALESCE(NULLIF(connected_by_user_id, ''), user_id)
    WHERE account_scope IS NULL OR account_scope = '' OR connected_by_user_id IS NULL OR connected_by_user_id = '';

    CREATE INDEX IF NOT EXISTS idx_email_accounts_workspace ON email_accounts (workspace_id, status);

    CREATE TABLE IF NOT EXISTS workspace_email_mailboxes (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      email_account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'inbound_outbound',
      created_by_user_id TEXT NOT NULL,
      last_edited_by_user_id TEXT NOT NULL,
      paused_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (last_edited_by_user_id) REFERENCES user(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_email_mailboxes_workspace_status
      ON workspace_email_mailboxes (workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_workspace_email_mailboxes_account_status
      ON workspace_email_mailboxes (email_account_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_email_mailboxes_active_account
      ON workspace_email_mailboxes (email_account_id) WHERE status = 'active';

    -- Existing workspace bindings become shared mailboxes. The account record
    -- retains its original creator only for provider compatibility; it is no
    -- longer exposed as that user's personal integration.
    UPDATE email_accounts
    SET account_scope = 'workspace',
        is_primary = 0
    WHERE id IN (
      SELECT email_account_id
      FROM workspace_email_mailboxes
      WHERE status = 'active'
    );

    CREATE TABLE IF NOT EXISTS email_inbox_events (
      id TEXT PRIMARY KEY NOT NULL,
      mailbox_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider_message_id TEXT,
      provider_thread_id TEXT,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      error_code TEXT,
      case_id TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (mailbox_id) REFERENCES workspace_email_mailboxes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inbox_events_mailbox_idempotency
      ON email_inbox_events (mailbox_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_email_inbox_events_workspace_status
      ON email_inbox_events (workspace_id, status, received_at);

    CREATE TABLE IF NOT EXISTS email_inbox_cases (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, latest_provider_message_id TEXT,
      requester_address TEXT, requester_name TEXT, subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', priority TEXT NOT NULL DEFAULT 'normal', assignee_user_id TEXT,
      closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (mailbox_id) REFERENCES workspace_email_mailboxes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inbox_cases_mailbox_thread ON email_inbox_cases (mailbox_id, provider_thread_id);
    CREATE INDEX IF NOT EXISTS idx_email_inbox_cases_workspace_status ON email_inbox_cases (workspace_id, status, updated_at);
  `);

  addColumns(sqlite, 'email_drafts', {
    workspace_id: 'TEXT', mailbox_id: 'TEXT', inbox_case_id: 'TEXT', origin: "TEXT NOT NULL DEFAULT 'manual'",
    origin_automation_job_id: 'TEXT', origin_run_id: 'TEXT', origin_agent_id: 'TEXT', outbox_status: 'TEXT',
    version: 'INTEGER NOT NULL DEFAULT 1', assigned_user_id: 'TEXT', editing_by_user_id: 'TEXT',
    editing_started_at: 'INTEGER', sent_by_user_id: 'TEXT',
  });
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_email_drafts_workspace_outbox ON email_drafts (workspace_id, outbox_status, updated_at)');
  addColumns(sqlite, 'email_drafts', { personal_inbox_case_id: 'TEXT' });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS personal_email_inbox_cases (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      email_account_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      latest_provider_message_id TEXT,
      requester_address TEXT,
      requester_name TEXT,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee_user_id TEXT,
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_email_inbox_cases_account_thread
      ON personal_email_inbox_cases (email_account_id, provider_thread_id);
    CREATE INDEX IF NOT EXISTS idx_personal_email_inbox_cases_user_status
      ON personal_email_inbox_cases (user_id, status, updated_at);
  `);

  addColumns(sqlite, 'pi_usage_events', {
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
  });

  addColumns(sqlite, 'automation_jobs', {
    scope: "TEXT NOT NULL DEFAULT 'personal'",
    job_scope: "TEXT NOT NULL DEFAULT 'personal:legacy:legacy'",
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
    owner_user_id: 'TEXT',
    responsible_user_id: 'TEXT',
    service_actor_id: 'TEXT',
    approved_by_user_id: 'TEXT',
    last_edited_by_user_id: 'TEXT',
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
    delivery_mode: "TEXT NOT NULL DEFAULT 'web'",
    delivery_channel_id: 'TEXT',
    delivery_session_mode: "TEXT NOT NULL DEFAULT 'new_session'",
    delivery_session_id: 'TEXT',
    delivery_channel_session_key: 'TEXT',
    job_type: "TEXT NOT NULL DEFAULT 'default'",
    trigger_kind: "TEXT NOT NULL DEFAULT 'schedule'",
    result_policy: "TEXT NOT NULL DEFAULT 'deliver_all'",
    event_config_json: 'TEXT',
    channel_id: 'TEXT',
    composio_trigger_id: 'TEXT',
    composio_trigger_slug: 'TEXT',
    composio_toolkit_slug: 'TEXT',
    composio_connected_account_id: 'TEXT',
    composio_profile_id: 'TEXT',
    composio_user_id: 'TEXT',
    webhook_trigger_config_json: 'TEXT',
    integrity_status: "TEXT NOT NULL DEFAULT 'valid'",
    integrity_reason: 'TEXT',
    revision: 'INTEGER NOT NULL DEFAULT 1',
    deleted_at: 'INTEGER',
    deleted_by_user_id: 'TEXT',
  });

  addColumns(sqlite, 'automation_runs', {
    scope: "TEXT NOT NULL DEFAULT 'personal'",
    job_scope: "TEXT NOT NULL DEFAULT 'personal:legacy:legacy'",
    organization_id: 'TEXT',
    customer_id: 'TEXT',
    project_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
    actor_type: "TEXT NOT NULL DEFAULT 'user'",
    actor_user_id: 'TEXT',
    service_actor_id: 'TEXT',
  });

  sqlite.exec(`
    UPDATE automation_jobs
    SET
      owner_user_id = CASE
        WHEN COALESCE(NULLIF(scope, ''), 'personal') = 'organization' THEN NULL
        ELSE COALESCE(owner_user_id, created_by_user_id)
      END,
      responsible_user_id = COALESCE(responsible_user_id, created_by_user_id),
      last_edited_by_user_id = COALESCE(last_edited_by_user_id, created_by_user_id),
      scope = COALESCE(NULLIF(scope, ''), 'personal'),
      workspace_type = COALESCE(NULLIF(workspace_type, ''), 'personal'),
      job_scope = CASE
        WHEN COALESCE(NULLIF(scope, ''), 'personal') = 'organization'
          THEN 'organization:' || COALESCE(NULLIF(organization_id, ''), 'legacy') || ':' || COALESCE(NULLIF(workspace_id, ''), NULLIF(workspace_type, ''), 'legacy')
        ELSE 'personal:' || COALESCE(NULLIF(owner_user_id, ''), NULLIF(responsible_user_id, ''), NULLIF(created_by_user_id, ''), 'unknown') || ':' || COALESCE(NULLIF(workspace_id, ''), NULLIF(workspace_type, ''), 'legacy')
      END
    WHERE owner_user_id IS NULL
      OR responsible_user_id IS NULL
      OR last_edited_by_user_id IS NULL
      OR scope IS NULL
      OR scope = ''
      OR workspace_type IS NULL
      OR workspace_type = ''
      OR job_scope IS NULL
      OR job_scope = ''
      OR job_scope = 'personal:legacy:legacy';

    UPDATE automation_jobs
    SET
      integrity_status = CASE
        WHEN scope NOT IN ('personal', 'organization') THEN 'quarantined'
        WHEN organization_id IS NULL OR workspace_id IS NULL THEN 'quarantined'
        WHEN workspace_id NOT IN (SELECT id FROM canvas_workspaces) THEN 'quarantined'
        WHEN organization_id != (SELECT organization_id FROM canvas_workspaces WHERE id = automation_jobs.workspace_id) THEN 'quarantined'
        WHEN workspace_type != (SELECT type FROM canvas_workspaces WHERE id = automation_jobs.workspace_id) THEN 'quarantined'
        WHEN scope = 'personal' AND (
          owner_user_id IS NULL OR responsible_user_id != owner_user_id OR
          workspace_type != 'personal' OR service_actor_id IS NOT NULL OR approved_by_user_id IS NOT NULL
        ) THEN 'quarantined'
        WHEN scope = 'organization' AND (
          owner_user_id IS NOT NULL OR responsible_user_id IS NULL OR service_actor_id IS NULL OR
          approved_by_user_id IS NULL OR workspace_type NOT IN ('organization', 'team')
        ) THEN 'quarantined'
        ELSE 'valid'
      END,
      integrity_reason = CASE
        WHEN scope NOT IN ('personal', 'organization') THEN 'invalid_scope'
        WHEN organization_id IS NULL OR workspace_id IS NULL THEN 'missing_scope_binding'
        WHEN workspace_id NOT IN (SELECT id FROM canvas_workspaces) THEN 'missing_workspace'
        WHEN organization_id != (SELECT organization_id FROM canvas_workspaces WHERE id = automation_jobs.workspace_id) THEN 'workspace_organization_mismatch'
        WHEN workspace_type != (SELECT type FROM canvas_workspaces WHERE id = automation_jobs.workspace_id) THEN 'workspace_type_mismatch'
        WHEN scope = 'personal' AND (
          owner_user_id IS NULL OR responsible_user_id != owner_user_id OR
          workspace_type != 'personal' OR service_actor_id IS NOT NULL OR approved_by_user_id IS NOT NULL
        ) THEN 'invalid_personal_binding'
        WHEN scope = 'organization' AND (
          owner_user_id IS NOT NULL OR responsible_user_id IS NULL OR service_actor_id IS NULL OR
          approved_by_user_id IS NULL OR workspace_type NOT IN ('organization', 'team')
        ) THEN 'invalid_organization_binding'
        ELSE NULL
      END,
      revision = CASE WHEN revision IS NULL OR revision < 1 THEN 1 ELSE revision END
    WHERE integrity_status IS NULL
      OR integrity_status = ''
      OR integrity_status = 'valid'
      OR integrity_reason IS NULL
      OR revision IS NULL
      OR revision < 1;

    UPDATE automation_jobs
    SET composio_profile_id = (
      SELECT profile.id
      FROM composio_connection_profiles profile
      WHERE profile.owner_user_id = COALESCE(
          automation_jobs.responsible_user_id,
          automation_jobs.owner_user_id,
          automation_jobs.created_by_user_id
        )
        AND profile.composio_user_id = automation_jobs.composio_user_id
        AND profile.status = 'active'
      LIMIT 1
    )
    WHERE composio_profile_id IS NULL
      AND composio_user_id IS NOT NULL
      AND composio_user_id <> '';

    UPDATE automation_runs
    SET
      scope = COALESCE(NULLIF(scope, ''), 'personal'),
      workspace_type = COALESCE(NULLIF(workspace_type, ''), 'personal'),
      actor_type = COALESCE(NULLIF(actor_type, ''), 'user'),
      job_scope = COALESCE((
        SELECT NULLIF(j.job_scope, '')
        FROM automation_jobs j
        WHERE j.id = automation_runs.job_id
      ), CASE
        WHEN COALESCE(NULLIF(scope, ''), 'personal') = 'organization'
          THEN 'organization:' || COALESCE(NULLIF(organization_id, ''), 'legacy') || ':' || COALESCE(NULLIF(workspace_id, ''), NULLIF(workspace_type, ''), 'legacy')
        ELSE 'personal:' || COALESCE(NULLIF(actor_user_id, ''), 'unknown') || ':' || COALESCE(NULLIF(workspace_id, ''), NULLIF(workspace_type, ''), 'legacy')
      END)
    WHERE scope IS NULL
      OR scope = ''
      OR workspace_type IS NULL
      OR workspace_type = ''
      OR actor_type IS NULL
      OR actor_type = ''
      OR job_scope IS NULL
      OR job_scope = ''
      OR job_scope = 'personal:legacy:legacy';

    UPDATE automation_runs
    SET actor_user_id = (
      SELECT COALESCE(j.responsible_user_id, j.owner_user_id, j.created_by_user_id)
      FROM automation_jobs j
      WHERE j.id = automation_runs.job_id
    )
    WHERE actor_user_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM automation_jobs j
        WHERE j.id = automation_runs.job_id
      );

    UPDATE pi_usage_events
    SET
      organization_id = COALESCE(organization_id, (
        SELECT s.organization_id
        FROM pi_sessions s
        WHERE s.session_id = pi_usage_events.session_id
          AND s.user_id = pi_usage_events.user_id
        ORDER BY s.updated_at DESC
        LIMIT 1
      )),
      workspace_id = COALESCE(workspace_id, (
        SELECT s.workspace_id
        FROM pi_sessions s
        WHERE s.session_id = pi_usage_events.session_id
          AND s.user_id = pi_usage_events.user_id
        ORDER BY s.updated_at DESC
        LIMIT 1
      )),
      workspace_type = COALESCE(NULLIF(workspace_type, ''), (
        SELECT s.workspace_type
        FROM pi_sessions s
        WHERE s.session_id = pi_usage_events.session_id
          AND s.user_id = pi_usage_events.user_id
        ORDER BY s.updated_at DESC
        LIMIT 1
      )),
      agent_id = COALESCE((
        SELECT NULLIF(s.agent_id, '')
        FROM pi_sessions s
        WHERE s.session_id = pi_usage_events.session_id
          AND s.user_id = pi_usage_events.user_id
        ORDER BY s.updated_at DESC
        LIMIT 1
      ), NULLIF(agent_id, ''), 'canvas-agent')
    WHERE organization_id IS NULL
      OR workspace_id IS NULL
      OR workspace_type IS NULL
      OR workspace_type = ''
      OR agent_id IS NULL
      OR agent_id = '';
  `);

  // A session belongs to exactly one agent for a user. Older versions could
  // create duplicate records for that pair, so merge their messages before the
  // unique index below is introduced.
  deduplicatePiSessions(sqlite);

  const invalidPiMessageSequenceCount = (sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT pi_session_db_id, sequence
      FROM pi_messages
      GROUP BY pi_session_db_id, sequence
      HAVING sequence IS NULL OR sequence <= 0 OR COUNT(*) > 1
    ) invalid_sequences
  `).get() as { count: number }).count;
  if (invalidPiMessageSequenceCount === 0) {
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_messages_session_sequence_unique
        ON pi_messages (pi_session_db_id, sequence);
    `);
  } else {
    console.warn(
      `[Database] PI message sequence integrity audit found ${invalidPiMessageSequenceCount} conflicting sequence group(s); unique index deferred.`,
    );
  }

  // ── Deferred indexes on columns added via ALTER TABLE ──────────────────────
  sqlite.exec(`
    DROP INDEX IF EXISTS idx_canvas_workspaces_personal_owner;
    DROP INDEX IF EXISTS idx_canvas_workspaces_team_organization;
    DROP INDEX IF EXISTS idx_canvas_workspaces_default_organization;

    CREATE INDEX IF NOT EXISTS idx_canvas_org_settings_owner ON canvas_organization_settings (owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_agents_organization_scope ON agents (organization_id, scope_type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agents_owner_scope ON agents (owner_user_id, scope_type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_organization_brand_profiles_updated ON organization_brand_profiles (updated_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_customers_organization ON canvas_customers (organization_id, status, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_customers_org_slug ON canvas_customers (organization_id, slug);
    CREATE INDEX IF NOT EXISTS idx_canvas_customers_creator ON canvas_customers (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_projects_organization ON canvas_projects (organization_id, status, name);
    CREATE INDEX IF NOT EXISTS idx_canvas_projects_customer ON canvas_projects (customer_id, status, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_projects_org_slug ON canvas_projects (organization_id, slug);
    CREATE INDEX IF NOT EXISTS idx_canvas_projects_creator ON canvas_projects (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_project_members_org_user ON canvas_project_members (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_canvas_project_members_project_status ON canvas_project_members (project_id, status);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization ON canvas_workspaces (organization_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_owner ON canvas_workspaces (owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_customer ON canvas_workspaces (customer_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_project ON canvas_workspaces (project_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization_type ON canvas_workspaces (organization_id, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_default_personal ON canvas_workspaces (owner_user_id) WHERE type = 'personal' AND is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_project_workspace ON canvas_workspaces (project_id) WHERE type = 'project';
    CREATE INDEX IF NOT EXISTS idx_workspace_brand_profiles_updated ON workspace_brand_profiles (updated_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspace_members_org_user ON canvas_workspace_members (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspace_members_workspace_status ON canvas_workspace_members (workspace_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_profiles_external_user ON composio_connection_profiles (composio_user_id);
    CREATE INDEX IF NOT EXISTS idx_composio_profiles_owner_status ON composio_connection_profiles (owner_user_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_profiles_owner_default ON composio_connection_profiles (owner_user_id) WHERE is_default = 1 AND status = 'active';
    CREATE INDEX IF NOT EXISTS idx_composio_workspace_overrides_profile ON composio_workspace_profile_overrides (profile_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_composio_oauth_states_expiry ON composio_oauth_flow_states (expires_at, consumed_at);
    CREATE INDEX IF NOT EXISTS idx_composio_oauth_states_user_profile ON composio_oauth_flow_states (user_id, profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_composio_profile ON automation_jobs (responsible_user_id, workspace_id, composio_profile_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_workspace_status ON workspace_trash_entries (workspace_id, status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_expires ON workspace_trash_entries (status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_org_status ON workspace_trash_entries (organization_id, status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_project_status ON workspace_trash_entries (project_id, status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_deleted_by ON workspace_trash_entries (deleted_by_user_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_trash_original_path ON workspace_trash_entries (workspace_id, original_path, status);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_workspace_path_created ON file_revisions (workspace_id, path, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_workspace_path_hash ON file_revisions (workspace_id, path, content_hash);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_lineage_created ON file_revisions (lineage_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_collaboration_lineages_active_path ON file_collaboration_lineages (workspace_id, path) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_file_collaboration_lineages_workspace_status ON file_collaboration_lineages (workspace_id, status, path);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_org_created ON file_revisions (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_project_created ON file_revisions (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_revisions_actor_created ON file_revisions (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_file_metadata_workspace_updated ON workspace_file_metadata (workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_file_user_state_favorite ON workspace_file_user_states (workspace_id, user_id, is_favorite, pinned_at);
    CREATE INDEX IF NOT EXISTS idx_file_locks_active_path ON file_locks (workspace_id, path, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_file_locks_user_status ON file_locks (locked_by_user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_file_locks_org_status ON file_locks (organization_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_file_locks_project_status ON file_locks (project_id, status, updated_at);
    DROP INDEX IF EXISTS idx_collab_documents_workspace_path_provider;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_documents_workspace_path_provider ON collaboration_documents (workspace_id, path, provider) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_collab_documents_org_status ON collaboration_documents (organization_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_collab_documents_project_status ON collaboration_documents (project_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_events_document_sequence ON collaboration_events (document_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_collab_events_document_created ON collaboration_events (document_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_collab_events_actor_created ON collaboration_events (actor_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_user ON organization_user_permissions (user_id);
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_role ON organization_user_permissions (organization_id, role);
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_status ON organization_user_permissions (organization_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_user_permissions_single_owner ON organization_user_permissions (organization_id) WHERE role = 'owner';
    CREATE INDEX IF NOT EXISTS idx_team_memberships_org_status ON team_memberships (organization_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_org_email ON team_memberships (organization_id, candidate_email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_org_user ON team_memberships (organization_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_external_invitation ON team_memberships (organization_id, external_invitation_id) WHERE external_invitation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_team_memberships_control_plane_operation ON team_memberships (organization_id, control_plane_operation_id);
    CREATE INDEX IF NOT EXISTS idx_team_membership_invitations_org_status ON team_membership_invitations (organization_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_membership_invitations_expiry ON team_membership_invitations (status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_membership_invitations_accept_request ON team_membership_invitations (accepted_request_id) WHERE accepted_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_membership_created ON team_membership_transitions (membership_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_org_created ON team_membership_transitions (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_org_revision ON team_membership_transitions (organization_id, membership_revision);
    CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_external_operation ON team_membership_transitions (organization_id, external_operation_id);
    CREATE INDEX IF NOT EXISTS idx_team_membership_sync_next_report ON team_membership_sync_state (next_report_at);
    CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_status_retry ON team_seat_outbox (status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_org_created ON team_seat_outbox (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_org_revision ON team_seat_outbox (organization_id, membership_revision);
    CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_membership ON team_seat_outbox (membership_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_control_plane_operation ON team_seat_outbox (control_plane_operation_id);
    CREATE INDEX IF NOT EXISTS idx_capability_policies_org_resource ON capability_policies (organization_id, resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_capability_policies_org_target ON capability_policies (organization_id, target_type, target_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_policies_binding ON capability_policies (organization_id, resource_type, resource_id, target_type, target_id);

    CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_message ON pi_sessions (last_message_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_created ON pi_sessions (user_id, created_at);
    DROP INDEX IF EXISTS idx_pi_sessions_user_session;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_sessions_user_session ON pi_sessions (user_id, session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_sessions_user_client_request ON pi_sessions (user_id, client_request_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_channel_created ON pi_sessions (user_id, channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_agent ON pi_sessions (agent_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_channel ON pi_sessions (channel_id, channel_session_key);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_workspace ON pi_sessions (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_project ON pi_sessions (project_id, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_workspace_created ON pi_sessions (user_id, workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_workspace_archived ON pi_sessions (user_id, workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_org_workspace ON pi_usage_events (organization_id, workspace_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_project ON pi_usage_events (project_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_workspace ON pi_usage_events (user_id, workspace_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_agent ON pi_usage_events (agent_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_project_store ON knowledge_sources (project_id, knowledge_store, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_project_store ON knowledge_chunks (project_id, knowledge_store, embedding_index_status);
    CREATE INDEX IF NOT EXISTS idx_audit_events_project_created ON audit_events (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_next_run_at ON automation_jobs (next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_owner_scope ON automation_jobs (owner_user_id, scope);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_org_workspace ON automation_jobs (organization_id, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_project_status ON automation_jobs (project_id, status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_job_scope_status ON automation_jobs (job_scope, status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_integrity_status ON automation_jobs (integrity_status, status, next_run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_jobs_composio_trigger_id ON automation_jobs (composio_trigger_id);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_job_id_created_at ON automation_runs (job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace_created ON automation_runs (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_project_created ON automation_runs (project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_job_scope_status ON automation_runs (job_scope, status, scheduled_for);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_user_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL DEFAULT 'telegram',
      channel_user_id TEXT NOT NULL,
      channel_user_name TEXT,
      metadata_json TEXT,
      settings_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS channel_link_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL DEFAULT 'telegram',
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS telegram_active_session (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS session_channel_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_session_key TEXT NOT NULL,
      channel_thread_key TEXT NOT NULL DEFAULT '',
      display_name TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      delivery_policy TEXT NOT NULL DEFAULT 'last_active',
      last_inbound_at INTEGER,
      last_outbound_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS channel_active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      channel_id TEXT NOT NULL,
      channel_session_key TEXT NOT NULL,
      channel_thread_key TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_user_binding ON channel_user_bindings (channel_id, channel_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_link_tokens_token ON channel_link_tokens (token);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_active_session_chat ON telegram_active_session (chat_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_channel_links_unique ON session_channel_links (user_id, session_id, channel_id, channel_session_key, channel_thread_key);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_session ON session_channel_links (session_id);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_user_channel ON session_channel_links (user_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_user_context ON session_channel_links (user_id, channel_id, channel_session_key, channel_thread_key);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_context ON session_channel_links (channel_id, channel_session_key, channel_thread_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_active_sessions_context ON channel_active_sessions (channel_id, channel_session_key, channel_thread_key);
    CREATE INDEX IF NOT EXISTS idx_channel_active_sessions_user_channel ON channel_active_sessions (user_id, channel_id);
  `);

  addColumns(sqlite, 'channel_user_bindings', {
    metadata_json: 'TEXT',
    settings_json: 'TEXT',
    enabled: 'INTEGER NOT NULL DEFAULT 1',
  });
  addColumns(sqlite, 'agents', {
    icon_id: "TEXT NOT NULL DEFAULT 'bot'",
    default_provider_installation_id: 'TEXT',
    default_thinking: 'TEXT',
    enabled_tools_json: 'TEXT',
    relevant_skills_json: 'TEXT',
    relevant_connections_json: 'TEXT',
    access_policy: "TEXT NOT NULL DEFAULT 'legacy'",
  });

  addColumns(sqlite, 'team_membership_transitions', {
    membership_revision: 'INTEGER',
  });
  addColumns(sqlite, 'team_membership_sync_state', {
    reconciliation_status: 'TEXT',
    reconciliation_action: 'TEXT',
    reconciliation_reason: 'TEXT',
    reconciliation_seat_limit: 'INTEGER',
    reconciliation_support_required: 'INTEGER NOT NULL DEFAULT 0',
    reconciled_at: 'INTEGER',
    next_attempt_at: 'INTEGER',
  });
  addColumns(sqlite, 'channel_active_sessions', {
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
  });
  addColumns(sqlite, 'user', {
    banned: 'INTEGER',
    ban_reason: 'TEXT',
    ban_expires: 'INTEGER',
  });
  addColumns(sqlite, 'session', {
    impersonated_by: 'TEXT',
  });
  sqlite.exec(`
    UPDATE channel_active_sessions
    SET agent_id = 'canvas-agent'
    WHERE agent_id IS NULL OR agent_id = '';

    UPDATE channel_active_sessions
    SET agent_id = (
      SELECT pi_sessions.agent_id
      FROM pi_sessions
      WHERE pi_sessions.user_id = channel_active_sessions.user_id
        AND pi_sessions.session_id = channel_active_sessions.session_id
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
      FROM pi_sessions
      WHERE pi_sessions.user_id = channel_active_sessions.user_id
        AND pi_sessions.session_id = channel_active_sessions.session_id
        AND pi_sessions.agent_id != channel_active_sessions.agent_id
    );

    WITH ranked_active_sessions AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, agent_id, channel_id, channel_session_key, channel_thread_key
          ORDER BY updated_at DESC, id DESC
        ) AS active_rank
      FROM channel_active_sessions
    )
    DELETE FROM channel_active_sessions
    WHERE id IN (
      SELECT id
      FROM ranked_active_sessions
      WHERE active_rank > 1
    );

    DROP INDEX IF EXISTS idx_session_channel_links_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_channel_links_unique
      ON session_channel_links (user_id, session_id, channel_id, channel_session_key, channel_thread_key);

    DROP INDEX IF EXISTS idx_channel_active_sessions_context;
    DROP INDEX IF EXISTS idx_channel_active_sessions_context_agent;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_active_sessions_user_context_agent
      ON channel_active_sessions (user_id, agent_id, channel_id, channel_session_key, channel_thread_key);
  `);

  const now = Date.now();
  sqlite.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, name, type, removable, created_at, updated_at)
    VALUES ('canvas-agent', 'Bradley', 'main', 0, ?, ?)
  `).run(now, now);

  sqlite.prepare(`
    INSERT OR IGNORE INTO agent_members (
      agent_id, organization_id, user_id, role, status,
      can_use, can_edit, can_manage, invited_by_user_id, created_at, updated_at
    )
    SELECT
      a.agent_id,
      p.organization_id,
      p.user_id,
      CASE WHEN p.role IN ('owner', 'admin') THEN 'manager' ELSE 'editor' END,
      'active',
      1,
      1,
      CASE WHEN p.role IN ('owner', 'admin') THEN 1 ELSE 0 END,
      NULL,
      ?,
      ?
    FROM agents a
    JOIN organization_user_permissions p
      ON p.status = 'active' AND p.role != 'external'
    LEFT JOIN user u ON u.id = p.user_id
    WHERE a.type != 'main'
      AND a.access_policy = 'legacy'
      AND COALESCE(u.banned, 0) = 0
  `).run(now, now);
  sqlite.exec(`
    UPDATE agents
    SET access_policy = 'restricted'
    WHERE type != 'main' AND access_policy = 'legacy'
  `);

  sqlite.exec(`
    UPDATE agents
    SET scope_type = 'system', organization_id = NULL, owner_user_id = NULL
    WHERE type = 'main';

    UPDATE agents
    SET
      scope_type = 'organization',
      organization_id = (
        SELECT MIN(m.organization_id)
        FROM agent_members m
        WHERE m.agent_id = agents.agent_id AND m.status = 'active'
      ),
      owner_user_id = NULL,
      created_by_user_id = COALESCE(created_by_user_id, (
        SELECT MIN(m.user_id)
        FROM agent_members m
        WHERE m.agent_id = agents.agent_id AND m.status = 'active' AND m.can_manage = 1
      ))
    WHERE type != 'main'
      AND created_by_user_id IS NULL
      AND EXISTS (
        SELECT 1 FROM agent_members m
        WHERE m.agent_id = agents.agent_id AND m.status = 'active'
      );
  `);

  sqlite.exec(`
    INSERT OR IGNORE INTO session_channel_links (
      session_id,
      user_id,
      channel_id,
      channel_session_key,
      channel_thread_key,
      display_name,
      is_primary,
      delivery_policy,
      last_inbound_at,
      last_outbound_at,
      created_at,
      updated_at
    )
    SELECT
      session_id,
      user_id,
      CASE WHEN channel_id = 'app' THEN 'web' ELSE channel_id END,
      CASE
        WHEN channel_session_key IS NOT NULL AND channel_session_key != '' THEN channel_session_key
        WHEN channel_id = 'telegram' THEN 'telegram:unknown'
        ELSE 'web:user:' || user_id
      END,
      '',
      title,
      CASE WHEN channel_id = 'app' THEN 1 ELSE 0 END,
      'last_active',
      last_message_at,
      last_message_at,
      created_at,
      updated_at
    FROM pi_sessions;

    INSERT OR IGNORE INTO channel_active_sessions (
      user_id,
      agent_id,
      channel_id,
      channel_session_key,
      channel_thread_key,
      session_id,
      updated_at
    )
    SELECT
      user_id,
      'canvas-agent',
      'telegram',
      'telegram:' || chat_id,
      '',
      session_id,
      updated_at
    FROM telegram_active_session;

    UPDATE session_channel_links
    SET is_primary = 0
    WHERE is_primary != 0
      AND EXISTS (
        SELECT 1
        FROM channel_active_sessions active
        WHERE active.user_id = session_channel_links.user_id
          AND active.channel_id = session_channel_links.channel_id
          AND active.channel_session_key = session_channel_links.channel_session_key
          AND active.channel_thread_key = session_channel_links.channel_thread_key
      );

    UPDATE session_channel_links
    SET is_primary = 1
    WHERE EXISTS (
      SELECT 1
      FROM channel_active_sessions active
      WHERE active.user_id = session_channel_links.user_id
        AND active.channel_id = session_channel_links.channel_id
        AND active.channel_session_key = session_channel_links.channel_session_key
        AND active.channel_thread_key = session_channel_links.channel_thread_key
        AND active.session_id = session_channel_links.session_id
        AND active.id = (
          SELECT latest.id
          FROM channel_active_sessions latest
          WHERE latest.user_id = active.user_id
            AND latest.channel_id = active.channel_id
            AND latest.channel_session_key = active.channel_session_key
            AND latest.channel_thread_key = active.channel_thread_key
          ORDER BY latest.updated_at DESC, latest.id DESC
          LIMIT 1
        )
    );
  `);

  // ── One-time data fixes ───────────────────────────────────────────────────────

  // To-do read state used to be stored globally on todo_items or in the generic
  // mobile inbox table. Keep both legacy sources readable while seeding the
  // canonical, per-user state. INSERT OR IGNORE makes this safe on every startup.
  sqlite.exec(`
    INSERT OR IGNORE INTO todo_read_states (
      user_id, todo_id, read_at, created_at, updated_at
    )
    SELECT user_id, id, seen_at, seen_at, seen_at
    FROM todo_items
    WHERE seen_at IS NOT NULL;

    INSERT OR IGNORE INTO todo_read_states (
      user_id, todo_id, read_at, created_at, updated_at
    )
    SELECT read_state.user_id,
      todo.id,
      read_state.read_at,
      read_state.created_at,
      read_state.updated_at
    FROM mobile_inbox_read_states read_state
    INNER JOIN todo_items todo
      ON read_state.item_key = 'todo:' || todo.id
    WHERE read_state.dismissed_at IS NULL;
  `);

  try {
    sqlite.exec(`
      UPDATE studio_presets
      SET preview_image_path = 'studio/assets/' || preview_image_path
      WHERE preview_image_path IS NOT NULL
        AND preview_image_path NOT LIKE 'studio/assets/%'
    `);
  } catch { /* ignore if column doesn't exist */ }

  // Durable memory is intentionally isolated from the legacy USER.md and
  // MEMORY.md runtime files. Every statement is idempotent so startup may
  // safely recover after interruption and existing installations upgrade in
  // place without rewriting old prompt data.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_user_settings (
      user_id TEXT PRIMARY KEY NOT NULL,
      automatic_memory_enabled INTEGER NOT NULL DEFAULT 1,
      provider_installation_id TEXT,
      model_id TEXT,
      memory_prompt_max_tokens INTEGER NOT NULL DEFAULT 2000,
      sensitive_memory_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (memory_prompt_max_tokens >= 0 AND memory_prompt_max_tokens <= 4000),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_settings_provider_model
      ON memory_user_settings (provider_installation_id, model_id);

    CREATE TABLE IF NOT EXISTS memory_collections (
      id TEXT PRIMARY KEY NOT NULL,
      scope_type TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      organization_id TEXT,
      workspace_id TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (scope_type IN ('user', 'agent', 'workspace', 'organization')),
      CHECK (sensitivity IN ('standard', 'sensitive')),
      CHECK (status IN ('active', 'archived')),
      CHECK (revision >= 1),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_collections_user_scope
      ON memory_collections (user_id, scope_type, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_collections_agent_scope
      ON memory_collections (user_id, agent_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_collections_workspace_scope
      ON memory_collections (workspace_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_collections_organization_scope
      ON memory_collections (organization_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY NOT NULL,
      collection_id TEXT NOT NULL,
      semantic_key TEXT,
      content TEXT NOT NULL,
      normalized_content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 50,
      pinned INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL DEFAULT 'standard',
      confidence REAL,
      estimated_tokens INTEGER NOT NULL,
      source_session_id TEXT,
      source_message_id INTEGER,
      source_agent_id TEXT,
      created_by_actor_type TEXT NOT NULL,
      created_by_user_id TEXT,
      last_confirmed_at INTEGER,
      last_used_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('pending', 'published', 'archived')),
      CHECK (priority >= 0 AND priority <= 100),
      CHECK (sensitivity IN ('standard', 'sensitive')),
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      CHECK (estimated_tokens >= 0),
      CHECK (revision >= 1),
      FOREIGN KEY (collection_id) REFERENCES memory_collections(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_collection_status
      ON memory_entries (collection_id, status, priority, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_collection_semantic_key
      ON memory_entries (collection_id, semantic_key);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_source_message
      ON memory_entries (source_session_id, source_message_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_collection_content_hash
      ON memory_entries (collection_id, normalized_content_hash);

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY NOT NULL,
      entry_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_user_id TEXT,
      session_id TEXT,
      source_message_id INTEGER,
      decision_code TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES user(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_entry_created
      ON memory_events (entry_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_events_session_created
      ON memory_events (session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_legacy_imports (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      entries_imported INTEGER NOT NULL DEFAULT 0,
      entries_skipped INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER NOT NULL,
      UNIQUE (user_id, agent_id, file_name, content_hash),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_legacy_imports_scope
      ON memory_legacy_imports (user_id, agent_id, file_name, completed_at);

    CREATE TABLE IF NOT EXISTS memory_review_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_assistant_message_id INTEGER,
      from_message_sequence INTEGER NOT NULL,
      through_message_sequence INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      scheduled_for INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled',
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      CHECK (trigger_type IN ('turn_interval', 'idle', 'session_close', 'maintenance')),
      CHECK (status IN ('scheduled', 'awaiting_model_configuration', 'queued', 'running', 'retry_wait', 'completed', 'failed')),
      CHECK (from_message_sequence >= 1 AND through_message_sequence >= from_message_sequence),
      CHECK (attempts >= 0),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
      UNIQUE (user_id, session_id, from_message_sequence, through_message_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_review_jobs_ready
      ON memory_review_jobs (status, scheduled_for, lease_until);
    CREATE INDEX IF NOT EXISTS idx_memory_review_jobs_user_session
      ON memory_review_jobs (user_id, session_id, created_at);
  `);

  runTeamSeatLegacyBackfill(sqlite);
}

/**
 * Adopts pre-Team-Seat organization access without manufacturing a billable
 * operation. The marker prevents this compatibility bridge from becoming a
 * permanent bypass once the membership orchestrator owns all future changes.
 */
export function runTeamSeatLegacyBackfill(sqlite: InstanceType<typeof Database>): void {
  const completed = sqlite.prepare(`
    SELECT 1
    FROM canvas_data_migrations
    WHERE migration_key = ?
    LIMIT 1
  `).get(TEAM_SEAT_LEGACY_MIGRATION_KEY);
  if (completed) return;

  const organization = sqlite.prepare(`
    SELECT 1
    FROM canvas_organization_settings
    LIMIT 1
  `).get();
  if (!organization) return;

  const legacyAccessCte = `
    legacy_access AS (
      SELECT
        organization.organization_id,
        owner.id AS user_id,
        lower(trim(owner.email)) AS candidate_email,
        NULLIF(trim(owner.name), '') AS display_name,
        'owner' AS role,
        CASE
          WHEN COALESCE(owner.banned, 0) != 0 THEN 'suspended'
          WHEN COALESCE(permission.status, 'active') = 'archived' THEN 'removed'
          WHEN COALESCE(permission.status, 'active') != 'active' THEN 'suspended'
          ELSE 'active'
        END AS status,
        COALESCE(permission.created_at, owner.created_at, organization.created_at) AS adopted_at
      FROM canvas_organization_settings organization
      INNER JOIN "user" owner
        ON owner.id = organization.owner_user_id
      LEFT JOIN organization_user_permissions permission
        ON permission.organization_id = organization.organization_id
       AND permission.user_id = owner.id

      UNION ALL

      SELECT
        permission.organization_id,
        member.id AS user_id,
        lower(trim(member.email)) AS candidate_email,
        NULLIF(trim(member.name), '') AS display_name,
        CASE
          WHEN permission.role IN ('owner', 'admin', 'member', 'external') THEN permission.role
          ELSE 'member'
        END AS role,
        CASE
          WHEN COALESCE(member.banned, 0) != 0 THEN 'suspended'
          WHEN permission.status = 'archived' THEN 'removed'
          WHEN permission.status != 'active' THEN 'suspended'
          ELSE 'active'
        END AS status,
        COALESCE(permission.created_at, member.created_at, organization.created_at) AS adopted_at
      FROM organization_user_permissions permission
      INNER JOIN canvas_organization_settings organization
        ON organization.organization_id = permission.organization_id
      INNER JOIN "user" member
        ON member.id = permission.user_id
      WHERE permission.user_id != organization.owner_user_id
    )
  `;
  const migrationNowSql = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

  sqlite.exec('SAVEPOINT team_seat_legacy_backfill_v1');
  try {
    const invalidIdentity = sqlite.prepare(`
      WITH ${legacyAccessCte}
      SELECT organization_id, user_id
      FROM legacy_access
      WHERE candidate_email = ''
        OR instr(candidate_email, '@') <= 1
      LIMIT 1
    `).get() as { organization_id: string; user_id: string } | undefined;
    if (invalidIdentity) {
      throw new Error(
        `Cannot migrate Team Seat membership for invalid identity ${invalidIdentity.organization_id}/${invalidIdentity.user_id}.`,
      );
    }

    const duplicateIdentity = sqlite.prepare(`
      WITH ${legacyAccessCte}
      SELECT organization_id, candidate_email
      FROM legacy_access
      GROUP BY organization_id, candidate_email
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get() as { organization_id: string; candidate_email: string } | undefined;
    if (duplicateIdentity) {
      throw new Error(
        `Cannot migrate duplicate Team Seat identity ${duplicateIdentity.organization_id}/${duplicateIdentity.candidate_email}.`,
      );
    }

    sqlite.exec(`
      WITH ${legacyAccessCte}
      INSERT OR IGNORE INTO team_memberships (
        id,
        organization_id,
        candidate_email,
        display_name,
        user_id,
        role,
        status,
        external_invitation_id,
        control_plane_operation_id,
        invited_by_user_id,
        invited_at,
        accepted_at,
        activated_at,
        suspended_at,
        removed_at,
        created_at,
        updated_at
      )
      SELECT
        'team-membership-migration-' || lower(hex(randomblob(16))),
        organization_id,
        candidate_email,
        display_name,
        user_id,
        role,
        status,
        NULL,
        NULL,
        NULL,
        adopted_at,
        adopted_at,
        adopted_at,
        CASE WHEN status = 'suspended' THEN ${migrationNowSql} ELSE NULL END,
        CASE WHEN status = 'removed' THEN ${migrationNowSql} ELSE NULL END,
        adopted_at,
        ${migrationNowSql}
      FROM legacy_access;
    `);

    const missingMembership = sqlite.prepare(`
      WITH ${legacyAccessCte}
      SELECT legacy_access.organization_id, legacy_access.user_id
      FROM legacy_access
      LEFT JOIN team_memberships membership
        ON membership.organization_id = legacy_access.organization_id
       AND membership.user_id = legacy_access.user_id
      WHERE membership.id IS NULL
      LIMIT 1
    `).get() as { organization_id: string; user_id: string } | undefined;
    if (missingMembership) {
      throw new Error(
        `Team Seat legacy migration could not adopt ${missingMembership.organization_id}/${missingMembership.user_id}.`,
      );
    }

    sqlite.exec(`
      WITH ${legacyAccessCte}
      INSERT INTO team_membership_transitions (
        id,
        membership_id,
        organization_id,
        from_status,
        to_status,
        actor_user_id,
        source,
        reason,
        external_operation_id,
        membership_revision,
        metadata_json,
        created_at
      )
      SELECT
        'team-membership-transition-migration-' || lower(hex(randomblob(16))),
        membership.id,
        membership.organization_id,
        NULL,
        membership.status,
        NULL,
        'migration',
        '${TEAM_SEAT_LEGACY_MIGRATION_REASON}',
        NULL,
        NULL,
        '${TEAM_SEAT_LEGACY_MIGRATION_METADATA}',
        ${migrationNowSql}
      FROM legacy_access
      INNER JOIN team_memberships membership
        ON membership.organization_id = legacy_access.organization_id
       AND membership.user_id = legacy_access.user_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM team_membership_transitions transition
        WHERE transition.membership_id = membership.id
          AND transition.source = 'migration'
          AND transition.metadata_json = '${TEAM_SEAT_LEGACY_MIGRATION_METADATA}'
      );

      INSERT OR IGNORE INTO team_membership_sync_state (
        organization_id,
        current_revision,
        current_observed_quantity,
        acknowledged_revision,
        created_at,
        updated_at
      )
      SELECT
        organization.organization_id,
        0,
        (
          SELECT COUNT(*)
          FROM team_memberships membership
          WHERE membership.organization_id = organization.organization_id
            AND membership.status = 'active'
            AND membership.user_id IS NOT NULL
            AND membership.accepted_at IS NOT NULL
        ),
        0,
        ${migrationNowSql},
        ${migrationNowSql}
      FROM canvas_organization_settings organization;

      INSERT OR IGNORE INTO canvas_data_migrations (
        migration_key,
        completed_at,
        metadata_json
      ) VALUES (
        '${TEAM_SEAT_LEGACY_MIGRATION_KEY}',
        ${migrationNowSql},
        '{"source":"organization_user_permissions","billableOperationsCreated":0}'
      );
    `);
    sqlite.exec('RELEASE SAVEPOINT team_seat_legacy_backfill_v1');
  } catch (error) {
    sqlite.exec('ROLLBACK TO SAVEPOINT team_seat_legacy_backfill_v1');
    sqlite.exec('RELEASE SAVEPOINT team_seat_legacy_backfill_v1');
    throw error;
  }
}

function addColumns(
  sqlite: InstanceType<typeof Database>,
  table: string,
  columns: Record<string, string>,
): void {
  const existing = getColumnNames(sqlite, table);
  for (const [col, def] of Object.entries(columns)) {
    if (!existing.has(col)) {
      try {
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        existing.add(col);
      } catch (error) {
        const refreshed = getColumnNames(sqlite, table);
        if (!refreshed.has(col)) {
          throw error;
        }
        existing.add(col);
      }
    }
  }
}

function deduplicatePiSessions(sqlite: InstanceType<typeof Database>): void {
  sqlite.exec(`
    DROP TABLE IF EXISTS temp._canvas_pi_session_dedup;

    CREATE TEMP TABLE _canvas_pi_session_dedup (
      duplicate_id INTEGER PRIMARY KEY,
      canonical_id INTEGER NOT NULL
    );

    INSERT INTO _canvas_pi_session_dedup (duplicate_id, canonical_id)
    WITH ranked_sessions AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, session_id
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS canonical_id
      FROM pi_sessions
    )
    SELECT id, canonical_id
    FROM ranked_sessions
    WHERE id != canonical_id;

    UPDATE pi_messages
    SET pi_session_db_id = (
      SELECT canonical_id
      FROM _canvas_pi_session_dedup
      WHERE duplicate_id = pi_messages.pi_session_db_id
    )
    WHERE pi_session_db_id IN (
      SELECT duplicate_id
      FROM _canvas_pi_session_dedup
    );

    WITH ordered_messages AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY pi_session_db_id
          ORDER BY timestamp ASC, id ASC
        ) AS next_sequence
      FROM pi_messages
      WHERE pi_session_db_id IN (
        SELECT DISTINCT canonical_id
        FROM _canvas_pi_session_dedup
      )
    )
    UPDATE pi_messages
    SET sequence = (
      SELECT next_sequence
      FROM ordered_messages
      WHERE ordered_messages.id = pi_messages.id
    )
    WHERE id IN (
      SELECT id
      FROM ordered_messages
    );

    DELETE FROM pi_sessions
    WHERE id IN (
      SELECT duplicate_id
      FROM _canvas_pi_session_dedup
    );

    DROP TABLE temp._canvas_pi_session_dedup;
  `);
}

function getColumnNames(sqlite: InstanceType<typeof Database>, table: string): Set<string> {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

function tableExists(sqlite: InstanceType<typeof Database>, table: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table),
  );
}
