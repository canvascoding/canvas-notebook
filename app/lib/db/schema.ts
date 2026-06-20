import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
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
  impersonatedBy: text("impersonated_by"),
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

export const emailAccounts = sqliteTable("email_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  provider: text("provider").notNull(),
  authType: text("auth_type").notNull(),
  emailAddress: text("email_address").notNull(),
  displayName: text("display_name"),
  providerAccountId: text("provider_account_id"),
  status: text("status").notNull().default("active"),
  policyJson: text("policy_json").notNull(),
  secretRef: text("secret_ref").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => ({
  userIdx: index("idx_email_accounts_user").on(table.userId),
  userStatusIdx: index("idx_email_accounts_user_status").on(table.userId, table.status),
  userProviderEmailIdx: uniqueIndex("idx_email_accounts_user_provider_email").on(table.userId, table.provider, table.emailAddress),
  userPrimaryIdx: uniqueIndex("idx_email_accounts_user_primary").on(table.userId).where(sql`${table.isPrimary} = 1`),
}));

export const emailDrafts = sqliteTable("email_drafts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  accountId: text("account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  status: text("status").notNull().default("draft"),
  toJson: text("to_json").notNull(),
  ccJson: text("cc_json").notNull(),
  bccJson: text("bcc_json").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  isHtml: integer("is_html", { mode: "boolean" }).notNull().default(false),
  attachmentsJson: text("attachments_json").notNull().default("[]"),
  providerDraftId: text("provider_draft_id"),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
}, (table) => ({
  userIdx: index("idx_email_drafts_user").on(table.userId),
  accountIdx: index("idx_email_drafts_account").on(table.accountId),
  userStatusIdx: index("idx_email_drafts_user_status").on(table.userId, table.status),
}));

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
});

export const canvasOrganizationSettings = sqliteTable("canvas_organization_settings", {
  organizationId: text("organization_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id),
  deploymentMode: text("deployment_mode").notNull().default("single_user"),
  teamFeaturesEnabled: integer("team_features_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  ownerIdx: index("idx_canvas_org_settings_owner").on(table.ownerUserId),
}));

export const canvasWorkspaces = sqliteTable("canvas_workspaces", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  type: text("type").notNull(),
  ownerUserId: text("owner_user_id").references(() => user.id),
  rootRelativePath: text("root_relative_path").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  organizationIdx: index("idx_canvas_workspaces_organization").on(table.organizationId),
  ownerIdx: index("idx_canvas_workspaces_owner").on(table.ownerUserId),
  organizationTypeIdx: index("idx_canvas_workspaces_organization_type").on(table.organizationId, table.type),
  personalOwnerIdx: uniqueIndex("idx_canvas_workspaces_personal_owner").on(table.ownerUserId).where(sql`${table.type} = 'personal'`),
  teamOrganizationIdx: uniqueIndex("idx_canvas_workspaces_team_organization").on(table.organizationId).where(sql`${table.type} = 'team'`),
}));

export const organizationUserPermissions = sqliteTable("organization_user_permissions", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  canWriteTeamWorkspace: integer("can_write_team_workspace", { mode: "boolean" }).notNull().default(false),
  canCreatePublicLinks: integer("can_create_public_links", { mode: "boolean" }).notNull().default(true),
  canCreateTeamAutomations: integer("can_create_team_automations", { mode: "boolean" }).notNull().default(false),
  canSharePluginsAndSkills: integer("can_share_plugins_and_skills", { mode: "boolean" }).notNull().default(false),
  canExport: integer("can_export", { mode: "boolean" }).notNull().default(false),
  canDeleteTeamFiles: integer("can_delete_team_files", { mode: "boolean" }).notNull().default(false),
  canDeleteStudioAssets: integer("can_delete_studio_assets", { mode: "boolean" }).notNull().default(true),
  canManageBackups: integer("can_manage_backups", { mode: "boolean" }).notNull().default(false),
  canMigrateDatabase: integer("can_migrate_database", { mode: "boolean" }).notNull().default(false),
  canEnableKnowledge: integer("can_enable_knowledge", { mode: "boolean" }).notNull().default(false),
  canRecoverWorkspaces: integer("can_recover_workspaces", { mode: "boolean" }).notNull().default(false),
  disabledAt: integer("disabled_at", { mode: "timestamp" }),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  offboardedByUserId: text("offboarded_by_user_id").references(() => user.id),
  offboardingReason: text("offboarding_reason"),
  offboardingReportJson: text("offboarding_report_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  pk: primaryKey(table.organizationId, table.userId),
  userIdx: index("idx_org_user_permissions_user").on(table.userId),
  roleIdx: index("idx_org_user_permissions_role").on(table.organizationId, table.role),
  statusIdx: index("idx_org_user_permissions_status").on(table.organizationId, table.status),
  singleOwnerIdx: uniqueIndex("idx_org_user_permissions_single_owner").on(table.organizationId).where(sql`${table.role} = 'owner'`),
}));

