import { desc, sql } from "drizzle-orm";
import { pgTable, text, bigint, bigserial, doublePrecision as real, index, uniqueIndex, primaryKey, check, customType } from "drizzle-orm/pg-core";
import { MAIN_AGENT_ID } from '@/app/lib/agents/main-agent';

// OAuth metadata is stored in text columns on both SQLite and PostgreSQL. A
// plain `$type<T>()` only affects TypeScript; PostgreSQL otherwise persists
// arrays as PostgreSQL array literals and returns strings to Better Auth.
// Canonical JSON keeps the runtime type identical for both database providers.
const jsonText = <T>(name: string) => customType<{
  data: T;
  driverData: string;
}>({
  dataType: () => 'text',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value),
})(name);

// Existing PostgreSQL installations store SQLite boolean and timestamp values
// as bigint (0/1 and epoch milliseconds). Keep those physical types while
// exposing the same runtime values to the application.
const pgBoolean = (name: string) => customType<{ data: boolean; driverData: number | string }>({
  dataType: () => 'bigint',
  toDriver: (value) => value ? 1 : 0,
  fromDriver: (value) => Number(value) !== 0,
})(name);
const pgTimestamp = (name: string) => customType<{ data: Date; driverData: number | string }>({
  dataType: () => 'bigint',
  toDriver: (value) => value.getTime(),
  fromDriver: (value) => new Date(Number(value)),
})(name);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: pgBoolean("email_verified").notNull(),
  image: text("image"),
  role: text("role"),
  banned: pgBoolean("banned"),
  banReason: text("ban_reason"),
  banExpires: pgTimestamp("ban_expires"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull()
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: pgTimestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  userId: text("user_id").notNull().references(() => user.id)
});

export const mobilePushDevices = pgTable("mobile_push_devices", {
  id: text("id").primaryKey(),
  installationId: text("installation_id").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  authSessionId: text("auth_session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  expoPushToken: text("expo_push_token").notNull().unique(),
  platform: text("platform").notNull(),
  appVariant: text("app_variant").notNull().default("production"),
  enabled: pgBoolean("enabled").notNull().default(true),
  agentResponseReady: pgBoolean("agent_response_ready").notNull().default(true),
  todoAttention: pgBoolean("todo_attention").notNull().default(true),
  emailReview: pgBoolean("email_review").notNull().default(true),
  studioCompleted: pgBoolean("studio_completed").notNull().default(true),
  failureAttention: pgBoolean("failure_attention").notNull().default(true),
  automationRunStatus: pgBoolean("automation_run_status").notNull().default(false),
  previewEnabled: pgBoolean("preview_enabled").notNull().default(false),
  lastRegisteredAt: pgTimestamp("last_registered_at").notNull(),
  lastDeliveryAt: pgTimestamp("last_delivery_at"),
  lastErrorCode: text("last_error_code"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userEnabledIdx: index("idx_mobile_push_devices_user_enabled").on(table.userId, table.enabled),
  authSessionIdx: index("idx_mobile_push_devices_auth_session").on(table.authSessionId),
}));

export const mobilePushDeliveries = pgTable("mobile_push_deliveries", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => mobilePushDevices.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  entityId: text("entity_id").notNull(),
  expoTicketId: text("expo_ticket_id").unique(),
  status: text("status").notNull(),
  attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
  nextReceiptCheckAt: pgTimestamp("next_receipt_check_at"),
  receiptAt: pgTimestamp("receipt_at"),
  lastErrorCode: text("last_error_code"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  receiptPollIdx: index("idx_mobile_push_deliveries_receipt_poll").on(table.status, table.nextReceiptCheckAt),
  userIdx: index("idx_mobile_push_deliveries_user").on(table.userId, table.createdAt),
}));

export const mobileInboxReadStates = pgTable("mobile_inbox_read_states", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  itemKey: text("item_key").notNull(),
  readAt: pgTimestamp("read_at").notNull(),
  dismissedAt: pgTimestamp("dismissed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.workspaceId, table.itemKey] }),
  workspaceReadIdx: index("idx_mobile_inbox_read_workspace").on(table.userId, table.workspaceId, table.readAt),
}));

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: pgTimestamp("access_token_expires_at"),
  refreshTokenExpiresAt: pgTimestamp("refresh_token_expires_at"),
  scope: text("scope"),
  // Better Auth 1.7+ requires a synthetic issuer for local credential accounts
  // (value: "local:credential") and OAuth accounts. Legacy rows without an
  // issuer are defaulted to the local credential issuer during migration.
  issuer: text("issuer").notNull().default("local:credential"),
  password: text("password"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull()
}, (table) => ({
  issuerAccountIdIdx: uniqueIndex("idx_account_issuer_account_id").on(table.issuer, table.accountId),
  userProviderIdx: index("idx_account_user_provider").on(table.userId, table.providerId),
}));

export const emailAccounts = pgTable("email_accounts", {
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
  isPrimary: pgBoolean("is_primary").notNull().default(false),
  accountScope: text("account_scope").notNull().default("personal"),
  organizationId: text("organization_id"),
  connectedByUserId: text("connected_by_user_id"),
  automationEnabledAt: pgTimestamp("automation_enabled_at"),
  // Compatibility field for the first workspace-binding rollout. New code uses
  // workspaceEmailMailboxes so historical assignments remain auditable.
  workspaceId: text("workspace_id"),
  lastUsedAt: pgTimestamp("last_used_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull()
}, (table) => ({
  userIdx: index("idx_email_accounts_user").on(table.userId),
  userStatusIdx: index("idx_email_accounts_user_status").on(table.userId, table.status),
  workspaceIdx: index("idx_email_accounts_workspace").on(table.workspaceId, table.status),
  userProviderEmailIdx: uniqueIndex("idx_email_accounts_user_provider_email").on(table.userId, table.provider, table.emailAddress),
  userPrimaryIdx: uniqueIndex("idx_email_accounts_user_primary").on(table.userId).where(sql`${table.isPrimary} = 1`),
}));

export const workspaceEmailMailboxes = pgTable("workspace_email_mailboxes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  emailAccountId: text("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  status: text("status").notNull().default("active"),
  role: text("role").notNull().default("inbound_outbound"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  lastEditedByUserId: text("last_edited_by_user_id").notNull().references(() => user.id),
  pausedAt: pgTimestamp("paused_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  workspaceStatusIdx: index("idx_workspace_email_mailboxes_workspace_status").on(table.workspaceId, table.status),
  accountStatusIdx: index("idx_workspace_email_mailboxes_account_status").on(table.emailAccountId, table.status),
  activeAccountIdx: uniqueIndex("idx_workspace_email_mailboxes_active_account")
    .on(table.emailAccountId)
    .where(sql`${table.status} = 'active'`),
}));

export const emailInboxEvents = pgTable("email_inbox_events", {
  id: text("id").primaryKey(),
  mailboxId: text("mailbox_id").notNull().references(() => workspaceEmailMailboxes.id, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull(),
  providerMessageId: text("provider_message_id"),
  providerThreadId: text("provider_thread_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  eventType: text("event_type").notNull(),
  receivedAt: pgTimestamp("received_at").notNull(),
  processedAt: pgTimestamp("processed_at"),
  status: text("status").notNull().default('pending'),
  attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
  nextAttemptAt: pgTimestamp("next_attempt_at"),
  errorCode: text("error_code"),
  caseId: text("case_id"),
  metadataJson: text("metadata_json"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  mailboxIdempotencyIdx: uniqueIndex("idx_email_inbox_events_mailbox_idempotency").on(table.mailboxId, table.idempotencyKey),
  workspaceStatusIdx: index("idx_email_inbox_events_workspace_status").on(table.workspaceId, table.status, table.receivedAt),
}));

export const emailInboxCases = pgTable("email_inbox_cases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => workspaceEmailMailboxes.id, { onDelete: 'cascade' }),
  providerThreadId: text("provider_thread_id").notNull(),
  latestProviderMessageId: text("latest_provider_message_id"),
  requesterAddress: text("requester_address"),
  requesterName: text("requester_name"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default('new'),
  priority: text("priority").notNull().default('normal'),
  assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: 'set null' }),
  closedAt: pgTimestamp("closed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  mailboxThreadIdx: uniqueIndex("idx_email_inbox_cases_mailbox_thread").on(table.mailboxId, table.providerThreadId),
  workspaceStatusIdx: index("idx_email_inbox_cases_workspace_status").on(table.workspaceId, table.status, table.updatedAt),
}));

// Personal mailboxes use the same Inbox-case lifecycle as workspace mailboxes,
// but deliberately have no implicit workspace assignment.
export const personalEmailInboxCases = pgTable("personal_email_inbox_cases", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  emailAccountId: text("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  providerThreadId: text("provider_thread_id").notNull(),
  latestProviderMessageId: text("latest_provider_message_id"),
  requesterAddress: text("requester_address"),
  requesterName: text("requester_name"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default('new'),
  priority: text("priority").notNull().default('normal'),
  assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: 'set null' }),
  closedAt: pgTimestamp("closed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  accountThreadIdx: uniqueIndex("idx_personal_email_inbox_cases_account_thread").on(table.emailAccountId, table.providerThreadId),
  userStatusIdx: index("idx_personal_email_inbox_cases_user_status").on(table.userId, table.status, table.updatedAt),
}));

export const emailDrafts = pgTable("email_drafts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  accountId: text("account_id").notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
  status: text("status").notNull().default("draft"),
  toJson: text("to_json").notNull(),
  ccJson: text("cc_json").notNull(),
  bccJson: text("bcc_json").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  isHtml: pgBoolean("is_html").notNull().default(false),
  attachmentsJson: text("attachments_json").notNull().default("[]"),
  providerDraftId: text("provider_draft_id"),
  workspaceId: text("workspace_id"),
  mailboxId: text("mailbox_id").references(() => workspaceEmailMailboxes.id, { onDelete: 'set null' }),
  inboxCaseId: text("inbox_case_id").references(() => emailInboxCases.id, { onDelete: 'set null' }),
  personalInboxCaseId: text("personal_inbox_case_id").references(() => personalEmailInboxCases.id, { onDelete: 'set null' }),
  origin: text("origin").notNull().default('manual'),
  originAutomationJobId: text("origin_automation_job_id"),
  originRunId: text("origin_run_id"),
  originAgentId: text("origin_agent_id"),
  outboxStatus: text("outbox_status"),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: 'set null' }),
  editingByUserId: text("editing_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  editingStartedAt: pgTimestamp("editing_started_at"),
  sentByUserId: text("sent_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  sentAt: pgTimestamp("sent_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull()
}, (table) => ({
  userIdx: index("idx_email_drafts_user").on(table.userId),
  accountIdx: index("idx_email_drafts_account").on(table.accountId),
  userStatusIdx: index("idx_email_drafts_user_status").on(table.userId, table.status),
  workspaceOutboxIdx: index("idx_email_drafts_workspace_outbox").on(table.workspaceId, table.outboxStatus, table.updatedAt),
}));

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: pgTimestamp("expires_at").notNull(),
  createdAt: pgTimestamp("created_at"),
  updatedAt: pgTimestamp("updated_at")
});

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  expiresAt: pgTimestamp("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  clientDiscoveryId: text("client_discovery_id"),
  disabled: pgBoolean("disabled").default(false),
  skipConsent: pgBoolean("skip_consent"),
  enableEndSession: pgBoolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: jsonText<string[]>("scopes"),
  clientCredentialsScopes: jsonText<string[]>("client_credentials_scopes"),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: pgTimestamp("created_at"),
  updatedAt: pgTimestamp("updated_at"),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: jsonText<string[]>("contacts"),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: jsonText<string[]>("redirect_uris").notNull(),
  postLogoutRedirectUris: jsonText<string[]>("post_logout_redirect_uris"),
  backchannelLogoutUri: text("backchannel_logout_uri"),
  backchannelLogoutSessionRequired: pgBoolean("backchannel_logout_session_required"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  applicationType: text("application_type"),
  jwks: text("jwks"),
  jwksUri: text("jwks_uri"),
  grantTypes: jsonText<string[]>("grant_types"),
  responseTypes: jsonText<string[]>("response_types"),
  public: pgBoolean("public"),
  type: text("type"),
  requirePKCE: pgBoolean("require_pkce"),
  dpopBoundAccessTokens: pgBoolean("dpop_bound_access_tokens"),
  referenceId: text("reference_id"),
  metadata: text("metadata").$type<Record<string, unknown>>(),
}, (table) => ({
  userIdx: index("idx_oauth_client_user").on(table.userId),
}));

export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: jsonText<string[]>("resources"),
  requestedUserInfoClaims: jsonText<string[]>("requested_user_info_claims"),
  expiresAt: pgTimestamp("expires_at").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  revoked: pgTimestamp("revoked"),
  rotatedAt: pgTimestamp("rotated_at"),
  rotationReplayResponse: text("rotation_replay_response"),
  rotationReplayExpiresAt: pgTimestamp("rotation_replay_expires_at"),
  authTime: pgTimestamp("auth_time"),
  confirmation: text("confirmation").$type<Record<string, unknown>>(),
  scopes: jsonText<string[]>("scopes").notNull(),
}, (table) => ({
  clientIdx: index("idx_oauth_refresh_token_client").on(table.clientId),
  sessionIdx: index("idx_oauth_refresh_token_session").on(table.sessionId),
  userIdx: index("idx_oauth_refresh_token_user").on(table.userId),
}));

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: jsonText<string[]>("resources"),
  requestedUserInfoClaims: jsonText<string[]>("requested_user_info_claims"),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
  expiresAt: pgTimestamp("expires_at").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  confirmation: text("confirmation").$type<Record<string, unknown>>(),
  scopes: jsonText<string[]>("scopes").notNull(),
}, (table) => ({
  clientIdx: index("idx_oauth_access_token_client").on(table.clientId),
  sessionIdx: index("idx_oauth_access_token_session").on(table.sessionId),
  userIdx: index("idx_oauth_access_token_user").on(table.userId),
  refreshIdx: index("idx_oauth_access_token_refresh").on(table.refreshId),
}));

