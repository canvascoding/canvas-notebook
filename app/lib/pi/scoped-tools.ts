import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  addMemory,
  deleteMemory,
  ONBOARDING_MEMORY_CATEGORIES,
  readMemory,
  updateMemory,
  type MemoryAction,
  type OnboardingMemoryInput,
  type MemoryReadResult,
  type MemoryTarget,
} from '@/app/lib/memory/service';
import {
  assertUserOrganizationPermission,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import {
  createAutomationJob,
  deleteAutomationJob,
  getAutomationJob,
  listAutomationJobs,
  scheduleAutomationJobRun,
  updateAutomationJob,
} from '@/app/lib/automations/store';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import {
  type AutomationIntervalUnit,
  type AutomationJobRecord,
  type AutomationJobStatus,
  type AutomationWeekday,
  type FriendlySchedule,
} from '@/app/lib/automations/types';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { createMcpProxyTool } from '@/app/lib/mcp/proxy-tool';
import { createSessionSearchTool } from '@/app/lib/pi/session-search-tool';
import { createDelegateTaskTool } from '@/app/lib/pi/delegate-task-tool';
import { createHumanTodoTool } from '@/app/lib/pi/human-todo-tool';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import {
  completeOnboardingProfile,
  isOnboardingProfileToolAvailable,
  ONBOARDING_PROFILE_TOOL_NAME,
} from '@/app/lib/onboarding/profile';
import { createBrowserGatewayTool } from '@/app/lib/pi/browser/tool';
import {
  createPublicFileShares,
  listPublicFileShares,
  revokePublicFileShare,
  type PublicShareStatus,
  type PublicShareTypeFilter,
} from '@/app/lib/public-sharing/public-file-shares';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import {
  createCanvasSkillDraft,
  discardCanvasSkillDraft,
  inspectCanvasSkillForAgent,
  installCanvasSkillFromWorkspace,
  updateCanvasSkillFromWorkspace,
  type AgentSkillDraftResult,
  type AgentSkillInspection,
  type AgentSkillInstallFromWorkspaceResult,
  type AgentSkillSourceScope,
  type AgentSkillUpdateFromWorkspaceResult,
} from '@/app/lib/skills/agent-skill-workspace';
import {
  createCanvasPluginDraft,
  inspectCanvasPluginForAgent,
  installCanvasPluginFromWorkspace,
  removeCanvasPluginForAgent,
  setCanvasPluginEnabledForAgent,
  updateCanvasPluginFromWorkspace,
  type AgentPluginInspection,
  type AgentPluginDraftResult,
  type AgentPluginWorkspaceResult,
} from '@/app/lib/plugins/agent-plugin-workspace';
import { getAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { hashAuditValue, recordAuditEvent, type AuditStatus } from '@/app/lib/audit/audit-service';
import {
  createStudioGenerateImageTool,
  createStudioGenerateVideoTool,
  createStudioGenerateSoundTool,
  createStudioBulkGenerateTool,
  createStudioListProductsTool,
  createStudioListPersonasTool,
  createStudioListStylesTool,
} from '@/app/lib/pi/studio-tools';
import {
  getErrorMessage,
  normalizeOptionalString,
} from '@/app/lib/pi/tool-runtime-helpers';
import { readPathList } from '@/app/lib/pi/tool-file-formatters';

const VALID_AUTOMATION_DAYS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const VALID_AUTOMATION_INTERVAL_UNITS: AutomationIntervalUnit[] = ['minutes', 'hours', 'days'];

function formatAutomationPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 240) {
    return normalized || '(empty)';
  }
  return `${normalized.slice(0, 240)}...`;
}

function formatAutomationPromptBlock(prompt: string): string {
  return ['Prompt:', '```text', prompt, '```'].join('\n');
}

function formatAutomationJob(job: AutomationJobRecord, options: { includeFullPrompt?: boolean } = {}): string {
  const schedule = JSON.stringify(job.schedule);
  const outputPath = job.targetOutputPath || job.effectiveTargetOutputPath || 'none';
  const lines = [
    `ID: ${job.id}`,
    `Name: ${job.name}`,
    `Status: ${job.status}`,
    `Scope: ${job.scope}`,
    `Workspace: ${job.workspaceId || job.workspaceType}`,
    `Responsible user: ${job.responsibleUserId || job.createdByUserId}`,
    `Preferred skill: ${job.preferredSkill || 'auto'}`,
    `Schedule: ${schedule}`,
    `Next run: ${job.nextRunAt || 'not scheduled'}`,
    `Last run: ${job.lastRunAt || 'never'}`,
    `Last run status: ${job.lastRunStatus || 'n/a'}`,
    `Output: ${outputPath}`,
    `Context paths: ${job.workspaceContextPaths.length > 0 ? job.workspaceContextPaths.join(', ') : 'none'}`,
    `Agent ID: ${job.agentId}`,
    `Delivery: mode=${job.deliveryMode}, channel=${job.deliveryChannelId || 'none'}, sessionMode=${job.deliverySessionMode}`,
    `Updated at: ${job.updatedAt}`,
  ];

  if (options.includeFullPrompt) {
    lines.push(formatAutomationPromptBlock(job.prompt));
  } else {
    lines.push(`Prompt preview (${job.prompt.length} chars): ${formatAutomationPromptPreview(job.prompt)}`);
    lines.push('Use inspect_automation_job to read the full prompt before editing it.');
  }

  return lines.join('\n');
}

function normalizeAutomationStatus(value: string | undefined): AutomationJobStatus | undefined {
  if (!value) {
    return undefined;
  }
  return value === 'paused' ? 'paused' : value === 'active' ? 'active' : undefined;
}

function normalizeAutomationSchedule(schedule: {
  kind: string;
  date?: string;
  time?: string;
  times?: string[];
  days?: string[];
  dayOfMonth?: number;
  every?: number;
  unit?: string;
  timeZone?: string;
}, defaultTimeZone: string): FriendlySchedule {
  const timeZone = schedule.timeZone?.trim() || defaultTimeZone;

  switch (schedule.kind) {
    case 'once':
      if (!schedule.date || !schedule.time) {
        throw new Error('once schedule requires date and time.');
      }
      return { kind: 'once', date: schedule.date, time: schedule.time, timeZone };
    case 'daily': {
      const times = Array.isArray(schedule.times) && schedule.times.length > 0
        ? schedule.times.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : (schedule.time ? [schedule.time] : []);
      if (times.length === 0) {
        throw new Error('daily schedule requires at least one time.');
      }
      return { kind: 'daily', times, timeZone };
    }
    case 'weekly': {
      const days = (schedule.days || []).filter((day): day is AutomationWeekday =>
        VALID_AUTOMATION_DAYS.includes(day as AutomationWeekday),
      );
      const times = Array.isArray(schedule.times) && schedule.times.length > 0
        ? schedule.times.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : (schedule.time ? [schedule.time] : []);
      if (days.length === 0 || times.length === 0) {
        throw new Error('weekly schedule requires at least one valid day and a time.');
      }
      return { kind: 'weekly', days, times, timeZone };
    }
    case 'monthly':
      if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth! < 1 || schedule.dayOfMonth! > 31 || !schedule.time) {
        throw new Error('monthly schedule requires dayOfMonth between 1 and 31 and a time.');
      }
      return { kind: 'monthly', dayOfMonth: schedule.dayOfMonth!, time: schedule.time, timeZone };
    case 'interval':
      if (!schedule.every || !schedule.unit || !VALID_AUTOMATION_INTERVAL_UNITS.includes(schedule.unit as AutomationIntervalUnit)) {
        throw new Error('interval schedule requires every and a valid unit.');
      }
      return { kind: 'interval', every: schedule.every, unit: schedule.unit as AutomationIntervalUnit, timeZone };
    default:
      throw new Error(`Unsupported automation schedule kind: ${schedule.kind}`);
  }
}

