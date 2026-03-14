import path from 'node:path';

import { agentLoop, type AgentContext, type AgentMessage, type ThinkingLevel } from '@mariozechner/pi-agent-core';

import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { createDirectory, writeFile } from '@/app/lib/filesystem/workspace-files';
import { resolveActivePiModel } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { normalizePiMessagesForLlm } from '@/app/lib/pi/message-normalization';
import { savePiSession } from '@/app/lib/pi/session-store';
import { getPiTools } from '@/app/lib/pi/tool-registry';

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'automation';
}

function buildPrompt(job: AutomationJobRecord): string {
  const sections = [
    `Automation name: ${job.name}`,
    `Preferred skill hint: ${job.preferredSkill}`,
  ];

  if (job.workspaceContextPaths.length > 0) {
    sections.push(`Relevant workspace paths:\n${job.workspaceContextPaths.map((entry) => `- ${entry}`).join('\n')}`);
  } else {
    sections.push('Relevant workspace paths:\n- none selected');
  }

  sections.push(`Task:\n${job.prompt}`);
  sections.push('Use workspace-relative file operations. Read the listed paths when relevant instead of assuming their contents.');

  return sections.join('\n\n');
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

function buildOutputPaths(job: AutomationJobRecord, run: AutomationRunRecord) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.posix.join('automationen', slugify(job.name), 'runs', `${timestamp}-${run.id}`);

  return {
    outputDir,
    logPath: path.posix.join(outputDir, 'events.log'),
    promptPath: path.posix.join(outputDir, 'prompt.md'),
    resultPath: path.posix.join(outputDir, 'result.md'),
    metadataPath: path.posix.join(outputDir, 'run.json'),
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

async function writeRunMetadata(
  metadataPath: string,
  job: AutomationJobRecord,
  run: AutomationRunRecord,
  extra: Record<string, unknown>,
) {
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        job,
        run,
        ...extra,
      },
      null,
      2,
    ),
  );
}

export async function executeAutomationRun(runId: string): Promise<void> {
  const run = await getAutomationRun(runId);
  if (!run) {
    return;
  }

  const job = await getAutomationJob(run.jobId);
  if (!job) {
    await markAutomationRunFinished(runId, { status: 'failed', errorMessage: 'Automation job not found.' });
    return;
  }

  const outputPaths = buildOutputPaths(job, run);
  await createDirectory(outputPaths.outputDir);

  const promptText = buildPrompt(job);
  await writeFile(outputPaths.promptPath, promptText);
  await writeFile(outputPaths.logPath, '');

  const piSessionId = `automation-${job.id}-${run.id}`;
  const startedRun = await markAutomationRunStarted(run.id, {
    outputDir: outputPaths.outputDir,
    logPath: outputPaths.logPath,
    resultPath: outputPaths.resultPath,
    piSessionId,
  });

  if (!startedRun) {
    return;
  }

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
    thinkingLevel: (providerConfig?.thinking || 'none') as ThinkingLevel,
    convertToLlm: async (messages: AgentMessage[]) => normalizePiMessagesForLlm(messages),
    getApiKey: resolvePiApiKey,
    sessionId: piSessionId,
  };
  const context: AgentContext = {
    systemPrompt,
    messages: [],
    tools,
  };
  const events: string[] = [];
  let finalMessages: AgentMessage[] = [];

  try {
    for await (const event of agentLoop([promptMessage], context, config, undefined)) {
      events.push(JSON.stringify(event));
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }

    const assistantText = extractAssistantText(finalMessages);
    await writeFile(outputPaths.logPath, `${events.join('\n')}\n`);
    await writeFile(outputPaths.resultPath, assistantText || 'Run completed without assistant text output.');
    await savePiSession(piSessionId, job.createdByUserId, provider, model.id, finalMessages);
    await markAutomationRunFinished(run.id, { status: 'success' });
    await writeRunMetadata(outputPaths.metadataPath, job, startedRun, {
      provider,
      model: model.id,
      status: 'success',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation run failed.';
    const retryAt = calculateRetryAt(run.attemptNumber);

    await writeFile(outputPaths.logPath, `${events.join('\n')}\n`);
    await writeFile(outputPaths.errorPath, message);

    if (retryAt) {
      await markAutomationRunRetryScheduled(run.id, retryAt, message);
      await writeRunMetadata(outputPaths.metadataPath, job, startedRun, {
        provider,
        model: model.id,
        status: 'retry_scheduled',
        retryAt: retryAt.toISOString(),
        error: message,
      });
      return;
    }

    await markAutomationRunFinished(run.id, { status: 'failed', errorMessage: message });
    await writeRunMetadata(outputPaths.metadataPath, job, startedRun, {
      provider,
      model: model.id,
      status: 'failed',
      error: message,
    });
  }
}