export const mcpRevokedAccessToken = pgTable("mcp_revoked_access_token", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  expiresAt: pgTimestamp("expires_at").notNull(),
  revokedAt: pgTimestamp("revoked_at").notNull(),
}, (table) => ({
  expiryIdx: index("idx_mcp_revoked_access_token_expiry").on(table.expiresAt),
}));

// A user can disconnect their own Direct MCP grant without disabling the
// dynamically registered public client for other users. The timestamp keeps
// bearer JWTs issued before the disconnect invalid while permitting a later,
// explicit reauthorization for the same browser session.
export const mcpDirectGrantRevocation = pgTable("mcp_direct_grant_revocation", {
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  revokedAt: pgTimestamp("revoked_at").notNull(),
}, (table) => ({
  grantPk: primaryKey({ columns: [table.clientId, table.sessionId, table.userId] }),
  userClientIdx: index("idx_mcp_direct_grant_revocation_user_client").on(table.userId, table.clientId),
}));

// Direct MCP only exposes workspace data after the signed-in person explicitly
// selects it for that public OAuth client. Current Canvas ACL checks remain in
// effect at every tool call, so an outdated row never grants access by itself.
export const mcpDirectWorkspaceGrant = pgTable("mcp_direct_workspace_grant", {
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  grantPk: primaryKey({ columns: [table.clientId, table.userId, table.workspaceId] }),
  userClientIdx: index("idx_mcp_direct_workspace_grant_user_client").on(table.userId, table.clientId),
}));

// A workspace manager must opt a workspace into Direct MCP before an
// individual user can grant it to one of their OAuth clients.
export const mcpDirectWorkspaceSetting = pgTable("mcp_direct_workspace_setting", {
  workspaceId: text("workspace_id").primaryKey().references(() => canvasWorkspaces.id, { onDelete: "cascade" }),
  enabledByUserId: text("enabled_by_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  enabledAt: pgTimestamp("enabled_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  resources: jsonText<string[]>("resources"),
  requestedUserInfoClaims: jsonText<string[]>("requested_user_info_claims"),
  scopes: jsonText<string[]>("scopes").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  clientIdx: index("idx_oauth_consent_client").on(table.clientId),
  userIdx: index("idx_oauth_consent_user").on(table.userId),
}));

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: bigint("access_token_ttl", { mode: "number" }),
  refreshTokenTtl: bigint("refresh_token_ttl", { mode: "number" }),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: jsonText<string[]>("allowed_scopes"),
  customClaims: text("custom_claims").$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: pgBoolean("dpop_bound_access_tokens_required"),
  disabled: pgBoolean("disabled").default(false),
  createdAt: pgTimestamp("created_at"),
  updatedAt: pgTimestamp("updated_at"),
  policyVersion: bigint("policy_version", { mode: "number" }).default(1),
  metadata: text("metadata").$type<Record<string, unknown>>(),
});

export const oauthClientResource = pgTable("oauth_client_resource", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: text("resource_id").notNull().references(() => oauthResource.identifier, { onDelete: "cascade" }),
  metadata: text("metadata").$type<Record<string, unknown>>(),
  createdAt: pgTimestamp("created_at"),
}, (table) => ({
  clientResourceUnique: uniqueIndex("idx_oauth_client_resource_unique").on(table.clientId, table.resourceId),
}));

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: pgTimestamp("expires_at").notNull(),
});

export const canvasOrganizationSettings = pgTable("canvas_organization_settings", {
  organizationId: text("organization_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id),
  deploymentMode: text("deployment_mode").notNull().default("single_user"),
  teamFeaturesEnabled: pgBoolean("team_features_enabled").notNull().default(false),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  ownerIdx: index("idx_canvas_org_settings_owner").on(table.ownerUserId),
}));

export const organizationBrandProfiles = pgTable("organization_brand_profiles", {
  organizationId: text("organization_id").primaryKey().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  settingsJson: text("settings_json").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  updatedIdx: index("idx_organization_brand_profiles_updated").on(table.updatedAt),
}));

export const canvasCustomers = pgTable("canvas_customers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  metadataJson: text("metadata_json"),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationIdx: index("idx_canvas_customers_organization").on(table.organizationId, table.status, table.name),
  organizationSlugIdx: uniqueIndex("idx_canvas_customers_org_slug").on(table.organizationId, table.slug),
  creatorIdx: index("idx_canvas_customers_creator").on(table.createdByUserId, table.createdAt),
}));

export const canvasProjects = pgTable("canvas_projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status").notNull().default("active"),
  description: text("description"),
  metadataJson: text("metadata_json"),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  archivedAt: pgTimestamp("archived_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationIdx: index("idx_canvas_projects_organization").on(table.organizationId, table.status, table.name),
  customerIdx: index("idx_canvas_projects_customer").on(table.customerId, table.status, table.name),
  organizationSlugIdx: uniqueIndex("idx_canvas_projects_org_slug").on(table.organizationId, table.slug),
  creatorIdx: index("idx_canvas_projects_creator").on(table.createdByUserId, table.createdAt),
}));

export const canvasProjectMembers = pgTable("canvas_project_members", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  projectId: text("project_id").notNull().references(() => canvasProjects.id, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  canRead: pgBoolean("can_read").notNull().default(true),
  canWrite: pgBoolean("can_write").notNull().default(false),
  canManage: pgBoolean("can_manage").notNull().default(false),
  invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.projectId, table.userId),
  organizationUserIdx: index("idx_canvas_project_members_org_user").on(table.organizationId, table.userId, table.status),
  projectStatusIdx: index("idx_canvas_project_members_project_status").on(table.projectId, table.status),
}));

export const canvasWorkspaces = pgTable("canvas_workspaces", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  type: text("type").notNull(),
  ownerUserId: text("owner_user_id").references(() => user.id),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'cascade' }),
  rootRelativePath: text("root_relative_path").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  workspaceIcon: text("workspace_icon").notNull().default("user-round"),
  workspaceColor: text("workspace_color").notNull().default("#2563EB"),
  status: text("status").notNull().default("active"),
  isDefault: pgBoolean("is_default").notNull().default(false),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationIdx: index("idx_canvas_workspaces_organization").on(table.organizationId),
  ownerIdx: index("idx_canvas_workspaces_owner").on(table.ownerUserId),
  customerIdx: index("idx_canvas_workspaces_customer").on(table.customerId),
  projectIdx: index("idx_canvas_workspaces_project").on(table.projectId),
  organizationTypeIdx: index("idx_canvas_workspaces_organization_type").on(table.organizationId, table.type),
  defaultPersonalIdx: uniqueIndex("idx_canvas_workspaces_default_personal").on(table.ownerUserId).where(sql`${table.type} = 'personal' AND ${table.isDefault} = 1`),
  projectWorkspaceIdx: uniqueIndex("idx_canvas_workspaces_project_workspace").on(table.projectId).where(sql`${table.type} = 'project'`),
  projectIdRequired: check("chk_canvas_workspaces_project_id_required", sql`${table.type} != 'project' OR ${table.projectId} IS NOT NULL`),
}));

export const uploadAccessGrants = pgTable("upload_access_grants", {
  fileId: text("file_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  workspaceId: text("workspace_id"),
  storagePath: text("storage_path").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  category: text("category").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  ownerIdx: index("idx_upload_access_owner").on(table.ownerUserId, table.createdAt),
  workspaceIdx: index("idx_upload_access_workspace").on(table.workspaceId, table.createdAt),
}));

export const workspaceBrandProfiles = pgTable("workspace_brand_profiles", {
  workspaceId: text("workspace_id").primaryKey().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  settingsJson: text("settings_json").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  updatedIdx: index("idx_workspace_brand_profiles_updated").on(table.updatedAt),
}));

export const canvasWorkspaceMembers = pgTable("canvas_workspace_members", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  canRead: pgBoolean("can_read").notNull().default(true),
  canWrite: pgBoolean("can_write").notNull().default(false),
  canManage: pgBoolean("can_manage").notNull().default(false),
  invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.workspaceId, table.userId),
  organizationUserIdx: index("idx_canvas_workspace_members_org_user").on(table.organizationId, table.userId, table.status),
  workspaceStatusIdx: index("idx_canvas_workspace_members_workspace_status").on(table.workspaceId, table.status),
}));

export const composioConnectionProfiles = pgTable("composio_connection_profiles", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  composioUserId: text("composio_user_id").notNull(),
  isDefault: pgBoolean("is_default").notNull().default(false),
  status: text("status").notNull().default("active"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  ownerStatusIdx: index("idx_composio_profiles_owner_status").on(table.ownerUserId, table.status, table.createdAt),
  ownerDefaultIdx: uniqueIndex("idx_composio_profiles_owner_default").on(table.ownerUserId).where(sql`${table.isDefault} = 1 AND ${table.status} = 'active'`),
  externalUserIdx: uniqueIndex("idx_composio_profiles_external_user").on(table.composioUserId),
}));

export const composioWorkspaceProfileOverrides = pgTable("composio_workspace_profile_overrides", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  profileId: text("profile_id").notNull().references(() => composioConnectionProfiles.id, { onDelete: 'restrict' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.userId, table.workspaceId),
  profileIdx: index("idx_composio_workspace_overrides_profile").on(table.profileId, table.updatedAt),
}));

export const composioOauthFlowStates = pgTable("composio_oauth_flow_states", {
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  profileId: text("profile_id").notNull().references(() => composioConnectionProfiles.id, { onDelete: 'cascade' }),
  composioUserId: text("composio_user_id").notNull(),
  toolkitSlug: text("toolkit_slug").notNull(),
  returnPath: text("return_path").notNull(),
  expiresAt: pgTimestamp("expires_at").notNull(),
  consumedAt: pgTimestamp("consumed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  expiryIdx: index("idx_composio_oauth_states_expiry").on(table.expiresAt, table.consumedAt),
  userProfileIdx: index("idx_composio_oauth_states_user_profile").on(table.userId, table.profileId, table.createdAt),
}));

export const workspaceTrashEntries = pgTable("workspace_trash_entries", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  workspaceType: text("workspace_type").notNull(),
  ownerUserId: text("owner_user_id"),
  originalPath: text("original_path").notNull(),
  trashRelativePath: text("trash_relative_path").notNull(),
  entryName: text("entry_name").notNull(),
  itemType: text("item_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  fileCount: bigint("file_count", { mode: "number" }).notNull().default(0),
  directoryCount: bigint("directory_count", { mode: "number" }).notNull().default(0),
  status: text("status").notNull().default("trashed"),
  deletedByUserId: text("deleted_by_user_id"),
  restoredByUserId: text("restored_by_user_id"),
  purgedByUserId: text("purged_by_user_id"),
  deletedAt: pgTimestamp("deleted_at").notNull(),
  expiresAt: pgTimestamp("expires_at").notNull(),
  restoredAt: pgTimestamp("restored_at"),
  purgedAt: pgTimestamp("purged_at"),
  metadataJson: text("metadata_json"),
}, (table) => ({
  workspaceStatusIdx: index("idx_workspace_trash_workspace_status").on(table.workspaceId, table.status, table.deletedAt),
  expiresIdx: index("idx_workspace_trash_expires").on(table.status, table.expiresAt),
  organizationStatusIdx: index("idx_workspace_trash_org_status").on(table.organizationId, table.status, table.deletedAt),
  projectStatusIdx: index("idx_workspace_trash_project_status").on(table.projectId, table.status, table.deletedAt),
  deletedByIdx: index("idx_workspace_trash_deleted_by").on(table.deletedByUserId, table.deletedAt),
  originalPathIdx: index("idx_workspace_trash_original_path").on(table.workspaceId, table.originalPath, table.status),
}));

// Collaboration metadata is shared by every file access channel. Workspace and
// actor IDs remain logical IDs while legacy SQLite rows are imported; lineage
// and revision constraints are enforced by the PostgreSQL migration.
export const fileCollaborationLineages = pgTable("file_collaboration_lineages", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id").notNull(),
  workspaceType: text("workspace_type").notNull(),
  path: text("path").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: pgTimestamp("created_at").notNull(),
  archivedAt: pgTimestamp("archived_at"),
  trashEntryId: text("trash_entry_id"),
}, (table) => ({
  activePathIdx: uniqueIndex("idx_file_collaboration_lineages_active_path")
    .on(table.workspaceId, table.path)
    .where(sql`${table.status} = 'active'`),
  workspaceStatusIdx: index("idx_file_collaboration_lineages_workspace_status").on(table.workspaceId, table.status, table.path),
  archivedTrashIdx: index("idx_file_collaboration_lineages_archived_trash")
    .on(table.workspaceId, table.trashEntryId, table.path)
    .where(sql`${table.status} = 'archived' AND ${table.trashEntryId} IS NOT NULL`),
  statusCheck: check("file_collaboration_lineages_status_check", sql`${table.status} IN ('active', 'archived')`),
  archiveStateCheck: check(
    "file_collaboration_lineages_archive_state_check",
    sql`(${table.status} = 'active' AND ${table.archivedAt} IS NULL) OR (${table.status} = 'archived' AND ${table.archivedAt} IS NOT NULL)`,
  ),
}));

export const fileRevisions = pgTable("file_revisions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id").notNull(),
  workspaceType: text("workspace_type").notNull(),
  path: text("path").notNull(),
  contentHash: text("content_hash").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  createdByUserId: text("created_by_user_id"),
  createdByActorType: text("created_by_actor_type").notNull().default("user"),
  sourceSessionId: text("source_session_id"),
  baseRevisionId: text("base_revision_id"),
  lineageId: text("lineage_id"),
  revisionNumber: bigint("revision_number", { mode: "number" }),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  workspacePathCreatedIdx: index("idx_file_revisions_workspace_path_created").on(table.workspaceId, table.path, table.createdAt),
  workspacePathHashIdx: index("idx_file_revisions_workspace_path_hash").on(table.workspaceId, table.path, table.contentHash),
  lineageCreatedIdx: index("idx_file_revisions_lineage_created").on(table.lineageId, table.createdAt),
  lineageRevisionIdx: uniqueIndex("idx_file_revisions_lineage_revision")
    .on(table.lineageId, table.revisionNumber)
    .where(sql`${table.lineageId} IS NOT NULL`),
  orgCreatedIdx: index("idx_file_revisions_org_created").on(table.organizationId, table.createdAt),
  projectCreatedIdx: index("idx_file_revisions_project_created").on(table.projectId, table.createdAt),
  actorCreatedIdx: index("idx_file_revisions_actor_created").on(table.createdByUserId, table.createdAt),
}));

