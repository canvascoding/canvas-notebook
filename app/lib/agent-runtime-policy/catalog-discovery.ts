import 'server-only';

import type {
  AiCatalogDiscovery,
  AiProviderSafeConfig,
  AiProviderSource,
} from '@/app/lib/agent-runtime-policy/types';
import type { ManagedControlPlaneCatalog } from '@/app/lib/managed/control-plane-models';
import { getProviderHelp } from '@/app/lib/pi/provider-help';
import {
  CANVAS_CONTROL_PLANE_PROVIDER_ID,
  getCanvasControlPlaneModels,
  getPiModels,
  getPiProviders,
  modelSupportsImageInput,
} from '@/app/lib/pi/model-resolver';

function providerSource(providerId: string): AiProviderSource {
  if (providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) return 'managed';
  if (providerId === 'ollama' || providerId === 'openai-compatible') return 'self-hosted';
  return 'built-in';
}

function providerName(providerId: string): string {
  if (providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) return 'Canvas Control Plane';
  return getProviderHelp(providerId)?.title || providerId
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function customModelFor(providerId: string, config?: AiProviderSafeConfig): string | undefined {
  if (providerId === 'ollama' && config?.ollamaModelSource === 'custom') {
    return config.ollamaCustomModel?.trim() || undefined;
  }
  if (providerId === 'openai-compatible' && config?.openaiCompatibleModelSource === 'custom') {
    return config.openaiCompatibleCustomModel?.trim() || undefined;
  }
  return undefined;
}

export async function loadAiCatalogDiscovery(
  configsByProvider: Record<string, readonly AiProviderSafeConfig[]> = {},
  options: { managedCatalog?: ManagedControlPlaneCatalog | null } = {},
): Promise<AiCatalogDiscovery> {
  const providers = Array.from(new Set(getPiProviders())).sort();
  const entries = await Promise.all(providers.map(async (providerId) => {
    const models = providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
      ? options.managedCatalog?.models ?? await getCanvasControlPlaneModels()
      : (configsByProvider[providerId]?.length
          ? configsByProvider[providerId].flatMap((config) => getPiModels(providerId, customModelFor(providerId, config)))
          : getPiModels(providerId));
    const uniqueModels = Array.from(new Map(models.map((model) => [model.id, model])).values());
    return [providerId, {
      id: providerId,
      name: providerName(providerId),
      source: providerSource(providerId),
      models: uniqueModels.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        supportsVision: modelSupportsImageInput(model),
        contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
        maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : undefined,
      })),
    }] as const;
  }));
  return Object.fromEntries(entries);
}
