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
// Using 'openai-completions' api type for OpenAI-compatible Ollama API
// Alle Modelle (lokal und cloud) werden über localhost API aufgerufen
export const OLLAMA_MODELS: Model<'openai-completions'>[] = [
  // Lokale Open-Source Modelle (mit 'ollama pull' herunterladen)
  { id: 'llama3.1', name: 'Llama 3.1 (Meta)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'llama3.2', name: 'Llama 3.2 (Meta)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'mistral', name: 'Mistral (Mistral AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B (DeepSeek)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  // Cloud-Modelle (automatisch aus Ollama Cloud gepullt)
  { id: 'glm-4.6:cloud', name: 'GLM 4.6 Cloud (Zhipu AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'kimi-k2.5:cloud', name: 'Kimi K2.5 Cloud (Moonshot AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 8192 },
  { id: 'qwen3.5:397b-cloud', name: 'Qwen 3.5 397B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'qwen3-coder:480b-cloud', name: 'Qwen 3 Coder 480B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'qwen3-vl:235b-cloud', name: 'Qwen 3 VL 235B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'minimax-m2:cloud', name: 'MiniMax M2 Cloud (MiniMax)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B (OpenAI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
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
 * For Ollama, dynamically sets the correct baseUrl based on mode.
 */
export async function resolvePiModel(provider: string, modelName: string) {
  const models = getPiModels(provider);
  const model = models.find(m => m.id === modelName);
  
  if (!model) {
    throw new Error(`Model ${modelName} not found for provider ${provider}`);
  }
  
  // For Ollama, we always use the local API endpoint (localhost:11434)
  // Cloud vs Local is distinguished by the model ID, not the URL
  if (provider === OLLAMA_PROVIDER_ID) {
    const config = await readPiRuntimeConfig();
    const providerConfig = config.providers[provider];
    
    console.log(`[Ollama Debug] Resolving model ${modelName} for provider ${provider}`);
    console.log(`[Ollama Debug] Mode: ${providerConfig?.ollamaMode || 'local'}`);
    
    // Always use localhost:11434 for all Ollama models (both local and cloud)
    // Cloud models are pulled via 'ollama pull <cloud-model>' and served locally via API
    const baseUrl = 'http://localhost:11434/v1';
    
    // Only use custom host if it's explicitly set and not the default cloud URL
    if (providerConfig?.ollamaHost && 
        !providerConfig.ollamaHost.includes('cloud.ollama.com')) {
      const customUrl = providerConfig.ollamaHost.endsWith('/v1') 
        ? providerConfig.ollamaHost 
        : `${providerConfig.ollamaHost}/v1`;
      
      console.log(`[Ollama Debug] Using custom host: ${customUrl}`);
      
      return {
        ...model,
        baseUrl: customUrl,
      };
    }
    
    console.log(`[Ollama Debug] Using localhost: ${baseUrl}`);
    
    return {
      ...model,
      baseUrl,
    };
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