/** Workspace-wide file annotations. Filesystem facts stay on disk; only user-authored data is stored here. */
export const workspaceFileMetadata = pgTable("workspace_file_metadata", {
  workspaceId: text("workspace_id").notNull(),
  path: text("path").notNull(),
  title: text("title"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.path] }),
  workspaceUpdatedIdx: index("idx_workspace_file_metadata_workspace_updated").on(table.workspaceId, table.updatedAt),
}));

/** Personal quick-access state. Favorites and pins must never affect other workspace members. */
export const workspaceFileUserStates = pgTable("workspace_file_user_states", {
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  path: text("path").notNull(),
  isFavorite: pgBoolean("is_favorite").notNull().default(false),
  pinnedAt: pgTimestamp("pinned_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.userId, table.path] }),
  workspaceUserFavoriteIdx: index("idx_workspace_file_user_state_favorite").on(table.workspaceId, table.userId, table.isFavorite, table.pinnedAt),
}));

export const fileLocks = pgTable("file_locks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id").notNull(),
  workspaceType: text("workspace_type").notNull(),
  path: text("path").notNull(),
  lineageId: text("lineage_id"),
  revisionId: text("revision_id"),
  lockedByUserId: text("locked_by_user_id"),
  lockedBySessionId: text("locked_by_session_id"),
  lockType: text("lock_type").notNull().default("edit"),
  status: text("status").notNull().default("active"),
  expiresAt: pgTimestamp("expires_at").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  activePathIdx: index("idx_file_locks_active_path").on(table.workspaceId, table.path, table.status, table.expiresAt),
  singleActivePathIdx: uniqueIndex("idx_file_locks_single_active_path")
    .on(table.workspaceId, table.path)
    .where(sql`${table.status} = 'active'`),
  activeExpiryIdx: index("idx_file_locks_active_expiry")
    .on(table.expiresAt)
    .where(sql`${table.status} = 'active'`),
  userStatusIdx: index("idx_file_locks_user_status").on(table.lockedByUserId, table.status, table.updatedAt),
  orgStatusIdx: index("idx_file_locks_org_status").on(table.organizationId, table.status, table.updatedAt),
  projectStatusIdx: index("idx_file_locks_project_status").on(table.projectId, table.status, table.updatedAt),
  statusCheck: check("file_locks_status_check", sql`${table.status} IN ('active', 'released', 'expired', 'force_released')`),
  lockTypeCheck: check("file_locks_type_check", sql`${table.lockType} IN ('edit', 'upload', 'agent_write')`),
  expiryCheck: check("file_locks_expiry_check", sql`${table.expiresAt} >= ${table.createdAt}`),
}));

export const collaborationDocuments = pgTable("collaboration_documents", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id").notNull(),
  workspaceType: text("workspace_type").notNull(),
  path: text("path").notNull(),
  lineageId: text("lineage_id"),
  provider: text("provider").notNull().default("yjs"),
  stateVersion: bigint("state_version", { mode: "number" }).notNull().default(0),
  snapshotRevisionId: text("snapshot_revision_id"),
  status: text("status").notNull().default("active"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  workspacePathProviderIdx: uniqueIndex("idx_collab_documents_workspace_path_provider")
    .on(table.workspaceId, table.path, table.provider)
    .where(sql`${table.status} = 'active'`),
  lineageProviderIdx: uniqueIndex("idx_collab_documents_lineage_provider")
    .on(table.lineageId, table.provider)
    .where(sql`${table.status} = 'active' AND ${table.lineageId} IS NOT NULL`),
  orgStatusIdx: index("idx_collab_documents_org_status").on(table.organizationId, table.status, table.updatedAt),
  projectStatusIdx: index("idx_collab_documents_project_status").on(table.projectId, table.status, table.updatedAt),
  statusCheck: check("collaboration_documents_status_check", sql`${table.status} IN ('active', 'archived')`),
  providerCheck: check("collaboration_documents_provider_check", sql`${table.provider} IN ('yjs', 'excalidraw')`),
}));

export const collaborationEvents = pgTable("collaboration_events", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  actorUserId: text("actor_user_id"),
  actorSessionId: text("actor_session_id"),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  payloadRef: text("payload_ref"),
  payloadHash: text("payload_hash"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  documentSequenceIdx: uniqueIndex("idx_collab_events_document_sequence").on(table.documentId, table.sequence),
  documentCreatedIdx: index("idx_collab_events_document_created").on(table.documentId, table.createdAt),
  actorCreatedIdx: index("idx_collab_events_actor_created").on(table.actorUserId, table.createdAt),
}));

export const organizationUserPermissions = pgTable("organization_user_permissions", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  canWriteTeamWorkspace: pgBoolean("can_write_team_workspace").notNull().default(false),
  canCreatePublicLinks: pgBoolean("can_create_public_links").notNull().default(true),
  canCreateTeamAutomations: pgBoolean("can_create_team_automations").notNull().default(false),
  canSharePluginsAndSkills: pgBoolean("can_share_plugins_and_skills").notNull().default(false),
  canExport: pgBoolean("can_export").notNull().default(false),
  canDeleteTeamFiles: pgBoolean("can_delete_team_files").notNull().default(false),
  canDeleteStudioAssets: pgBoolean("can_delete_studio_assets").notNull().default(true),
  canManageBackups: pgBoolean("can_manage_backups").notNull().default(false),
  canManageOrganizationMemory: pgBoolean("can_manage_organization_memory").notNull().default(false),
  canMigrateDatabase: pgBoolean("can_migrate_database").notNull().default(false),
  canEnableKnowledge: pgBoolean("can_enable_knowledge").notNull().default(false),
  canRecoverWorkspaces: pgBoolean("can_recover_workspaces").notNull().default(false),
  disabledAt: pgTimestamp("disabled_at"),
  archivedAt: pgTimestamp("archived_at"),
  offboardedByUserId: text("offboarded_by_user_id").references(() => user.id),
  offboardingReason: text("offboarding_reason"),
  offboardingReportJson: text("offboarding_report_json"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.organizationId, table.userId),
  userIdx: index("idx_org_user_permissions_user").on(table.userId),
  roleIdx: index("idx_org_user_permissions_role").on(table.organizationId, table.role),
  statusIdx: index("idx_org_user_permissions_status").on(table.organizationId, table.status),
  singleOwnerIdx: uniqueIndex("idx_org_user_permissions_single_owner").on(table.organizationId).where(sql`${table.role} = 'owner'`),
}));

export const canvasDataMigrations = pgTable("canvas_data_migrations", {
  migrationKey: text("migration_key").primaryKey(),
  completedAt: pgTimestamp("completed_at").notNull(),
  metadataJson: text("metadata_json"),
});

export const teamMemberships = pgTable("team_memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  candidateEmail: text("candidate_email").notNull(),
  displayName: text("display_name"),
  userId: text("user_id").references(() => user.id, { onDelete: 'restrict' }),
  role: text("role").notNull().default("member"),
  status: text("status").notNull(),
  externalInvitationId: text("external_invitation_id"),
  controlPlaneOperationId: text("control_plane_operation_id"),
  invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  invitedAt: pgTimestamp("invited_at"),
  acceptedAt: pgTimestamp("accepted_at"),
  activatedAt: pgTimestamp("activated_at"),
  suspendedAt: pgTimestamp("suspended_at"),
  removedAt: pgTimestamp("removed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationStatusIdx: index("idx_team_memberships_org_status").on(table.organizationId, table.status),
  organizationEmailIdx: uniqueIndex("idx_team_memberships_org_email").on(table.organizationId, table.candidateEmail),
  organizationUserIdx: uniqueIndex("idx_team_memberships_org_user").on(table.organizationId, table.userId).where(sql`${table.userId} IS NOT NULL`),
  externalInvitationIdx: uniqueIndex("idx_team_memberships_external_invitation").on(table.organizationId, table.externalInvitationId).where(sql`${table.externalInvitationId} IS NOT NULL`),
  controlPlaneOperationIdx: index("idx_team_memberships_control_plane_operation").on(table.organizationId, table.controlPlaneOperationId),
  statusCheck: check("team_memberships_status_check", sql`${table.status} IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')`),
  roleCheck: check("team_memberships_role_check", sql`${table.role} IN ('owner', 'admin', 'member', 'external')`),
  activeIdentityCheck: check("team_memberships_active_identity_check", sql`${table.status} != 'active' OR (${table.userId} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL)`),
  pendingCandidateCheck: check("team_memberships_pending_candidate_check", sql`${table.status} NOT IN ('invited', 'approval_required', 'billing_pending') OR ${table.userId} IS NULL`),
}));

export const teamMembershipInvitations = pgTable("team_membership_invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  membershipId: text("membership_id").notNull().unique().references(() => teamMemberships.id, { onDelete: 'cascade' }),
  tokenHash: text("token_hash").notNull().unique(),
  emailSnapshot: text("email_snapshot").notNull(),
  roleSnapshot: text("role_snapshot").notNull(),
  status: text("status").notNull().default("pending"),
  invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  expiresAt: pgTimestamp("expires_at").notNull(),
  acceptedRequestId: text("accepted_request_id"),
  acceptedAt: pgTimestamp("accepted_at"),
  revokedAt: pgTimestamp("revoked_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationStatusIdx: index("idx_team_membership_invitations_org_status").on(table.organizationId, table.status, table.createdAt),
  expiryIdx: index("idx_team_membership_invitations_expiry").on(table.status, table.expiresAt),
  acceptedRequestIdx: uniqueIndex("idx_team_membership_invitations_accept_request").on(table.acceptedRequestId).where(sql`${table.acceptedRequestId} IS NOT NULL`),
  statusCheck: check("team_membership_invitations_status_check", sql`${table.status} IN ('pending', 'accepted', 'revoked', 'expired')`),
  roleCheck: check("team_membership_invitations_role_check", sql`${table.roleSnapshot} IN ('admin', 'member', 'external')`),
  acceptedCheck: check("team_membership_invitations_accepted_check", sql`${table.status} != 'accepted' OR (${table.acceptedRequestId} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL)`),
}));

export const teamMembershipTransitions = pgTable("team_membership_transitions", {
  id: text("id").primaryKey(),
  membershipId: text("membership_id").notNull().references(() => teamMemberships.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: 'set null' }),
  source: text("source").notNull(),
  reason: text("reason"),
  externalOperationId: text("external_operation_id"),
  membershipRevision: bigint("membership_revision", { mode: "number" }),
  metadataJson: text("metadata_json"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  membershipCreatedIdx: index("idx_team_membership_transitions_membership_created").on(table.membershipId, table.createdAt),
  organizationCreatedIdx: index("idx_team_membership_transitions_org_created").on(table.organizationId, table.createdAt),
  organizationRevisionIdx: index("idx_team_membership_transitions_org_revision").on(table.organizationId, table.membershipRevision),
  externalOperationIdx: index("idx_team_membership_transitions_external_operation").on(table.organizationId, table.externalOperationId),
  fromStatusCheck: check("team_membership_transitions_from_status_check", sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')`),
  toStatusCheck: check("team_membership_transitions_to_status_check", sql`${table.toStatus} IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')`),
}));

export const teamMembershipSyncState = pgTable("team_membership_sync_state", {
  organizationId: text("organization_id").primaryKey().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  currentRevision: bigint("current_revision", { mode: "number" }).notNull().default(0),
  currentObservedQuantity: bigint("current_observed_quantity", { mode: "number" }).notNull().default(0),
  latestSnapshotHash: text("latest_snapshot_hash"),
  latestSnapshotGeneratedAt: pgTimestamp("latest_snapshot_generated_at"),
  lastLocalChangeAt: pgTimestamp("last_local_change_at"),
  acknowledgedRevision: bigint("acknowledged_revision", { mode: "number" }).notNull().default(0),
  acknowledgedSnapshotId: text("acknowledged_snapshot_id"),
  acknowledgedSnapshotHash: text("acknowledged_snapshot_hash"),
  acknowledgedAt: pgTimestamp("acknowledged_at"),
  controlPlaneProtocolVersion: text("control_plane_protocol_version"),
  controlPlaneObservedQuantity: bigint("control_plane_observed_quantity", { mode: "number" }),
  approvedQuantity: bigint("approved_quantity", { mode: "number" }),
  billedQuantity: bigint("billed_quantity", { mode: "number" }),
  licensedQuantity: bigint("licensed_quantity", { mode: "number" }),
  expectedLicensedQuantity: bigint("expected_licensed_quantity", { mode: "number" }),
  entitlementsVersion: bigint("entitlements_version", { mode: "number" }),
  billingStatus: text("billing_status"),
  driftStatus: text("drift_status"),
  reconciliationStatus: text("reconciliation_status"),
  reconciliationAction: text("reconciliation_action"),
  reconciliationReason: text("reconciliation_reason"),
  reconciliationSeatLimit: bigint("reconciliation_seat_limit", { mode: "number" }),
  reconciliationSupportRequired: pgBoolean("reconciliation_support_required").notNull().default(false),
  reconciledAt: pgTimestamp("reconciled_at"),
  nextReportAt: pgTimestamp("next_report_at"),
  lastSyncErrorCode: text("last_sync_error_code"),
  lastSyncError: text("last_sync_error"),
  lastSyncAt: pgTimestamp("last_sync_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  nextReportIdx: index("idx_team_membership_sync_next_report").on(table.nextReportAt),
  revisionCheck: check("team_membership_sync_revision_check", sql`${table.currentRevision} >= 0 AND ${table.acknowledgedRevision} >= 0 AND ${table.acknowledgedRevision} <= ${table.currentRevision}`),
  quantityCheck: check("team_membership_sync_quantity_check", sql`${table.currentObservedQuantity} >= 0`),
  reconciliationSeatLimitCheck: check("team_membership_sync_reconciliation_seat_limit_check", sql`${table.reconciliationSeatLimit} IS NULL OR ${table.reconciliationSeatLimit} >= 1`),
}));