function normalizeAutomationWorkspacePaths(paths: string[] | undefined): string[] | undefined {
  if (!paths) {
    return undefined;
  }

  const normalized = paths
    .map((entry) => entry.trim().replace(/^\/+|^\.\/+/, ''))
    .filter(Boolean)
    .slice(0, 20);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAutomationWorkspacePathsForUpdate(paths: string[] | undefined): string[] | undefined {
  if (paths === undefined) {
    return undefined;
  }

  return paths
    .map((entry) => entry.trim().replace(/^\/+|^\.\/+/, ''))
    .filter(Boolean)
    .slice(0, 20);
}

async function getUserOwnedAutomationJob(userId: string, jobId: string): Promise<AutomationJobRecord> {
  const job = await getAutomationJob(jobId);
  if (!job) {
    throw new Error(`Automation job "${jobId}" not found.`);
  }
  try {
    await assertCanAccessAutomationJob(userId, job);
  } catch {
    throw new Error(`Automation job "${jobId}" not found.`);
  }
  return job;
}

function requireToolUserId(userId: string | undefined, toolLabel: string): string {
  if (!userId) {
    throw new Error(`User ID is required for ${toolLabel}.`);
  }
  return userId;
}

function formatMemoryResult(result: MemoryReadResult): string {
  const label = `${result.target[0].toUpperCase()}${result.target.slice(1)} memory`;
  if (result.entries.length === 0) {
    return `${label} has no stored entries.`;
  }
  return [
    `${label} entries:`,
    ...result.entries.map((entry) => `- [${entry.id}] ${entry.content} (${entry.status})`),
  ].join('\n');
}

function parsePublicShareStatus(value: unknown): PublicShareStatus | 'all' {
  if (value === 'active' || value === 'revoked' || value === 'missing' || value === 'stale' || value === 'expired') {
    return value;
  }
  return 'all';
}

function parsePublicShareType(value: unknown): PublicShareTypeFilter {
  if (value === 'image' || value === 'html' || value === 'pdf' || value === 'media' || value === 'other') {
    return value;
  }
  return 'all';
}

function parsePublicShareExpiry(value: unknown): Date | null {
  if (value === null || value === 'never') return null;
  const days = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : 30;
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + Math.min(Math.trunc(days), 365) * 24 * 60 * 60 * 1000);
}

