import { getModels, getProviders, registerBuiltInApiProviders, type KnownProvider } from '@mariozechner/pi-ai';
import { readPiRuntimeConfig } from '../agents/storage';

// Ensure all built-in providers are registered once
registerBuiltInApiProviders();

/**
 * Discovery helpers for PI providers and models.
 */

export function getPiProviders(): string[] {
  return getProviders();
}

export function getPiModels(provider: string) {
  try {
    return getModels(provider as KnownProvider);
  } catch {
    return [];
  }
}

/**
 * Resolves the PI model instance based on user configuration.
 */
export async function resolvePiModel(provider: string, modelName: string) {
  const models = getPiModels(provider);
  const model = models.find(m => m.id === modelName);
  
  if (!model) {
    throw new Error(`Model ${modelName} not found for provider ${provider}`);
  }
  
  return model;
}

/**
 * Resolves the active PI model based on stored configuration.
 */
export async function resolveActivePiModel() {
  const config = await readPiRuntimeConfig();
  const providerConfig = config.providers[config.activeProvider];
  
  if (!providerConfig) {
    throw new Error(`Configuration for active provider "${config.activeProvider}" is missing.`);
  }
  
  return resolvePiModel(config.activeProvider, providerConfig.model);
}