export const aiSessions = sqliteTable("ai_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  model: text("model").notNull(), // agent id, e.g. 'claude', 'codex', 'openrouter', 'ollama'
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userCreatedIdx: index("idx_ai_sessions_user_created").on(table.userId, table.createdAt),
  userSessionIdx: index("idx_ai_sessions_user_session").on(table.userId, table.sessionId),
}));

export const aiMessages = sqliteTable("ai_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  aiSessionDbId: integer("ai_session_db_id").notNull().references(() => aiSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'system'
  content: text("content").notNull(),
  type: text("type"),
  attachments: text("attachments"), // JSON string
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  sessionCreatedIdx: index("idx_ai_messages_session_created").on(table.aiSessionDbId, table.createdAt, table.id),
}));

export const piSessions = sqliteTable("pi_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  agentId: text("agent_id").notNull().default('canvas-agent'),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level"),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  summaryText: text("summary_text"),
  summaryUpdatedAt: integer("summary_updated_at", { mode: "timestamp" }),
  summaryThroughTimestamp: integer("summary_through_timestamp"),
  summaryThroughSequence: integer("summary_through_sequence"),
  systemPromptSnapshot: text("system_prompt_snapshot"),
  systemPromptSnapshotHash: text("system_prompt_snapshot_hash"),
  systemPromptSnapshotCreatedAt: integer("system_prompt_snapshot_created_at", { mode: "timestamp" }),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }),
  channelId: text("channel_id").notNull().default('app'),
  channelSessionKey: text("channel_session_key"),
  organizationId: text("organization_id"),
  workspaceId: text("workspace_id"),
  workspaceType: text("workspace_type"),
  workspaceName: text("workspace_name"),
  workspaceRootRelativePath: text("workspace_root_relative_path"),
}, (table) => ({
  channelIdx: index("idx_pi_sessions_channel").on(table.channelId, table.channelSessionKey),
  userCreatedIdx: index("idx_pi_sessions_user_created").on(table.userId, table.createdAt),
  userSessionIdx: index("idx_pi_sessions_user_session").on(table.userId, table.sessionId),
  userChannelIdx: index("idx_pi_sessions_user_channel_created").on(table.userId, table.channelId, table.createdAt),
  agentIdx: index("idx_pi_sessions_agent").on(table.agentId),
  workspaceIdx: index("idx_pi_sessions_workspace").on(table.workspaceId),
  userWorkspaceCreatedIdx: index("idx_pi_sessions_user_workspace_created").on(table.userId, table.workspaceId, table.createdAt),
}));

export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: text("agent_id").notNull().unique(),
  name: text("name").notNull(),
  iconId: text("icon_id").notNull().default("bot"),
  type: text("type").notNull().default('main'),
  removable: integer("removable", { mode: "boolean" }).notNull().default(false),
  defaultProvider: text("default_provider"),
  defaultModel: text("default_model"),
  defaultThinking: text("default_thinking"),
  enabledToolsJson: text("enabled_tools_json"),
  relevantSkillsJson: text("relevant_skills_json"),
  relevantConnectionsJson: text("relevant_connections_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  agentIdIdx: uniqueIndex("idx_agents_agent_id").on(table.agentId),
}));

export const piMessages = sqliteTable("pi_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  piSessionDbId: integer("pi_session_db_id").notNull().references(() => piSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'toolResult'
  content: text("content").notNull(), // Full JSON of Message object
  timestamp: integer("timestamp").notNull(),
  sequence: integer("sequence").notNull().default(0),
}, (table) => ({
  sessionTimestampIdx: index("idx_pi_messages_session_timestamp").on(table.piSessionDbId, table.timestamp, table.id),
  sessionSequenceIdx: index("idx_pi_messages_session_sequence").on(table.piSessionDbId, table.sequence, table.id),
}));

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

export const todoCategories = sqliteTable("todo_categories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userSortIdx: index("idx_todo_categories_user_sort").on(table.userId, table.sortOrder),
  userArchivedIdx: index("idx_todo_categories_user_archived").on(table.userId, table.isArchived),
}));

