import 'server-only';

import crypto from 'node:crypto';

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';

export type AgentModelTestCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_TEST_ABORTED'
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

export type AgentModelProbeComplete = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

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

function isExpectedProbeResponse(responseText: string): boolean {
  // Some otherwise compatible providers add a single terminal period despite
  // the exact-response instruction. Keep the probe strict while accepting
  // that harmless punctuation variant.
  const normalized = responseText.toUpperCase();
  return normalized === 'OK' || normalized === 'OK.';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown model test error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Model probe was aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Model probe was aborted.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function createProbeController(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  onTimeout?: () => void,
): { controller: AbortController; didTimeout: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    onTimeout?.();
    controller.abort(new Error('Model probe timed out.'));
  }, timeoutMs);
  timer.unref?.();
  return {
    controller,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export async function testAgentModelConnection(params: {
  agentId: string;
  provider: string;
  model: Model<Api>;
  complete: AgentModelProbeComplete;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AgentModelTestResult> {
  const agentId = params.agentId.trim();
  const timeoutMs = Math.max(1, Math.min(params.timeoutMs ?? DEFAULT_MODEL_TEST_TIMEOUT_MS, 120_000));
  const complete = params.complete;
  const now = params.now ?? Date.now;
  const wait = params.sleep ?? sleep;

  const provider = params.provider.trim() || undefined;
  const modelId = params.model.id.trim() || undefined;
  const startedAt = now();
  const runId = `mt-${startedAt.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  let activeAttempt = 0;
  const budget = createProbeController(timeoutMs, params.signal, () => {
    logWarn(runId, 'timeout-fired', {
      agentId,
      provider,
      model: modelId,
      attempt: activeAttempt,
      timeoutMs,
      durationMs: now() - startedAt,
    });
  });

  logInfo(runId, 'start', { agentId, timeoutMs });

  try {
    if (!agentId || !provider || !modelId) {
      throw new Error('The model probe requires an explicit agent, provider, and model.');
    }
    logInfo(runId, 'runtime-received', {
      agentId,
      activeProvider: provider,
      model: modelDetailsForLog(params.model),
    });

    const messages: Message[] = [
      {
        role: 'user',
        content: MODEL_TEST_PROMPT,
        timestamp: now(),
      },
    ];

    const maxAttempts = provider === CANVAS_CONTROL_PLANE_PROVIDER_ID ? MANAGED_MODEL_TEST_MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      activeAttempt = attempt;
      const completeStartedAt = now();
      if (budget.controller.signal.aborted) {
        const code = budget.didTimeout() ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_ABORTED';
        return {
          success: false,
          provider,
          model: modelId,
          error: code === 'MODEL_TEST_TIMEOUT' ? 'Model probe timed out.' : 'Model probe was aborted.',
          code,
          runId,
          durationMs: now() - startedAt,
          timeoutMs,
          attempts: attempt - 1,
        };
      }

      logInfo(runId, 'probe-request-start', {
        agentId,
        provider,
        model: modelId,
        attempt,
        maxAttempts,
        timeoutMs,
      });

      try {
        const response = await raceWithAbort(
          complete(
            params.model,
            {
              systemPrompt: MODEL_TEST_SYSTEM_PROMPT,
              messages,
            },
            {
              temperature: 0,
              maxTokens: 8,
              sessionId: `model-test:${agentId}:${runId}:attempt-${attempt}`,
              signal: budget.controller.signal,
            },
          ),
          budget.controller.signal,
        );
        const completeDurationMs = now() - completeStartedAt;

        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          const code = response.stopReason !== 'aborted'
            ? 'MODEL_TEST_FAILED'
            : budget.controller.signal.aborted
              ? (budget.didTimeout() ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_ABORTED')
              : 'MODEL_TEST_TIMEOUT';
          logWarn(runId, 'probe-request-failed', {
            agentId,
            provider,
            model: modelId,
            attempt,
            maxAttempts,
            stopReason: response.stopReason,
            code,
            willRetry: code === 'MODEL_TEST_TIMEOUT' && !budget.controller.signal.aborted && attempt < maxAttempts,
            errorMessage: truncateLogText(response.errorMessage),
            completeDurationMs,
            durationMs: now() - startedAt,
            timeoutMs,
          });

          if (code === 'MODEL_TEST_TIMEOUT' && !budget.controller.signal.aborted && attempt < maxAttempts) {
            await raceWithAbort(wait(MANAGED_MODEL_TEST_RETRY_DELAY_MS), budget.controller.signal);
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
        if (!isExpectedProbeResponse(responseText)) {
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
        const aborted = budget.controller.signal.aborted;
        const timedOut = aborted && budget.didTimeout();
        const code = timedOut ? 'MODEL_TEST_TIMEOUT' : aborted ? 'MODEL_TEST_ABORTED' : 'MODEL_TEST_FAILED';
        logWarn(runId, 'probe-request-exception', {
          agentId,
          provider,
          model: modelId,
          attempt,
          maxAttempts,
          code,
          timedOut,
          willRetry: false,
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
          attempts: attempt,
        };
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
    const code = !agentId || !provider || !modelId ? 'MODEL_NOT_CONFIGURED' : 'MODEL_TEST_FAILED';
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
  } finally {
    budget.dispose();
  }
}
