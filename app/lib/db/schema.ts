import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  role: text("role"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id)
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
});

export const aiSessions = sqliteTable("ai_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  model: text("model").notNull(), // agent id, e.g. 'claude', 'codex', 'openrouter', 'ollama'
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const aiMessages = sqliteTable("ai_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  aiSessionDbId: integer("ai_session_db_id").notNull().references(() => aiSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'system'
  content: text("content").notNull(),
  type: text("type"),
  attachments: text("attachments"), // JSON string
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const piSessions = sqliteTable("pi_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  summaryText: text("summary_text"),
  summaryUpdatedAt: integer("summary_updated_at", { mode: "timestamp" }),
  summaryThroughTimestamp: integer("summary_through_timestamp"),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }),
  channelId: text("channel_id").notNull().default('app'),
  channelSessionKey: text("channel_session_key"),
}, (table) => ({
  channelIdx: index("idx_pi_sessions_channel").on(table.channelId, table.channelSessionKey),
}));

export const piMessages = sqliteTable("pi_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  piSessionDbId: integer("pi_session_db_id").notNull().references(() => piSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'toolResult'
  content: text("content").notNull(), // Full JSON of Message object
  timestamp: integer("timestamp").notNull(),
});

export const piUsageEvents = sqliteTable("pi_usage_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fingerprint: text("fingerprint").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id),
  sessionId: text("session_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  sessionTitleSnapshot: text("session_title_snapshot"),
  assistantTimestamp: integer("assistant_timestamp").notNull(),
  stopReason: text("stop_reason").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull(),
  cacheWriteTokens: integer("cache_write_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  inputCost: real("input_cost").notNull(),
  outputCost: real("output_cost").notNull(),
  cacheReadCost: real("cache_read_cost").notNull(),
  cacheWriteCost: real("cache_write_cost").notNull(),
  totalCost: real("total_cost").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const onboardingLog = sqliteTable("onboarding_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
  completedBy: text("completed_by"), // userId or null for bootstrap
  method: text("method").notNull(), // 'ui' | 'bootstrap'
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const automationJobs = sqliteTable("automation_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  preferredSkill: text("preferred_skill").notNull(),
  workspaceContextPathsJson: text("workspace_context_paths_json").notNull(),
  targetOutputPath: text("target_output_path"),
  scheduleKind: text("schedule_kind").notNull(),
  scheduleConfigJson: text("schedule_config_json").notNull(),
  timeZone: text("time_zone").notNull(),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastRunStatus: text("last_run_status"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const userHintState = sqliteTable("user_hint_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  hintKey: text("hint_key").notNull(),
  page: text("page").notNull(),
  dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const pageOnboardingState = sqliteTable("page_onboarding_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  page: text("page").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => automationJobs.id),
  status: text("status").notNull(),
  triggerType: text("trigger_type").notNull(),
  scheduledFor: integer("scheduled_for", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  attemptNumber: integer("attempt_number").notNull(),
  outputDir: text("output_dir"),
  targetOutputPath: text("target_output_path"),
  effectiveTargetOutputPath: text("effective_target_output_path"),
  logPath: text("log_path"),
  resultPath: text("result_path"),
  errorMessage: text("error_message"),
  piSessionId: text("pi_session_id"),
  // Metadata stored in DB instead of files
  eventsLog: text("events_log"), // JSON array of event strings (replaces events.log file)
  metadataJson: text("metadata_json"), // JSON with provider, model, status, etc. (replaces run.json)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const studioProducts = sqliteTable("studio_products", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_products_user").on(table.userId),
  createdIdx: index("idx_studio_products_created").on(table.createdAt),
}));

export const studioProductImages = sqliteTable("studio_product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => studioProducts.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: integer("sort_order").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  productIdx: index("idx_studio_product_images_product").on(table.productId),
}));

export const studioPersonas = sqliteTable("studio_personas", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_personas_user").on(table.userId),
  createdIdx: index("idx_studio_personas_created").on(table.createdAt),
}));

export const studioPersonaImages = sqliteTable("studio_persona_images", {
  id: text("id").primaryKey(),
  personaId: text("persona_id").notNull().references(() => studioPersonas.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: integer("sort_order").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  personaIdx: index("idx_studio_persona_images_persona").on(table.personaId),
}));

export const studioStyles = sqliteTable("studio_styles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_styles_user").on(table.userId),
  createdIdx: index("idx_studio_styles_created").on(table.createdAt),
}));

export const studioStyleImages = sqliteTable("studio_style_images", {
  id: text("id").primaryKey(),
  styleId: text("style_id").notNull().references(() => studioStyles.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: integer("sort_order").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  styleIdx: index("idx_studio_style_images_style").on(table.styleId),
}));