export const teamSeatOutbox = pgTable("team_seat_outbox", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull().unique(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  membershipId: text("membership_id").references(() => teamMemberships.id, { onDelete: 'set null' }),
  membershipRevision: bigint("membership_revision", { mode: "number" }),
  operationKind: text("operation_kind").notNull(),
  operationType: text("operation_type"),
  status: text("status").notNull().default("pending"),
  requestJson: text("request_json").notNull(),
  requestHash: text("request_hash").notNull(),
  responseJson: text("response_json"),
  controlPlaneOperationId: text("control_plane_operation_id"),
  attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
  maxAttempts: bigint("max_attempts", { mode: "number" }).notNull().default(10),
  nextAttemptAt: pgTimestamp("next_attempt_at"),
  lastAttemptAt: pgTimestamp("last_attempt_at"),
  lastErrorCode: text("last_error_code"),
  lastError: text("last_error"),
  completedAt: pgTimestamp("completed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  statusRetryIdx: index("idx_team_seat_outbox_status_retry").on(table.status, table.nextAttemptAt),
  organizationCreatedIdx: index("idx_team_seat_outbox_org_created").on(table.organizationId, table.createdAt),
  organizationRevisionIdx: index("idx_team_seat_outbox_org_revision").on(table.organizationId, table.membershipRevision),
  membershipIdx: index("idx_team_seat_outbox_membership").on(table.membershipId, table.createdAt),
  controlPlaneOperationIdx: index("idx_team_seat_outbox_control_plane_operation").on(table.controlPlaneOperationId),
  operationKindCheck: check("team_seat_outbox_operation_kind_check", sql`${table.operationKind} IN ('membership_snapshot', 'seat_prepare', 'seat_execute', 'license_refresh')`),
  operationTypeCheck: check("team_seat_outbox_operation_type_check", sql`${table.operationType} IS NULL OR ${table.operationType} IN ('team_upgrade', 'member_create', 'invitation_accept', 'member_remove', 'reconcile')`),
  statusCheck: check("team_seat_outbox_status_check", sql`${table.status} IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'canceled')`),
  attemptCheck: check("team_seat_outbox_attempt_check", sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} >= 1 AND ${table.attemptCount} <= ${table.maxAttempts}`),
}));

export const capabilityPolicies = pgTable("capability_policies", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  effect: text("effect").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id, { onDelete: 'restrict' }),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => user.id, { onDelete: 'restrict' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationResourceIdx: index("idx_capability_policies_org_resource").on(table.organizationId, table.resourceType, table.resourceId),
  organizationTargetIdx: index("idx_capability_policies_org_target").on(table.organizationId, table.targetType, table.targetId),
  bindingIdx: uniqueIndex("idx_capability_policies_binding").on(
    table.organizationId,
    table.resourceType,
    table.resourceId,
    table.targetType,
    table.targetId,
  ),
  resourceTypeCheck: check("capability_policies_resource_type_check", sql`${table.resourceType} IN ('skill', 'plugin')`),
  targetTypeCheck: check("capability_policies_target_type_check", sql`${table.targetType} IN ('organization', 'role', 'workspace', 'project', 'user')`),
  effectCheck: check("capability_policies_effect_check", sql`${table.effect} IN ('optional', 'default-enabled', 'required', 'blocked')`),
}));

export const aiProviderInstallations = pgTable("ai_provider_installations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  providerId: text("provider_id").notNull(),
  displayName: text("display_name").notNull(),
  source: text("source").notNull(),
  credentialScope: text("credential_scope").notNull(),
  enabled: pgBoolean("enabled").notNull().default(false),
  status: text("status").notNull().default("unverified"),
  configJson: text("config_json"),
  sourceRevision: text("source_revision"),
  lastSyncedAt: pgTimestamp("last_synced_at"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  verifiedAt: pgTimestamp("verified_at"),
  verifiedByUserId: text("verified_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationBindingIdx: uniqueIndex("idx_ai_provider_installations_org_binding").on(table.organizationId, table.providerId, table.credentialScope),
  organizationEnabledIdx: index("idx_ai_provider_installations_org_enabled").on(table.organizationId, table.enabled),
  organizationStatusIdx: index("idx_ai_provider_installations_org_status").on(table.organizationId, table.status),
}));

export const aiProviderModels = pgTable("ai_provider_models", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  providerInstallationId: text("provider_installation_id").notNull().references(() => aiProviderInstallations.id, { onDelete: 'cascade' }),
  modelId: text("model_id").notNull(),
  displayName: text("display_name").notNull(),
  enabled: pgBoolean("enabled").notNull().default(true),
  isProviderDefault: pgBoolean("is_provider_default").notNull().default(false),
  reasoning: pgBoolean("reasoning").notNull().default(false),
  supportsVision: pgBoolean("supports_vision").notNull().default(false),
  thinkingLevelsJson: text("thinking_levels_json").notNull().default('["off"]'),
  metadataJson: text("metadata_json"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.providerInstallationId, table.modelId),
  providerEnabledIdx: index("idx_ai_provider_models_provider_enabled").on(table.organizationId, table.providerInstallationId, table.enabled),
  providerDefaultIdx: uniqueIndex("idx_ai_provider_models_provider_default")
    .on(table.providerInstallationId)
    .where(sql`${table.isProviderDefault} = 1`),
}));

export const aiRuntimeDefaults = pgTable("ai_runtime_defaults", {
  organizationId: text("organization_id").primaryKey().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  providerInstallationId: text("provider_installation_id").references(() => aiProviderInstallations.id, { onDelete: 'set null' }),
  providerId: text("provider_id"),
  modelId: text("model_id"),
  thinkingLevel: text("thinking_level").notNull().default("off"),
  catalogRevision: bigint("catalog_revision", { mode: "number" }).notNull().default(0),
  migrationState: text("migration_state").notNull().default("uninitialized"),
  legacySourceHash: text("legacy_source_hash"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
});

export const aiWorkspaceModelPolicies = pgTable("ai_workspace_model_policies", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").primaryKey().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  allowedModelsJson: text("allowed_models_json"),
  defaultProviderInstallationId: text("default_provider_installation_id"),
  defaultProviderId: text("default_provider_id"),
  defaultModelId: text("default_model_id"),
  defaultThinkingLevel: text("default_thinking_level"),
  allowUserCredentials: pgBoolean("allow_user_credentials").notNull().default(false),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  organizationIdx: index("idx_ai_workspace_model_policies_org").on(table.organizationId),
}));

export const aiUserModelPreferences = pgTable("ai_user_model_preferences", {
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  agentId: text("agent_id").notNull().default(MAIN_AGENT_ID),
  providerInstallationId: text("provider_installation_id").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  thinkingLevel: text("thinking_level").notNull().default("off"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.userId, table.workspaceId, table.agentId),
  organizationUserIdx: index("idx_ai_user_model_preferences_org_user").on(table.organizationId, table.userId),
  workspaceIdx: index("idx_ai_user_model_preferences_workspace").on(table.workspaceId),
}));

export const aiUserWorkspaceProviderGrants = pgTable("ai_user_workspace_provider_grants", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  workspaceId: text("workspace_id").notNull().references(() => canvasWorkspaces.id, { onDelete: 'cascade' }),
  agentId: text("agent_id").notNull(),
  providerInstallationId: text("provider_installation_id").notNull().references(() => aiProviderInstallations.id, { onDelete: 'cascade' }),
  allowedExecutionModesJson: text("allowed_execution_modes_json").notNull().default('["interactive"]'),
  status: text("status").notNull().default("active"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  grantedAt: pgTimestamp("granted_at").notNull(),
  revokedAt: pgTimestamp("revoked_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  bindingIdx: uniqueIndex("idx_ai_user_workspace_provider_grants_binding")
    .on(table.userId, table.workspaceId, table.agentId, table.providerInstallationId),
  organizationUserIdx: index("idx_ai_user_workspace_provider_grants_org_user")
    .on(table.organizationId, table.userId, table.status),
  workspaceIdx: index("idx_ai_user_workspace_provider_grants_workspace")
    .on(table.workspaceId, table.status),
  statusCheck: check("ai_user_workspace_provider_grants_status_check", sql`${table.status} IN ('active', 'revoked')`),
}));

export const aiSessions = pgTable("ai_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  model: text("model").notNull(), // agent id, e.g. 'claude', 'codex', 'openrouter', 'ollama'
  title: text("title"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  userCreatedIdx: index("idx_ai_sessions_user_created").on(table.userId, table.createdAt),
  userSessionIdx: index("idx_ai_sessions_user_session").on(table.userId, table.sessionId),
}));

export const aiMessages = pgTable("ai_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  aiSessionDbId: bigint("ai_session_db_id", { mode: "number" }).notNull().references(() => aiSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'system'
  content: text("content").notNull(),
  type: text("type"),
  attachments: text("attachments"), // JSON string
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  sessionCreatedIdx: index("idx_ai_messages_session_created").on(table.aiSessionDbId, table.createdAt, table.id),
}));

export const piSessions = pgTable("pi_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull(),
  clientRequestId: text("client_request_id"),
  userId: text("user_id").notNull().references(() => user.id),
  agentId: text("agent_id").notNull().default(MAIN_AGENT_ID),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level"),
  title: text("title"),
  titleGenerationState: text("title_generation_state"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  summaryText: text("summary_text"),
  summaryUpdatedAt: pgTimestamp("summary_updated_at"),
  summaryThroughTimestamp: bigint("summary_through_timestamp", { mode: "number" }),
  summaryThroughSequence: bigint("summary_through_sequence", { mode: "number" }),
  summaryRevision: bigint("summary_revision", { mode: "number" }).notNull().default(0),
  systemPromptSnapshot: text("system_prompt_snapshot"),
  systemPromptSnapshotHash: text("system_prompt_snapshot_hash"),
  systemPromptSnapshotCreatedAt: pgTimestamp("system_prompt_snapshot_created_at"),
  lastMessageAt: pgTimestamp("last_message_at"),
  lastViewedAt: pgTimestamp("last_viewed_at"),
  archivedAt: pgTimestamp("archived_at"),
  channelId: text("channel_id").notNull().default('app'),
  channelSessionKey: text("channel_session_key"),
  sessionKind: text("session_kind").notNull().default('conversation'),
  parentSessionId: text("parent_session_id"),
  forkedFromSessionId: text("forked_from_session_id"),
  forkedFromSequence: bigint("forked_from_sequence", { mode: "number" }),
  delegationId: text("delegation_id"),
  delegationDepth: bigint("delegation_depth", { mode: "number" }).notNull().default(0),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id"),
  workspaceType: text("workspace_type"),
  workspaceName: text("workspace_name"),
  workspaceRootRelativePath: text("workspace_root_relative_path"),
  runtimeProviderInstallationId: text("runtime_provider_installation_id"),
  runtimeCatalogRevision: bigint("runtime_catalog_revision", { mode: "number" }),
  runtimePolicyRevision: bigint("runtime_policy_revision", { mode: "number" }),
  runtimeSelectionSource: text("runtime_selection_source"),
}, (table) => ({
  channelIdx: index("idx_pi_sessions_channel").on(table.channelId, table.channelSessionKey),
  userCreatedIdx: index("idx_pi_sessions_user_created").on(table.userId, table.createdAt),
  userSessionIdx: uniqueIndex("idx_pi_sessions_user_session").on(table.userId, table.sessionId),
  userChannelIdx: index("idx_pi_sessions_user_channel_created").on(table.userId, table.channelId, table.createdAt),
  agentIdx: index("idx_pi_sessions_agent").on(table.agentId),
  workspaceIdx: index("idx_pi_sessions_workspace").on(table.workspaceId),
  projectIdx: index("idx_pi_sessions_project").on(table.projectId, table.lastMessageAt),
  userWorkspaceCreatedIdx: index("idx_pi_sessions_user_workspace_created").on(table.userId, table.workspaceId, table.createdAt),
  userWorkspaceArchivedIdx: index("idx_pi_sessions_user_workspace_archived").on(table.userId, table.workspaceId, table.archivedAt),
  userKindCreatedIdx: index("idx_pi_sessions_user_kind_created").on(table.userId, table.sessionKind, table.createdAt),
  delegationIdx: index("idx_pi_sessions_delegation").on(table.userId, table.delegationId),
  sessionKindCheck: check("pi_sessions_session_kind_check", sql`${table.sessionKind} IN ('conversation', 'delegation_worker')`),
  delegationDepthCheck: check("pi_sessions_delegation_depth_check", sql`${table.delegationDepth} IN (0, 1)`),
}));

export const piSessionCompactionAttempts = pgTable("pi_session_compaction_attempts", {
  id: text("id").primaryKey(),
  piSessionDbId: bigint("pi_session_db_id", { mode: "number" }).notNull().references(() => piSessions.id, { onDelete: "cascade" }),
  attemptOrdinal: bigint("attempt_ordinal", { mode: "number" }).notNull().default(0),
  trigger: text("trigger").notNull(),
  state: text("state").notNull(),
  reasonCode: text("reason_code"),
  baseSummaryRevision: bigint("base_summary_revision", { mode: "number" }).notNull(),
  committedSummaryRevision: bigint("committed_summary_revision", { mode: "number" }),
  baseThroughSequence: bigint("base_through_sequence", { mode: "number" }),
  committedThroughSequence: bigint("committed_through_sequence", { mode: "number" }),
  messageSequenceCheckpoint: bigint("message_sequence_checkpoint", { mode: "number" }).notNull(),
  contractFingerprint: text("contract_fingerprint"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  beforeEstimatedTokens: bigint("before_estimated_tokens", { mode: "number" }),
  afterEstimatedTokens: bigint("after_estimated_tokens", { mode: "number" }),
  beforeEstimatedBytes: bigint("before_estimated_bytes", { mode: "number" }),
  afterEstimatedBytes: bigint("after_estimated_bytes", { mode: "number" }),
  protectedUnitCount: bigint("protected_unit_count", { mode: "number" }),
  summarizedUnitCount: bigint("summarized_unit_count", { mode: "number" }),
  omittedUnitCount: bigint("omitted_unit_count", { mode: "number" }),
  startedAt: pgTimestamp("started_at").notNull(),
  deadlineAt: pgTimestamp("deadline_at").notNull(),
  completedAt: pgTimestamp("completed_at"),
  retryAt: pgTimestamp("retry_at"),
  idleDeadlineAt: pgTimestamp("idle_deadline_at"),
  lastProgressAt: pgTimestamp("last_progress_at"),
  progressEventCount: bigint("progress_event_count", { mode: "number" }).notNull().default(0),
  durationMs: bigint("duration_ms", { mode: "number" }),
  telemetryJson: text("telemetry_json"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  sessionStartedIdx: index("idx_pi_compaction_attempts_session_started").on(table.piSessionDbId, table.startedAt),
  sessionOrdinalIdx: uniqueIndex("idx_pi_compaction_attempts_session_ordinal").on(table.piSessionDbId, table.attemptOrdinal),
  stateDeadlineIdx: index("idx_pi_compaction_attempts_state_deadline").on(table.state, table.deadlineAt),
  activeSessionIdx: uniqueIndex("idx_pi_compaction_attempts_active_session")
    .on(table.piSessionDbId)
    .where(sql`${table.state} = 'running'`),
  triggerCheck: check("pi_compaction_attempts_trigger_check", sql`${table.trigger} IN ('automatic', 'manual', 'automation')`),
  stateCheck: check("pi_compaction_attempts_state_check", sql`${table.state} IN ('running', 'succeeded', 'no_op', 'deferred', 'failed', 'aborted', 'stale', 'timed_out')`),
}));

export const piDelegations = pgTable("pi_delegations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  sourceSessionId: text("source_session_id").notNull(),
  sourceAgentId: text("source_agent_id").notNull(),
  workerSessionId: text("worker_session_id").notNull(),
  requestedSessionId: text("requested_session_id"),
  targetAgentId: text("target_agent_id"),
  workerType: text("worker_type").notNull(),
  goal: text("goal").notNull(),
  context: text("context"),
  workerRole: text("worker_role"),
  toolsetsJson: text("toolsets_json").notNull().default("[]"),
  status: text("status").notNull().default("queued"),
  resultStatus: text("result_status"),
  resultText: text("result_text"),
  errorText: text("error_text"),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  deliveryErrorText: text("delivery_error_text"),
  attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
  cancelRequestedAt: pgTimestamp("cancel_requested_at"),
  startedAt: pgTimestamp("started_at"),
  completedAt: pgTimestamp("completed_at"),
  deliveredAt: pgTimestamp("delivered_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userCreatedIdx: index("idx_pi_delegations_user_created").on(table.userId, table.createdAt),
  sourceSessionIdx: index("idx_pi_delegations_source_session").on(table.userId, table.sourceSessionId, table.createdAt),
  statusCreatedIdx: index("idx_pi_delegations_status_created").on(table.status, table.createdAt),
  deliveryIdx: index("idx_pi_delegations_delivery").on(table.deliveryStatus, table.completedAt),
  workerSessionIdx: index("idx_pi_delegations_worker_session").on(table.userId, table.workerSessionId),
  workerTypeCheck: check("pi_delegations_worker_type_check", sql`${table.workerType} IN ('ephemeral', 'managed')`),
  statusCheck: check("pi_delegations_status_check", sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`),
  deliveryStatusCheck: check("pi_delegations_delivery_status_check", sql`${table.deliveryStatus} IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')`),
}));

