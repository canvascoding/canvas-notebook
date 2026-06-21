import type Database from 'better-sqlite3';

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
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

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

    CREATE TABLE IF NOT EXISTS canvas_organization_settings (
      organization_id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      deployment_mode TEXT NOT NULL DEFAULT 'single_user',
      team_features_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS canvas_workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL,
      owner_user_id TEXT,
      root_relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES user(id)
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

    CREATE TABLE IF NOT EXISTS pi_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_text TEXT,
      summary_updated_at INTEGER,
      summary_through_timestamp INTEGER,
      summary_through_sequence INTEGER,
      system_prompt_snapshot TEXT,
      system_prompt_snapshot_hash TEXT,
      system_prompt_snapshot_created_at INTEGER,
      last_message_at INTEGER,
      last_viewed_at INTEGER,
      channel_id TEXT NOT NULL DEFAULT 'app',
      channel_session_key TEXT,
      organization_id TEXT,
      workspace_id TEXT,
      workspace_type TEXT,
      workspace_name TEXT,
      workspace_root_relative_path TEXT,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

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
      default_provider TEXT,
      default_model TEXT,
      default_thinking TEXT,
      enabled_tools_json TEXT,
      relevant_skills_json TEXT,
      relevant_connections_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      workspace_id TEXT,
      workspace_type TEXT NOT NULL DEFAULT 'personal',
      category_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_at INTEGER,
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

    CREATE TABLE IF NOT EXISTS todo_file_links (
      id TEXT PRIMARY KEY NOT NULL,
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
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

    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      job_scope TEXT NOT NULL DEFAULT 'personal:legacy:legacy',
      organization_id TEXT,
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
      channel_id TEXT,
      composio_trigger_id TEXT,
      composio_trigger_slug TEXT,
      composio_toolkit_slug TEXT,
      composio_connected_account_id TEXT,
      composio_user_id TEXT,
      webhook_trigger_config_json TEXT,
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE SET NULL,
      FOREIGN KEY (owner_user_id) REFERENCES user(id),
      FOREIGN KEY (responsible_user_id) REFERENCES user(id),
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

  addColumns(sqlite, 'organization_user_permissions', {
    status: "TEXT NOT NULL DEFAULT 'active'",
    disabled_at: 'INTEGER',
    archived_at: 'INTEGER',
    offboarded_by_user_id: 'TEXT',
    offboarding_reason: 'TEXT',
    offboarding_report_json: 'TEXT',
  });

  addColumns(sqlite, 'studio_generations', {
    studio_preset_name: 'TEXT',
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'studio_products', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_personas', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_styles', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'organization'",
  });

  addColumns(sqlite, 'studio_presets', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    visibility: "TEXT NOT NULL DEFAULT 'user'",
  });

  addColumns(sqlite, 'studio_generation_outputs', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'studio_bulk_jobs', {
    organization_id: 'TEXT',
    created_by_user_id: 'TEXT',
    workspace_id: 'TEXT',
  });

  addColumns(sqlite, 'todo_items', {
    created_by_user_id: 'TEXT',
    assignee_user_id: 'TEXT',
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
    completion_comment: 'TEXT',
    follow_up_sent_at: 'INTEGER',
    follow_up_error: 'TEXT',
    email_notification_sent_at: 'INTEGER',
    email_notification_error: 'TEXT',
  });

  addColumns(sqlite, 'todo_file_links', {
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
  });

  sqlite.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_next_run_at ON automation_jobs (next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_owner_scope ON automation_jobs (owner_user_id, scope);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_org_workspace ON automation_jobs (organization_id, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_job_id_created_at ON automation_runs (job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace_created ON automation_runs (workspace_id, created_at);
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_license_public_keys_fingerprint ON license_public_keys (fingerprint);
    CREATE INDEX IF NOT EXISTS idx_license_public_keys_fetched_at ON license_public_keys (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_user ON studio_products (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_products_organization ON studio_products (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_creator ON studio_products (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_products_created ON studio_products (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_product_images_product ON studio_product_images (product_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_user ON studio_personas (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_organization ON studio_personas (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_creator ON studio_personas (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_created ON studio_personas (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_persona_images_persona ON studio_persona_images (persona_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_user ON studio_styles (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_organization ON studio_styles (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_creator ON studio_styles (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_created ON studio_styles (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_style_images_style ON studio_style_images (style_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_user ON studio_presets (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_organization ON studio_presets (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_creator ON studio_presets (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_category ON studio_presets (category);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_created ON studio_presets (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_user ON studio_generations (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_organization ON studio_generations (organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_creator ON studio_generations (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_workspace ON studio_generations (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_status ON studio_generations (status);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_created ON studio_generations (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_generation ON studio_generation_outputs (generation_id);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_organization ON studio_generation_outputs (organization_id, created_at);
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
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_creator ON studio_bulk_jobs (created_by_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_workspace ON studio_bulk_jobs (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_status ON studio_bulk_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_created ON studio_bulk_jobs (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_bulk_job ON studio_bulk_job_line_items (bulk_job_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_status ON studio_bulk_job_line_items (status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_id ON agents (agent_id);
    CREATE INDEX IF NOT EXISTS idx_pi_messages_session_timestamp ON pi_messages (pi_session_db_id, timestamp, id);
    CREATE INDEX IF NOT EXISTS idx_todo_categories_user_sort ON todo_categories (user_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_todo_categories_user_archived ON todo_categories (user_id, is_archived);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_status_updated ON todo_items (user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_due ON todo_items (user_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_user_seen ON todo_items (user_id, seen_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_source_session ON todo_items (user_id, source_session_id);
    CREATE INDEX IF NOT EXISTS idx_todo_items_org_workspace_status ON todo_items (organization_id, workspace_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_assignee_status ON todo_items (assignee_user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_items_category ON todo_items (category_id);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_todo ON todo_file_links (todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_user_path ON todo_file_links (user_id, workspace_path);
    CREATE INDEX IF NOT EXISTS idx_todo_file_links_workspace_path ON todo_file_links (organization_id, workspace_id, workspace_path);
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

  addColumns(sqlite, 'pi_sessions', {
    last_message_at: 'INTEGER',
    last_viewed_at: 'INTEGER',
    thinking_level: 'TEXT',
    summary_through_sequence: 'INTEGER',
  });

  addColumns(sqlite, 'pi_messages', {
    sequence: 'INTEGER NOT NULL DEFAULT 0',
  });

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

  addColumns(sqlite, 'public_file_shares', {
    short_code: 'TEXT',
    security_mode: "TEXT NOT NULL DEFAULT 'strict'",
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    workspace_root_relative_path: 'TEXT',
    target_revision_policy: "TEXT NOT NULL DEFAULT 'latest'",
    last_known_revision: 'TEXT',
    revoked_reason: 'TEXT',
    password_enabled: 'INTEGER NOT NULL DEFAULT 0',
    password_hash: 'TEXT',
  });

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_file_shares_short_code ON public_file_shares (short_code);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_workspace_id_path ON public_file_shares (workspace_id, workspace_path, status);
    CREATE INDEX IF NOT EXISTS idx_public_file_shares_org_status ON public_file_shares (organization_id, status);
  `);

  addColumns(sqlite, 'pi_sessions', {
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
    channel_id: "TEXT NOT NULL DEFAULT 'app'",
    channel_session_key: 'TEXT',
    system_prompt_snapshot: 'TEXT',
    system_prompt_snapshot_hash: 'TEXT',
    system_prompt_snapshot_created_at: 'INTEGER',
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    workspace_name: 'TEXT',
    workspace_root_relative_path: 'TEXT',
  });

  addColumns(sqlite, 'pi_usage_events', {
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: 'TEXT',
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
  });

  addColumns(sqlite, 'automation_jobs', {
    scope: "TEXT NOT NULL DEFAULT 'personal'",
    job_scope: "TEXT NOT NULL DEFAULT 'personal:legacy:legacy'",
    organization_id: 'TEXT',
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
    channel_id: 'TEXT',
    composio_trigger_id: 'TEXT',
    composio_trigger_slug: 'TEXT',
    composio_toolkit_slug: 'TEXT',
    composio_connected_account_id: 'TEXT',
    composio_user_id: 'TEXT',
    webhook_trigger_config_json: 'TEXT',
  });

  addColumns(sqlite, 'automation_runs', {
    scope: "TEXT NOT NULL DEFAULT 'personal'",
    job_scope: "TEXT NOT NULL DEFAULT 'personal:legacy:legacy'",
    organization_id: 'TEXT',
    workspace_id: 'TEXT',
    workspace_type: "TEXT NOT NULL DEFAULT 'personal'",
    actor_type: "TEXT NOT NULL DEFAULT 'user'",
    actor_user_id: 'TEXT',
    service_actor_id: 'TEXT',
  });

  sqlite.exec(`
    UPDATE automation_jobs
    SET
      owner_user_id = COALESCE(owner_user_id, created_by_user_id),
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

  // ── Deferred indexes on columns added via ALTER TABLE ──────────────────────
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_canvas_org_settings_owner ON canvas_organization_settings (owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization ON canvas_workspaces (organization_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_owner ON canvas_workspaces (owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization_type ON canvas_workspaces (organization_id, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_personal_owner ON canvas_workspaces (owner_user_id) WHERE type = 'personal';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_team_organization ON canvas_workspaces (organization_id) WHERE type = 'team';
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_user ON organization_user_permissions (user_id);
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_role ON organization_user_permissions (organization_id, role);
    CREATE INDEX IF NOT EXISTS idx_org_user_permissions_status ON organization_user_permissions (organization_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_user_permissions_single_owner ON organization_user_permissions (organization_id) WHERE role = 'owner';

    CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_message ON pi_sessions (last_message_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_created ON pi_sessions (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_session ON pi_sessions (user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_channel_created ON pi_sessions (user_id, channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_agent ON pi_sessions (agent_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_channel ON pi_sessions (channel_id, channel_session_key);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_workspace ON pi_sessions (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_workspace_created ON pi_sessions (user_id, workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_org_workspace ON pi_usage_events (organization_id, workspace_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_workspace ON pi_usage_events (user_id, workspace_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_pi_usage_events_agent ON pi_usage_events (agent_id, assistant_timestamp);
    CREATE INDEX IF NOT EXISTS idx_automation_jobs_job_scope_status ON automation_jobs (job_scope, status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_job_scope_status ON automation_runs (job_scope, status, scheduled_for);
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_jobs_composio_trigger_id ON automation_jobs (composio_trigger_id);
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
    default_thinking: 'TEXT',
    enabled_tools_json: 'TEXT',
    relevant_skills_json: 'TEXT',
    relevant_connections_json: 'TEXT',
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
    VALUES ('canvas-agent', 'Canvas Agent', 'main', 0, ?, ?)
  `).run(now, now);

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

  try {
    sqlite.exec(`
      UPDATE studio_presets
      SET preview_image_path = 'studio/assets/' || preview_image_path
      WHERE preview_image_path IS NOT NULL
        AND preview_image_path NOT LIKE 'studio/assets/%'
    `);
  } catch { /* ignore if column doesn't exist */ }
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
