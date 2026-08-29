import path from 'node:path';

import { agentLoop, type AgentContext, type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, ProviderId } from '@earendil-works/pi-ai';

import {
  resolveAndPinSessionRuntime,
  resolveExecutableAgentRuntime,
  type ExecutableAgentRuntime,
} from '@/app/lib/agent-runtime-policy/provider-runtime';
import { sessionRuntimeSnapshotFromResolvedSelection } from '@/app/lib/agent-runtime-policy/runtime-snapshot';
import { SessionRuntimeContextRevisionConflictError } from '@/app/lib/agent-runtime-policy/runtime-store';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';
import { preparePiFinalPayload } from '@/app/lib/pi/multimodal-preparation';
import { getPiRequestOutputTokenCap, withPiRequestOutputTokenCap } from '@/app/lib/pi/context-budget';
import { projectAgentEventForExternal } from '@/app/lib/pi/visual-data-projection';
import { estimateTextTokens } from '@/app/lib/pi/history-budget';
import { MAX_LLM_HISTORY_BYTES } from '@/app/lib/pi/llm-payload-limits';
import {
  createPiSessionWithRuntimeSnapshot,
  finalizePiSessionAfterNoop,
  loadPiSessionWithSummary,
  savePiSession,
} from '@/app/lib/pi/session-store';
import { runWithAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  appendWorkspaceBrandPromptBlock,
  getWorkspaceBrandPromptBlock,
} from '@/app/lib/agents/workspace-brand-context';
import {
  buildWorkspaceFileTreePrompt,
  replaceWorkspaceFileTreePromptBlock,
  WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES,
} from '@/app/lib/agents/workspace-file-tree-context';
import {
  addEffectiveSkillReadRoots,
  workspaceToAgentExecutionContext,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';
import { findOwnedPiSessionForRuntime, isPiSessionInWorkspace } from '@/app/lib/pi/session-runtime-access';
import {
  sendAgentResponseReadyPush,
  sendAutomationRunStatusPush,
  sendFailureAttentionPush,
} from '@/app/lib/mobile/push-devices';
import {
  PiSessionBusyError,
  withExclusivePiSessionExecution,
} from '@/app/lib/pi/session-exclusive-execution';
import { loadPiSessionSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import {
  appendEffectiveToolCapabilitiesPrompt,
  buildEffectiveToolManifest,
  effectiveToolManifestHas,
} from '@/app/lib/pi/effective-tool-manifest';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { prepareAutomationHistoryWithCompaction } from './history-compaction';
import { buildAutomationPrompt } from './prompt';
import { classifyAutomationResult, NO_ACTION_TOKEN } from './result-policy';
import {
  AutomationLoopShutdownError,
  AutomationRunTimeoutError,
  runWithAutomationTimeout,
} from './run-timeout';
import { buildPersistedAutomationMessages, getAutomationPersistedLength } from './session-messages';
import {
  dispatchAutomationResult,
  getAutomationDeliveryFailureMessage,
  resolveAutomationDeliveryTarget,
  shouldPauseAutomationAfterDeliveryFailure,
  type AutomationDeliveryDispatchResult,
  type AutomationDeliveryResolution,
} from './delivery';
import {
  getAutomationJob,
  getAutomationRun,
  markAutomationRunFinished,
  markAutomationRunRetryScheduled,
  markAutomationRunStarted,
  migrateLegacyHeartbeatJobs,
  revalidateAutomationRunClaim,
  updateAutomationJob,
} from './store';
import { resolveAutomationRunWorkspace } from './policy';
import { type AutomationJobRecord, type AutomationRunRecord } from './types';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';
import { getWorkspaceEmailAttentionSummary } from '@/app/lib/email/workspace-inbox-outbox';
import {
  getWorkspaceEmailAutomationEventContext,
  markWorkspaceEmailAutomationEventRunFinished,
} from '@/app/lib/email/workspace-email-automation-events';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000] as const;
const MAX_EVENTS_LOG = 500;
const MAX_EVENT_JSON_LENGTH = 10_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const RUN_ABORT_GRACE_MS = 30_000;
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

class AutomationRunClaimLostError extends Error {
  constructor() {
    super('Automation run claim was lost while waiting for its session.');
    this.name = 'AutomationRunClaimLostError';
  }
}

async function sendAutomationTerminalPush(input: {
  userId: string;
  workspaceId: string | null;
  runId: string;
  jobName: string;
  triggerType: AutomationRunRecord['triggerType'];
  status: 'success' | 'failed';
}): Promise<void> {
  if (input.status === 'success' && input.triggerType !== 'scheduled') return;
  try {
    const workspaceId = input.workspaceId || LEGACY_PERSONAL_WORKSPACE_ID;
    if (input.triggerType === 'scheduled') {
      await sendAutomationRunStatusPush({
        userId: input.userId,
        workspaceId,
        runId: input.runId,
        jobName: input.jobName,
        status: input.status,
      });
    } else {
      await sendFailureAttentionPush({
        userId: input.userId,
        workspaceId,
        entityKind: 'automation',
        entityId: input.runId,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send automation push notification.';
    console.warn('[Automationen] Push notification failed:', message);
  }
}

function queueAutomationResponsePush(input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
  job: AutomationJobRecord;
  resolution: AutomationDeliveryResolution;
}): void {
  if (input.job.deliveryMode === 'silent' || input.resolution.channelId !== 'web') return;
  void sendAgentResponseReadyPush({
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to send automation response push notification.';
      console.warn('[Automationen] Response push notification failed:', message);
    });
}

function assertAutomationExecutionActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Automation execution was aborted after exceeding its deadline.');
  }
}

function extractAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }

    return message.content
      .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && part.type === 'text')
      .map((part) => part.text)
      .join('\n\n')
      .trim();
  }

  return '';
}

