import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

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
});

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
