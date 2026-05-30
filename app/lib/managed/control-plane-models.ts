import 'server-only';

import type { Model } from '@mariozechner/pi-ai';

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
    : ['text', 'image'] as ('text' | 'image')[];
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
  const controlPlaneUrl = getManagedControlPlaneBaseUrl();
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!controlPlaneUrl || !token) {
    return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${controlPlaneUrl}/v1/managed/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[Canvas Control Plane] Failed to load managed models: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ''}`);
      return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
    }
    const payload = await response.json();
    const rawModels = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
    const models = rawModels
      .map(parseManagedControlPlaneModel)
      .filter((model): model is ManagedControlPlaneModel => Boolean(model));
    return models.length > 0 ? models : FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  } catch {
    console.warn('[Canvas Control Plane] Failed to load managed models from Control Plane.');
    return FALLBACK_CANVAS_CONTROL_PLANE_MODELS;
  } finally {
    clearTimeout(timeout);
  }
}
