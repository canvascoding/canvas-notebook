import { getModels, getProviders, registerBuiltInApiProviders, type KnownProvider, type Model } from '@mariozechner/pi-ai';
import { readPiRuntimeConfig } from '../agents/storage';

// Ensure all built-in providers are registered once
registerBuiltInApiProviders();

/**
 * Discovery helpers for PI providers and models.
 */

// Ollama provider ID - used for custom provider discovery
export const OLLAMA_PROVIDER_ID = 'ollama';

// Recommended Ollama models with metadata
// Format: Model<'openai'> for OpenAI-compatible API
// [Lokal] = Muss mit "ollama pull" heruntergeladen werden
// [Cloud] = Direkt über Ollama Cloud verfügbar
export const OLLAMA_MODELS: Model<'openai'>[] = [
  // Lokale Modelle (Meta, Mistral, etc.)
  { id: 'llama3.1', name: 'Llama 3.1 [Lokal]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'llama3.2', name: 'Llama 3.2 [Lokal]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'mistral', name: 'Mistral [Lokal]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B [Lokal]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B [Lokal/Cloud]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  // Cloud-Modelle (kein "ollama pull" nötig)
  { id: 'glm-4', name: 'GLM-4 [Cloud]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'glm-5.6', name: 'GLM 5.6 [Cloud]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5 [Cloud]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 8192 },
  { id: 'qwen3.5', name: 'Qwen 3.5 [Cloud]', api: 'openai', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
];

export function getPiProviders(): string[] {
  const providers = getProviders();
  // Add Ollama if not already present (it's not a built-in PI-AI provider)
  // TypeScript workaround: cast to string array for includes check
  if (!(providers as string[]).includes(OLLAMA_PROVIDER_ID)) {
    (providers as string[]).push(OLLAMA_PROVIDER_ID);
  }
  return providers as string[];
}

export function getPiModels(provider: string) {
  // Special handling for Ollama provider
  if (provider === OLLAMA_PROVIDER_ID) {
    return OLLAMA_MODELS;
  }
  
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
