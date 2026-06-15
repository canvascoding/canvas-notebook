import 'server-only';

import type { Model } from '@earendil-works/pi-ai';

import { getManagedControlPlaneBaseUrl } from './control-plane-url';

export const CANVAS_CONTROL_PLANE_PROVIDER_ID = 'canvas-control-plane';

export type ManagedControlPlaneProvider = 'openrouter' | 'groq' | 'openai-compatible';

type ManagedControlPlanePricing = {
  currency: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
  source?: string;
};

export type ManagedControlPlaneModel = Model<'openai-completions'> & {
  managedProvider: ManagedControlPlaneProvider;
  managedPricing?: ManagedControlPlanePricing | null;
};

export const FALLBACK_CANVAS_CONTROL_PLANE_MODELS: ManagedControlPlaneModel[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|gh[pousr]|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]');
}

function truncateLogText(value: string, maxLength = 300): string {
  const redacted = redactSensitiveText(value);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

function controlPlaneUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return truncateLogText(value.split('?')[0].replace(/\/+$/, ''), 300);
  }
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateLogText(error.message, 800),
      stack: error.stack ? truncateLogText(error.stack.split('\n').slice(0, 4).join('\n'), 1_000) : undefined,
    };
  }

  return { message: truncateLogText(String(error), 800) };
}

export function managedProviderPath(provider: ManagedControlPlaneProvider): string {
  if (provider === 'groq') return 'groq';
  if (provider === 'openai-compatible') return 'openai-compatible';
  return 'openrouter';
}

function managedProviderCompat(provider: ManagedControlPlaneProvider): ManagedControlPlaneModel['compat'] {
  const base = {
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsLongCacheRetention: false,
  } satisfies NonNullable<ManagedControlPlaneModel['compat']>;

  if (provider === 'openrouter') {
    return {
      ...base,
      thinkingFormat: 'openrouter',
    };
  }

  return {
    ...base,
    supportsReasoningEffort: false,
  };
}

function parseManagedControlPlaneModel(value: unknown): ManagedControlPlaneModel | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : id;
  const managedProvider = value.provider === 'groq'
    ? 'groq'
    : value.provider === 'openai-compatible'
      ? 'openai-compatible'
      : value.provider === 'openrouter'
        ? 'openrouter'
        : null;
  const contextWindow = typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow)
    ? value.contextWindow
    : 128000;
  const maxTokens = typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens)
    ? value.maxTokens
    : 8192;
  const input = Array.isArray(value.input) && value.input.every((entry) => entry === 'text' || entry === 'image')
    ? value.input as ('text' | 'image')[]
    : ['text'] as ('text' | 'image')[];
  const pricingValue = isRecord(value.pricing) ? value.pricing : null;
  const pricing = pricingValue ? {
    currency: typeof pricingValue.currency === 'string' ? pricingValue.currency : 'usd',
    inputPer1m: numberValue(pricingValue.inputPer1m),
    outputPer1m: numberValue(pricingValue.outputPer1m),
    cacheReadPer1m: numberValue(pricingValue.cacheReadPer1m, numberValue(pricingValue.inputPer1m)),
    cacheWritePer1m: numberValue(pricingValue.cacheWritePer1m, numberValue(pricingValue.inputPer1m)),
    source: typeof pricingValue.source === 'string' ? pricingValue.source : undefined,
  } : null;

  if (!id || !managedProvider) return null;

  return {
    id,
    name,
    api: 'openai-completions',
    provider: CANVAS_CONTROL_PLANE_PROVIDER_ID,
    managedProvider,
    baseUrl: '',
    reasoning: Boolean(value.reasoning),
    input,
    cost: {
      input: pricing?.inputPer1m ?? 0,
      output: pricing?.outputPer1m ?? 0,
      cacheRead: pricing?.cacheReadPer1m ?? pricing?.inputPer1m ?? 0,
      cacheWrite: pricing?.cacheWritePer1m ?? pricing?.inputPer1m ?? 0,
    },
    contextWindow,
    maxTokens,
    compat: managedProviderCompat(managedProvider),
    managedPricing: pricing,
  };
}

export async function getCanvasControlPlaneModels(): Promise<ManagedControlPlaneModel[]> {
  const startedAt = Date.now();
  const controlPlaneUrl = getManagedControlPlaneBaseUrl();
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!controlPlaneUrl || !token) {
    if (process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || controlPlaneUrl || token) {
      console.warn('[Canvas Control Plane] Managed model discovery skipped.', {
        hasControlPlaneUrl: Boolean(controlPlaneUrl),
        hasInstanceToken: Boolean(token),
        managedServicesEnabled: process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
      });
    }
    return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    console.log('[Canvas Control Plane] Loading managed models.', {
      endpoint: `${controlPlaneUrlForLog(controlPlaneUrl)}/v1/managed/models`,
      timeoutMs: 5000,
    });
    const response = await fetch(`${controlPlaneUrl}/v1/managed/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn('[Canvas Control Plane] Failed to load managed models.', {
        status: response.status,
        durationMs: Date.now() - startedAt,
        body: body ? truncateLogText(body, 500) : undefined,
      });
      return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
    }
    const payload = await response.json();
    const rawModels = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
    const models = rawModels
      .map(parseManagedControlPlaneModel)
      .filter((model): model is ManagedControlPlaneModel => Boolean(model));
    console.log('[Canvas Control Plane] Managed models loaded.', {
      rawCount: rawModels.length,
      parsedCount: models.length,
      durationMs: Date.now() - startedAt,
      providerCounts: models.reduce<Record<string, number>>((counts, model) => {
        counts[model.managedProvider] = (counts[model.managedProvider] || 0) + 1;
        return counts;
      }, {}),
    });
    return models.length > 0 ? models : FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  } catch (error) {
    console.warn('[Canvas Control Plane] Failed to load managed models from Control Plane.', {
      timedOut: controller.signal.aborted,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error),
    });
    return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  } finally {
    clearTimeout(timeout);
  }
}