export const agents = pgTable("agents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  agentId: text("agent_id").notNull().unique(),
  name: text("name").notNull(),
  iconId: text("icon_id").notNull().default("bot"),
  type: text("type").notNull().default('main'),
  removable: pgBoolean("removable").notNull().default(false),
  defaultProviderInstallationId: text("default_provider_installation_id"),
  defaultProvider: text("default_provider"),
  defaultModel: text("default_model"),
  defaultThinking: text("default_thinking"),
  enabledToolsJson: text("enabled_tools_json"),
  relevantSkillsJson: text("relevant_skills_json"),
  relevantConnectionsJson: text("relevant_connections_json"),
  accessPolicy: text("access_policy").notNull().default("legacy"),
  scopeType: text("scope_type").notNull().default("user"),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: 'cascade' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  agentIdIdx: uniqueIndex("idx_agents_agent_id").on(table.agentId),
  organizationScopeIdx: index("idx_agents_organization_scope").on(table.organizationId, table.scopeType, table.updatedAt),
  ownerScopeIdx: index("idx_agents_owner_scope").on(table.ownerUserId, table.scopeType, table.updatedAt),
}));

export const agentMembers = pgTable("agent_members", {
  agentId: text("agent_id").notNull().references(() => agents.agentId, { onDelete: 'cascade' }),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("active"),
  canUse: pgBoolean("can_use").notNull().default(true),
  canEdit: pgBoolean("can_edit").notNull().default(false),
  canManage: pgBoolean("can_manage").notNull().default(false),
  invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.agentId, table.userId),
  organizationUserIdx: index("idx_agent_members_org_user").on(table.organizationId, table.userId, table.status),
  agentStatusIdx: index("idx_agent_members_agent_status").on(table.agentId, table.status),
}));

export const agentGrants = pgTable("agent_grants", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.agentId, { onDelete: 'cascade' }),
  organizationId: text("organization_id").notNull().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  canUse: pgBoolean("can_use").notNull().default(true),
  canEdit: pgBoolean("can_edit").notNull().default(false),
  canManage: pgBoolean("can_manage").notNull().default(false),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  bindingIdx: uniqueIndex("idx_agent_grants_binding").on(table.agentId, table.targetType, table.targetId),
  organizationTargetIdx: index("idx_agent_grants_org_target").on(table.organizationId, table.targetType, table.targetId),
  agentIdx: index("idx_agent_grants_agent").on(table.agentId, table.updatedAt),
  targetTypeCheck: check("agent_grants_target_type_check", sql`${table.targetType} IN ('organization', 'role', 'workspace', 'project', 'user')`),
}));

export const agentCapabilityBindings = pgTable("agent_capability_bindings", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.agentId, { onDelete: 'cascade' }),
  resourceType: text("resource_type").notNull(),
  scopeType: text("scope_type").notNull(),
  resourceId: text("resource_id").notNull(),
  name: text("name").notNull(),
  version: text("version"),
  requirement: text("requirement").notNull().default("optional"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  bindingIdx: uniqueIndex("idx_agent_capability_bindings_binding").on(table.agentId, table.resourceType, table.resourceId),
  agentTypeIdx: index("idx_agent_capability_bindings_agent_type").on(table.agentId, table.resourceType),
  resourceIdx: index("idx_agent_capability_bindings_resource").on(table.resourceType, table.resourceId),
  resourceTypeCheck: check("agent_capability_bindings_resource_type_check", sql`${table.resourceType} IN ('skill', 'plugin', 'connection')`),
  scopeTypeCheck: check("agent_capability_bindings_scope_type_check", sql`${table.scopeType} IN ('system', 'organization', 'user')`),
  requirementCheck: check("agent_capability_bindings_requirement_check", sql`${table.requirement} IN ('optional', 'required')`),
}));

export const agentUserPreferences = pgTable("agent_user_preferences", {
  agentId: text("agent_id").notNull().references(() => agents.agentId, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  preferencesJson: text("preferences_json").notNull().default("{}"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.agentId, table.userId),
  userIdx: index("idx_agent_user_preferences_user").on(table.userId, table.updatedAt),
}));

export const piMessages = pgTable("pi_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  piSessionDbId: bigint("pi_session_db_id", { mode: "number" }).notNull().references(() => piSessions.id),
  role: text("role").notNull(), // 'user', 'assistant', 'toolResult'
  content: text("content").notNull(), // Full JSON of Message object
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
}, (table) => ({
  sessionTimestampIdx: index("idx_pi_messages_session_timestamp").on(table.piSessionDbId, table.timestamp, table.id),
  sessionSequenceIdx: index("idx_pi_messages_session_sequence").on(table.piSessionDbId, table.sequence, table.id),
}));

export const memoryUserSettings = pgTable("memory_user_settings", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  automaticMemoryEnabled: pgBoolean("automatic_memory_enabled").notNull().default(false),
  automaticMemoryEnabledAt: pgTimestamp("automatic_memory_enabled_at"),
  automaticMemoryDisabledAt: pgTimestamp("automatic_memory_disabled_at"),
  settingsRevision: bigint("settings_revision", { mode: "number" }).notNull().default(1),
  providerInstallationId: text("provider_installation_id"),
  modelId: text("model_id"),
  memoryPromptMaxTokens: bigint("memory_prompt_max_tokens", { mode: "number" }).notNull().default(2_000),
  sensitiveMemoryEnabled: pgBoolean("sensitive_memory_enabled").notNull().default(false),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  modelIdx: index("idx_memory_user_settings_provider_model").on(table.providerInstallationId, table.modelId),
  promptBudgetCheck: check("memory_user_settings_prompt_budget_check", sql`${table.memoryPromptMaxTokens} >= 0 AND ${table.memoryPromptMaxTokens} <= 4000`),
}));

export const memoryReviewRuntimeSettings = pgTable("memory_review_runtime_settings", {
  organizationId: text("organization_id").primaryKey().references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  providerInstallationId: text("provider_installation_id").notNull(),
  modelId: text("model_id").notNull(),
  verifiedCatalogRevision: bigint("verified_catalog_revision", { mode: "number" }).notNull(),
  verifiedAt: pgTimestamp("verified_at").notNull(),
  configuredByUserId: text("configured_by_user_id").notNull().references(() => user.id, { onDelete: 'restrict' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  providerModelIdx: index("idx_memory_review_runtime_provider_model").on(table.providerInstallationId, table.modelId),
  verifiedIdx: index("idx_memory_review_runtime_verified").on(table.verifiedAt, table.verifiedCatalogRevision),
}));

export const memoryCollections = pgTable("memory_collections", {
  id: text("id").primaryKey(),
  scopeType: text("scope_type").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: 'cascade' }),
  agentId: text("agent_id"),
  organizationId: text("organization_id"),
  workspaceId: text("workspace_id"),
  category: text("category").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  sensitivity: text("sensitivity").notNull().default('standard'),
  status: text("status").notNull().default('active'),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userScopeIdx: index("idx_memory_collections_user_scope").on(table.userId, table.scopeType, table.status, table.updatedAt),
  agentScopeIdx: index("idx_memory_collections_agent_scope").on(table.userId, table.agentId, table.status, table.updatedAt),
  workspaceScopeIdx: index("idx_memory_collections_workspace_scope").on(table.workspaceId, table.status, table.updatedAt),
  organizationScopeIdx: index("idx_memory_collections_organization_scope").on(table.organizationId, table.status, table.updatedAt),
  scopeTypeCheck: check("memory_collections_scope_type_check", sql`${table.scopeType} IN ('user', 'agent', 'workspace', 'organization')`),
  sensitivityCheck: check("memory_collections_sensitivity_check", sql`${table.sensitivity} IN ('standard', 'sensitive')`),
  statusCheck: check("memory_collections_status_check", sql`${table.status} IN ('active', 'archived')`),
  revisionCheck: check("memory_collections_revision_check", sql`${table.revision} >= 1`),
}));

