import 'server-only';

import { completeSimple, type AssistantMessage, type Message } from '@earendil-works/pi-ai';

import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';

export type AgentModelTestCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'API_KEY_MISSING'
  | 'MODEL_TEST_FAILED'
  | 'MODEL_TEST_TIMEOUT'
  | 'MODEL_TEST_UNEXPECTED_RESPONSE';

export type AgentModelTestResult = {
  success: boolean;
  provider?: string;
  model?: string;
  responseText?: string;
  error?: string;
  code?: AgentModelTestCode;
};

type TestAgentModelConnectionDeps = {
  resolveConfig?: typeof resolveAgentRuntimeConfig;
  resolveApiKey?: typeof resolvePiApiKey;
  complete?: typeof completeSimple;
  now?: () => number;
};

const MODEL_TEST_SYSTEM_PROMPT = [
  'You are a connectivity probe for Canvas Notebook.',
  'Follow the user instruction exactly and do not add any explanation.',
].join(' ');

const MODEL_TEST_PROMPT = 'Reply exactly OK.';
const DEFAULT_MODEL_TEST_TIMEOUT_MS = 30_000;

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown model test error';
}

function createTimeoutController(timeoutMs: number): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    controller,
    dispose: () => clearTimeout(timer),
  };
}

export async function testAgentModelConnection(params?: {
  agentId?: string | null;
  timeoutMs?: number;
  deps?: TestAgentModelConnectionDeps;
}): Promise<AgentModelTestResult> {
  const agentId = params?.agentId?.trim() || DEFAULT_MANAGED_AGENT_ID;
  const timeoutMs = Math.max(1_000, Math.min(params?.timeoutMs ?? DEFAULT_MODEL_TEST_TIMEOUT_MS, 120_000));
  const deps = params?.deps ?? {};
  const resolveConfig = deps.resolveConfig ?? resolveAgentRuntimeConfig;
  const resolveApiKey = deps.resolveApiKey ?? resolvePiApiKey;
  const complete = deps.complete ?? completeSimple;
  const now = deps.now ?? Date.now;

  let provider: string | undefined;
  let modelId: string | undefined;
  const { controller, dispose } = createTimeoutController(timeoutMs);

  try {
    const effectiveConfig = await resolveConfig(agentId);
    provider = effectiveConfig.activeProvider;
    modelId = effectiveConfig.model.id;

    const apiKey = await resolveApiKey(effectiveConfig.model.provider);
    if (!apiKey) {
      return {
        success: false,
        provider,
        model: modelId,
        error: `API key not configured for ${effectiveConfig.model.provider}.`,
        code: 'API_KEY_MISSING',
      };
    }

    const messages: Message[] = [
      {
        role: 'user',
        content: MODEL_TEST_PROMPT,
        timestamp: now(),
      },
    ];

    const response = await complete(
      effectiveConfig.model,
      {
        systemPrompt: MODEL_TEST_SYSTEM_PROMPT,
        messages,
      },
      {
        apiKey,
        temperature: 0,
        maxTokens: 8,
        sessionId: `model-test:${agentId}:${now()}`,
        signal: controller.signal,
      },
    );

    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      return {
        success: false,
        provider,
        model: modelId,
        error: response.errorMessage || 'Model test failed.',
        code: response.stopReason === 'aborted' ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_FAILED',
      };
    }

    const responseText = extractAssistantText(response);
    if (!/\bok\b/i.test(responseText)) {
      return {
        success: false,
        provider,
        model: modelId,
        responseText,
        error: 'Model responded, but did not return the expected probe response.',
        code: 'MODEL_TEST_UNEXPECTED_RESPONSE',
      };
    }

    return {
      success: true,
      provider,
      model: modelId,
      responseText,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      success: false,
      provider,
      model: modelId,
      error: getErrorMessage(error),
      code: timedOut ? 'MODEL_TEST_TIMEOUT' : provider || modelId ? 'MODEL_TEST_FAILED' : 'MODEL_NOT_CONFIGURED',
    };
  } finally {
    dispose();
  }
}
