import path from 'node:path';

import { agentLoop, type AgentContext, type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, ProviderId } from '@earendil-works/pi-ai';

import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { loadPiSessionWithSummary, savePiSession } from '@/app/lib/pi/session-store';
import { runWithAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { workspaceToAgentExecutionContext } from '@/app/lib/pi/session-workspace-context';
import { loadPiSessionSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import { getPiTools } from '@/app/lib/pi/tool-registry';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { buildAutomationPrompt } from './prompt';
import { buildHeartbeatPrompt } from './heartbeat';
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
  updateAutomationJob,
} from './store';
import { resolveAutomationRunWorkspace } from './policy';
import { type AutomationJobRecord, type AutomationRunRecord } from './types';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000] as const;
const MAX_EVENTS_LOG = 500;
const MAX_EVENT_JSON_LENGTH = 10_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
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

function createRunTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Automation run timed out after ${ms}ms`)), ms);
  });
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

export async function executeAutomationRun(runId: string): Promise<void> {
  const runStartTime = Date.now();
  const run = await getAutomationRun(runId);
  if (!run) {
    console.warn(`[Automationen] Run ${runId} not found, skipping`);
    return;
  }

  const job = await getAutomationJob(run.jobId);
  if (!job) {
    console.error(`[Automationen] Job ${run.jobId} not found for run ${runId}`);
    await markAutomationRunFinished(runId, {
      status: 'failed',
      errorMessage: 'Automation job not found.',
      eventsLog: [],
      metadataJson: { provider: 'unknown', model: 'unknown', status: 'failed' },
    });
    return;
  }

  const automationUserId = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
  console.log(`[Automationen] Starting run ${runId} for job "${job.name}" (type=${job.jobType}, scope=${job.scope}, workspace=${job.workspaceId ?? 'legacy'})`);

  try {
    const defaultPiSessionId = buildAutomationSessionId(run.id);
    const deliveryResolution = await resolveAutomationDeliveryTarget({
      job,
      userId: automationUserId,
      defaultSessionId: defaultPiSessionId,
    });
    const piSessionId = deliveryResolution.sessionId;
    const piSessionTitle = buildAutomationSessionTitle(job.name);
    const automationWorkspace = await resolveAutomationRunWorkspace(job);
    const executionContext = workspaceToAgentExecutionContext({
      workspace: automationWorkspace,
      userId: automationUserId,
      sessionId: piSessionId,
      agentId: job.agentId,
    });

    await runWithAgentExecutionContext(executionContext, async () => {
      const effectiveTargetOutputPath = getEffectiveAutomationTargetOutputPath(job);

      if (effectiveTargetOutputPath) {
        const targetParentDir = path.posix.dirname(effectiveTargetOutputPath);
        if (targetParentDir && targetParentDir !== '.') {
          await createDirectory(targetParentDir, { workspace: automationWorkspace });
        }
      }

      const includeAutomatedHeartbeatContext = job.jobType === 'heartbeat' && run.triggerType !== 'manual';
      const jobPrompt = job.jobType === 'heartbeat'
        ? await buildHeartbeatPrompt(job, { includeAutomatedRuntimeContext: includeAutomatedHeartbeatContext })
        : job.prompt;
      const promptText = buildAutomationPrompt({
        name: job.name,
        workspaceContextPaths: job.workspaceContextPaths,
        prompt: jobPrompt,
        preferredSkill: job.preferredSkill,
        executionKind: job.jobType === 'heartbeat' ? 'heartbeat' : 'automation',
        effectiveTargetOutputPath,
        webhookContext: run.triggerType === 'webhook' ? getWebhookPromptContext(run) : null,
      });

      const events: string[] = [];
      let finalMessages: AgentMessage[] = [];
      let dispatchResult: AutomationDeliveryDispatchResult | undefined;
      let promptPersistedBeforeRun = false;
      const existingSession = deliveryResolution.mode === 'new_session'
        ? null
        : await loadPiSessionWithSummary(piSessionId, automationUserId, job.agentId);
      const existingMessages = existingSession?.messages ?? [];

      const effectiveConfig = await resolveAgentRuntimeConfig(job.agentId);
      const provider = effectiveConfig.activeProvider;
      const providerConfig = effectiveConfig.providerConfig;
      const model = effectiveConfig.model;
      console.log(`[Automationen] Run ${runId} using provider=${provider}, model=${model.id}`);

      const tools = await getPiTools(automationUserId, job.agentId, piSessionId);
      const promptSnapshot = await loadPiSessionSystemPromptSnapshot({
        sessionId: piSessionId,
        userId: automationUserId,
        agentId: job.agentId,
      });
      const systemPrompt = promptSnapshot.systemPrompt;
      const promptMessage: AgentMessage = {
        role: 'user',
        content: promptText,
        timestamp: Date.now(),
      };
      const config = {
        model,
        thinkingLevel: (providerConfig?.thinking || 'off') as ThinkingLevel,
        convertToLlm: async (messages: AgentMessage[]) => normalizePiMessagesForLlm(messages),
        getApiKey: resolvePiApiKey,
        sessionId: piSessionId,
      };
      const context: AgentContext = {
        systemPrompt,
        messages: existingMessages,
        tools,
      };

      const startedRun = await markAutomationRunStarted(run.id, {
        outputDir: null,
        targetOutputPath: job.targetOutputPath,
        effectiveTargetOutputPath: effectiveTargetOutputPath || null,
        logPath: '',
        resultPath: null,
        piSessionId,
        eventsLog: [],
      });

      if (!startedRun) {
        console.warn(`[Automationen] Run ${runId} could not be marked as started (already running?), aborting`);
        return;
      }

      try {
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

        console.log(`[Automationen] Starting agent loop for run ${runId} (provider=${provider}, model=${model.id})`);
        const agentLoopPromise = (async () => {
          const loopEvents: string[] = [];
          let loopMessages: AgentMessage[] = [];
          for await (const event of agentLoop([promptMessage], context, config, undefined)) {
            if (loopEvents.length < MAX_EVENTS_LOG) {
              const json = JSON.stringify(event);
              loopEvents.push(json.length > MAX_EVENT_JSON_LENGTH ? json.slice(0, MAX_EVENT_JSON_LENGTH) + '...[truncated]' : json);
            }
            if (event.type === 'agent_end') {
              loopMessages = event.messages;
            }
          }
          return { loopEvents, loopMessages };
        })();

        const { loopEvents, loopMessages } = await Promise.race([agentLoopPromise, createRunTimeoutPromise(RUN_TIMEOUT_MS)]);
        events.push(...loopEvents);
        finalMessages = loopMessages;
        console.log(`[Automationen] Agent loop completed for run ${runId} (events=${events.length})`);

        const assistantError = getAssistantError(finalMessages);
        if (assistantError) {
          throw new Error(assistantError);
        }

        const assistantText = extractAssistantText(finalMessages);
        dispatchResult = await dispatchAutomationResult({
          job,
          userId: automationUserId,
          resolution: deliveryResolution,
          text: assistantText,
        });
        const deliveryFailureMessage = getAutomationDeliveryFailureMessage(deliveryResolution, dispatchResult);
        if (deliveryFailureMessage) {
          throw new Error(deliveryFailureMessage);
        }
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
        console.log(`[Automationen] Saved session ${piSessionId} for run ${runId}`);
        await markAutomationRunFinished(run.id, {
          status: 'success',
          resultText: assistantText || 'Run completed without assistant text output.',
          eventsLog: events,
          metadataJson: {
            provider,
            model: model.id,
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            status: 'success',
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          },
        });
        const duration = Date.now() - runStartTime;
        console.log(`[Automationen] Run ${runId} completed successfully (duration=${duration}ms)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Automation run failed.';
        const pauseJobAfterFailure = shouldPauseAutomationAfterDeliveryFailure(dispatchResult);
        const retryAt = pauseJobAfterFailure ? null : calculateRetryAt(run.attemptNumber);
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

        if (retryAt) {
          await markAutomationRunRetryScheduled(run.id, retryAt, message, events, {
            provider,
            model: model.id,
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            status: 'retry_scheduled',
            retryAt: retryAt.toISOString(),
            error: message,
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          }, failureResultText);
          const duration = Date.now() - runStartTime;
          console.warn(`[Automationen] Run ${runId} failed, scheduling retry #${run.attemptNumber} at ${retryAt.toISOString()} (duration=${duration}ms): ${message}`);
          return;
        }

        await markAutomationRunFinished(run.id, {
          status: 'failed',
          errorMessage: message,
          resultText: failureResultText,
          eventsLog: events,
          metadataJson: {
            provider,
            model: model.id,
            ...buildAutomationRunMetadata(job, deliveryResolution, dispatchResult),
            status: 'failed',
            error: message,
            automationPaused: pauseJobAfterFailure,
            automationPauseReason: dispatchResult?.skippedReason ?? null,
            targetOutputPath: job.targetOutputPath,
            effectiveTargetOutputPath,
          },
        });
        if (pauseJobAfterFailure) {
          await updateAutomationJob(job.id, { status: 'paused' });
          console.warn(`[Automationen] Paused job ${job.id} because delivery channel is unavailable (${dispatchResult?.skippedReason ?? 'unknown'})`);
        }
        const duration = Date.now() - runStartTime;
        console.error(`[Automationen] Run ${runId} failed permanently (duration=${duration}ms): ${message}`);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation run preparation failed.';
    await markAutomationRunFinished(run.id, {
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
    });
    const duration = Date.now() - runStartTime;
    console.error(`[Automationen] Run ${runId} failed during preparation (duration=${duration}ms): ${message}`);
  }
}
