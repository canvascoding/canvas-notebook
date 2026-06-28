import 'server-only';

import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';

import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';
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
  runId?: string;
  durationMs?: number;
  timeoutMs?: number;
  attempts?: number;
};

type TestAgentModelConnectionDeps = {
  resolveConfig?: typeof resolveAgentRuntimeConfig;
  resolveApiKey?: typeof resolvePiApiKey;
  complete?: typeof completeSimple;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const MODEL_TEST_SYSTEM_PROMPT = [
  'You are a connectivity probe for Canvas Notebook.',
  'Follow the user instruction exactly and do not add any explanation.',
].join(' ');

const MODEL_TEST_PROMPT = 'Reply exactly OK.';
const DEFAULT_MODEL_TEST_TIMEOUT_MS = 30_000;
const MANAGED_MODEL_TEST_MAX_ATTEMPTS = 2;
const MANAGED_MODEL_TEST_RETRY_DELAY_MS = 1_000;
const MODEL_TEST_LOG_PREFIX = '[agents/model-test]';

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|gh[pousr]|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]');
}

function truncateLogText(value: string | undefined, maxLength = 800): string | undefined {
  if (!value) {
    return value;
  }
  const redacted = redactSensitiveText(value);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateLogText(error.message),
      stack: truncateLogText(error.stack?.split('\n').slice(0, 5).join('\n'), 1_200),
    };
  }

  return {
    message: truncateLogText(String(error)),
  };
}

function safeUrlForLog(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return truncateLogText(trimmed.split('?')[0].replace(/\/+$/, ''), 300) || null;
  }
}

function modelDetailsForLog(model: Model<Api>): Record<string, unknown> {
  const maybeManaged = model as Model<Api> & { managedProvider?: unknown };
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    baseUrl: safeUrlForLog(model.baseUrl),
    managedProvider: typeof maybeManaged.managedProvider === 'string' ? maybeManaged.managedProvider : undefined,
    reasoning: Boolean(model.reasoning),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headerKeys: model.headers ? Object.keys(model.headers).sort() : [],
  };
}

function logInfo(runId: string, event: string, details?: Record<string, unknown>): void {
  console.log(`${MODEL_TEST_LOG_PREFIX} ${event}`, { runId, ...details });
}

