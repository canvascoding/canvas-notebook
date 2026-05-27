import path from 'node:path';

import { agentLoop, type AgentContext, type AgentMessage, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Api, Provider } from '@mariozechner/pi-ai';

import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { createDirectory } from '@/app/lib/filesystem/workspace-files';
import { resolveActivePiModel } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { loadPiSessionWithSummary, savePiSession } from '@/app/lib/pi/session-store';
import { getPiTools } from '@/app/lib/pi/tool-registry';

import { getEffectiveAutomationTargetOutputPath } from './paths';
import { buildAutomationPrompt } from './prompt';
import { executeHeartbeat } from './heartbeat';
import { resolveAutomationDeliveryTarget, type AutomationDeliveryResolution } from './delivery';
import {
  getAutomationJob,
  getAutomationRun,
  markAutomationRunFinished,
  markAutomationRunRetryScheduled,
  markAutomationRunStarted,
} from './store';
import { type AutomationJobRecord, type AutomationRunRecord } from './types';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000] as const;
const MAX_EVENTS_LOG = 500;
const MAX_EVENT_JSON_LENGTH = 10_000;
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

function createAutomationErrorMessage(message: string, provider: Provider, modelId: string, api: Api): AgentMessage {
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

function buildAutomationRunMetadata(job: AutomationJobRecord, resolution?: AutomationDeliveryResolution) {
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

  console.log(`[Automationen] Starting run ${runId} for job "${job.name}" (type=${job.jobType})`);

  const effectiveTargetOutputPath = getEffectiveAutomationTargetOutputPath(job);

  if (job.jobType === 'heartbeat') {
    console.log(`[Automationen] Executing heartbeat for run ${runId}`);
    const heartbeatRunSessionId = `heartbeat-${run.id}`;
    const startedRun = await markAutomationRunStarted(run.id, {
      outputDir: null,
      targetOutputPath: job.targetOutputPath,
      effectiveTargetOutputPath: effectiveTargetOutputPath || null,
      logPath: '',
      resultPath: null,
      piSessionId: heartbeatRunSessionId,
      eventsLog: [],
    });

    if (!startedRun) {
      console.warn(`[Automationen] Heartbeat run ${runId} could not be marked as started (already running?), aborting`);
      return;
    }

    const heartbeatResult = await executeHeartbeat(job);
    const heartbeatDuration = Date.now() - runStartTime;

    const heartbeatStatus = heartbeatResult.errors.length > 0 && heartbeatResult.usersNotified === 0 ? 'failed' : 'success';
    await markAutomationRunFinished(run.id, {
      status: heartbeatStatus,
      errorMessage: heartbeatResult.errors.length > 0 ? heartbeatResult.errors.join('; ') : null,
      piSessionId: heartbeatResult.sessionIds[0] || heartbeatRunSessionId,
      eventsLog: [],
      metadataJson: {
        provider: 'heartbeat',
        model: 'heartbeat',
        ...buildAutomationRunMetadata(job),
        status: heartbeatResult.usersNotified > 0 ? 'success' : 'skipped',
        heartbeatUsersNotified: heartbeatResult.usersNotified,
        heartbeatSessionIds: heartbeatResult.sessionIds,
        heartbeatErrors: heartbeatResult.errors,
      },
    });

    console.log(`[Automationen] Heartbeat run ${runId} finished (status=${heartbeatStatus}, duration=${heartbeatDuration}ms, notified=${heartbeatResult.usersNotified}, errors=${heartbeatResult.errors.length})`);
    return;
  }

  if (effectiveTargetOutputPath) {
    const targetParentDir = path.posix.dirname(effectiveTargetOutputPath);
    if (targetParentDir && targetParentDir !== '.') {
      await createDirectory(targetParentDir);
    }
  }

  const promptText = buildAutomationPrompt({
    name: job.name,
    workspaceContextPaths: job.workspaceContextPaths,
    prompt: job.prompt,
    preferredSkill: job.preferredSkill,
    effectiveTargetOutputPath,
    webhookContext: run.triggerType === 'webhook' ? getWebhookPromptContext(run) : null,
  });

  const defaultPiSessionId = buildAutomationSessionId(run.id);
  const deliveryResolution = await resolveAutomationDeliveryTarget({
    job,
    userId: job.createdByUserId,
    defaultSessionId: defaultPiSessionId,
  });
  const piSessionId = deliveryResolution.sessionId;
  const piSessionTitle = buildAutomationSessionTitle(job.name);
  
  const events: string[] = [];
  let finalMessages: AgentMessage[] = [];
  const existingSession = deliveryResolution.mode === 'new_session'
    ? null
    : await loadPiSessionWithSummary(piSessionId, job.createdByUserId);
  const existingMessages = existingSession?.messages ?? [];

  const piConfig = await readPiRuntimeConfig();
  const provider = piConfig.activeProvider;
  const providerConfig = piConfig.providers[provider];
  const model = await resolveActivePiModel();
  console.log(`[Automationen] Run ${runId} using provider=${provider}, model=${model.id}`);

  const tools = await getPiTools();
  const { systemPrompt } = await loadManagedAgentSystemPrompt(job.agentId);
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
      job.createdByUserId,
      provider,
      model.id,
      [...existingMessages, promptMessage],
      undefined,
      {
        titleOverride: piSessionTitle,
        agentId: job.agentId,
        persistedLength: existingMessages.length,
      },
    );

    console.log(`[Automationen] Starting agent loop for run ${runId} (provider=${provider}, model=${model.id})`);
    for await (const event of agentLoop([promptMessage], context, config, undefined)) {
      if (events.length < MAX_EVENTS_LOG) {
        const json = JSON.stringify(event);
        events.push(json.length > MAX_EVENT_JSON_LENGTH ? json.slice(0, MAX_EVENT_JSON_LENGTH) + '...[truncated]' : json);
      }
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }
    console.log(`[Automationen] Agent loop completed for run ${runId} (events=${events.length})`);

    const assistantError = getAssistantError(finalMessages);
    if (assistantError) {
      throw new Error(assistantError);
    }

    const assistantText = extractAssistantText(finalMessages);
    const persistedFinalMessages = finalMessages.length >= existingMessages.length
      ? finalMessages
      : [...existingMessages, ...finalMessages];
    await savePiSession(
      piSessionId,
      job.createdByUserId,
      provider,
      model.id,
      persistedFinalMessages,
      undefined,
      {
        titleOverride: piSessionTitle,
        agentId: job.agentId,
        persistedLength: existingMessages.length,
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
        ...buildAutomationRunMetadata(job, deliveryResolution),
        status: 'success',
        targetOutputPath: job.targetOutputPath,
        effectiveTargetOutputPath,
      },
    });
    const duration = Date.now() - runStartTime;
    console.log(`[Automationen] Run ${runId} completed successfully (duration=${duration}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation run failed.';
    const retryAt = calculateRetryAt(run.attemptNumber);
    const persistedMessages = finalMessages.length > 0
      ? finalMessages
      : [promptMessage, createAutomationErrorMessage(message, model.provider, model.id, model.api)];
    const failureResultText = `Automation failed: ${message}`;

    const persistedFailureMessages = persistedMessages.length >= existingMessages.length
      ? persistedMessages
      : [...existingMessages, ...persistedMessages];
    await savePiSession(
      piSessionId,
      job.createdByUserId,
      provider,
      model.id,
      persistedFailureMessages,
      undefined,
      {
        titleOverride: piSessionTitle,
        agentId: job.agentId,
        persistedLength: existingMessages.length,
      },
    );

    if (retryAt) {
      await markAutomationRunRetryScheduled(run.id, retryAt, message, events, {
        provider,
        model: model.id,
        ...buildAutomationRunMetadata(job, deliveryResolution),
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
        ...buildAutomationRunMetadata(job, deliveryResolution),
        status: 'failed',
        error: message,
        targetOutputPath: job.targetOutputPath,
        effectiveTargetOutputPath,
      },
    });
    const duration = Date.now() - runStartTime;
    console.error(`[Automationen] Run ${runId} failed permanently (duration=${duration}ms): ${message}`);
  }
}