export const todoItems = sqliteTable("todo_items", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  createdByUserId: text("created_by_user_id").references(() => user.id),
  assigneeUserId: text("assignee_user_id").references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default("personal"),
  categoryId: text("category_id").references(() => todoCategories.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  dueAt: integer("due_at", { mode: "timestamp" }),
  sourceType: text("source_type").notNull().default("user"),
  sourceAgentId: text("source_agent_id"),
  sourceSessionId: text("source_session_id"),
  seenAt: integer("seen_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  completionComment: text("completion_comment"),
  followUpSentAt: integer("follow_up_sent_at", { mode: "timestamp" }),
  followUpError: text("follow_up_error"),
  emailNotificationSentAt: integer("email_notification_sent_at", { mode: "timestamp" }),
  emailNotificationError: text("email_notification_error"),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  userStatusUpdatedIdx: index("idx_todo_items_user_status_updated").on(table.userId, table.status, table.updatedAt),
  userDueIdx: index("idx_todo_items_user_due").on(table.userId, table.dueAt),
  userSeenIdx: index("idx_todo_items_user_seen").on(table.userId, table.seenAt),
  sourceSessionIdx: index("idx_todo_items_source_session").on(table.userId, table.sourceSessionId),
  orgWorkspaceStatusIdx: index("idx_todo_items_org_workspace_status").on(table.organizationId, table.workspaceId, table.status, table.updatedAt),
  assigneeStatusIdx: index("idx_todo_items_assignee_status").on(table.assigneeUserId, table.status, table.updatedAt),
  categoryIdx: index("idx_todo_items_category").on(table.categoryId),
}));

export const todoFileLinks = sqliteTable("todo_file_links", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull().references(() => todoItems.id),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default("personal"),
  workspacePath: text("workspace_path").notNull(),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  todoIdx: index("idx_todo_file_links_todo").on(table.todoId),
  userPathIdx: index("idx_todo_file_links_user_path").on(table.userId, table.workspacePath),
  workspacePathIdx: index("idx_todo_file_links_workspace_path").on(table.organizationId, table.workspaceId, table.workspacePath),
}));

export const todoEmailReplyWatchers = sqliteTable("todo_email_reply_watchers", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull().references(() => todoItems.id, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  accountId: text("account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  status: text("status").notNull().default("active"),
  replyToken: text("reply_token").notNull(),
  outboundMessageId: text("outbound_message_id"),
  sourceAgentId: text("source_agent_id"),
  sourceSessionId: text("source_session_id"),
  locale: text("locale").notNull().default("de"),
  sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  statusCheckedIdx: index("idx_todo_email_reply_watchers_status_checked").on(table.status, table.lastCheckedAt),
  todoIdx: index("idx_todo_email_reply_watchers_todo").on(table.todoId),
  userStatusIdx: index("idx_todo_email_reply_watchers_user_status").on(table.userId, table.status),
  tokenIdx: uniqueIndex("idx_todo_email_reply_watchers_token").on(table.replyToken),
}));

export const todoEmailReplyEvents = sqliteTable("todo_email_reply_events", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id").notNull().references(() => todoEmailReplyWatchers.id, { onDelete: 'cascade' }),
  todoId: text("todo_id").notNull().references(() => todoItems.id, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  accountId: text("account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  providerMessageId: text("provider_message_id").notNull(),
  threadId: text("thread_id"),
  folder: text("folder"),
  fromAddress: text("from_address"),
  subject: text("subject"),
  receivedAt: integer("received_at", { mode: "timestamp" }),
  replyText: text("reply_text"),
  status: text("status").notNull(),
  error: text("error"),
  dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  watcherCreatedIdx: index("idx_todo_email_reply_events_watcher_created").on(table.watcherId, table.createdAt),
  todoCreatedIdx: index("idx_todo_email_reply_events_todo_created").on(table.todoId, table.createdAt),
  uniqueMessageIdx: uniqueIndex("idx_todo_email_reply_events_message").on(table.watcherId, table.accountId, table.providerMessageId),
}));