function logWarn(runId: string, event: string, details?: Record<string, unknown>): void {
  console.warn(`${MODEL_TEST_LOG_PREFIX} ${event}`, { runId, ...details });
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutController(
  timeoutMs: number,
  onTimeout?: () => void,
): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    onTimeout?.();
    controller.abort();
  }, timeoutMs);
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
  const wait = deps.sleep ?? sleep;

  let provider: string | undefined;
  let modelId: string | undefined;
  const startedAt = now();
  const runId = `mt-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  logInfo(runId, 'start', { agentId, timeoutMs });

  try {
    const resolveStartedAt = now();
    const effectiveConfig = await resolveConfig(agentId);
    provider = effectiveConfig.activeProvider;
    modelId = effectiveConfig.model.id;
    logInfo(runId, 'config-resolved', {
      agentId,
      durationMs: now() - resolveStartedAt,
      activeProvider: provider,
      thinkingLevel: effectiveConfig.thinkingLevel,
      setupState: effectiveConfig.setupState,
      model: modelDetailsForLog(effectiveConfig.model),
    });

    const keyStartedAt = now();
    const apiKey = await resolveApiKey(effectiveConfig.model.provider);
    logInfo(runId, 'api-key-resolved', {
      agentId,
      durationMs: now() - keyStartedAt,
      activeProvider: provider,
      modelProvider: effectiveConfig.model.provider,
      hasApiKey: Boolean(apiKey),
    });
    if (!apiKey) {
      logWarn(runId, 'api-key-missing', {
        agentId,
        provider,
        model: modelId,
        durationMs: now() - startedAt,
      });
      return {
        success: false,
        provider,
        model: modelId,
        error: `API key not configured for ${effectiveConfig.model.provider}.`,
        code: 'API_KEY_MISSING',
        runId,
        durationMs: now() - startedAt,
        timeoutMs,
        attempts: 0,
      };
    }

    const messages: Message[] = [
      {
        role: 'user',
        content: MODEL_TEST_PROMPT,
        timestamp: now(),
      },
    ];

    const maxAttempts = provider === CANVAS_CONTROL_PLANE_PROVIDER_ID ? MANAGED_MODEL_TEST_MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const completeStartedAt = now();
      const { controller, dispose } = createTimeoutController(timeoutMs, () => {
        logWarn(runId, 'timeout-fired', {
          agentId,
          provider,
          model: modelId,
          attempt,
          maxAttempts,
          timeoutMs,
          durationMs: now() - startedAt,
        });
      });

      logInfo(runId, 'probe-request-start', {
        agentId,
        provider,
        model: modelId,
        attempt,
        maxAttempts,
        timeoutMs,
      });

      try {
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
            sessionId: `model-test:${agentId}:${runId}:attempt-${attempt}`,
            signal: controller.signal,
          },
        );
        const completeDurationMs = now() - completeStartedAt;

        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          const code = response.stopReason === 'aborted' ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_FAILED';
          logWarn(runId, 'probe-request-failed', {
            agentId,
            provider,
            model: modelId,
            attempt,
            maxAttempts,
            stopReason: response.stopReason,
            code,
            willRetry: code === 'MODEL_TEST_TIMEOUT' && attempt < maxAttempts,
            errorMessage: truncateLogText(response.errorMessage),
            completeDurationMs,
            durationMs: now() - startedAt,
            timeoutMs,
          });

          if (code === 'MODEL_TEST_TIMEOUT' && attempt < maxAttempts) {
            await wait(MANAGED_MODEL_TEST_RETRY_DELAY_MS);
            continue;
          }

          return {
            success: false,
            provider,
            model: modelId,
            error: response.errorMessage || 'Model test failed.',
            code,
            runId,
            durationMs: now() - startedAt,
            timeoutMs,
            attempts: attempt,
          };
        }

        const responseText = extractAssistantText(response);
        if (!/\bok\b/i.test(responseText)) {
          logWarn(runId, 'unexpected-response', {
            agentId,
            provider,
            model: modelId,
            attempt,
            maxAttempts,
            stopReason: response.stopReason,
            responsePreview: truncateLogText(responseText, 300),
            completeDurationMs,
            durationMs: now() - startedAt,
          });
          return {
            success: false,
            provider,
            model: modelId,
            responseText,
            error: 'Model responded, but did not return the expected probe response.',
            code: 'MODEL_TEST_UNEXPECTED_RESPONSE',
            runId,
            durationMs: now() - startedAt,
            timeoutMs,
            attempts: attempt,
          };
        }

        logInfo(runId, 'success', {
          agentId,
          provider,
          model: modelId,
          attempt,
          maxAttempts,
          stopReason: response.stopReason,
          responseChars: responseText.length,
          completeDurationMs,
          durationMs: now() - startedAt,
        });
        return {
          success: true,
          provider,
          model: modelId,
          responseText,
          runId,
          durationMs: now() - startedAt,
          timeoutMs,
          attempts: attempt,
        };
      } catch (error) {
        const timedOut = controller.signal.aborted;
        const code = timedOut ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_FAILED';
        logWarn(runId, 'probe-request-exception', {
          agentId,
          provider,
          model: modelId,
          attempt,
          maxAttempts,
          code,
          timedOut,
          willRetry: timedOut && attempt < maxAttempts,
          durationMs: now() - startedAt,
          timeoutMs,
          error: summarizeError(error),
        });

        if (timedOut && attempt < maxAttempts) {
          await wait(MANAGED_MODEL_TEST_RETRY_DELAY_MS);
          continue;
        }

        return {
          success: false,
          provider,
          model: modelId,
          error: getErrorMessage(error),
          code,
          runId,
          durationMs: now() - startedAt,
          timeoutMs,
          attempts: attempt,
        };
      } finally {
        dispose();
      }
    }

    logWarn(runId, 'probe-request-failed', {
      agentId,
      provider,
      model: modelId,
      code: 'MODEL_TEST_FAILED',
      durationMs: now() - startedAt,
      timeoutMs,
      attempts: maxAttempts,
    });
    return {
      success: false,
      provider,
      model: modelId,
      error: 'Model test failed.',
      code: 'MODEL_TEST_FAILED',
      runId,
      durationMs: now() - startedAt,
      timeoutMs,
      attempts: maxAttempts,
    };
  } catch (error) {
    const code = provider || modelId ? 'MODEL_TEST_FAILED' : 'MODEL_NOT_CONFIGURED';
    logWarn(runId, 'exception', {
      agentId,
      provider,
      model: modelId,
      code,
      timedOut: false,
      durationMs: now() - startedAt,
      timeoutMs,
      error: summarizeError(error),
    });
    return {
      success: false,
      provider,
      model: modelId,
      error: getErrorMessage(error),
      code,
      runId,
      durationMs: now() - startedAt,
      timeoutMs,
      attempts: 0,
    };
  }
}