export const studioPresets = sqliteTable("studio_presets", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: 'cascade' }),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  blocks: text("blocks").notNull(),
  previewImagePath: text("preview_image_path"),
  tags: text("tags"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_presets_user").on(table.userId),
  categoryIdx: index("idx_studio_presets_category").on(table.category),
  createdIdx: index("idx_studio_presets_created").on(table.createdAt),
}));

export const studioGenerations = sqliteTable("studio_generations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  mode: text("mode").notNull(),
  prompt: text("prompt"),
  rawPrompt: text("raw_prompt"),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  aspectRatio: text("aspect_ratio").notNull().default('1:1'),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  bulkJobId: text("bulk_job_id"),
  sourceGenerationId: text("source_generation_id"),
  metadata: text("metadata"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_generations_user").on(table.userId),
  statusIdx: index("idx_studio_generations_status").on(table.status),
  createdIdx: index("idx_studio_generations_created").on(table.createdAt),
}));

export const studioGenerationOutputs = sqliteTable("studio_generation_outputs", {
  id: text("id").primaryKey(),
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  variationIndex: integer("variation_index").notNull(),
  type: text("type").notNull(),
  filePath: text("file_path").notNull(),
  fileName: text("file_name"),
  mediaUrl: text("media_url"),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  width: integer("width"),
  height: integer("height"),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  generationIdx: index("idx_studio_gen_outputs_generation").on(table.generationId),
  createdIdx: index("idx_studio_gen_outputs_created").on(table.createdAt),
}));

export const studioGenerationProducts = sqliteTable("studio_generation_products", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  productId: text("product_id").notNull().references(() => studioProducts.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.productId),
  generationIdx: index("idx_gen_products_generation").on(table.generationId),
  productIdx: index("idx_gen_products_product").on(table.productId),
}));

export const studioGenerationPersonas = sqliteTable("studio_generation_personas", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  personaId: text("persona_id").notNull().references(() => studioPersonas.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.personaId),
  generationIdx: index("idx_gen_personas_generation").on(table.generationId),
  personaIdx: index("idx_gen_personas_persona").on(table.personaId),
}));

export const studioGenerationStyles = sqliteTable("studio_generation_styles", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  styleId: text("style_id").notNull().references(() => studioStyles.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.styleId),
  generationIdx: index("idx_gen_styles_generation").on(table.generationId),
  styleIdx: index("idx_gen_styles_style").on(table.styleId),
}));

export const studioBulkJobs = sqliteTable("studio_bulk_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name"),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  additionalPrompt: text("additional_prompt"),
  aspectRatio: text("aspect_ratio").notNull().default('1:1'),
  versionsPerProduct: integer("versions_per_product").notNull().default(1),
  status: text("status").notNull(),
  totalLineItems: integer("total_line_items").notNull(),
  completedLineItems: integer("completed_line_items").notNull().default(0),
  failedLineItems: integer("failed_line_items").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userIdx: index("idx_studio_bulk_jobs_user").on(table.userId),
  statusIdx: index("idx_studio_bulk_jobs_status").on(table.status),
  createdIdx: index("idx_studio_bulk_jobs_created").on(table.createdAt),
}));

export const studioBulkJobLineItems = sqliteTable("studio_bulk_job_line_items", {
  id: text("id").primaryKey(),
  bulkJobId: text("bulk_job_id").notNull().references(() => studioBulkJobs.id, { onDelete: 'cascade' }),
  productId: text("product_id").references(() => studioProducts.id, { onDelete: 'set null' }),
  personaId: text("persona_id").references(() => studioPersonas.id, { onDelete: 'set null' }),
  styleId: text("style_id").references(() => studioStyles.id, { onDelete: 'set null' }),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  customPrompt: text("custom_prompt"),
  generationId: text("generation_id").references(() => studioGenerations.id, { onDelete: 'set null' }),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  bulkJobIdx: index("idx_studio_bulk_job_line_items_bulk_job").on(table.bulkJobId),
  statusIdx: index("idx_studio_bulk_job_line_items_status").on(table.status),
}));

export const channelUserBindings = sqliteTable("channel_user_bindings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull().default('telegram'),
  channelUserId: text("channel_user_id").notNull(),
  channelUserName: text("channel_user_name"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  uniqueBinding: index("idx_channel_user_binding").on(table.channelId, table.channelUserId),
}));

export const channelLinkTokens = sqliteTable("channel_link_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull().default('telegram'),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const telegramActiveSession = sqliteTable("telegram_active_session", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  chatId: text("chat_id").notNull(),
  sessionId: text("session_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  uniqueChat: index("idx_tg_active_session_chat").on(table.chatId),
}));
