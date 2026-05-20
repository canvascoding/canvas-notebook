import path from 'node:path';

import { agentLoop, type AgentContext, type AgentMessage, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Api, Provider } from '@mariozechner/pi-ai';

import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { createDirectory, writeFile } from '@/app/lib/filesystem/workspace-files';
import { resolveActivePiModel } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { savePiSession } from '@/app/lib/pi/session-store';
import { getPiTools } from '@/app/lib/pi/tool-registry';

import { getEffectiveAutomationTargetOutputPath, slugifyAutomationName } from './paths';
import { buildAutomationPrompt } from './prompt';
import { executeHeartbeat } from './heartbeat';
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

function buildOutputPaths(job: AutomationJobRecord, run: AutomationRunRecord) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.posix.join('automationen', slugifyAutomationName(job.name), 'runs', `${timestamp}-${run.id}`);

  return {
    outputDir,
    resultPath: path.posix.join(outputDir, 'result.md'),
    errorPath: path.posix.join(outputDir, 'error.txt'),
  };
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

  const outputPaths = buildOutputPaths(job, run);
  const effectiveTargetOutputPath = getEffectiveAutomationTargetOutputPath(job);

  if (job.jobType === 'heartbeat') {
    console.log(`[Automationen] Executing heartbeat for run ${runId}`);
    const heartbeatResult = await executeHeartbeat(job);
    const heartbeatDuration = Date.now() - runStartTime;

    await markAutomationRunStarted(run.id, {
      outputDir: outputPaths.outputDir,
      targetOutputPath: job.targetOutputPath,
      effectiveTargetOutputPath: effectiveTargetOutputPath || '',
      logPath: '',
      resultPath: outputPaths.resultPath,
      piSessionId: heartbeatResult.sessionIds[0] || `heartbeat-${run.id}`,
      eventsLog: [],
    });

    const heartbeatStatus = heartbeatResult.errors.length > 0 && heartbeatResult.usersNotified === 0 ? 'failed' : 'success';
    await markAutomationRunFinished(run.id, {
      status: heartbeatStatus,
      errorMessage: heartbeatResult.errors.length > 0 ? heartbeatResult.errors.join('; ') : null,
      eventsLog: [],
      metadataJson: {
        provider: 'heartbeat',
        model: 'heartbeat',
        status: heartbeatResult.usersNotified > 0 ? 'success' : 'skipped',
        heartbeatUsersNotified: heartbeatResult.usersNotified,
        heartbeatSessionIds: heartbeatResult.sessionIds,
        heartbeatErrors: heartbeatResult.errors,
      },
    });

    console.log(`[Automationen] Heartbeat run ${runId} finished (status=${heartbeatStatus}, duration=${heartbeatDuration}ms, notified=${heartbeatResult.usersNotified}, errors=${heartbeatResult.errors.length})`);
    return;
  }

  await createDirectory(outputPaths.outputDir);
  await createDirectory(path.dirname(effectiveTargetOutputPath));

  const promptText = buildAutomationPrompt({
    name: job.name,
    workspaceContextPaths: job.workspaceContextPaths,
    prompt: job.prompt,
    preferredSkill: job.preferredSkill,
    effectiveTargetOutputPath,
    runArtifactDir: outputPaths.outputDir,
    webhookContext: run.triggerType === 'webhook' ? getWebhookPromptContext(run) : null,
  });

  const piSessionId = buildAutomationSessionId(run.id);
  const piSessionTitle = buildAutomationSessionTitle(job.name);
  
  const events: string[] = [];
  let finalMessages: AgentMessage[] = [];

  const piConfig = await readPiRuntimeConfig();
  const provider = piConfig.activeProvider;
  const providerConfig = piConfig.providers[provider];
  const model = await resolveActivePiModel();
  console.log(`[Automationen] Run ${runId} using provider=${provider}, model=${model.id}`);

  const tools = await getPiTools();
  const { systemPrompt } = await loadManagedAgentSystemPrompt();
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
    messages: [],
    tools,
  };

  const startedRun = await markAutomationRunStarted(run.id, {
    outputDir: outputPaths.outputDir,
    targetOutputPath: job.targetOutputPath,
    effectiveTargetOutputPath,
    logPath: '',
    resultPath: outputPaths.resultPath,
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
      [promptMessage],
      undefined,
      { titleOverride: piSessionTitle },
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
    await writeFile(outputPaths.resultPath, assistantText || 'Run completed without assistant text output.');
    await savePiSession(
      piSessionId,
      job.createdByUserId,
      provider,
      model.id,
      finalMessages,
      undefined,
      { titleOverride: piSessionTitle },
    );
    console.log(`[Automationen] Saved session ${piSessionId} for run ${runId}`);
    await markAutomationRunFinished(run.id, {
      status: 'success',
      eventsLog: events,
      metadataJson: {
        provider,
        model: model.id,
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

    await writeFile(outputPaths.resultPath, `Automation failed: ${message}\n`);
    await writeFile(outputPaths.errorPath, message);
    await savePiSession(
      piSessionId,
      job.createdByUserId,
      provider,
      model.id,
      persistedMessages,
      undefined,
      { titleOverride: piSessionTitle },
    );

    if (retryAt) {
      await markAutomationRunRetryScheduled(run.id, retryAt, message, events, {
        provider,
        model: model.id,
        status: 'retry_scheduled',
        retryAt: retryAt.toISOString(),
        error: message,
        targetOutputPath: job.targetOutputPath,
        effectiveTargetOutputPath,
      });
      const duration = Date.now() - runStartTime;
      console.warn(`[Automationen] Run ${runId} failed, scheduling retry #${run.attemptNumber} at ${retryAt.toISOString()} (duration=${duration}ms): ${message}`);
      return;
    }

    await markAutomationRunFinished(run.id, {
      status: 'failed',
      errorMessage: message,
      eventsLog: events,
      metadataJson: {
        provider,
        model: model.id,
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
