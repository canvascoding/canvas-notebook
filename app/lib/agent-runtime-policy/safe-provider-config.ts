import type { AiProviderSafeConfig } from './types';

export const SAFE_PROVIDER_CONFIG_KEYS = new Set<keyof AiProviderSafeConfig>([
  'authMethod',
  'ollamaMode',
  'ollamaHost',
  'ollamaModelSource',
  'ollamaCustomModel',
  'ollamaAdditionalModels',
  'openaiCompatibleBaseUrl',
  'openaiCompatibleModelSource',
  'openaiCompatibleCustomModel',
]);

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;
const MAX_MODELS_PER_PROVIDER = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return undefined;
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value.trim());
}

/** Project persisted provider config onto the public, non-secret schema. */
export function sanitizeSafeProviderConfig(value: unknown): AiProviderSafeConfig {
  if (!isRecord(value)) return {};

  const config: AiProviderSafeConfig = {};
  if (value.authMethod === 'api-key' || value.authMethod === 'oauth') config.authMethod = value.authMethod;
  if (value.ollamaMode === 'local' || value.ollamaMode === 'cloud') config.ollamaMode = value.ollamaMode;
  const ollamaHost = safeEndpoint(value.ollamaHost);
  if (ollamaHost) config.ollamaHost = ollamaHost;
  if (value.ollamaModelSource === 'predefined' || value.ollamaModelSource === 'custom') config.ollamaModelSource = value.ollamaModelSource;
  if (safeModelId(value.ollamaCustomModel)) config.ollamaCustomModel = value.ollamaCustomModel.trim();
  if (
    Array.isArray(value.ollamaAdditionalModels)
    && value.ollamaAdditionalModels.length <= MAX_MODELS_PER_PROVIDER
    && value.ollamaAdditionalModels.every(safeModelId)
  ) {
    config.ollamaAdditionalModels = Array.from(new Set(value.ollamaAdditionalModels.map((model) => model.trim())));
  }
  const openaiCompatibleBaseUrl = safeEndpoint(value.openaiCompatibleBaseUrl);
  if (openaiCompatibleBaseUrl) config.openaiCompatibleBaseUrl = openaiCompatibleBaseUrl;
  if (value.openaiCompatibleModelSource === 'predefined' || value.openaiCompatibleModelSource === 'custom') {
    config.openaiCompatibleModelSource = value.openaiCompatibleModelSource;
  }
  if (safeModelId(value.openaiCompatibleCustomModel)) config.openaiCompatibleCustomModel = value.openaiCompatibleCustomModel.trim();
  return config;
}