export const publicFileShares = sqliteTable("public_file_shares", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPreview: text("token_preview").notNull(),
  shortCode: text("short_code").unique(),
  workspacePath: text("workspace_path").notNull(),
  fileName: text("file_name").notNull(),
  fileIdentity: text("file_identity").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  status: text("status").notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdByAgentId: text("created_by_agent_id"),
  sourceSessionId: text("source_session_id"),
  source: text("source").notNull().default("ui"),
  securityMode: text("security_mode").notNull().default("strict"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  accessCount: integer("access_count").notNull().default(0),
}, (table) => ({
  tokenHashIdx: uniqueIndex("idx_public_file_shares_token_hash").on(table.tokenHash),
  tokenIdx: uniqueIndex("idx_public_file_shares_token").on(table.token),
  shortCodeIdx: uniqueIndex("idx_public_file_shares_short_code").on(table.shortCode),
  statusIdx: index("idx_public_file_shares_status").on(table.status),
  pathIdx: index("idx_public_file_shares_workspace_path").on(table.workspacePath),
  userStatusIdx: index("idx_public_file_shares_user_status").on(table.createdByUserId, table.status),
  expiresIdx: index("idx_public_file_shares_expires_at").on(table.expiresAt),
}));

export const onboardingLog = sqliteTable("onboarding_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
  completedBy: text("completed_by"), // userId or null for bootstrap
  method: text("method").notNull(), // 'ui' | 'bootstrap'
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const licenseCerts = sqliteTable("license_certs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cert: text("cert").notNull(),
  plan: text("plan").notNull(),
  instanceId: text("instance_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  instanceIdx: index("idx_license_certs_instance").on(table.instanceId),
}));

export const licensePublicKeys = sqliteTable("license_public_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kid: text("kid"),
  publicKey: text("public_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  source: text("source").notNull().default("control_plane"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
}, (table) => ({
  fingerprintIdx: uniqueIndex("idx_license_public_keys_fingerprint").on(table.fingerprint),
  fetchedAtIdx: index("idx_license_public_keys_fetched_at").on(table.fetchedAt),
}));

export const automationJobs = sqliteTable("automation_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  scope: text("scope").notNull().default('personal'),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default('personal'),
  ownerUserId: text("owner_user_id").references(() => user.id),
  responsibleUserId: text("responsible_user_id").references(() => user.id),
  serviceActorId: text("service_actor_id"),
  approvedByUserId: text("approved_by_user_id").references(() => user.id),
  lastEditedByUserId: text("last_edited_by_user_id").references(() => user.id),
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
  agentId: text("agent_id").notNull().default('canvas-agent'),
  deliveryMode: text("delivery_mode").notNull().default('web'),
  deliveryChannelId: text("delivery_channel_id"),
  deliverySessionMode: text("delivery_session_mode").notNull().default('new_session'),
  deliverySessionId: text("delivery_session_id"),
  deliveryChannelSessionKey: text("delivery_channel_session_key"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  jobType: text("job_type").notNull().default('default'),
  channelId: text("channel_id"),
  composioTriggerId: text("composio_trigger_id"),
  composioTriggerSlug: text("composio_trigger_slug"),
  composioToolkitSlug: text("composio_toolkit_slug"),
  composioConnectedAccountId: text("composio_connected_account_id"),
  composioUserId: text("composio_user_id"),
  webhookTriggerConfigJson: text("webhook_trigger_config_json"),
}, (table) => ({
  ownerScopeIdx: index("idx_automation_jobs_owner_scope").on(table.ownerUserId, table.scope),
  organizationWorkspaceIdx: index("idx_automation_jobs_org_workspace").on(table.organizationId, table.workspaceId),
  composioTriggerIdx: uniqueIndex("idx_automation_jobs_composio_trigger_id").on(table.composioTriggerId),
}));

export const composioWebhookSubscriptions = sqliteTable("composio_webhook_subscriptions", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().unique(),
  webhookUrl: text("webhook_url").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  secretPreview: text("secret_preview"),
  eventTypes: text("event_types"),
  status: text("status").notNull().default("active"),
  mode: text("mode").notNull().default("local"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  rotatedAt: integer("rotated_at", { mode: "timestamp" }),
}, (table) => ({
  subscriptionIdx: uniqueIndex("idx_composio_webhook_subscriptions_subscription_id").on(table.subscriptionId),
}));

export const composioWebhookEvents = sqliteTable("composio_webhook_events", {
  id: text("id").primaryKey(),
  eventId: text("event_id"),
  webhookId: text("webhook_id"),
  triggerId: text("trigger_id"),
  jobId: text("job_id").references(() => automationJobs.id, { onDelete: 'set null' }),
  runId: text("run_id"),
  source: text("source").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  metadataJson: text("metadata_json"),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  eventIdx: uniqueIndex("idx_composio_webhook_events_event_id").on(table.eventId),
  webhookIdx: uniqueIndex("idx_composio_webhook_events_webhook_id").on(table.webhookId),
  triggerIdx: index("idx_composio_webhook_events_trigger").on(table.triggerId, table.receivedAt),
  jobIdx: index("idx_composio_webhook_events_job").on(table.jobId, table.receivedAt),
}));

