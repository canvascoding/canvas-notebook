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

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      ai_session_db_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT,
      attachments TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (ai_session_db_id) REFERENCES ai_sessions(id)
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
      last_message_at INTEGER,
      last_viewed_at INTEGER,
      channel_id TEXT NOT NULL DEFAULT 'app',
      channel_session_key TEXT,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS pi_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      pi_session_db_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (pi_session_db_id) REFERENCES pi_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS pi_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      fingerprint TEXT NOT NULL,
      user_id TEXT NOT NULL,
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
      type TEXT NOT NULL DEFAULT 'main',
      removable INTEGER NOT NULL DEFAULT 0,
      default_provider TEXT,
      default_model TEXT,
      default_thinking TEXT,
      enabled_tools_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
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
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
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
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id)
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
      mode TEXT NOT NULL,
      prompt TEXT,
      raw_prompt TEXT,
      studio_preset_id TEXT,
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

  // ── Indexes ──────────────────────────────────────────────────────────────────

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
    CREATE UNIQUE INDEX IF NOT EXISTS session_token_unique ON session (token);
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
    CREATE INDEX IF NOT EXISTS idx_automation_runs_job_id_created_at ON automation_runs (job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status);
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
    CREATE INDEX IF NOT EXISTS idx_studio_products_created ON studio_products (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_product_images_product ON studio_product_images (product_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_user ON studio_personas (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_personas_created ON studio_personas (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_persona_images_persona ON studio_persona_images (persona_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_user ON studio_styles (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_styles_created ON studio_styles (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_style_images_style ON studio_style_images (style_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_user ON studio_presets (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_category ON studio_presets (category);
    CREATE INDEX IF NOT EXISTS idx_studio_presets_created ON studio_presets (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_user ON studio_generations (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_status ON studio_generations (status);
    CREATE INDEX IF NOT EXISTS idx_studio_generations_created ON studio_generations (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_generation ON studio_generation_outputs (generation_id);
    CREATE INDEX IF NOT EXISTS idx_studio_gen_outputs_created ON studio_generation_outputs (created_at);
    CREATE INDEX IF NOT EXISTS idx_gen_products_generation ON studio_generation_products (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_products_product ON studio_generation_products (product_id);
    CREATE INDEX IF NOT EXISTS idx_gen_personas_generation ON studio_generation_personas (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_personas_persona ON studio_generation_personas (persona_id);
    CREATE INDEX IF NOT EXISTS idx_gen_styles_generation ON studio_generation_styles (generation_id);
    CREATE INDEX IF NOT EXISTS idx_gen_styles_style ON studio_generation_styles (style_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_user ON studio_bulk_jobs (user_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_status ON studio_bulk_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_created ON studio_bulk_jobs (created_at);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_bulk_job ON studio_bulk_job_line_items (bulk_job_id);
    CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_status ON studio_bulk_job_line_items (status);
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_created ON ai_sessions (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_session ON ai_sessions (user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_ai_messages_session_created ON ai_messages (ai_session_db_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_id ON agents (agent_id);
    CREATE INDEX IF NOT EXISTS idx_pi_messages_session_timestamp ON pi_messages (pi_session_db_id, timestamp, id);
  `);

  // ── Column additions for existing volumes ────────────────────────────────────
  // Each block adds columns that were missing from older schema versions.
  // ALTER TABLE ADD COLUMN is idempotent here because we check PRAGMA table_info first.

  addColumns(sqlite, 'pi_sessions', {
    last_message_at: 'INTEGER',
    last_viewed_at: 'INTEGER',
    thinking_level: 'TEXT',
  });

  addColumns(sqlite, 'automation_jobs', {
    target_output_path: 'TEXT',
  });

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

  addColumns(sqlite, 'pi_sessions', {
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
    channel_id: "TEXT NOT NULL DEFAULT 'app'",
    channel_session_key: 'TEXT',
  });

  addColumns(sqlite, 'automation_jobs', {
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

  // ── Deferred indexes on columns added via ALTER TABLE ──────────────────────
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_message ON pi_sessions (last_message_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_created ON pi_sessions (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_session ON pi_sessions (user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_user_channel_created ON pi_sessions (user_id, channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_agent ON pi_sessions (agent_id);
    CREATE INDEX IF NOT EXISTS idx_pi_sessions_channel ON pi_sessions (channel_id, channel_session_key);
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_channel_links_unique ON session_channel_links (session_id, channel_id, channel_session_key, channel_thread_key);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_session ON session_channel_links (session_id);
    CREATE INDEX IF NOT EXISTS idx_session_channel_links_user_channel ON session_channel_links (user_id, channel_id);
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
    default_thinking: 'TEXT',
    enabled_tools_json: 'TEXT',
  });
  addColumns(sqlite, 'channel_active_sessions', {
    agent_id: "TEXT NOT NULL DEFAULT 'canvas-agent'",
  });
  sqlite.exec(`
    UPDATE channel_active_sessions
    SET agent_id = 'canvas-agent'
    WHERE agent_id IS NULL OR agent_id = '';

    DROP INDEX IF EXISTS idx_channel_active_sessions_context;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_active_sessions_context_agent
      ON channel_active_sessions (agent_id, channel_id, channel_session_key, channel_thread_key);
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