function getAssistantError(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if ('stopReason' in message && message.stopReason === 'error') {
      if ('errorMessage' in message && typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
        return message.errorMessage.trim();
      }
      return 'Assistant run failed.';
    }
  }

  return null;
}

function calculateRetryAt(attemptNumber: number): Date | null {
  if (attemptNumber >= MAX_ATTEMPTS) {
    return null;
  }
  const delay = RETRY_BACKOFF_MS[attemptNumber - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  return new Date(Date.now() + delay);
}

function buildAutomationSessionId(runId: string): string {
  return `auto-${runId.replace(/^run-/, '')}`;
}

function buildAutomationSessionTitle(jobName: string): string {
  return `Automation: ${jobName}`.slice(0, 120);
}

function getWebhookPromptContext(run: AutomationRunRecord) {
  const webhook = run.metadataJson?.webhook;
  if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) return null;
  const record = webhook as Record<string, unknown>;
  return {
    provider: typeof record.provider === 'string' ? record.provider : 'composio',
    source: typeof record.source === 'string' ? record.source : 'unknown',
    triggerSlug: typeof record.triggerSlug === 'string' ? record.triggerSlug : 'unknown',
    triggerId: typeof record.triggerId === 'string' ? record.triggerId : 'unknown',
    toolkitSlug: typeof record.toolkitSlug === 'string' ? record.toolkitSlug : 'unknown',
    eventId: typeof record.eventId === 'string' ? record.eventId : 'unknown',
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
    data: record.data ?? {},
  };
}

function createAutomationErrorMessage(message: string, provider: ProviderId, modelId: string, api: Api): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `Automation failed: ${message}`,
      },
    ],
    api,
    provider,
    model: modelId,
    usage: EMPTY_USAGE,
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function buildAutomationRunMetadata(
  job: AutomationJobRecord,
  resolution?: AutomationDeliveryResolution,
  dispatch?: AutomationDeliveryDispatchResult,
) {
  return {
    agentId: job.agentId,
    delivery: {
      mode: job.deliveryMode,
      channelId: job.deliveryChannelId,
      sessionMode: job.deliverySessionMode,
      sessionId: job.deliverySessionId,
      channelSessionKey: job.deliveryChannelSessionKey,
      resolvedSessionId: resolution?.sessionId,
      resolvedMode: resolution?.mode,
      resolvedChannelId: resolution?.channelId,
      resolvedChannelSessionKey: resolution?.channelSessionKey,
      activeDelivery: resolution?.activeDelivery,
      warnings: resolution?.warnings,
      dispatch,
    },
  };
}

function buildAutomationRuntimeMetadata(runtime: ExecutableAgentRuntime) {
  const selection = runtime.selection;
  return {
    providerInstallationId: selection.selection.providerInstallationId,
    providerId: selection.selection.providerId,
    modelId: selection.selection.modelId,
    thinkingLevel: selection.selection.thinkingLevel,
    credentialScope: selection.credentialScope,
    catalogRevision: selection.catalogRevision,
    policyRevision: selection.policyRevision,
    selectionSource: selection.selectionSource,
  };
}

function sameAutomationWorkspaceIdentity(
  left: { workspaceId: string; workspaceType: string; organizationId?: string | null },
  right: { workspaceId: string; workspaceType: string; organizationId?: string | null },
): boolean {
  return left.workspaceId === right.workspaceId
    && left.workspaceType === right.workspaceType
    && (left.organizationId ?? null) === (right.organizationId ?? null);
}