export const memoryEntries = pgTable("memory_entries", {
  id: text("id").primaryKey(),
  collectionId: text("collection_id").notNull().references(() => memoryCollections.id, { onDelete: 'cascade' }),
  semanticKey: text("semantic_key"),
  content: text("content").notNull(),
  normalizedContentHash: text("normalized_content_hash").notNull(),
  status: text("status").notNull().default('pending'),
  archivedFromStatus: text("archived_from_status"),
  priority: bigint("priority", { mode: "number" }).notNull().default(50),
  pinned: pgBoolean("pinned").notNull().default(false),
  sensitivity: text("sensitivity").notNull().default('standard'),
  confidence: real("confidence"),
  estimatedTokens: bigint("estimated_tokens", { mode: "number" }).notNull(),
  sourceSessionId: text("source_session_id"),
  sourceMessageId: bigint("source_message_id", { mode: "number" }),
  sourceAgentId: text("source_agent_id"),
  createdByActorType: text("created_by_actor_type").notNull(),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  lastConfirmedAt: pgTimestamp("last_confirmed_at"),
  lastUsedAt: pgTimestamp("last_used_at"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  collectionStatusIdx: index("idx_memory_entries_collection_status").on(table.collectionId, table.status, table.priority, table.updatedAt),
  semanticKeyIdx: index("idx_memory_entries_collection_semantic_key").on(table.collectionId, table.semanticKey),
  sourceMessageIdx: index("idx_memory_entries_source_message").on(table.sourceSessionId, table.sourceMessageId),
  contentHashIdx: index("idx_memory_entries_collection_content_hash").on(table.collectionId, table.normalizedContentHash),
  statusCheck: check("memory_entries_status_check", sql`${table.status} IN ('pending', 'published', 'archived')`),
  archivedFromStatusCheck: check("memory_entries_archived_from_status_check", sql`${table.archivedFromStatus} IS NULL OR ${table.archivedFromStatus} IN ('pending', 'published')`),
  priorityCheck: check("memory_entries_priority_check", sql`${table.priority} >= 0 AND ${table.priority} <= 100`),
  sensitivityCheck: check("memory_entries_sensitivity_check", sql`${table.sensitivity} IN ('standard', 'sensitive')`),
  confidenceCheck: check("memory_entries_confidence_check", sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`),
  estimatedTokensCheck: check("memory_entries_estimated_tokens_check", sql`${table.estimatedTokens} >= 0`),
  revisionCheck: check("memory_entries_revision_check", sql`${table.revision} >= 1`),
}));

export const memoryApprovalReadStates = pgTable("memory_approval_read_states", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  entryId: text("entry_id").notNull().references(() => memoryEntries.id, { onDelete: "cascade" }),
  readAt: pgTimestamp("read_at").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.entryId] }),
  userReadIdx: index("idx_memory_approval_read_user").on(table.userId, table.readAt),
}));

export const memoryEvents = pgTable("memory_events", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull().references(() => memoryEntries.id, { onDelete: 'cascade' }),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: 'set null' }),
  sessionId: text("session_id"),
  sourceMessageId: bigint("source_message_id", { mode: "number" }),
  decisionCode: text("decision_code"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  entryCreatedIdx: index("idx_memory_events_entry_created").on(table.entryId, table.createdAt),
  sessionCreatedIdx: index("idx_memory_events_session_created").on(table.sessionId, table.createdAt),
}));

export const memoryLegacyImports = pgTable("memory_legacy_imports", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  agentId: text("agent_id").notNull(),
  fileName: text("file_name").notNull(),
  contentHash: text("content_hash").notNull(),
  entriesImported: bigint("entries_imported", { mode: "number" }).notNull().default(0),
  entriesSkipped: bigint("entries_skipped", { mode: "number" }).notNull().default(0),
  completedAt: pgTimestamp("completed_at").notNull(),
}, (table) => ({
  scopeIdx: index("idx_memory_legacy_imports_scope").on(table.userId, table.agentId, table.fileName, table.completedAt),
  sourceUnique: uniqueIndex("memory_legacy_imports_source_unique").on(table.userId, table.agentId, table.fileName, table.contentHash),
}));

export const memoryReviewJobs = pgTable("memory_review_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  sessionId: text("session_id").notNull(),
  sourceAssistantMessageId: bigint("source_assistant_message_id", { mode: "number" }),
  fromMessageSequence: bigint("from_message_sequence", { mode: "number" }).notNull(),
  throughMessageSequence: bigint("through_message_sequence", { mode: "number" }).notNull(),
  triggerType: text("trigger_type").notNull(),
  scheduledFor: pgTimestamp("scheduled_for"),
  status: text("status").notNull().default('scheduled'),
  attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
  leaseUntil: pgTimestamp("lease_until"),
  errorCode: text("error_code"),
  responseJson: text("response_json"),
  responseHash: text("response_hash"),
  responseRecordedAt: pgTimestamp("response_recorded_at"),
  resultJson: text("result_json"),
  failedAt: pgTimestamp("failed_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  startedAt: pgTimestamp("started_at"),
  completedAt: pgTimestamp("completed_at"),
}, (table) => ({
  sessionRangeIdx: uniqueIndex("idx_memory_review_jobs_session_range")
    .on(table.userId, table.sessionId, table.fromMessageSequence, table.throughMessageSequence),
  readyIdx: index("idx_memory_review_jobs_ready").on(table.status, table.scheduledFor, table.leaseUntil),
  userSessionIdx: index("idx_memory_review_jobs_user_session").on(table.userId, table.sessionId, table.createdAt),
  organizationStatusIdx: index("idx_memory_review_jobs_organization_status").on(table.organizationId, table.status, table.scheduledFor),
  triggerCheck: check("memory_review_jobs_trigger_check", sql`${table.triggerType} IN ('turn_interval', 'idle', 'session_close', 'maintenance')`),
  statusCheck: check("memory_review_jobs_status_check", sql`${table.status} IN ('scheduled', 'awaiting_model_configuration', 'queued', 'running', 'retry_wait', 'completed', 'failed')`),
  sequenceRangeCheck: check("memory_review_jobs_sequence_range_check", sql`${table.fromMessageSequence} >= 1 AND ${table.throughMessageSequence} >= ${table.fromMessageSequence}`),
  attemptsCheck: check("memory_review_jobs_attempts_check", sql`${table.attempts} >= 0`),
}));

export const piUsageEvents = pgTable("pi_usage_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  fingerprint: text("fingerprint").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id"),
  workspaceType: text("workspace_type"),
  agentId: text("agent_id").notNull().default(MAIN_AGENT_ID),
  sessionId: text("session_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  sessionTitleSnapshot: text("session_title_snapshot"),
  assistantTimestamp: bigint("assistant_timestamp", { mode: "number" }).notNull(),
  stopReason: text("stop_reason").notNull(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
  totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
  inputCost: real("input_cost").notNull(),
  outputCost: real("output_cost").notNull(),
  cacheReadCost: real("cache_read_cost").notNull(),
  cacheWriteCost: real("cache_write_cost").notNull(),
  totalCost: real("total_cost").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  userCreatedIdx: index("idx_pi_usage_events_user_created_at").on(table.userId, table.createdAt),
  sessionCreatedIdx: index("idx_pi_usage_events_session_created_at").on(table.sessionId, table.createdAt),
  providerCreatedIdx: index("idx_pi_usage_events_provider_created_at").on(table.provider, table.createdAt),
  modelCreatedIdx: index("idx_pi_usage_events_model_created_at").on(table.model, table.createdAt),
  userAssistantTimestampIdx: index("idx_pi_usage_events_user_assistant_timestamp").on(table.userId, table.assistantTimestamp),
  sessionAssistantTimestampIdx: index("idx_pi_usage_events_session_assistant_timestamp").on(table.sessionId, table.assistantTimestamp),
  providerAssistantTimestampIdx: index("idx_pi_usage_events_provider_assistant_timestamp").on(table.provider, table.assistantTimestamp),
  modelAssistantTimestampIdx: index("idx_pi_usage_events_model_assistant_timestamp").on(table.model, table.assistantTimestamp),
  organizationWorkspaceIdx: index("idx_pi_usage_events_org_workspace").on(table.organizationId, table.workspaceId, table.assistantTimestamp),
  projectIdx: index("idx_pi_usage_events_project").on(table.projectId, table.assistantTimestamp),
  userWorkspaceIdx: index("idx_pi_usage_events_user_workspace").on(table.userId, table.workspaceId, table.assistantTimestamp),
  agentIdx: index("idx_pi_usage_events_agent").on(table.agentId, table.assistantTimestamp),
}));

export const todoCategories = pgTable("todo_categories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  sortOrder: bigint("sort_order", { mode: "number" }).notNull().default(0),
  isArchived: pgBoolean("is_archived").notNull().default(false),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userSortIdx: index("idx_todo_categories_user_sort").on(table.userId, table.sortOrder),
  userArchivedIdx: index("idx_todo_categories_user_archived").on(table.userId, table.isArchived),
}));

export const todoItems = pgTable("todo_items", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  createdByUserId: text("created_by_user_id").references(() => user.id),
  assigneeUserId: text("assignee_user_id").references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default("personal"),
  scopeKind: text("scope_kind").notNull().default("user"),
  categoryId: text("category_id").references(() => todoCategories.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  iconKey: text("icon_key"),
  dueAt: pgTimestamp("due_at"),
  remindAt: pgTimestamp("remind_at"),
  reminderSentAt: pgTimestamp("reminder_sent_at"),
  reminderError: text("reminder_error"),
  sourceType: text("source_type").notNull().default("user"),
  sourceAgentId: text("source_agent_id"),
  sourceSessionId: text("source_session_id"),
  seenAt: pgTimestamp("seen_at"),
  completedAt: pgTimestamp("completed_at"),
  completionComment: text("completion_comment"),
  followUpSentAt: pgTimestamp("follow_up_sent_at"),
  followUpError: text("follow_up_error"),
  emailNotificationSentAt: pgTimestamp("email_notification_sent_at"),
  emailNotificationError: text("email_notification_error"),
  archivedAt: pgTimestamp("archived_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userStatusUpdatedIdx: index("idx_todo_items_user_status_updated").on(table.userId, table.status, table.updatedAt),
  userDueIdx: index("idx_todo_items_user_due").on(table.userId, table.dueAt),
  reminderDueIdx: index("idx_todo_items_reminder_due").on(table.status, table.remindAt, table.reminderSentAt),
  userSeenIdx: index("idx_todo_items_user_seen").on(table.userId, table.seenAt),
  sourceSessionIdx: index("idx_todo_items_source_session").on(table.userId, table.sourceSessionId),
  orgWorkspaceStatusIdx: index("idx_todo_items_org_workspace_status").on(table.organizationId, table.workspaceId, table.status, table.updatedAt),
  scopeWorkspaceStatusIdx: index("idx_todo_items_scope_workspace_status").on(table.scopeKind, table.workspaceId, table.status, table.updatedAt),
  projectStatusIdx: index("idx_todo_items_project_status").on(table.projectId, table.status, table.updatedAt),
  assigneeStatusIdx: index("idx_todo_items_assignee_status").on(table.assigneeUserId, table.status, table.updatedAt),
  categoryIdx: index("idx_todo_items_category").on(table.categoryId),
}));

export const todoReadStates = pgTable("todo_read_states", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  todoId: text("todo_id").notNull().references(() => todoItems.id, { onDelete: "cascade" }),
  readAt: pgTimestamp("read_at").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.todoId] }),
  userReadIdx: index("idx_todo_read_states_user_read").on(table.userId, table.readAt),
  todoIdx: index("idx_todo_read_states_todo").on(table.todoId),
}));

export const todoFileLinks = pgTable("todo_file_links", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull().references(() => todoItems.id),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default("personal"),
  workspacePath: text("workspace_path").notNull(),
  label: text("label"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  todoIdx: index("idx_todo_file_links_todo").on(table.todoId),
  userPathIdx: index("idx_todo_file_links_user_path").on(table.userId, table.workspacePath),
  workspacePathIdx: index("idx_todo_file_links_workspace_path").on(table.organizationId, table.workspaceId, table.workspacePath),
  projectPathIdx: index("idx_todo_file_links_project_path").on(table.projectId, table.workspacePath),
}));

export const todoEmailReplyWatchers = pgTable("todo_email_reply_watchers", {
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
  sentAt: pgTimestamp("sent_at").notNull(),
  lastCheckedAt: pgTimestamp("last_checked_at"),
  completedAt: pgTimestamp("completed_at"),
  error: text("error"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  statusCheckedIdx: index("idx_todo_email_reply_watchers_status_checked").on(table.status, table.lastCheckedAt),
  todoIdx: index("idx_todo_email_reply_watchers_todo").on(table.todoId),
  userStatusIdx: index("idx_todo_email_reply_watchers_user_status").on(table.userId, table.status),
  tokenIdx: uniqueIndex("idx_todo_email_reply_watchers_token").on(table.replyToken),
}));

export const todoEmailReplyEvents = pgTable("todo_email_reply_events", {
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
  receivedAt: pgTimestamp("received_at"),
  replyText: text("reply_text"),
  status: text("status").notNull(),
  error: text("error"),
  dispatchedAt: pgTimestamp("dispatched_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  watcherCreatedIdx: index("idx_todo_email_reply_events_watcher_created").on(table.watcherId, table.createdAt),
  todoCreatedIdx: index("idx_todo_email_reply_events_todo_created").on(table.todoId, table.createdAt),
  uniqueMessageIdx: uniqueIndex("idx_todo_email_reply_events_message").on(table.watcherId, table.accountId, table.providerMessageId),
}));

export const publicFileShares = pgTable("public_file_shares", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPreview: text("token_preview").notNull(),
  shortCode: text("short_code").unique(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id"),
  workspaceType: text("workspace_type"),
  workspaceRootRelativePath: text("workspace_root_relative_path"),
  workspacePath: text("workspace_path").notNull(),
  fileName: text("file_name").notNull(),
  fileIdentity: text("file_identity").notNull(),
  targetRevisionPolicy: text("target_revision_policy").notNull().default("latest"),
  lastKnownRevision: text("last_known_revision"),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  status: text("status").notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdByAgentId: text("created_by_agent_id"),
  sourceSessionId: text("source_session_id"),
  source: text("source").notNull().default("ui"),
  securityMode: text("security_mode").notNull().default("strict"),
  reason: text("reason"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  expiresAt: pgTimestamp("expires_at"),
  revokedAt: pgTimestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  passwordEnabled: bigint("password_enabled", { mode: "number" }).notNull().default(0),
  passwordHash: text("password_hash"),
  lastAccessedAt: pgTimestamp("last_accessed_at"),
  accessCount: bigint("access_count", { mode: "number" }).notNull().default(0),
  policyRevision: bigint("policy_revision", { mode: "number" }).notNull().default(1),
}, (table) => ({
  tokenHashIdx: uniqueIndex("idx_public_file_shares_token_hash").on(table.tokenHash),
  tokenIdx: uniqueIndex("idx_public_file_shares_token").on(table.token),
  shortCodeIdx: uniqueIndex("idx_public_file_shares_short_code").on(table.shortCode),
  statusIdx: index("idx_public_file_shares_status").on(table.status),
  pathIdx: index("idx_public_file_shares_workspace_path").on(table.workspacePath),
  workspacePathIdx: index("idx_public_file_shares_workspace_id_path").on(table.workspaceId, table.workspacePath, table.status),
  organizationStatusIdx: index("idx_public_file_shares_org_status").on(table.organizationId, table.status),
  projectStatusIdx: index("idx_public_file_shares_project_status").on(table.projectId, table.status),
  userStatusIdx: index("idx_public_file_shares_user_status").on(table.createdByUserId, table.status),
  expiresIdx: index("idx_public_file_shares_expires_at").on(table.expiresAt),
}));

export const fileGuestInvitations = pgTable('file_guest_invitations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  path: text('path').notNull(),
  documentId: text('document_id').notNull(),
  email: text('email').notNull(),
  permission: text('permission').notNull(),
  status: text('status').notNull().default('active'),
  policyRevision: bigint('policy_revision', { mode: 'number' }).notNull().default(1),
  createdByUserId: text('created_by_user_id').notNull().references(() => user.id),
  assetsJson: text('assets_json').notNull().default('[]'),
  expiresAt: pgTimestamp('expires_at'),
  createdAt: pgTimestamp('created_at').notNull(),
  updatedAt: pgTimestamp('updated_at').notNull(),
  challengeId: text('challenge_id'),
  challengeHash: text('challenge_hash'),
  challengeExpiresAt: pgTimestamp('challenge_expires_at'),
  challengeAttempts: bigint('challenge_attempts', { mode: 'number' }).notNull().default(0),
  challengeSentAt: pgTimestamp('challenge_sent_at'),
  challengeWindowAt: pgTimestamp('challenge_window_at'),
  challengeSendCount: bigint('challenge_send_count', { mode: 'number' }).notNull().default(0),
}, (table) => ({
  activeEmailIdx: uniqueIndex('idx_file_guest_active_email').on(table.workspaceId, table.documentId, table.email).where(sql`${table.status} = 'active'`),
  documentIdx: index('idx_file_guest_document').on(table.documentId, table.status),
}));

export const fileGuestSessions = pgTable('file_guest_sessions', {
  id: text('id').primaryKey(),
  invitationId: text('invitation_id').notNull().references(() => fileGuestInvitations.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  displayName: text('display_name').notNull(),
  expiresAt: pgTimestamp('expires_at').notNull(),
  createdAt: pgTimestamp('created_at').notNull(),
}, (table) => ({
  invitationIdx: index('idx_file_guest_session_invitation').on(table.invitationId, table.expiresAt),
}));

export const fileGuestVersions = pgTable('file_guest_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  documentId: text('document_id').notNull(),
  lifecycleGeneration: bigint('lifecycle_generation', { mode: 'number' }).notNull(),
  documentSequence: bigint('document_sequence', { mode: 'number' }).notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: pgTimestamp('created_at').notNull(),
}, (table) => ({
  hashIdx: uniqueIndex('idx_file_guest_version_hash').on(table.documentId, table.lifecycleGeneration, table.contentHash),
  timeIdx: index('idx_file_guest_version_time').on(table.documentId, table.createdAt),
}));

export const knowledgeSources = pgTable("knowledge_sources", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  userId: text("user_id").references(() => user.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  knowledgeStore: text("knowledge_store").notNull(),
  visibility: text("visibility").notNull(),
  sourceType: text("source_type").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceTitle: text("source_title"),
  contentHash: text("content_hash"),
  parserProvider: text("parser_provider").notNull().default("native"),
  parserVersion: text("parser_version"),
  scanStatus: text("scan_status").notNull().default("pending"),
  policyDecision: text("policy_decision").notNull().default("metadata-only"),
  sourceAclVersion: bigint("source_acl_version", { mode: "number" }).notNull().default(1),
  indexVersion: bigint("index_version", { mode: "number" }).notNull().default(1),
  embeddingIndexStatus: text("embedding_index_status").notNull().default("disabled"),
  databaseProvider: text("database_provider").notNull().default("postgres"),
  metadataJson: text("metadata_json"),
  status: text("status").notNull().default("pending"),
  lastAccessCheckedAt: pgTimestamp("last_access_checked_at"),
  revokedAt: pgTimestamp("revoked_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  storeStatusIdx: index("idx_knowledge_sources_store_status").on(table.knowledgeStore, table.status),
  organizationWorkspaceIdx: index("idx_knowledge_sources_org_workspace").on(table.organizationId, table.workspaceId, table.knowledgeStore, table.status),
  projectStoreIdx: index("idx_knowledge_sources_project_store").on(table.projectId, table.knowledgeStore, table.status),
  userStoreIdx: index("idx_knowledge_sources_user_store").on(table.userId, table.knowledgeStore, table.status),
  sourcePathIdx: index("idx_knowledge_sources_workspace_path").on(table.workspaceId, table.sourcePath),
  contentHashIdx: index("idx_knowledge_sources_content_hash").on(table.contentHash),
}));

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  userId: text("user_id").references(() => user.id, { onDelete: 'set null' }),
  knowledgeStore: text("knowledge_store").notNull(),
  visibility: text("visibility").notNull(),
  chunkIndex: bigint("chunk_index", { mode: "number" }).notNull(),
  pageStart: bigint("page_start", { mode: "number" }),
  pageEnd: bigint("page_end", { mode: "number" }),
  text: text("text"),
  markdown: text("markdown"),
  metadataJson: text("metadata_json"),
  contentHash: text("content_hash"),
  scanStatus: text("scan_status").notNull().default("pending"),
  policyDecision: text("policy_decision").notNull().default("metadata-only"),
  sourceAclVersion: bigint("source_acl_version", { mode: "number" }).notNull().default(1),
  indexVersion: bigint("index_version", { mode: "number" }).notNull().default(1),
  embeddingIndexStatus: text("embedding_index_status").notNull().default("disabled"),
  revokedAt: pgTimestamp("revoked_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  sourceChunkIdx: uniqueIndex("idx_knowledge_chunks_source_chunk").on(table.sourceId, table.chunkIndex),
  organizationWorkspaceIdx: index("idx_knowledge_chunks_org_workspace").on(table.organizationId, table.workspaceId, table.knowledgeStore, table.embeddingIndexStatus),
  projectStoreIdx: index("idx_knowledge_chunks_project_store").on(table.projectId, table.knowledgeStore, table.embeddingIndexStatus),
  userStoreIdx: index("idx_knowledge_chunks_user_store").on(table.userId, table.knowledgeStore, table.embeddingIndexStatus),
  policyIdx: index("idx_knowledge_chunks_policy").on(table.policyDecision, table.scanStatus, table.embeddingIndexStatus),
  contentHashIdx: index("idx_knowledge_chunks_content_hash").on(table.contentHash),
}));

export const onboardingLog = pgTable("onboarding_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  completedAt: pgTimestamp("completed_at").notNull(),
  completedBy: text("completed_by"), // userId or null for bootstrap
  method: text("method").notNull(), // 'ui' | 'bootstrap'
  notes: text("notes"),
  createdAt: pgTimestamp("created_at").notNull(),
});

export const licenseCerts = pgTable("license_certs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  cert: text("cert").notNull(),
  plan: text("plan").notNull(),
  instanceId: text("instance_id").notNull(),
  expiresAt: pgTimestamp("expires_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  instanceIdx: index("idx_license_certs_instance").on(table.instanceId),
  instanceIdDescIdx: index("idx_license_certs_instance_id_desc").on(table.instanceId, desc(table.id)),
  instanceCertUniqueIdx: uniqueIndex("idx_license_certs_instance_cert").on(table.instanceId, table.cert),
}));

export const licensePublicKeys = pgTable("license_public_keys", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kid: text("kid"),
  publicKey: text("public_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  source: text("source").notNull().default("control_plane"),
  fetchedAt: pgTimestamp("fetched_at").notNull(),
  lastUsedAt: pgTimestamp("last_used_at"),
}, (table) => ({
  fingerprintIdx: uniqueIndex("idx_license_public_keys_fingerprint").on(table.fingerprint),
  fetchedAtIdx: index("idx_license_public_keys_fetched_at").on(table.fetchedAt),
}));

export const automationJobs = pgTable("automation_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  integrityStatus: text("integrity_status").notNull().default('valid'),
  integrityReason: text("integrity_reason"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  scope: text("scope").notNull().default('personal'),
  jobScope: text("job_scope").notNull().default('personal:legacy:legacy'),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
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
  nextRunAt: pgTimestamp("next_run_at"),
  lastRunAt: pgTimestamp("last_run_at"),
  lastRunStatus: text("last_run_status"),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  agentId: text("agent_id").notNull().default(MAIN_AGENT_ID),
  deliveryMode: text("delivery_mode").notNull().default('web'),
  deliveryChannelId: text("delivery_channel_id"),
  deliverySessionMode: text("delivery_session_mode").notNull().default('new_session'),
  deliverySessionId: text("delivery_session_id"),
  deliveryChannelSessionKey: text("delivery_channel_session_key"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  deletedAt: pgTimestamp("deleted_at"),
  deletedByUserId: text("deleted_by_user_id").references(() => user.id),
  jobType: text("job_type").notNull().default('default'),
  triggerKind: text("trigger_kind").notNull().default('schedule'),
  resultPolicy: text("result_policy").notNull().default('deliver_all'),
  eventConfigJson: text("event_config_json"),
  channelId: text("channel_id"),
  composioTriggerId: text("composio_trigger_id"),
  composioTriggerSlug: text("composio_trigger_slug"),
  composioToolkitSlug: text("composio_toolkit_slug"),
  composioConnectedAccountId: text("composio_connected_account_id"),
  composioProfileId: text("composio_profile_id").references(() => composioConnectionProfiles.id),
  composioUserId: text("composio_user_id"),
  webhookTriggerConfigJson: text("webhook_trigger_config_json"),
}, (table) => ({
  ownerScopeIdx: index("idx_automation_jobs_owner_scope").on(table.ownerUserId, table.scope),
  organizationWorkspaceIdx: index("idx_automation_jobs_org_workspace").on(table.organizationId, table.workspaceId),
  projectStatusIdx: index("idx_automation_jobs_project_status").on(table.projectId, table.status, table.nextRunAt),
  jobScopeStatusIdx: index("idx_automation_jobs_job_scope_status").on(table.jobScope, table.status, table.nextRunAt),
  integrityStatusIdx: index("idx_automation_jobs_integrity_status").on(table.integrityStatus, table.status, table.nextRunAt),
  composioTriggerIdx: uniqueIndex("idx_automation_jobs_composio_trigger_id").on(table.composioTriggerId),
  composioProfileIdx: index("idx_automation_jobs_composio_profile").on(table.responsibleUserId, table.workspaceId, table.composioProfileId),
}));

export const composioWebhookSubscriptions = pgTable("composio_webhook_subscriptions", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().unique(),
  webhookUrl: text("webhook_url").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  secretPreview: text("secret_preview"),
  eventTypes: text("event_types"),
  status: text("status").notNull().default("active"),
  mode: text("mode").notNull().default("local"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  rotatedAt: pgTimestamp("rotated_at"),
}, (table) => ({
  subscriptionIdx: uniqueIndex("idx_composio_webhook_subscriptions_subscription_id").on(table.subscriptionId),
}));

export const composioWebhookEvents = pgTable("composio_webhook_events", {
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
  receivedAt: pgTimestamp("received_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  eventIdx: uniqueIndex("idx_composio_webhook_events_event_id").on(table.eventId),
  webhookIdx: uniqueIndex("idx_composio_webhook_events_webhook_id").on(table.webhookId),
  triggerIdx: index("idx_composio_webhook_events_trigger").on(table.triggerId, table.receivedAt),
  jobIdx: index("idx_composio_webhook_events_job").on(table.jobId, table.receivedAt),
}));

export const automationWebhookTriggers = pgTable("automation_webhook_triggers", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => automationJobs.id, { onDelete: 'cascade' }),
  secretHash: text("secret_hash").notNull(),
  secretPreview: text("secret_preview").notNull(),
  status: text("status").notNull().default('active'),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
  rotatedAt: pgTimestamp("rotated_at"),
}, (table) => ({
  jobIdx: uniqueIndex("idx_automation_webhook_triggers_job").on(table.jobId),
  statusIdx: index("idx_automation_webhook_triggers_status").on(table.status),
}));

export const automationWebhookEvents = pgTable("automation_webhook_events", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull().references(() => automationWebhookTriggers.id, { onDelete: 'cascade' }),
  jobId: text("job_id").notNull().references(() => automationJobs.id, { onDelete: 'cascade' }),
  eventId: text("event_id"),
  idempotencyKey: text("idempotency_key"),
  runId: text("run_id"),
  status: text("status").notNull(),
  error: text("error"),
  metadataJson: text("metadata_json"),
  receivedAt: pgTimestamp("received_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  webhookReceivedIdx: index("idx_automation_webhook_events_webhook_received").on(table.webhookId, table.receivedAt),
  jobReceivedIdx: index("idx_automation_webhook_events_job_received").on(table.jobId, table.receivedAt),
  eventIdx: uniqueIndex("idx_automation_webhook_events_event").on(table.webhookId, table.eventId),
  idempotencyIdx: uniqueIndex("idx_automation_webhook_events_idempotency").on(table.webhookId, table.idempotencyKey),
}));

export const userHintState = pgTable("user_hint_state", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  hintKey: text("hint_key").notNull(),
  page: text("page").notNull(),
  dismissed: pgBoolean("dismissed").notNull().default(false),
  dismissedAt: pgTimestamp("dismissed_at"),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
});

export const pageOnboardingState = pgTable("page_onboarding_state", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  page: text("page").notNull(),
  completed: pgBoolean("completed").notNull().default(false),
  completedAt: pgTimestamp("completed_at"),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
});

export const mobileAppPromotionStates = pgTable("mobile_app_promotion_states", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  promotionVersion: bigint("promotion_version", { mode: "number" }).notNull().default(1),
  impressionCount: bigint("impression_count", { mode: "number" }).notNull().default(0),
  dismissalCount: bigint("dismissal_count", { mode: "number" }).notNull().default(0),
  lastShownAt: pgTimestamp("last_shown_at"),
  dismissedUntil: pgTimestamp("dismissed_until"),
  permanentlyDismissedAt: pgTimestamp("permanently_dismissed_at"),
  ctaClickedAt: pgTimestamp("cta_clicked_at"),
  lastAction: text("last_action"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  dismissedUntilIdx: index("idx_mobile_app_promotion_dismissed_until").on(table.dismissedUntil),
}));

export const automationRuns = pgTable("automation_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => automationJobs.id),
  status: text("status").notNull(),
  scope: text("scope").notNull().default('personal'),
  jobScope: text("job_scope").notNull().default('personal:legacy:legacy'),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  workspaceType: text("workspace_type").notNull().default('personal'),
  actorType: text("actor_type").notNull().default('user'),
  actorUserId: text("actor_user_id").references(() => user.id),
  serviceActorId: text("service_actor_id"),
  triggerType: text("trigger_type").notNull(),
  scheduledFor: pgTimestamp("scheduled_for"),
  startedAt: pgTimestamp("started_at"),
  finishedAt: pgTimestamp("finished_at"),
  attemptNumber: bigint("attempt_number", { mode: "number" }).notNull(),
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
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  workspaceCreatedIdx: index("idx_automation_runs_workspace_created").on(table.workspaceId, table.createdAt),
  projectCreatedIdx: index("idx_automation_runs_project_created").on(table.projectId, table.createdAt),
  jobScopeStatusIdx: index("idx_automation_runs_job_scope_status").on(table.jobScope, table.status, table.scheduledFor),
}));

export const studioProducts = pgTable("studio_products", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  visibility: text("visibility").notNull().default('organization'),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_products_user").on(table.userId),
  organizationIdx: index("idx_studio_products_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_products_project").on(table.projectId, table.createdAt),
  workspaceIdx: index("idx_studio_products_workspace").on(table.workspaceId, table.createdAt),
  creatorIdx: index("idx_studio_products_creator").on(table.createdByUserId, table.createdAt),
  createdIdx: index("idx_studio_products_created").on(table.createdAt),
}));

export const studioProductImages = pgTable("studio_product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => studioProducts.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: bigint("file_size", { mode: "number" }),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: bigint("sort_order", { mode: "number" }).notNull(),
  width: bigint("width", { mode: "number" }),
  height: bigint("height", { mode: "number" }),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  productIdx: index("idx_studio_product_images_product").on(table.productId),
}));

export const studioPersonas = pgTable("studio_personas", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  visibility: text("visibility").notNull().default('organization'),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_personas_user").on(table.userId),
  organizationIdx: index("idx_studio_personas_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_personas_project").on(table.projectId, table.createdAt),
  workspaceIdx: index("idx_studio_personas_workspace").on(table.workspaceId, table.createdAt),
  creatorIdx: index("idx_studio_personas_creator").on(table.createdByUserId, table.createdAt),
  createdIdx: index("idx_studio_personas_created").on(table.createdAt),
}));

export const studioPersonaImages = pgTable("studio_persona_images", {
  id: text("id").primaryKey(),
  personaId: text("persona_id").notNull().references(() => studioPersonas.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: bigint("file_size", { mode: "number" }),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: bigint("sort_order", { mode: "number" }).notNull(),
  width: bigint("width", { mode: "number" }),
  height: bigint("height", { mode: "number" }),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  personaIdx: index("idx_studio_persona_images_persona").on(table.personaId),
}));

export const studioStyles = pgTable("studio_styles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  visibility: text("visibility").notNull().default('organization'),
  name: text("name").notNull(),
  description: text("description"),
  thumbnailPath: text("thumbnail_path"),
  metadata: text("metadata"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_styles_user").on(table.userId),
  organizationIdx: index("idx_studio_styles_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_styles_project").on(table.projectId, table.createdAt),
  workspaceIdx: index("idx_studio_styles_workspace").on(table.workspaceId, table.createdAt),
  creatorIdx: index("idx_studio_styles_creator").on(table.createdByUserId, table.createdAt),
  createdIdx: index("idx_studio_styles_created").on(table.createdAt),
}));

export const studioStyleImages = pgTable("studio_style_images", {
  id: text("id").primaryKey(),
  styleId: text("style_id").notNull().references(() => studioStyles.id, { onDelete: 'cascade' }),
  filePath: text("file_path").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: bigint("file_size", { mode: "number" }),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  sortOrder: bigint("sort_order", { mode: "number" }).notNull(),
  width: bigint("width", { mode: "number" }),
  height: bigint("height", { mode: "number" }),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  styleIdx: index("idx_studio_style_images_style").on(table.styleId),
}));

export const studioPresets = pgTable("studio_presets", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  visibility: text("visibility").notNull().default('user'),
  isDefault: pgBoolean("is_default").notNull().default(false),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  blocks: text("blocks").notNull(),
  previewImagePath: text("preview_image_path"),
  tags: text("tags"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_presets_user").on(table.userId),
  organizationIdx: index("idx_studio_presets_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_presets_project").on(table.projectId, table.createdAt),
  workspaceIdx: index("idx_studio_presets_workspace").on(table.workspaceId, table.createdAt),
  creatorIdx: index("idx_studio_presets_creator").on(table.createdByUserId, table.createdAt),
  categoryIdx: index("idx_studio_presets_category").on(table.category),
  createdIdx: index("idx_studio_presets_created").on(table.createdAt),
}));

export const studioGenerations = pgTable("studio_generations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  mode: text("mode").notNull(),
  prompt: text("prompt"),
  rawPrompt: text("raw_prompt"),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  studioPresetName: text("studio_preset_name"),
  aspectRatio: text("aspect_ratio").notNull().default('1:1'),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  idempotencyKey: text("idempotency_key"),
  bulkJobId: text("bulk_job_id"),
  sourceGenerationId: text("source_generation_id"),
  metadata: text("metadata"),
  status: text("status").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_generations_user").on(table.userId),
  organizationIdx: index("idx_studio_generations_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_generations_project").on(table.projectId, table.createdAt),
  creatorIdx: index("idx_studio_generations_creator").on(table.createdByUserId, table.createdAt),
  workspaceIdx: index("idx_studio_generations_workspace").on(table.workspaceId, table.createdAt),
  idempotencyIdx: uniqueIndex("idx_studio_generations_idempotency").on(table.userId, table.workspaceId, table.idempotencyKey),
  statusIdx: index("idx_studio_generations_status").on(table.status),
  createdIdx: index("idx_studio_generations_created").on(table.createdAt),
}));

export const studioGenerationOutputs = pgTable("studio_generation_outputs", {
  id: text("id").primaryKey(),
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  variationIndex: bigint("variation_index", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  filePath: text("file_path").notNull(),
  fileName: text("file_name"),
  mediaUrl: text("media_url"),
  fileSize: bigint("file_size", { mode: "number" }),
  mimeType: text("mime_type"),
  width: bigint("width", { mode: "number" }),
  height: bigint("height", { mode: "number" }),
  isFavorite: pgBoolean("is_favorite").notNull().default(false),
  metadata: text("metadata"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  generationIdx: index("idx_studio_gen_outputs_generation").on(table.generationId),
  organizationIdx: index("idx_studio_gen_outputs_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_gen_outputs_project").on(table.projectId, table.createdAt),
  creatorIdx: index("idx_studio_gen_outputs_creator").on(table.createdByUserId, table.createdAt),
  workspaceIdx: index("idx_studio_gen_outputs_workspace").on(table.workspaceId, table.createdAt),
  createdIdx: index("idx_studio_gen_outputs_created").on(table.createdAt),
}));

export const studioGenerationProducts = pgTable("studio_generation_products", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  productId: text("product_id").notNull().references(() => studioProducts.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.productId),
  generationIdx: index("idx_gen_products_generation").on(table.generationId),
  productIdx: index("idx_gen_products_product").on(table.productId),
}));

export const studioGenerationPersonas = pgTable("studio_generation_personas", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  personaId: text("persona_id").notNull().references(() => studioPersonas.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.personaId),
  generationIdx: index("idx_gen_personas_generation").on(table.generationId),
  personaIdx: index("idx_gen_personas_persona").on(table.personaId),
}));

export const studioGenerationStyles = pgTable("studio_generation_styles", {
  generationId: text("generation_id").notNull().references(() => studioGenerations.id, { onDelete: 'cascade' }),
  styleId: text("style_id").notNull().references(() => studioStyles.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey(table.generationId, table.styleId),
  generationIdx: index("idx_gen_styles_generation").on(table.generationId),
  styleIdx: index("idx_gen_styles_style").on(table.styleId),
}));

export const studioBulkJobs = pgTable("studio_bulk_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => canvasOrganizationSettings.organizationId, { onDelete: 'cascade' }),
  customerId: text("customer_id").references(() => canvasCustomers.id, { onDelete: 'set null' }),
  projectId: text("project_id").references(() => canvasProjects.id, { onDelete: 'set null' }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: 'set null' }),
  workspaceId: text("workspace_id").references(() => canvasWorkspaces.id, { onDelete: 'set null' }),
  name: text("name"),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  additionalPrompt: text("additional_prompt"),
  aspectRatio: text("aspect_ratio").notNull().default('1:1'),
  versionsPerProduct: bigint("versions_per_product", { mode: "number" }).notNull().default(1),
  status: text("status").notNull(),
  totalLineItems: bigint("total_line_items", { mode: "number" }).notNull(),
  completedLineItems: bigint("completed_line_items", { mode: "number" }).notNull().default(0),
  failedLineItems: bigint("failed_line_items", { mode: "number" }).notNull().default(0),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  userIdx: index("idx_studio_bulk_jobs_user").on(table.userId),
  organizationIdx: index("idx_studio_bulk_jobs_organization").on(table.organizationId, table.createdAt),
  projectIdx: index("idx_studio_bulk_jobs_project").on(table.projectId, table.createdAt),
  creatorIdx: index("idx_studio_bulk_jobs_creator").on(table.createdByUserId, table.createdAt),
  workspaceIdx: index("idx_studio_bulk_jobs_workspace").on(table.workspaceId, table.createdAt),
  statusIdx: index("idx_studio_bulk_jobs_status").on(table.status),
  createdIdx: index("idx_studio_bulk_jobs_created").on(table.createdAt),
}));

export const studioBulkJobLineItems = pgTable("studio_bulk_job_line_items", {
  id: text("id").primaryKey(),
  bulkJobId: text("bulk_job_id").notNull().references(() => studioBulkJobs.id, { onDelete: 'cascade' }),
  productId: text("product_id").references(() => studioProducts.id, { onDelete: 'set null' }),
  personaId: text("persona_id").references(() => studioPersonas.id, { onDelete: 'set null' }),
  styleId: text("style_id").references(() => studioStyles.id, { onDelete: 'set null' }),
  studioPresetId: text("studio_preset_id").references(() => studioPresets.id, { onDelete: 'set null' }),
  customPrompt: text("custom_prompt"),
  generationId: text("generation_id").references(() => studioGenerations.id, { onDelete: 'set null' }),
  status: text("status").notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  bulkJobIdx: index("idx_studio_bulk_job_line_items_bulk_job").on(table.bulkJobId),
  statusIdx: index("idx_studio_bulk_job_line_items_status").on(table.status),
}));

export const channelUserBindings = pgTable("channel_user_bindings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull().default('telegram'),
  channelUserId: text("channel_user_id").notNull(),
  channelUserName: text("channel_user_name"),
  metadataJson: text("metadata_json"),
  settingsJson: text("settings_json"),
  enabled: pgBoolean("enabled").notNull().default(true),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  uniqueBinding: uniqueIndex("idx_channel_user_binding").on(table.channelId, table.channelUserId),
}));

export const sessionChannelLinks = pgTable("session_channel_links", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull(),
  channelSessionKey: text("channel_session_key").notNull(),
  channelThreadKey: text("channel_thread_key").notNull().default(''),
  displayName: text("display_name"),
  isPrimary: pgBoolean("is_primary").notNull().default(false),
  deliveryPolicy: text("delivery_policy").notNull().default('last_active'),
  lastInboundAt: pgTimestamp("last_inbound_at"),
  lastOutboundAt: pgTimestamp("last_outbound_at"),
  createdAt: pgTimestamp("created_at").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  uniqueLink: uniqueIndex("idx_session_channel_links_unique").on(table.userId, table.sessionId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  sessionIdx: index("idx_session_channel_links_session").on(table.sessionId),
  userChannelIdx: index("idx_session_channel_links_user_channel").on(table.userId, table.channelId),
  userContextIdx: index("idx_session_channel_links_user_context").on(table.userId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  channelContextIdx: index("idx_session_channel_links_context").on(table.channelId, table.channelSessionKey, table.channelThreadKey),
}));

export const channelActiveSessions = pgTable("channel_active_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  agentId: text("agent_id").notNull().default(MAIN_AGENT_ID),
  channelId: text("channel_id").notNull(),
  channelSessionKey: text("channel_session_key").notNull(),
  channelThreadKey: text("channel_thread_key").notNull().default(''),
  sessionId: text("session_id").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  uniqueContext: uniqueIndex("idx_channel_active_sessions_user_context_agent").on(table.userId, table.agentId, table.channelId, table.channelSessionKey, table.channelThreadKey),
  userChannelIdx: index("idx_channel_active_sessions_user_channel").on(table.userId, table.channelId),
}));

export const channelLinkTokens = pgTable("channel_link_tokens", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  channelId: text("channel_id").notNull().default('telegram'),
  token: text("token").notNull().unique(),
  expiresAt: pgTimestamp("expires_at").notNull(),
  usedAt: pgTimestamp("used_at"),
  createdAt: pgTimestamp("created_at").notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  customerId: text("customer_id"),
  projectId: text("project_id"),
  workspaceId: text("workspace_id"),
  userId: text("user_id"),
  sessionId: text("session_id"),
  agentId: text("agent_id"),
  source: text("source").notNull(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  action: text("action").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  metadataJson: text("metadata_json"),
  inputHash: text("input_hash"),
  outputHash: text("output_hash"),
  artifactRef: text("artifact_ref"),
  secretRef: text("secret_ref"),
  secretScope: text("secret_scope"),
  createdAt: pgTimestamp("created_at").notNull(),
}, (table) => ({
  createdIdx: index("idx_audit_events_created").on(table.createdAt),
  organizationCreatedIdx: index("idx_audit_events_org_created").on(table.organizationId, table.createdAt),
  projectCreatedIdx: index("idx_audit_events_project_created").on(table.projectId, table.createdAt),
  workspaceCreatedIdx: index("idx_audit_events_workspace_created").on(table.workspaceId, table.createdAt),
  userCreatedIdx: index("idx_audit_events_user_created").on(table.userId, table.createdAt),
  entityCreatedIdx: index("idx_audit_events_entity_created").on(table.entityType, table.entityId, table.createdAt),
  sourceActionCreatedIdx: index("idx_audit_events_source_action_created").on(table.source, table.action, table.createdAt),
}));

// Short-lived, metadata-only diagnostics for the public Canvas MCP server.
// This is intentionally separate from audit_events: it is automatically
// pruned and must never contain request bodies, OAuth material, or user data.
export const directMcpRequestHistory = pgTable("direct_mcp_request_history", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  serverVersion: text("server_version"),
  flowRef: text("flow_ref"),
  phase: text("phase").notNull(),
  httpMethod: text("http_method").notNull(),
  clientName: text("client_name"),
  operation: text("operation"),
  toolName: text("tool_name"),
  outcome: text("outcome").notNull(),
  statusCode: bigint("status_code", { mode: "number" }),
  code: text("code").notNull(),
  durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
  createdAt: pgTimestamp("created_at").notNull(),
  expiresAt: pgTimestamp("expires_at").notNull(),
}, (table) => ({
  createdIdx: index("idx_direct_mcp_request_history_created").on(table.createdAt),
  expiresIdx: index("idx_direct_mcp_request_history_expires").on(table.expiresAt),
}));

export const telegramActiveSession = pgTable("telegram_active_session", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  chatId: text("chat_id").notNull(),
  sessionId: text("session_id").notNull(),
  updatedAt: pgTimestamp("updated_at").notNull(),
}, (table) => ({
  uniqueChat: uniqueIndex("idx_tg_active_session_chat").on(table.chatId),
}));