function formatPublicShares(shares: Array<{ workspacePath: string; status: string; shortUrl?: string; publicUrl: string; expiresAt: string | null; accessCount: number }>): string {
  if (shares.length === 0) return '(no public shares found)';
  return shares.map((share) => [
    `Path: ${share.workspacePath}`,
    `Status: ${share.status}`,
    `Short URL: ${share.shortUrl || share.publicUrl}`,
    share.shortUrl && share.shortUrl !== share.publicUrl ? `Long URL: ${share.publicUrl}` : null,
    `Expires: ${share.expiresAt || 'never'}`,
    `Accesses: ${share.accessCount}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function createPublicShareTool(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool {
  return {
    name: 'public_share_file',
    label: 'Managing public file links',
    description:
      'Carefully creates, lists, or revokes read-only public URLs for specific workspace files. ' +
      'Use only when the user explicitly asks to publish files publicly. Never publish folders, secrets, credentials, databases, private keys, or files that merely seem useful. ' +
      'For create, provide a concrete path or paths, a reason, and confirmPublicExposure=true.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('create'),
        Type.Literal('revoke'),
      ], { description: 'Operation to perform.' }),
      path: Type.Optional(Type.String({ description: 'Workspace-relative file path for create. Legacy /data/workspace aliases are mapped to the active workspace.' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Multiple concrete file paths for create. Folders are rejected.' })),
      shareId: Type.Optional(Type.String({ description: 'Public share ID for revoke.' })),
      status: Type.Optional(Type.String({ description: 'For list: all, active, expired, missing, stale, revoked.' })),
      type: Type.Optional(Type.String({ description: 'For list: all, image, html, pdf, media, other.' })),
      query: Type.Optional(Type.String({ description: 'For list: search by file name or workspace path.' })),
      expiresInDays: Type.Optional(Type.Number({ description: 'For create: link lifetime in days. Defaults to 30. Use 0 only if the user explicitly asks for no expiration.' })),
      reason: Type.Optional(Type.String({ description: 'Required for create: short reason the public link is needed.' })),
      confirmPublicExposure: Type.Optional(Type.Boolean({ description: 'Required true for create. Confirms the user asked to expose the file publicly.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const scopedUserId = requireToolUserId(userId, 'public_share_file');
        const p = params as {
          action?: 'list' | 'create' | 'revoke';
          path?: string;
          paths?: string[];
          shareId?: string;
          status?: string;
          type?: string;
          query?: string;
          expiresInDays?: number;
          reason?: string;
          confirmPublicExposure?: boolean;
        };

        if (p.action === 'list') {
          const shares = await listPublicFileShares({
            userId: scopedUserId,
            isAdmin: false,
            status: parsePublicShareStatus(p.status),
            type: parsePublicShareType(p.type),
            query: p.query || '',
            source: 'all',
            limit: 100,
            baseUrl: process.env.BETTER_AUTH_BASE_URL || process.env.BASE_URL || null,
          });
          return { content: [{ type: 'text', text: formatPublicShares(shares) }], details: { shares } };
        }

        if (p.action === 'revoke') {
          await assertUserOrganizationPermission(scopedUserId, 'canCreatePublicLinks', 'Public link permission required.');
          if (!p.shareId) throw new Error('shareId is required for revoke.');
          const share = await revokePublicFileShare({
            id: p.shareId,
            userId: scopedUserId,
            isAdmin: false,
            baseUrl: process.env.BETTER_AUTH_BASE_URL || process.env.BASE_URL || null,
          });
          if (!share) throw new Error(`Public share not found: ${p.shareId}`);
          clearFileTreeCache();
          return { content: [{ type: 'text', text: `Public share revoked:\n${formatPublicShares([share])}` }], details: { share } };
        }

        if (p.action === 'create') {
          await assertUserOrganizationPermission(scopedUserId, 'canCreatePublicLinks', 'Public link permission required.');
          if (p.confirmPublicExposure !== true) {
            throw new Error('Refusing to publish: confirmPublicExposure must be true after the user explicitly asks for public sharing.');
          }
          const reason = normalizeOptionalString(p.reason)?.slice(0, 500);
          if (!reason) throw new Error('reason is required for public sharing.');
          const paths = readPathList(p as Record<string, unknown>, 'path', 'paths');
          const result = await createPublicFileShares({
            paths,
            createdByUserId: scopedUserId,
            source: 'agent',
            createdByAgentId: normalizeManagedAgentId(agentId),
            sourceSessionId: sessionId ?? null,
            expiresAt: parsePublicShareExpiry(p.expiresInDays),
            reason,
            confirmPublicExposure: true,
            baseUrl: process.env.BETTER_AUTH_BASE_URL || process.env.BASE_URL || null,
          });
          clearFileTreeCache();
          const text = [
            result.shares.length > 0 ? `Created public file link(s):\n${formatPublicShares(result.shares)}` : 'No public links were created.',
            result.skipped.length > 0
              ? `Skipped:\n${result.skipped.map((item) => `- ${item.path}: ${item.reason}`).join('\n')}`
              : null,
          ].filter(Boolean).join('\n\n');
          return { content: [{ type: 'text', text }], details: result };
        }

        throw new Error('action must be list, create, or revoke.');
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
      }
    },
  };
}

function createMemoryTool(userId?: string, agentId?: string | null): AgentTool {
  return {
    name: 'memory',
    label: 'Managing memory',
    description:
      'Reads and maintains durable database-backed memory. Use the target that matches the current runtime scope. ' +
      'Use only for long-term facts, preferences, and recurring context; never store secrets, logs, temporary tasks, or session summaries. ' +
      'Write added or updated memory content in the language configured for the user account, while preserving proper names and established technical terms.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('read'),
        Type.Literal('add'),
        Type.Literal('update'),
        Type.Literal('delete'),
      ], { description: 'Memory operation to perform.' }),
      target: Type.Union([
        Type.Literal('agent'),
        Type.Literal('user'),
        Type.Literal('workspace'),
        Type.Literal('organization'),
      ], { description: 'Memory scope. Workspace and organization entries are created as pending suggestions.' }),
      id: Type.Optional(Type.String({ description: 'Required for update and delete.' })),
      content: Type.Optional(Type.String({ description: 'Required for add and update.' })),
      reason: Type.Optional(Type.String({ description: 'Optional short reason for why this memory matters.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const input = params as {
          action?: MemoryAction;
          target?: MemoryTarget;
          id?: string;
          content?: string;
          reason?: string;
        };
        const target = input.target;
        if (target !== 'agent' && target !== 'user' && target !== 'workspace' && target !== 'organization') {
          throw new Error('target must be "user", "agent", "workspace", or "organization".');
        }
        const scopedUserId = requireToolUserId(userId, 'memory');
        const executionContext = getAgentExecutionContext();
        const scope = {
          target,
          userId: scopedUserId,
          agentId,
          workspaceId: executionContext?.workspaceId,
          organizationId: executionContext?.organizationId,
        };

        if (input.action === 'read') {
          const result = await readMemory(scope);
          return { content: [{ type: 'text', text: formatMemoryResult(result) }], details: result };
        }

        if (input.action === 'add') {
          if (typeof input.content !== 'string') {
            throw new Error('content is required for add.');
          }
          const result = await addMemory({ ...scope, content: input.content });
          const prefix = result.changed ? 'Memory entry added.' : 'Memory entry already existed.';
          const managerQuery = new URLSearchParams({ tab: 'memory', scope: target });
          if (target === 'agent' && agentId) managerQuery.set('agentId', agentId);
          if (target === 'workspace' && executionContext?.workspaceId) managerQuery.set('workspaceId', executionContext.workspaceId);
          const reviewHint = target === 'workspace' || target === 'organization'
            ? ' This shared memory is a pending suggestion until a manager publishes it.'
            : '';
          return { content: [{ type: 'text', text: `${prefix}${reviewHint}\nManage it: /settings?${managerQuery.toString()}\n${formatMemoryResult(result)}` }], details: result };
        }

        if (input.action === 'update') {
          if (!input.id) {
            throw new Error('id is required for update.');
          }
          if (typeof input.content !== 'string') {
            throw new Error('content is required for update.');
          }
          const result = await updateMemory({ ...scope, id: input.id, content: input.content });
          return { content: [{ type: 'text', text: `Memory entry updated.\n${formatMemoryResult(result)}` }], details: result };
        }

        if (input.action === 'delete') {
          if (!input.id) {
            throw new Error('id is required for delete.');
          }
          const result = await deleteMemory({ ...scope, id: input.id });
          return { content: [{ type: 'text', text: `Memory entry deleted.\n${formatMemoryResult(result)}` }], details: result };
        }

        throw new Error('action must be read, add, update, or delete.');
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createOnboardingProfileTool(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool {
  return {
    name: ONBOARDING_PROFILE_TOOL_NAME,
    label: 'Saving Bradley preferences',
    description:
      'Call this tool ONCE when the onboarding conversation has gathered enough information about the user and their collaboration preferences for working with Bradley. ' +
      'It stores compact durable user facts in database-backed memory, writes Bradley collaboration preferences to SOUL.md, and completes that user profile. ' +
      'Do NOT call this tool before you have asked the user at least one question and received a real answer. ' +
      'Do NOT call this tool repeatedly. If the tool returns an error, explain the issue to the user and try once more with corrected parameters. ' +
      'After a successful call, give a brief confirmation in natural language. Do not output code, logs, or technical artifacts after the call.',
    parameters: Type.Object({
      memories: Type.Array(Type.Object({
        category: Type.Union(ONBOARDING_MEMORY_CATEGORIES.map((category) => Type.Literal(category)), {
          description: 'Memory category for this durable fact.',
        }),
        semanticKey: Type.String({
          description: 'Stable lowercase key such as profile.name or preferences.response-detail.',
          minLength: 1,
          maxLength: 120,
        }),
        content: Type.String({
          description: 'One compact, durable fact stated without secrets, temporary tasks, or session details.',
          minLength: 1,
          maxLength: 800,
        }),
        priority: Type.Optional(Type.Integer({
          description: 'Importance from 0 to 100. Use 70 when unsure.',
          minimum: 0,
          maximum: 100,
        })),
      }), {
        description: 'Atomic user memories gathered from the user answers.',
        minItems: 1,
        maxItems: 20,
      }),
      soulMd: Type.String({ description: 'Complete Markdown content for SOUL.md. Include durable communication style, formality, response detail, initiative, boundaries, and collaboration preferences. Do not define or rename Bradley\'s identity. Do not include secrets.' }),
      summary: Type.Optional(Type.String({ description: 'Short one-sentence summary of what was captured.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const scopedUserId = requireToolUserId(userId, ONBOARDING_PROFILE_TOOL_NAME);
        const available = await isOnboardingProfileToolAvailable({ userId: scopedUserId, agentId, sessionId });
        if (!available) {
          throw new Error('This tool is only available during the initial Bradley onboarding profile session.');
        }

        const input = params as {
          memories?: OnboardingMemoryInput[];
          soulMd?: string;
          summary?: string;
        };
        if (!Array.isArray(input.memories)) {
          throw new Error('memories is required.');
        }
        if (typeof input.soulMd !== 'string') {
          throw new Error('soulMd is required.');
        }
        if (!sessionId) {
          throw new Error('The onboarding session context is missing.');
        }

        const result = await completeOnboardingProfile({
          userId: scopedUserId,
          sessionId,
          memories: input.memories,
          soulMd: input.soulMd,
          summary: input.summary,
        });

        try {
          const [{ invalidatePiSystemPromptSnapshotsForUser }, { requestPiRuntimePromptRefreshForUser }] = await Promise.all([
            import('@/app/lib/pi/system-prompt-snapshot'),
            import('@/app/lib/pi/live-runtime'),
          ]);
          await invalidatePiSystemPromptSnapshotsForUser(scopedUserId);
          await requestPiRuntimePromptRefreshForUser(scopedUserId);
        } catch (error) {
          console.warn('[Onboarding] Bradley context refresh will retry on the next runtime load:', getErrorMessage(error));
        }

        return {
          content: [{
            type: 'text',
            text: 'Your Bradley preferences are saved. Next, continue with the workspace tour.',
          }],
          details: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

function requireAgentExecutionContextForTool(toolLabel: string): AgentExecutionContext {
  const context = getAgentExecutionContext();
  if (!context) {
    throw new Error(`${toolLabel} requires an active workspace-bound agent session.`);
  }
  return context;
}

async function assertAgentCanManageSkills(userId: string): Promise<void> {
  await assertUserOrganizationPermission(
    userId,
    'canSharePluginsAndSkills',
    'Plugin and skill sharing permission required.',
  );
}

async function assertOrganizationSkillSourceAvailable(
  userId: string,
  context: AgentExecutionContext,
  skillName: string,
): Promise<void> {
  if (!context.organizationId) {
    throw new Error('An organization-bound agent session is required to inspect or fork an organization skill.');
  }
  const organizationState = await readOrganizationPermissionForUser(userId);
  if (
    organizationState.organizationId !== context.organizationId
    || !organizationState.permission
    || organizationState.permission.status !== 'active'
  ) {
    throw new Error('Active membership in the workspace organization is required.');
  }
  const snapshot = await resolveEffectiveCapabilitySnapshot({
    organizationId: context.organizationId,
    userId,
    role: organizationState.permission.role,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
  });
  const candidates = snapshot.capabilities.filter((entry) => (
    entry.ref.resourceType === 'skill'
    && entry.ref.scopeType === 'organization'
    && entry.ref.name === skillName
  ));
  if (candidates.length === 0) {
    throw new Error(`Organization skill "${skillName}" is not available in this workspace.`);
  }
  const denied = candidates.find((entry) => entry.readiness === 'blocked' || entry.readiness === 'conflict');
  if (denied) {
    throw new Error(denied.blockedReason || `Organization skill "${skillName}" is not available for this user.`);
  }
}

async function recordAgentSkillToolAudit(input: {
  action: string;
  status: AuditStatus;
  skillName?: string | null;
  draftPath?: string | null;
  metadata?: Record<string, unknown>;
  error?: string;
}) {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const metadata = {
    skillName: input.skillName ?? null,
    draftPath: input.draftPath ?? null,
    workspace: {
      workspaceId: executionContext.workspaceId,
      workspaceType: executionContext.workspaceType,
      workspaceName: executionContext.workspaceName,
      workspaceRootRelativePath: executionContext.workspaceRootRelativePath,
    },
    ...input.metadata,
    error: input.error ? input.error.slice(0, 500) : null,
  };

  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'plugin',
    entityType: 'canvas_skill',
    entityId: input.skillName || input.draftPath || executionContext.workspaceId,
    action: input.action,
    status: input.status,
    summary: `Agent skill tool ${input.action} ${input.status}.`,
    metadata,
    inputHash: hashAuditValue({
      action: input.action,
      skillName: input.skillName ?? null,
      draftPath: input.draftPath ?? null,
    }),
    outputHash: hashAuditValue({
      status: input.status,
      metadata,
      error: input.error ?? null,
    }),
  }).catch((error) => {
    console.warn('[ToolRegistry] Failed to record skill tool audit:', error);
  });
}

function formatAgentSkillInspection(result: AgentSkillInspection): string {
  const lines = [
    `Skill: ${result.name}`,
    `Editable: ${result.editable ? 'yes' : 'no'}`,
    `Forkable: ${result.forkable ? 'yes' : 'no'}`,
    `Scope: ${result.scope}`,
    `Source: ${result.sourceType}`,
    result.version ? `Version: ${result.version}` : null,
    result.checksum ? `Checksum: ${result.checksum}` : null,
    result.installDir ? `Install dir: ${result.installDir}` : null,
    result.skillPath ? `SKILL.md: ${result.skillPath}` : null,
    result.reason ? `Reason: ${result.reason}` : null,
  ].filter(Boolean);
  if (result.files?.length) {
    lines.push(`Files: ${result.files.length}`);
  }
  return lines.join('\n');
}

function formatAgentSkillDraft(result: AgentSkillDraftResult): string {
  return [
    `Skill draft created: ${result.packagePath}`,
    `Draft id: ${result.draftId}`,
    `Skill: ${result.skillName}`,
    result.sourceSkillName ? `Source skill: ${result.sourceSkillName}` : null,
    result.sourceScope ? `Source scope: ${result.sourceScope}` : null,
    result.forked ? 'Mode: personal fork' : null,
    result.expectedVersion ? `Expected version: ${result.expectedVersion}` : null,
    result.expectedChecksum ? `Expected checksum: ${result.expectedChecksum}` : null,
    `Files: ${result.files.length}`,
  ].filter(Boolean).join('\n');
}

function formatAgentSkillInstall(result: AgentSkillInstallFromWorkspaceResult): string {
  return [
    `Skill installed: ${result.name}`,
    `Version: ${result.version}`,
    `Checksum: ${result.checksum}`,
    `Files imported: ${result.importedFiles}`,
    `Draft path: ${result.draftPath}`,
    `Draft cleaned: ${result.draftCleaned ? 'yes' : 'no'}`,
    result.cleanupSkippedReason ? `Cleanup skipped: ${result.cleanupSkippedReason}` : null,
  ].filter(Boolean).join('\n');
}

function formatAgentSkillUpdate(result: AgentSkillUpdateFromWorkspaceResult): string {
  return [
    `Skill updated: ${result.name}`,
    `Previous version: ${result.previousVersion}`,
    `Version: ${result.version}`,
    `Previous checksum: ${result.previousChecksum}`,
    `Checksum: ${result.checksum}`,
    `Files installed: ${result.files}`,
    `Draft path: ${result.draftPath}`,
    `Draft cleaned: ${result.draftCleaned ? 'yes' : 'no'}`,
    result.cleanupSkippedReason ? `Cleanup skipped: ${result.cleanupSkippedReason}` : null,
  ].filter(Boolean).join('\n');
}

function createAgentSkillTools(userId?: string): AgentTool[] {
  return [
    {
      name: 'inspect_canvas_skill',
      label: 'Inspecting Canvas skill',
      description: 'Inspects a personal, organization, or core Canvas skill before editing or forking. Organization and core skills are read-only and can only be copied to a differently named personal fork.',
      parameters: Type.Object({
        skillName: Type.String({ description: 'Skill name to inspect.' }),
        sourceScope: Type.Optional(Type.Union([
          Type.Literal('personal'),
          Type.Literal('organization'),
          Type.Literal('core'),
        ], { description: 'Scope to inspect. Core skill names are always resolved as core.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { skillName?: string; sourceScope?: AgentSkillSourceScope };
        try {
          const scopedUserId = requireToolUserId(userId, 'skill tools');
          await assertAgentCanManageSkills(scopedUserId);
          const context = requireAgentExecutionContextForTool('inspect_canvas_skill');
          if (p.sourceScope === 'organization') {
            await assertOrganizationSkillSourceAvailable(scopedUserId, context, p.skillName || '');
          }
          const result = await inspectCanvasSkillForAgent({
            skillName: p.skillName || '',
            sourceScope: p.sourceScope,
            scope: { userId: scopedUserId, organizationId: context.organizationId },
          });
          await recordAgentSkillToolAudit({
            action: 'skill.inspect',
            status: 'success',
            skillName: result.name,
            metadata: {
              editable: result.editable,
              forkable: result.forkable,
              scope: result.scope,
              sourceType: result.sourceType,
              version: result.version ?? null,
              checksum: result.checksum ?? null,
              files: result.files?.length ?? null,
            },
          });
          return { content: [{ type: 'text', text: formatAgentSkillInspection(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentSkillToolAudit({ action: 'skill.inspect', status: 'failure', skillName: p.skillName, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'create_canvas_skill_draft',
      label: 'Creating Canvas skill draft',
      description: 'Creates a managed workspace draft under .canvas-skill-drafts. For new skills, provide skillName, description, and optional version. For editing a personal skill or creating a differently named personal fork from a personal, organization, plugin-managed, or core skill, provide sourceSkillName and sourceScope.',
      parameters: Type.Object({
        skillName: Type.String({ description: 'Target skill name for the draft folder. For normal edits, use the same name as sourceSkillName.' }),
        description: Type.Optional(Type.String({ description: 'Description for a new skill draft.' })),
        version: Type.Optional(Type.String({ description: 'Version for a new skill draft. Defaults to 1.0.0.' })),
        sourceSkillName: Type.Optional(Type.String({ description: 'Existing skill to copy into the draft for editing or forking.' })),
        sourceScope: Type.Optional(Type.Union([
          Type.Literal('personal'),
          Type.Literal('organization'),
          Type.Literal('core'),
        ], { description: 'Scope of sourceSkillName. Defaults to personal; core names are detected automatically.' })),
        draftId: Type.Optional(Type.String({ description: 'Optional stable draft id. Defaults to a generated id.' })),
        overwrite: Type.Optional(Type.Boolean({ description: 'Overwrite an existing draft with the same draftId and skillName. Defaults to false.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as {
          skillName?: string;
          description?: string;
          version?: string;
          sourceSkillName?: string;
          sourceScope?: AgentSkillSourceScope;
          draftId?: string;
          overwrite?: boolean;
        };
        try {
          const scopedUserId = requireToolUserId(userId, 'skill tools');
          const context = requireAgentExecutionContextForTool('create_canvas_skill_draft');
          if (!context.canWrite) {
            throw new Error('Agent file writes are disabled for the active workspace.');
          }
          await assertAgentCanManageSkills(scopedUserId);
          if (p.sourceSkillName && p.sourceScope === 'organization') {
            await assertOrganizationSkillSourceAvailable(scopedUserId, context, p.sourceSkillName);
          }
          const result = await createCanvasSkillDraft({
            workspaceRoot: context.workspaceRoot,
            scope: { userId: scopedUserId, organizationId: context.organizationId },
            skillName: p.skillName || '',
            description: p.description,
            version: p.version,
            sourceSkillName: p.sourceSkillName,
            sourceScope: p.sourceScope,
            draftId: p.draftId,
            overwrite: p.overwrite,
          });
          await recordAgentSkillToolAudit({
            action: 'skill.create_draft',
            status: 'success',
            skillName: result.skillName,
            draftPath: result.packagePath,
            metadata: {
              sourceSkillName: result.sourceSkillName ?? null,
              sourceScope: result.sourceScope ?? null,
              forked: result.forked ?? false,
              expectedVersion: result.expectedVersion ?? null,
              expectedChecksum: result.expectedChecksum ?? null,
              files: result.files.length,
            },
          });
          return { content: [{ type: 'text', text: formatAgentSkillDraft(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentSkillToolAudit({
            action: 'skill.create_draft',
            status: 'failure',
            skillName: p.skillName,
            metadata: {
              sourceSkillName: p.sourceSkillName ?? null,
              sourceScope: p.sourceScope ?? null,
            },
            error: message,
          });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'install_canvas_skill_from_workspace',
      label: 'Installing Canvas skill from workspace',
      description: 'Installs a new personal Canvas skill from a workspace folder containing one complete skill package. The package must include SKILL.md and a version in agents/canvas.yaml skill.version or SKILL.md metadata.version. Managed drafts under .canvas-skill-drafts are deleted after successful install by default.',
      parameters: Type.Object({
        draftPath: Type.String({ description: 'Workspace-relative path to the skill package folder.' }),
        enable: Type.Optional(Type.Boolean({ description: 'Enable the skill after install. Defaults to true.' })),
        cleanupDraft: Type.Optional(Type.Boolean({ description: 'Delete the managed .canvas-skill-drafts draft after success. Defaults to true.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { draftPath?: string; enable?: boolean; cleanupDraft?: boolean };
        try {
          const scopedUserId = requireToolUserId(userId, 'skill tools');
          const context = requireAgentExecutionContextForTool('install_canvas_skill_from_workspace');
          if (p.cleanupDraft !== false && !context.canDelete) {
            throw new Error('Agent file deletes are disabled for the active workspace. Pass cleanupDraft=false or enable delete permission.');
          }
          await assertAgentCanManageSkills(scopedUserId);
          const result = await installCanvasSkillFromWorkspace({
            workspaceRoot: context.workspaceRoot,
            scope: { userId: scopedUserId },
            draftPath: p.draftPath || '',
            enable: p.enable,
            cleanupDraft: p.cleanupDraft,
            updatedBy: scopedUserId,
          });
          await recordAgentSkillToolAudit({
            action: 'skill.install_from_workspace',
            status: 'success',
            skillName: result.name,
            draftPath: result.draftPath,
            metadata: {
              version: result.version,
              checksum: result.checksum,
              importedFiles: result.importedFiles,
              draftCleaned: result.draftCleaned,
            },
          });
          return { content: [{ type: 'text', text: formatAgentSkillInstall(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentSkillToolAudit({
            action: 'skill.install_from_workspace',
            status: 'failure',
            draftPath: p.draftPath,
            error: message,
          });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'update_canvas_skill_from_workspace',
      label: 'Updating Canvas skill from workspace',
      description: 'Atomically replaces an existing personal Canvas skill with a complete workspace package folder. Requires expectedVersion and expectedChecksum from inspect_canvas_skill to prevent stale edits. Managed drafts under .canvas-skill-drafts are deleted after successful update by default.',
      parameters: Type.Object({
        skillName: Type.String({ description: 'Existing personal skill to update.' }),
        draftPath: Type.String({ description: 'Workspace-relative path to the edited complete skill package folder.' }),
        expectedVersion: Type.String({ description: 'Version returned by inspect_canvas_skill before editing.' }),
        expectedChecksum: Type.String({ description: 'Checksum returned by inspect_canvas_skill before editing.' }),
        enable: Type.Optional(Type.Boolean({ description: 'Enable the skill after update. Defaults to true.' })),
        cleanupDraft: Type.Optional(Type.Boolean({ description: 'Delete the managed .canvas-skill-drafts draft after success. Defaults to true.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as {
          skillName?: string;
          draftPath?: string;
          expectedVersion?: string;
          expectedChecksum?: string;
          enable?: boolean;
          cleanupDraft?: boolean;
        };
        try {
          const scopedUserId = requireToolUserId(userId, 'skill tools');
          const context = requireAgentExecutionContextForTool('update_canvas_skill_from_workspace');
          if (p.cleanupDraft !== false && !context.canDelete) {
            throw new Error('Agent file deletes are disabled for the active workspace. Pass cleanupDraft=false or enable delete permission.');
          }
          await assertAgentCanManageSkills(scopedUserId);
          const result = await updateCanvasSkillFromWorkspace({
            workspaceRoot: context.workspaceRoot,
            scope: { userId: scopedUserId },
            skillName: p.skillName || '',
            draftPath: p.draftPath || '',
            expectedVersion: p.expectedVersion || '',
            expectedChecksum: p.expectedChecksum || '',
            enable: p.enable,
            cleanupDraft: p.cleanupDraft,
            updatedBy: scopedUserId,
          });
          await recordAgentSkillToolAudit({
            action: 'skill.update_from_workspace',
            status: 'success',
            skillName: result.name,
            draftPath: result.draftPath,
            metadata: {
              previousVersion: result.previousVersion,
              version: result.version,
              previousChecksum: result.previousChecksum,
              checksum: result.checksum,
              files: result.files,
              draftCleaned: result.draftCleaned,
            },
          });
          return { content: [{ type: 'text', text: formatAgentSkillUpdate(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentSkillToolAudit({
            action: 'skill.update_from_workspace',
            status: 'failure',
            skillName: p.skillName,
            draftPath: p.draftPath,
            error: message,
          });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'discard_canvas_skill_draft',
      label: 'Discarding Canvas skill draft',
      description: 'Deletes a managed skill draft under .canvas-skill-drafts without installing it. Use this for abandoned or failed skill creation/editing work.',
      parameters: Type.Object({
        draftPath: Type.String({ description: 'Workspace-relative path to the draft id folder or skill package folder under .canvas-skill-drafts.' }),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { draftPath?: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'skill tools');
          const context = requireAgentExecutionContextForTool('discard_canvas_skill_draft');
          if (!context.canDelete) {
            throw new Error('Agent file deletes are disabled for the active workspace.');
          }
          await assertAgentCanManageSkills(scopedUserId);
          const result = await discardCanvasSkillDraft({
            workspaceRoot: context.workspaceRoot,
            draftPath: p.draftPath || '',
          });
          await recordAgentSkillToolAudit({
            action: 'skill.discard_draft',
            status: 'success',
            draftPath: result.draftPath,
            metadata: { deleted: result.deleted },
          });
          return {
            content: [{ type: 'text', text: `Skill draft discarded: ${result.draftPath}\nDeleted: ${result.deleted ? 'yes' : 'no'}` }],
            details: result,
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentSkillToolAudit({
            action: 'skill.discard_draft',
            status: 'failure',
            draftPath: p.draftPath,
            error: message,
          });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
  ];
}

async function recordAgentPluginToolAudit(input: {
  action: string;
  status: AuditStatus;
  pluginName?: string | null;
  workspacePath?: string | null;
  metadata?: Record<string, unknown>;
  error?: string;
}) {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const metadata = {
    pluginName: input.pluginName ?? null,
    workspacePath: input.workspacePath ?? null,
    workspace: {
      workspaceId: executionContext.workspaceId,
      workspaceType: executionContext.workspaceType,
      workspaceName: executionContext.workspaceName,
      workspaceRootRelativePath: executionContext.workspaceRootRelativePath,
    },
    ...input.metadata,
    error: input.error ? input.error.slice(0, 500) : null,
  };
  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'plugin',
    entityType: 'canvas_plugin',
    entityId: input.pluginName || executionContext.workspaceId,
    action: input.action,
    status: input.status,
    summary: `Agent plugin tool ${input.action} ${input.status}.`,
    metadata,
    inputHash: hashAuditValue({ action: input.action, pluginName: input.pluginName ?? null, workspacePath: input.workspacePath ?? null }),
    outputHash: hashAuditValue({ status: input.status, metadata, error: input.error ?? null }),
  }).catch((error) => {
    console.warn('[ToolRegistry] Failed to record plugin tool audit:', error);
  });
}

function formatAgentPluginInspection(result: AgentPluginInspection): string {
  return [
    `Plugin: ${result.name}`,
    `Installed: ${result.installed ? 'yes' : 'no'}`,
    result.version ? `Version: ${result.version}` : null,
    result.enabled !== undefined ? `Enabled: ${result.enabled ? 'yes' : 'no'}` : null,
    result.checksum ? `Checksum: ${result.checksum}` : null,
    result.description ? `Description: ${result.description}` : null,
    result.skills?.length ? `Skills: ${result.skills.join(', ')}` : null,
    result.reason ? `Reason: ${result.reason}` : null,
  ].filter(Boolean).join('\n');
}

function formatAgentPluginDraft(result: AgentPluginDraftResult): string {
  return [
    `Plugin draft created: ${result.packagePath}`,
    `Draft id: ${result.draftId}`,
    `Plugin: ${result.pluginName}`,
    `Version: ${result.version}`,
    `Starter skill: ${result.skillName}`,
  ].join('\n');
}

function formatAgentPluginMutation(result: AgentPluginWorkspaceResult): string {
  return [
    `Plugin: ${result.name}`,
    `Version: ${result.version}`,
    `Enabled: ${result.enabled ? 'yes' : 'no'}`,
    `Checksum: ${result.checksum}`,
    `Skills: ${result.skills.join(', ') || 'none'}`,
    `Package: ${result.workspacePath}`,
  ].join('\n');
}

function createAgentPluginTools(userId?: string): AgentTool[] {
  return [
    {
      name: 'create_canvas_plugin_draft',
      label: 'Creating Canvas plugin draft',
      description: 'Creates a managed plugin package draft under .canvas-plugin-drafts with a valid manifest and one editable starter skill. Edit this package, then install_canvas_plugin_from_workspace using the returned packagePath.',
      parameters: Type.Object({
        pluginName: Type.String({ description: 'New plugin name in lowercase kebab-case.' }),
        description: Type.Optional(Type.String({ description: 'Short plugin description.' })),
        version: Type.Optional(Type.String({ description: 'Plugin version. Defaults to 1.0.0.' })),
        draftId: Type.Optional(Type.String({ description: 'Optional stable draft id. Defaults to a generated id.' })),
        overwrite: Type.Optional(Type.Boolean({ description: 'Overwrite an existing draft with the same draftId and pluginName. Defaults to false.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { pluginName?: string; description?: string; version?: string; draftId?: string; overwrite?: boolean };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          const context = requireAgentExecutionContextForTool('create_canvas_plugin_draft');
          if (!context.canWrite) throw new Error('Agent file writes are disabled for the active workspace.');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await createCanvasPluginDraft({
            workspaceRoot: context.workspaceRoot,
            pluginName: p.pluginName || '',
            description: p.description,
            version: p.version,
            draftId: p.draftId,
            overwrite: p.overwrite,
          });
          await recordAgentPluginToolAudit({ action: 'plugin.create_draft', status: 'success', pluginName: result.pluginName, workspacePath: result.packagePath, metadata: { version: result.version, skillName: result.skillName } });
          return { content: [{ type: 'text', text: formatAgentPluginDraft(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.create_draft', status: 'failure', pluginName: p.pluginName, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'inspect_canvas_plugin',
      label: 'Inspecting Canvas plugin',
      description: 'Inspects an installed Canvas plugin before updating, enabling, disabling, or removing it. Returns version, checksum, activation state, and bundled skill names without exposing server paths.',
      parameters: Type.Object({ pluginName: Type.String({ description: 'Plugin name to inspect.' }) }),
      execute: async (_toolCallId, params) => {
        const p = params as { pluginName?: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await inspectCanvasPluginForAgent({ pluginName: p.pluginName || '', scope: { userId: scopedUserId } });
          await recordAgentPluginToolAudit({ action: 'plugin.inspect', status: 'success', pluginName: result.name, metadata: { installed: result.installed, version: result.version ?? null, checksum: result.checksum ?? null } });
          return { content: [{ type: 'text', text: formatAgentPluginInspection(result) }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.inspect', status: 'failure', pluginName: p.pluginName, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'install_canvas_plugin_from_workspace',
      label: 'Installing Canvas plugin from workspace',
      description: 'Installs a new Canvas plugin package from a workspace directory. Create or edit the package with the create-plugin skill first; the directory must contain .canvas-plugin/plugin.json and valid skill content.',
      parameters: Type.Object({
        workspacePath: Type.String({ description: 'Workspace-relative plugin package directory.' }),
        enable: Type.Optional(Type.Boolean({ description: 'Enable the plugin after install. Defaults to true.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { workspacePath?: string; enable?: boolean };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          const context = requireAgentExecutionContextForTool('install_canvas_plugin_from_workspace');
          if (!context.canWrite) throw new Error('Agent file writes are disabled for the active workspace.');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await installCanvasPluginFromWorkspace({ workspaceRoot: context.workspaceRoot, workspacePath: p.workspacePath || '', scope: { userId: scopedUserId }, enable: p.enable, updatedBy: scopedUserId });
          await recordAgentPluginToolAudit({ action: 'plugin.install_from_workspace', status: 'success', pluginName: result.name, workspacePath: result.workspacePath, metadata: { version: result.version, checksum: result.checksum, enabled: result.enabled, skills: result.skills } });
          return { content: [{ type: 'text', text: `Plugin installed.\n${formatAgentPluginMutation(result)}` }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.install_from_workspace', status: 'failure', workspacePath: p.workspacePath, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'update_canvas_plugin_from_workspace',
      label: 'Updating Canvas plugin from workspace',
      description: 'Replaces an installed Canvas plugin with a validated workspace package. Call inspect_canvas_plugin first and pass its version and checksum to prevent overwriting a concurrent change.',
      parameters: Type.Object({
        pluginName: Type.String({ description: 'Installed plugin name to update.' }),
        workspacePath: Type.String({ description: 'Workspace-relative updated plugin package directory.' }),
        expectedVersion: Type.String({ description: 'Version returned by inspect_canvas_plugin.' }),
        expectedChecksum: Type.String({ description: 'Checksum returned by inspect_canvas_plugin.' }),
        enable: Type.Optional(Type.Boolean({ description: 'Plugin activation state after update. Defaults to the current state.' })),
      }),
      execute: async (_toolCallId, params) => {
        const p = params as { pluginName?: string; workspacePath?: string; expectedVersion?: string; expectedChecksum?: string; enable?: boolean };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          const context = requireAgentExecutionContextForTool('update_canvas_plugin_from_workspace');
          if (!context.canWrite) throw new Error('Agent file writes are disabled for the active workspace.');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await updateCanvasPluginFromWorkspace({ workspaceRoot: context.workspaceRoot, workspacePath: p.workspacePath || '', pluginName: p.pluginName || '', expectedVersion: p.expectedVersion || '', expectedChecksum: p.expectedChecksum || '', scope: { userId: scopedUserId }, enable: p.enable, updatedBy: scopedUserId });
          await recordAgentPluginToolAudit({ action: 'plugin.update_from_workspace', status: 'success', pluginName: result.name, workspacePath: result.workspacePath, metadata: { previousVersion: result.previousVersion, version: result.version, previousChecksum: result.previousChecksum, checksum: result.checksum, enabled: result.enabled, skills: result.skills } });
          return { content: [{ type: 'text', text: `Plugin updated.\n${formatAgentPluginMutation(result)}` }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.update_from_workspace', status: 'failure', pluginName: p.pluginName, workspacePath: p.workspacePath, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'set_canvas_plugin_enabled',
      label: 'Setting Canvas plugin activation',
      description: 'Enables or disables an installed Canvas plugin and its plugin-owned materialized skills.',
      parameters: Type.Object({ pluginName: Type.String({ description: 'Installed plugin name.' }), enabled: Type.Boolean({ description: 'Whether the plugin should be enabled.' }) }),
      execute: async (_toolCallId, params) => {
        const p = params as { pluginName?: string; enabled?: boolean };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await setCanvasPluginEnabledForAgent({ pluginName: p.pluginName || '', enabled: p.enabled === true, scope: { userId: scopedUserId }, updatedBy: scopedUserId });
          await recordAgentPluginToolAudit({ action: 'plugin.set_enabled', status: 'success', pluginName: result.name, metadata: { enabled: result.enabled, version: result.version, checksum: result.checksum } });
          return { content: [{ type: 'text', text: `Plugin activation updated.\n${formatAgentPluginMutation(result)}` }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.set_enabled', status: 'failure', pluginName: p.pluginName, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
    {
      name: 'remove_canvas_plugin',
      label: 'Removing Canvas plugin',
      description: 'Removes an installed Canvas plugin and unmodified plugin-owned materialized skills. It refuses removal if a materialized skill was edited, so user work is never silently deleted.',
      parameters: Type.Object({ pluginName: Type.String({ description: 'Installed plugin name to remove.' }) }),
      execute: async (_toolCallId, params) => {
        const p = params as { pluginName?: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'plugin tools');
          await assertAgentCanManageSkills(scopedUserId);
          const result = await removeCanvasPluginForAgent({ pluginName: p.pluginName || '', scope: { userId: scopedUserId }, updatedBy: scopedUserId });
          await recordAgentPluginToolAudit({ action: 'plugin.remove', status: 'success', pluginName: result.name });
          return { content: [{ type: 'text', text: `Plugin removed: ${result.name}` }], details: result };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          await recordAgentPluginToolAudit({ action: 'plugin.remove', status: 'failure', pluginName: p.pluginName, error: message });
          return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
        }
      },
    },
  ];
}

export function createUserScopedTools(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool[] {
  const sourceAgentId = normalizeManagedAgentId(agentId);
  const tools: AgentTool[] = [
    createMcpProxyTool(userId),
    createMemoryTool(userId, agentId),
    createSessionSearchTool({ userId, agentId, sessionId }),
    createHumanTodoTool({ userId, agentId, sessionId }),
    createPublicShareTool(userId, agentId, sessionId),
    createBrowserGatewayTool({ userId, agentId: sourceAgentId, sessionId }),
    ...createAgentSkillTools(userId),
    ...createAgentPluginTools(userId),
  ];

  if (sourceAgentId === DEFAULT_AGENT_ID) {
    tools.push(createDelegateTaskTool({ userId, sourceAgentId, sourceSessionId: sessionId }));
  }

  tools.push(
    {
      name: 'list_automation_jobs',
      label: 'Listing automation jobs',
      description: 'Lists all automation jobs with status, schedule, and a short prompt preview. Use inspect_automation_job to read the full prompt before editing an existing automation.',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const jobs = await listAutomationJobs(scopedUserId);
          const text = jobs.length === 0
            ? 'No automation jobs found'
            : jobs.map((job, index) => `--- Job ${index + 1} ---\n${formatAutomationJob(job)}`).join('\n\n');
          return {
            content: [{ type: 'text', text }],
            details: { jobs },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'inspect_automation_job',
      label: 'Inspecting automation job',
      description: 'Reads one automation job in full, including the complete prompt text, schedule, context paths, output target, delivery settings, and updatedAt. Always use this before updating an automation prompt so you can preserve the existing prompt and edit it precisely.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the automation job to inspect' }),
      }),
      execute: async (toolCallId, params) => {
        const { jobId } = params as { jobId: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const job = await getUserOwnedAutomationJob(scopedUserId, jobId);
          return {
            content: [{ type: 'text', text: formatAutomationJob(job, { includeFullPrompt: true }) }],
            details: { job },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'create_automation_job',
      label: 'Creating automation job',
      description: 'Creates a new scheduled automation job. Use when user wants to automate tasks, create scheduled workflows, or set up recurring jobs. Required: name (job name), prompt (the script to execute), schedule (when to run). Schedule types: once (date+time), daily (time), weekly (days+time), monthly (dayOfMonth+time), interval (every+unit). Use monthly directly for monthly requests; do not emulate it with a weekly or daily schedule and a prompt guard. Optional: targetOutputPath (where to save results), workspaceContextPaths (context files), status (active/paused).',
      parameters: Type.Object({
        name: Type.String({ description: 'Name of the automation job (max 120 chars)' }),
        prompt: Type.String({ description: 'The script/prompt to execute when the job runs' }),
        schedule: Type.Object({
          kind: Type.String({ description: 'Schedule type: once, daily, weekly, monthly, interval' }),
          date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
          time: Type.Optional(Type.String({ description: 'For daily/weekly/monthly/once: time in HH:MM format' })),
          days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days (mon, tue, wed, thu, fri, sat, sun)' })),
          dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: 'For monthly: calendar day from 1 to 31. Shorter months use their last calendar day.' })),
          every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
          unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
          timeZone: Type.Optional(Type.String({ description: 'Timezone (default: user preference, initially Europe/Berlin)' })),
        }),
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save job outputs (relative to workspace)' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Array of file paths to include as context' })),
        status: Type.Optional(Type.String({ description: 'Job status: active (default) or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { name, prompt, schedule, targetOutputPath, workspaceContextPaths, status } = params as {
          name: string;
          prompt: string;
          schedule: {
            kind: string;
            date?: string;
            time?: string;
            days?: string[];
            dayOfMonth?: number;
            every?: number;
            unit?: string;
            timeZone?: string;
          };
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const executionContext = getAgentExecutionContext();
          const preferredTimeZone = await getServerPreferredTimeZone();
          const job = await createAutomationJob(
            {
              name: name.trim().slice(0, 120),
              prompt: prompt.trim().slice(0, 12000),
              scope: executionContext?.workspaceType === 'organization' || executionContext?.workspaceType === 'team' ? 'organization' : 'personal',
              workspaceId: executionContext?.workspaceId ?? null,
              schedule: normalizeAutomationSchedule(schedule, preferredTimeZone),
              targetOutputPath: normalizeOptionalString(targetOutputPath)?.replace(/^\/+|^\.\/+/, '') || null,
              workspaceContextPaths: normalizeAutomationWorkspacePaths(workspaceContextPaths),
              status: normalizeAutomationStatus(status) || 'active',
            },
            scopedUserId,
          );
          return {
            content: [{ type: 'text', text: `Automation job created successfully\n\n${formatAutomationJob(job, { includeFullPrompt: true })}` }],
            details: { job },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'update_automation_job',
      label: 'Updating automation job',
      description: 'Updates an existing automation job. Required: jobId. Optional: name, prompt, schedule, targetOutputPath, workspaceContextPaths, status (active/paused). Schedule types include monthly (dayOfMonth+time); use it directly instead of adding date guards to daily or weekly prompts. Before changing prompt, call inspect_automation_job, preserve the existing prompt text, edit only the requested parts, and pass expectedPrompt or expectedUpdatedAt to avoid overwriting a newer version.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to update' }),
        name: Type.Optional(Type.String({ description: 'New name for the job' })),
        prompt: Type.Optional(Type.String({ description: 'New prompt/script' })),
        expectedPrompt: Type.Optional(Type.String({ description: 'Current full prompt as returned by inspect_automation_job. Required for prompt edits unless expectedUpdatedAt is provided.' })),
        expectedUpdatedAt: Type.Optional(Type.String({ description: 'Current updatedAt value as returned by inspect_automation_job. Required for prompt edits unless expectedPrompt is provided.' })),
        schedule: Type.Optional(Type.Object({
          kind: Type.String({ description: 'Schedule type: once, daily, weekly, monthly, interval' }),
          date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
          time: Type.Optional(Type.String({ description: 'For daily/weekly/monthly/once: time in HH:MM format' })),
          days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days' })),
          dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, description: 'For monthly: calendar day from 1 to 31. Shorter months use their last calendar day.' })),
          every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
          unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
          timeZone: Type.Optional(Type.String({ description: 'Timezone' })),
        })),
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save outputs' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Context file paths' })),
        status: Type.Optional(Type.String({ description: 'active or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { jobId, name, prompt, expectedPrompt, expectedUpdatedAt, schedule, targetOutputPath, workspaceContextPaths, status } = params as {
          jobId: string;
          name?: string;
          prompt?: string;
          expectedPrompt?: string;
          expectedUpdatedAt?: string;
          schedule?: {
            kind: string;
            date?: string;
            time?: string;
            days?: string[];
            dayOfMonth?: number;
            every?: number;
            unit?: string;
            timeZone?: string;
          };
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const existingJob = await getUserOwnedAutomationJob(scopedUserId, jobId);
          const normalizedPrompt = normalizeOptionalString(prompt)?.slice(0, 12000);
          if (normalizedPrompt !== undefined && expectedPrompt === undefined && expectedUpdatedAt === undefined) {
            throw new Error('Prompt updates require expectedPrompt or expectedUpdatedAt from inspect_automation_job. Inspect the automation first, then submit the complete revised prompt.');
          }
          if (expectedPrompt !== undefined && existingJob.prompt !== expectedPrompt) {
            throw new Error('Automation prompt changed since inspection. Inspect the automation again before updating.');
          }
          if (expectedUpdatedAt !== undefined && existingJob.updatedAt !== expectedUpdatedAt) {
            throw new Error('Automation changed since inspection. Inspect the automation again before updating.');
          }
          const preferredTimeZone = await getServerPreferredTimeZone();
          const updatedJob = await updateAutomationJob(jobId, {
            name: normalizeOptionalString(name)?.slice(0, 120),
            prompt: normalizedPrompt,
            targetOutputPath: targetOutputPath === undefined
              ? undefined
              : normalizeOptionalString(targetOutputPath)?.replace(/^\/+|^\.\/+/, '') || null,
            workspaceContextPaths: normalizeAutomationWorkspacePathsForUpdate(workspaceContextPaths),
            status: normalizeAutomationStatus(status),
            schedule: schedule ? normalizeAutomationSchedule(schedule, existingJob.timeZone || preferredTimeZone) : undefined,
          }, { actorUserId: scopedUserId });
          if (!updatedJob) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          return {
            content: [{ type: 'text', text: `Automation job updated successfully\n\n${formatAutomationJob(updatedJob, { includeFullPrompt: true })}` }],
            details: { job: updatedJob },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'delete_automation_job',
      label: 'Deleting automation job',
      description: 'Permanently deletes an automation job and all its run history. Use when user wants to remove a job completely. Required: jobId.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to delete' }),
      }),
      execute: async (toolCallId, params) => {
        const { jobId } = params as { jobId: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          await getUserOwnedAutomationJob(scopedUserId, jobId);
          const deleted = await deleteAutomationJob(jobId);
          if (!deleted) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          return {
            content: [{ type: 'text', text: 'Automation job deleted successfully' }],
            details: { jobId },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'trigger_automation_job',
      label: 'Triggering automation job',
      description: 'Manually triggers an automation job to run immediately, regardless of its schedule. Use when user wants to run a job now instead of waiting for the next scheduled time. Required: jobId.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to trigger' }),
      }),
      execute: async (toolCallId, params) => {
        const { jobId } = params as { jobId: string };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          await getUserOwnedAutomationJob(scopedUserId, jobId);
          const run = await scheduleAutomationJobRun(jobId, 'manual', new Date(), { actorUserId: scopedUserId });
          if (!run) {
            return {
              content: [{ type: 'text', text: 'Automation already has an in-flight run.' }],
              details: { jobId, skipped: true },
            };
          }
          return {
            content: [{ type: 'text', text: `Automation job triggered successfully\nRun ID: ${run.id}` }],
            details: { jobId, run },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    createStudioGenerateImageTool({ userId }),
    createStudioGenerateVideoTool({ userId }),
    createStudioGenerateSoundTool({ userId }),
    createStudioBulkGenerateTool({ userId }),
    createStudioListProductsTool({ userId }),
    createStudioListPersonasTool({ userId }),
    createStudioListStylesTool({ userId }),
  );

  return tools;
}