export async function executeAutomationRun(runId: string): Promise<void> {
  await migrateLegacyHeartbeatJobs();
  const runStartTime = Date.now();
  const run = await getAutomationRun(runId);
  if (!run) {
    console.warn(`[Automationen] Run ${runId} not found, skipping`);
    return;
  }
  if (run.status !== 'pending' && run.status !== 'retry_scheduled') {
    console.warn(`[Automationen] Run ${runId} is already ${run.status}, skipping`);
    return;
  }

  let runTransitionExpectation: {
    status: AutomationRunRecord['status'];
    attemptNumber: number;
  } = {
    status: run.status,
    attemptNumber: run.attemptNumber,
  };

  const job = await getAutomationJob(run.jobId);
  if (!job) {
    console.error(`[Automationen] Job ${run.jobId} not found for run ${runId}`);
    const failedRun = await markAutomationRunFinished(runId, {
      status: 'failed',
      errorMessage: 'Automation job not found.',
      eventsLog: [],
      metadataJson: { provider: 'unknown', model: 'unknown', status: 'failed' },
      expectation: runTransitionExpectation,
    });
    if (failedRun) await markWorkspaceEmailAutomationEventRunFinished({ run: failedRun, status: 'failed', errorMessage: 'Automation job not found.' });
    return;
  }

  const automationUserId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
  console.log(`[Automationen] Starting run ${runId} for job "${job.name}" (type=${job.jobType}, scope=${job.scope}, workspace=${job.workspaceId ?? 'legacy'})`);

  try {
    const emailInboxEventContext = await getWorkspaceEmailAutomationEventContext({ job, run });
    const defaultPiSessionId = emailInboxEventContext?.sessionId || buildAutomationSessionId(run.id);
    let automationWorkspace = await resolveAutomationRunWorkspace(job);
    const deliveryResolution = await resolveAutomationDeliveryTarget({
      job,
      userId: automationUserId,
      defaultSessionId: defaultPiSessionId,
      workspace: automationWorkspace,
    });
    const piSessionId = deliveryResolution.sessionId;
    const piSessionTitle = buildAutomationSessionTitle(job.name);
    const effectiveTargetOutputPath = getEffectiveAutomationTargetOutputPath(job);
    const startedRun = await markAutomationRunStarted(run.id, {
      outputDir: null,
      targetOutputPath: job.targetOutputPath,
      effectiveTargetOutputPath: effectiveTargetOutputPath || null,
      logPath: '',
      resultPath: null,
      piSessionId,
      eventsLog: [],
      expectedAttemptNumber: run.attemptNumber,
    });
    if (!startedRun) {
      console.warn(`[Automationen] Run ${runId} could not be marked as started (already running or completed), aborting`);
      return;
    }
    runTransitionExpectation = {
      status: 'running',
      attemptNumber: startedRun.attemptNumber,
    };
    let executionContext = await addEffectiveSkillReadRoots(workspaceToAgentExecutionContext({
      workspace: automationWorkspace,
      userId: automationUserId,
      sessionId: piSessionId,
      agentId: job.agentId,
    }));

    await withExclusivePiSessionExecution({
      sessionId: piSessionId,
      userId: automationUserId,
      beforeRuntimeCheck: async () => {
        const revalidatedRun = await revalidateAutomationRunClaim(run.id, runTransitionExpectation);
        if (!revalidatedRun) throw new AutomationRunClaimLostError();
        const refreshedWorkspace = await resolveAutomationRunWorkspace(job);
        if (!sameAutomationWorkspaceIdentity(automationWorkspace, refreshedWorkspace)) {
          throw new Error('Automation workspace identity changed while waiting for session execution.');
        }
        automationWorkspace = refreshedWorkspace;
        executionContext = await addEffectiveSkillReadRoots(workspaceToAgentExecutionContext({
          workspace: refreshedWorkspace,
          userId: automationUserId,
          sessionId: piSessionId,
          agentId: job.agentId,
        }));
      },
      operation: async (reservation) => {
        try {
          return await runWithAutomationTimeout({
            timeoutMs: RUN_TIMEOUT_MS,
            abortGraceMs: RUN_ABORT_GRACE_MS,
            operation: (executionSignal) => reservation.runReserved(
              executionSignal,
              () => runWithAgentExecutionContext(executionContext, async () => {
      assertAutomationExecutionActive(executionSignal);

      if (effectiveTargetOutputPath) {
        const targetParentDir = path.posix.dirname(effectiveTargetOutputPath);
        if (targetParentDir && targetParentDir !== '.') {
          await createDirectory(targetParentDir, { workspace: automationWorkspace });
        }
      }
      assertAutomationExecutionActive(executionSignal);

      const jobPrompt = job.prompt;
      assertAutomationExecutionActive(executionSignal);
      const workspaceEmailAttention = job.resultPolicy === 'deliver_relevant_only'
        ? await getWorkspaceEmailAttentionSummary(automationWorkspace.workspaceId)
        : null;
      assertAutomationExecutionActive(executionSignal);
      const promptText = buildAutomationPrompt({
        name: job.name,
        workspaceContextPaths: job.workspaceContextPaths,
        prompt: jobPrompt,
        preferredSkill: job.preferredSkill,
        resultPolicy: job.resultPolicy,
        effectiveTargetOutputPath,
        webhookContext: run.triggerType === 'webhook' ? getWebhookPromptContext(run) : null,
        emailInboxEventContext,
        workspaceEmailAttention,
      });

      const events: string[] = [];
      let finalMessages: AgentMessage[] = [];
      let dispatchResult: AutomationDeliveryDispatchResult | undefined;
      let promptPersistedBeforeRun = false;
      const persistedSession = await findOwnedPiSessionForRuntime({
        sessionId: piSessionId,
        userId: automationUserId,
        agentId: job.agentId,
      });
      assertAutomationExecutionActive(executionSignal);
      if (persistedSession && !isPiSessionInWorkspace(persistedSession, automationWorkspace)) {
        throw new Error('Automation delivery session belongs to a different workspace.');
      }
      const historySession = persistedSession
        ? await loadPiSessionWithSummary(piSessionId, automationUserId, job.agentId)
        : null;
      assertAutomationExecutionActive(executionSignal);
      const existingMessages = historySession?.messages ?? [];
      const initialSessionSummary = historySession?.summary ?? {
        summaryText: null,
        summaryUpdatedAt: null,
        summaryThroughTimestamp: null,
        summaryThroughSequence: null,
        summaryRevision: 0,
      };
      if (!automationWorkspace.organizationId) {
        throw new Error('Complete the app AI runtime setup before running an automation.');
      }
      const runtimeContext = {
        organizationId: automationWorkspace.organizationId,
        userId: automationUserId,
        workspaceId: automationWorkspace.workspaceId,
        workspaceType: automationWorkspace.workspaceType,
        agentId: job.agentId,
        requestedSelection: null,
        executionMode: job.scope === 'organization'
          ? 'organization_automation' as const
          : 'personal_automation' as const,
        principal: job.scope === 'organization'
          ? {
              type: 'organization_service' as const,
              serviceActorId: job.serviceActorId || `org-service:${automationWorkspace.organizationId}`,
              responsibleUserId: automationUserId,
              credentialSubjectUserId: null,
            }
          : {
              type: 'user' as const,
              userId: automationUserId,
              credentialSubjectUserId: automationUserId,
            },
      };
      let executableRuntime = persistedSession
        ? await resolveAndPinSessionRuntime({ ...runtimeContext, sessionId: piSessionId })
        : await resolveExecutableAgentRuntime({ ...runtimeContext, sessionId: null });
      assertAutomationExecutionActive(executionSignal);
      let provider = executableRuntime.selection.selection.providerId;
      let model = executableRuntime.model;
      console.log(
        `[Automationen] Run ${runId} using installation=${executableRuntime.selection.selection.providerInstallationId}, `
        + `provider=${provider}, model=${model.id}`,
      );

      // Inbox-event runs receive server-bound email tools. Their final
      // capability boundary is enforced in the tool registry, where only
      // read-only workspace tools and human-review email operations survive.
      const tools = await getPiTools(automationUserId, job.agentId, piSessionId, {
        automationExecution: true,
        workspaceEmailAutomation: emailInboxEventContext
          ? {
              ...emailInboxEventContext,
              userId: automationUserId,
              workspaceId: automationWorkspace.workspaceId,
              automationJobId: job.id,
              automationRunId: run.id,
              agentId: job.agentId,
            }
          : undefined,
      });
      assertAutomationExecutionActive(executionSignal);
      const promptSnapshot = await loadPiSessionSystemPromptSnapshot({
        sessionId: piSessionId,
        userId: automationUserId,
        agentId: job.agentId,
      });
      assertAutomationExecutionActive(executionSignal);
      const automationBrandContext = await getWorkspaceBrandPromptBlock(automationWorkspace.workspaceId);
      const baseSystemPrompt = appendWorkspaceBrandPromptBlock(
        promptSnapshot.systemPrompt,
        automationBrandContext,
      );
      const effectiveBaseSystemPrompt = appendEffectiveToolCapabilitiesPrompt(
        baseSystemPrompt,
        buildEffectiveToolManifest(tools),
      );
      const hasWorkspaceReadCapability = ['ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations']
        .some((toolName) => effectiveToolManifestHas(buildEffectiveToolManifest(tools), toolName));
      const initialWorkspaceFileTree = hasWorkspaceReadCapability
        ? await buildWorkspaceFileTreePrompt({
            workspaceId: automationWorkspace.workspaceId,
            rootPath: automationWorkspace.rootPath,
          })
        : { promptBlock: '' };
      const systemPrompt = replaceWorkspaceFileTreePromptBlock(
        effectiveBaseSystemPrompt,
        initialWorkspaceFileTree.promptBlock,
      );
      const systemPromptBudgetTokens = estimateTextTokens(effectiveBaseSystemPrompt)
        + estimateTextTokens('x'.repeat(WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES));
      const promptMessage: AgentMessage = {
        role: 'user',
        content: promptText,
        timestamp: Date.now(),
      };
      const prepareHistoryForRuntime = (runtime: ExecutableAgentRuntime) => (
        prepareAutomationHistoryWithCompaction({
          sessionId: piSessionId,
          userId: automationUserId,
          agentId: job.agentId,
          workspaceId: automationWorkspace.workspaceId,
          messages: [...existingMessages, promptMessage],
          promptMessage,
          summary: initialSessionSummary,
          persistedMessageCheckpoint: existingMessages.length,
          model: runtime.model,
          tools: tools || [],
          effectiveSystemPrompt: systemPrompt,
          systemPromptBudgetTokens,
          requestOutputTokens: getPiRequestOutputTokenCap(runtime.model),
          runtimeCatalogRevision: runtime.selection.catalogRevision,
          runtimePolicyRevision: runtime.selection.policyRevision,
          signal: executionSignal,
          streamFn: runtime.streamFn,
        })
      );
      let sessionReadyForPersistence = Boolean(persistedSession);
      try {
        if (!sessionReadyForPersistence) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await createPiSessionWithRuntimeSnapshot({
                sessionId: piSessionId,
                userId: automationUserId,
                agentId: job.agentId,
                title: piSessionTitle,
                workspace: workspaceToPiSessionFields(automationWorkspace),
                runtimeSnapshot: sessionRuntimeSnapshotFromResolvedSelection(executableRuntime.selection),
                systemPromptSnapshot: promptSnapshot,
              });
              sessionReadyForPersistence = true;
              break;
            } catch (error) {
              const concurrentSession = await findOwnedPiSessionForRuntime({
                sessionId: piSessionId,
                userId: automationUserId,
                agentId: job.agentId,
              });
              if (concurrentSession && isPiSessionInWorkspace(concurrentSession, automationWorkspace)) {
                sessionReadyForPersistence = true;
                break;
              }
              if (error instanceof SessionRuntimeContextRevisionConflictError && attempt === 0) {
                assertAutomationExecutionActive(executionSignal);
                executableRuntime = await resolveExecutableAgentRuntime({ ...runtimeContext, sessionId: null });
                assertAutomationExecutionActive(executionSignal);
                provider = executableRuntime.selection.selection.providerId;
                model = executableRuntime.model;
                continue;
              }
              throw error;
            }
          }
          if (!sessionReadyForPersistence) {
            throw new Error('Automation session could not be created with a current runtime snapshot.');
          }

          assertAutomationExecutionActive(executionSignal);
          executableRuntime = await resolveAndPinSessionRuntime({ ...runtimeContext, sessionId: piSessionId });
          provider = executableRuntime.selection.selection.providerId;
          model = executableRuntime.model;
        }
        assertAutomationExecutionActive(executionSignal);

        const preparedHistory = await prepareHistoryForRuntime(executableRuntime);
        assertAutomationExecutionActive(executionSignal);
        const preparedMessages = preparedHistory.composition.llmMessages;
        const requestOutputTokenCap = getPiRequestOutputTokenCap(model);
        const mainRequestStreamFn = withPiRequestOutputTokenCap(
          executableRuntime.streamFn,
          requestOutputTokenCap,
        );
        let currentSystemPrompt = systemPrompt;
        const config = {
          model,
          thinkingLevel: executableRuntime.selection.selection.thinkingLevel as ThinkingLevel,
          convertToLlm: async (messages: AgentMessage[]) => {
            const preparedPayload = await preparePiFinalPayload({
              messages,
              model,
              effectiveInstructions: [{ role: 'system' as const, content: currentSystemPrompt }],
              effectiveTools: tools || [],
              requestOutputTokenCap,
              runtimeContractRevision: 'canvas-pi-automation-v1',
            }, {
              workspaceImageRoot: automationWorkspace.rootPath,
              allowedImageFileRoots: [automationWorkspace.rootPath],
              uploadOwnerUserId: runtimeContext.userId,
              uploadWorkspaceId: automationWorkspace.workspaceId,
            });
            if (preparedPayload.budgetSnapshot.payloadBudgetExceeded) {
              throw new Error(
                `Automation request exceeds the ${Math.floor(MAX_LLM_HISTORY_BYTES / (1024 * 1024))}MB final LLM transfer budget.`,
              );
            }
            if (preparedPayload.budgetSnapshot.contextBudgetExceeded) {
              throw new Error('Automation final payload exceeds the selected model context window.');
            }
            return preparedPayload.messages;
          },
          prepareNextTurn: async (turnContext: { context: AgentContext }) => {
            const nextWorkspaceFileTree = hasWorkspaceReadCapability
              ? await buildWorkspaceFileTreePrompt({
                  workspaceId: automationWorkspace.workspaceId,
                  rootPath: automationWorkspace.rootPath,
                })
              : { promptBlock: '' };
            currentSystemPrompt = replaceWorkspaceFileTreePromptBlock(
              effectiveBaseSystemPrompt,
              nextWorkspaceFileTree.promptBlock,
            );
            return {
              context: {
                ...turnContext.context,
                systemPrompt: currentSystemPrompt,
              },
            };
          },
          sessionId: piSessionId,
        };
        const context: AgentContext = {
          systemPrompt,
          messages: preparedMessages.slice(0, -1),
          tools,
        };

        await savePiSession(
          piSessionId,
          automationUserId,
          provider,
          model.id,
          [...existingMessages, promptMessage],
          undefined,
          {
            titleOverride: piSessionTitle,
            agentId: job.agentId,
            persistedLength: existingMessages.length,
            channelId: deliveryResolution.channelId,
            channelSessionKey: deliveryResolution.channelSessionKey || null,
            workspaceId: automationWorkspace.workspaceId,
            systemPromptSnapshot: promptSnapshot,
          },
        );
        promptPersistedBeforeRun = true;
        assertAutomationExecutionActive(executionSignal);

        console.log(`[Automationen] Starting agent loop for run ${runId} (provider=${provider}, model=${model.id})`);
        const loopEvents: string[] = [];
        let loopMessages: AgentMessage[] = [];
        for await (const event of agentLoop(
          [promptMessage],
          context,
          config,
          executionSignal,
          mainRequestStreamFn,
        )) {
          if (loopEvents.length < MAX_EVENTS_LOG) {
            const json = JSON.stringify(projectAgentEventForExternal(event));
            loopEvents.push(json.length > MAX_EVENT_JSON_LENGTH ? json.slice(0, MAX_EVENT_JSON_LENGTH) + '...[truncated]' : json);
          }
          if (event.type === 'agent_end') {
            loopMessages = event.messages;
          }
        }
        assertAutomationExecutionActive(executionSignal);
        events.push(...loopEvents);
        finalMessages = loopMessages;
        console.log(`[Automationen] Agent loop completed for run ${runId} (events=${events.length})`);

        const assistantError = getAssistantError(finalMessages);
        if (assistantError) {
          throw new Error(assistantError);
        }

        const assistantText = extractAssistantText(finalMessages);
        const automationResult = classifyAutomationResult(assistantText, job.resultPolicy);
        if (automationResult?.kind === 'empty') {
          throw new Error(job.resultPolicy === 'deliver_relevant_only'
            ? `Automation completed without a final response. Return ${NO_ACTION_TOKEN} when there are no relevant updates.`
            : 'Automation completed without a final response.');
        }
        const automationNoop = automationResult?.kind === 'no_action';
        dispatchResult = automationNoop
          ? {
              attempted: false,
              delivered: false,
              skippedReason: 'no_action',
              error: null,
            }
          : await dispatchAutomationResult({
              job,
              userId: automationUserId,
              resolution: deliveryResolution,
              text: assistantText,
            });
        assertAutomationExecutionActive(executionSignal);
        const deliveryFailureMessage = getAutomationDeliveryFailureMessage(deliveryResolution, dispatchResult);
        if (deliveryFailureMessage) {
          throw new Error(deliveryFailureMessage);
        }
        if (automationNoop) {
          await finalizePiSessionAfterNoop({
            sessionId: piSessionId,
            userId: automationUserId,
            agentId: job.agentId,
            retainedMessageCount: existingMessages.length,
            deleteSessionIfEmpty: !persistedSession,
            title: persistedSession?.title,
            titleGenerationState: persistedSession?.titleGenerationState,
          });
        } else {
          const persistedFinalMessages = buildPersistedAutomationMessages({
            existingMessages,
            promptMessage,
            runMessages: finalMessages,
          });
          const persistedLength = getAutomationPersistedLength({
            existingMessagesLength: existingMessages.length,
            promptPersistedBeforeRun,
          });
          await savePiSession(
            piSessionId,
            automationUserId,
            provider,
            model.id,
            persistedFinalMessages,
            undefined,
            {
              titleOverride: piSessionTitle,
              agentId: job.agentId,
              persistedLength,
              channelId: deliveryResolution.channelId,
              channelSessionKey: deliveryResolution.channelSessionKey || null,
              workspaceId: automationWorkspace.workspaceId,
            },
          );
        }
        assertAutomationExecutionActive(executionSignal);
        console.log(`[Automationen] Saved session ${piSessionId} for run ${runId}`);
        const finishedRun = await markAutomationRunFinished(run.id, {
          status: 'success',
          resultText: automationNoop
            ? 'Automation completed without relevant updates.'
            : assistantText || 'Run completed without assistant text output.',
          eventsLog: events,
          metadataJson: {
            provider,
            model: model.id,
            runtime: buildAutomationRuntimeMetadata(executableRuntime),
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            ...(automationResult ? {
              automation: {
                outcome: automationNoop ? 'no_action' : 'message',
                acknowledgement: automationNoop ? NO_ACTION_TOKEN : null,
                deliverySuppressed: automationNoop,
                resultPolicy: job.resultPolicy,
              },
            } : {}),
            status: 'success',
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          },
          expectation: runTransitionExpectation,
        });
        if (!finishedRun) {
          console.warn(`[Automationen] Run ${runId} completed but its terminal transition lost the run CAS`);
          return;
        }
        await markWorkspaceEmailAutomationEventRunFinished({ run: finishedRun, status: 'success' });
        if (run.triggerType === 'scheduled' && !automationNoop) {
          await sendAutomationTerminalPush({
            userId: automationUserId,
            workspaceId: automationWorkspace.workspaceId,
            runId: run.id,
            jobName: job.name,
            triggerType: run.triggerType,
            status: 'success',
          });
        } else if (!automationNoop) {
          queueAutomationResponsePush({
            userId: automationUserId,
            workspaceId: automationWorkspace.workspaceId,
            sessionId: piSessionId,
            job,
            resolution: deliveryResolution,
          });
        }
        const duration = Date.now() - runStartTime;
        console.log(`[Automationen] Run ${runId} completed successfully (duration=${duration}ms)`);
      } catch (error) {
        assertAutomationExecutionActive(executionSignal);
        const message = error instanceof Error ? error.message : 'Automation run failed.';
        const pauseJobAfterFailure = shouldPauseAutomationAfterDeliveryFailure(dispatchResult);
        const retryAt = pauseJobAfterFailure ? null : calculateRetryAt(runTransitionExpectation.attemptNumber);
        const fallbackErrorMessage = createAutomationErrorMessage(message, model.provider, model.id, model.api);
        const persistedMessages = finalMessages.length > 0
          ? (extractAssistantText(finalMessages) ? finalMessages : [...finalMessages, fallbackErrorMessage])
          : [promptMessage, fallbackErrorMessage];
        const failureResultText = `Automation failed: ${message}`;

        const persistedFailureMessages = buildPersistedAutomationMessages({
          existingMessages,
          promptMessage,
          runMessages: persistedMessages,
        });
        const persistedLength = getAutomationPersistedLength({
          existingMessagesLength: existingMessages.length,
          promptPersistedBeforeRun,
        });
        if (sessionReadyForPersistence) {
          await savePiSession(
            piSessionId,
            automationUserId,
            provider,
            model.id,
            persistedFailureMessages,
            undefined,
            {
              titleOverride: piSessionTitle,
              agentId: job.agentId,
              persistedLength,
              channelId: deliveryResolution.channelId,
              channelSessionKey: deliveryResolution.channelSessionKey || null,
              workspaceId: automationWorkspace.workspaceId,
            },
          );
          assertAutomationExecutionActive(executionSignal);
        }

        if (retryAt) {
          const retryScheduled = await markAutomationRunRetryScheduled(run.id, retryAt, message, events, {
            provider,
            model: model.id,
            runtime: buildAutomationRuntimeMetadata(executableRuntime),
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            status: 'retry_scheduled',
            loopQuiescent: true,
            retryAt: retryAt.toISOString(),
            error: message,
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          }, runTransitionExpectation, failureResultText);
          if (!retryScheduled) {
            console.warn(`[Automationen] Run ${runId} could not schedule a retry because its status or attempt changed`);
            return;
          }
          const duration = Date.now() - runStartTime;
          console.warn(`[Automationen] Run ${runId} failed, scheduling retry #${runTransitionExpectation.attemptNumber} at ${retryAt.toISOString()} (duration=${duration}ms): ${message}`);
          return;
        }

        const failedRun = await markAutomationRunFinished(run.id, {
          status: 'failed',
          errorMessage: message,
          resultText: failureResultText,
          eventsLog: events,
          metadataJson: {
            provider,
            model: model.id,
            runtime: buildAutomationRuntimeMetadata(executableRuntime),
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            status: 'failed',
            loopQuiescent: true,
            error: message,
            automationPaused: pauseJobAfterFailure,
            automationPauseReason: dispatchResult?.skippedReason ?? null,
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          },
          expectation: runTransitionExpectation,
        });
        if (!failedRun) {
          console.warn(`[Automationen] Run ${runId} could not be marked failed because its status or attempt changed`);
          return;
        }
        await markWorkspaceEmailAutomationEventRunFinished({ run: failedRun, status: 'failed', errorMessage: message });
        await sendAutomationTerminalPush({
          userId: automationUserId,
          workspaceId: job.workspaceId,
          runId: run.id,
          jobName: job.name,
          triggerType: run.triggerType,
          status: 'failed',
        });
        if (pauseJobAfterFailure) {
          await updateAutomationJob(job.id, { status: 'paused' });
          console.warn(`[Automationen] Paused job ${job.id} because delivery channel is unavailable (${dispatchResult?.skippedReason ?? 'unknown'})`);
        }
        const duration = Date.now() - runStartTime;
        console.error(`[Automationen] Run ${runId} failed permanently (duration=${duration}ms): ${message}`);
      }
              }),
            ),
          });
        } catch (error) {
          if (error instanceof AutomationLoopShutdownError) {
            reservation.lease.holdUntil(error.operationSettlement);
          }
          throw error;
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation run preparation failed.';
    if (error instanceof AutomationRunClaimLostError) {
      console.warn(`[Automationen] Run ${runId} stopped because its claim was lost before session execution`);
      return;
    }
    if (error instanceof AutomationRunTimeoutError || error instanceof AutomationLoopShutdownError) {
      const loopQuiescent = !(error instanceof AutomationLoopShutdownError);
      const failedRun = await markAutomationRunFinished(run.id, {
        status: 'failed',
        errorMessage: message,
        resultText: `Automation failed: ${message}`,
        eventsLog: [],
        metadataJson: {
          agentId: job.agentId,
          status: 'failed',
          stage: 'execution_timeout',
          loopQuiescent,
          error: message,
        },
        expectation: runTransitionExpectation,
      });
      if (!failedRun) {
        console.warn(`[Automationen] Run ${runId} timeout lost the run CAS; leaving the current terminal state unchanged`);
        return;
      }
      await markWorkspaceEmailAutomationEventRunFinished({ run: failedRun, status: 'failed', errorMessage: message });
      await sendAutomationTerminalPush({
        userId: automationUserId,
        workspaceId: job.workspaceId,
        runId: run.id,
        jobName: job.name,
        triggerType: run.triggerType,
        status: 'failed',
      });
      console.error(`[Automationen] Run ${runId} exceeded its execution deadline (quiescent=${loopQuiescent}): ${message}`);
      return;
    }
    if (error instanceof PiSessionBusyError) {
      const retryAt = calculateRetryAt(runTransitionExpectation.attemptNumber);
      if (retryAt) {
        const retryScheduled = await markAutomationRunRetryScheduled(run.id, retryAt, message, [], {
          agentId: job.agentId,
          status: 'retry_scheduled',
          stage: 'session_reservation',
          retryAt: retryAt.toISOString(),
          error: message,
        }, runTransitionExpectation, `Automation delayed: ${message}`);
        if (!retryScheduled) {
          console.warn(`[Automationen] Run ${runId} stayed unchanged because its busy retry lost the run CAS`);
          return;
        }
        console.warn(
          `[Automationen] Run ${runId} delayed because session is busy; retry scheduled at ${retryAt.toISOString()}.`,
        );
        return;
      }
    }
    const failedRun = await markAutomationRunFinished(run.id, {
      status: 'failed',
      errorMessage: message,
      resultText: `Automation failed during preparation: ${message}`,
      eventsLog: [],
      metadataJson: {
        agentId: job.agentId,
        status: 'failed',
        stage: 'prepare',
        error: message,
      },
      expectation: runTransitionExpectation,
    });
    if (!failedRun) {
      console.warn(`[Automationen] Run ${runId} preparation failure lost the run CAS; leaving the current state unchanged`);
      return;
    }
    await markWorkspaceEmailAutomationEventRunFinished({ run: failedRun, status: 'failed', errorMessage: message });
    await sendAutomationTerminalPush({
      userId: automationUserId,
      workspaceId: job.workspaceId,
      runId: run.id,
      jobName: job.name,
      triggerType: run.triggerType,
      status: 'failed',
    });
    const duration = Date.now() - runStartTime;
    console.error(`[Automationen] Run ${runId} failed during preparation (duration=${duration}ms): ${message}`);
  }
}