export const automationWebhookTriggers = sqliteTable("automation_webhook_triggers", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => automationJobs.id, { onDelete: 'cascade' }),
  secretHash: text("secret_hash").notNull(),
  secretPreview: text("secret_preview").notNull(),
  status: text("status").notNull().default('active'),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  rotatedAt: integer("rotated_at", { mode: "timestamp" }),
}, (table) => ({
  jobIdx: uniqueIndex("idx_automation_webhook_triggers_job").on(table.jobId),
  statusIdx: index("idx_automation_webhook_triggers_status").on(table.status),
}));

export const automationWebhookEvents = sqliteTable("automation_webhook_events", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull().references(() => automationWebhookTriggers.id, { onDelete: 'cascade' }),
  jobId: text("job_id").notNull().references(() => automationJobs.id, { onDelete: 'cascade' }),
  eventId: text("event_id"),
  idempotencyKey: text("idempotency_key"),
  runId: text("run_id"),
  status: text("status").notNull(),
  error: text("error"),
  metadataJson: text("metadata_json"),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  webhookReceivedIdx: index("idx_automation_webhook_events_webhook_received").on(table.webhookId, table.receivedAt),
  jobReceivedIdx: index("idx_automation_webhook_events_job_received").on(table.jobId, table.receivedAt),
  eventIdx: uniqueIndex("idx_automation_webhook_events_event").on(table.webhookId, table.eventId),
  idempotencyIdx: uniqueIndex("idx_automation_webhook_events_idempotency").on(table.webhookId, table.idempotencyKey),
}));

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
  scope: text("scope").notNull().default('personal'),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default('personal'),
  actorType: text("actor_type").notNull().default('user'),
  actorUserId: text("actor_user_id").references(() => user.id),
  serviceActorId: text("service_actor_id"),
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
  resultText: text("result_text"),
  // Metadata stored in DB instead of files
  eventsLog: text("events_log"), // JSON array of event strings (replaces events.log file)
  metadataJson: text("metadata_json"), // JSON with provider, model, status, etc. (replaces run.json)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  workspaceCreatedIdx: index("idx_automation_runs_workspace_created").on(table.workspaceId, table.createdAt),
}));

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
  studioPresetName: text("studio_preset_name"),
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
  metadataJson: text("metadata_json"),
  settingsJson: text("settings_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  uniqueBinding: uniqueIndex("idx_channel_user_binding").on(table.channelId, table.channelUserId),
}));

export const sessionChannelLinks = sqliteTable("session_channel_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull(),
  channelSessionKey: text("channel_session_key").notNull(),
  channelThreadKey: text("channel_thread_key").notNull().default(''),
  displayName: text("display_name"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  deliveryPolicy: text("delivery_policy").notNull().default('last_active'),
  lastInboundAt: integer("last_inbound_at", { mode: "timestamp" }),
  lastOutboundAt: integer("last_outbound_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  uniqueLink: uniqueIndex("idx_session_channel_links_unique").on(table.userId, table.sessionId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  sessionIdx: index("idx_session_channel_links_session").on(table.sessionId),
  userChannelIdx: index("idx_session_channel_links_user_channel").on(table.userId, table.channelId),
  userContextIdx: index("idx_session_channel_links_user_context").on(table.userId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  channelContextIdx: index("idx_session_channel_links_context").on(table.channelId, table.channelSessionKey, table.channelThreadKey),
}));

export const channelActiveSessions = sqliteTable("channel_active_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => user.id),
  agentId: text("agent_id").notNull().default('canvas-agent'),
  channelId: text("channel_id").notNull(),
  channelSessionKey: text("channel_session_key").notNull(),
  channelThreadKey: text("channel_thread_key").notNull().default(''),
  sessionId: text("session_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  uniqueContext: uniqueIndex("idx_channel_active_sessions_user_context_agent").on(table.userId, table.agentId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  userChannelIdx: index("idx_channel_active_sessions_user_channel").on(table.userId, table.channelId),
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
  uniqueChat: uniqueIndex("idx_tg_active_session_chat").on(table.chatId),
}));
