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
  const run = await getAutomationRun(runId);
  if (!run) {
    return;
  }

  const job = await getAutomationJob(run.jobId);
  if (!job) {
    await markAutomationRunFinished(runId, { 
      status: 'failed', 
      errorMessage: 'Automation job not found.',
      eventsLog: [],
      metadataJson: { provider: 'unknown', model: 'unknown', status: 'failed' },
    });
    return;
  }

  const outputPaths = buildOutputPaths(job, run);
  const effectiveTargetOutputPath = getEffectiveAutomationTargetOutputPath(job);
  await createDirectory(outputPaths.outputDir);
  await createDirectory(effectiveTargetOutputPath);

  const promptText = buildAutomationPrompt({
    name: job.name,
    workspaceContextPaths: job.workspaceContextPaths,
    prompt: job.prompt,
    effectiveTargetOutputPath,
    runArtifactDir: outputPaths.outputDir,
  });

  const piSessionId = buildAutomationSessionId(run.id);
  const piSessionTitle = buildAutomationSessionTitle(job.name);
  
  // Start collecting events before run starts
  const events: string[] = [];
  let finalMessages: AgentMessage[] = [];

  const piConfig = await readPiRuntimeConfig();
  const provider = piConfig.activeProvider;
  const providerConfig = piConfig.providers[provider];
  const model = await resolveActivePiModel();
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
    logPath: '', // No longer used - events stored in DB
    resultPath: outputPaths.resultPath,
    piSessionId,
    eventsLog: [],
  });

  if (!startedRun) {
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

    for await (const event of agentLoop([promptMessage], context, config, undefined)) {
      events.push(JSON.stringify(event));
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }

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
  }
}
