import { getModels, getProviders, registerBuiltInApiProviders, type KnownProvider, type Model } from '@mariozechner/pi-ai';
import { readPiRuntimeConfig } from '../agents/storage';

// Ensure all built-in providers are registered once
registerBuiltInApiProviders();

/**
 * Discovery helpers for PI providers and models.
 */

// Ollama provider ID - used for custom provider discovery
export const OLLAMA_PROVIDER_ID = 'ollama';
// OpenAI-Compatible provider ID - used for custom OpenAI-compatible servers
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

  // Recommended Ollama models with metadata
// Using 'openai-completions' api type for OpenAI-compatible Ollama API
// Alle Modelle (lokal und cloud) werden über localhost API aufgerufen
// Vision model IDs that support image input
export const VISION_MODEL_IDS = new Set([
  // OpenAI Vision Models
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4o-2024-11-20',
  'gpt-4o-2024-08-06',
  'gpt-4-turbo',
  'gpt-4-turbo-2024-04-09',
  'gpt-4-vision-preview',
  // Anthropic Vision Models
  'claude-3-opus-20240229',
  'claude-3-opus',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-sonnet',
  'claude-3-5-sonnet-20241022',
  'claude-3-haiku-20240307',
  'claude-3-haiku',
  // Google Vision Models
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-1.0-pro-vision',
  'gemini-pro-vision',
  // xAI Vision Models
  'grok-2-vision',
  'grok-2-vision-latest',
]);

// Helper to determine if a model supports vision
export function modelSupportsVision(modelId: string): boolean {
  return VISION_MODEL_IDS.has(modelId);
}

export const OLLAMA_MODELS: Model<'openai-completions'>[] = [
  // Lokale Open-Source Modelle (mit 'ollama pull' herunterladen)
  { id: 'llama3.1', name: 'Llama 3.1 (Meta)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'llama3.2', name: 'Llama 3.2 (Meta)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'mistral', name: 'Mistral (Mistral AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'deepseek-r1:32b', name: 'DeepSeek R1 32B (DeepSeek)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'llava', name: 'LLaVA (Vision)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 },
  { id: 'bakllava', name: 'BakLLaVA (Vision)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 },
  // Cloud-Modelle (automatisch aus Ollama Cloud gepullt)
  { id: 'glm-5.1:cloud', name: 'GLM 5.1 Cloud (Zhipu AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 1.05, output: 3.50, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'kimi-k2.5:cloud', name: 'Kimi K2.5 Cloud (Moonshot AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0.44, output: 2.00, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 8192 },
  { id: 'kimi-k2.6:cloud', name: 'Kimi K2.6 Cloud (Moonshot AI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0.74, output: 3.49, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 },
  { id: 'qwen3.5:397b-cloud', name: 'Qwen 3.5 397B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0.40, output: 2.40, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'qwen3-coder:480b-cloud', name: 'Qwen 3 Coder 480B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'qwen3-vl:235b-cloud', name: 'Qwen 3 VL 235B Cloud (Alibaba)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'gemma4:31b-cloud', name: 'Gemma 4 31B Cloud (Google)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0.13, output: 0.38, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 },
  { id: 'minimax-m2:cloud', name: 'MiniMax M2 Cloud (MiniMax)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B (OpenAI)', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
];

export function getPiProviders(): string[] {
  const providers = getProviders();
  // Add Ollama and OpenAI-Compatible if not already present (they are not built-in PI-AI providers)
  if (!(providers as string[]).includes(OLLAMA_PROVIDER_ID)) {
    (providers as string[]).push(OLLAMA_PROVIDER_ID);
  }
  if (!(providers as string[]).includes(OPENAI_COMPATIBLE_PROVIDER_ID)) {
    (providers as string[]).push(OPENAI_COMPATIBLE_PROVIDER_ID);
  }
  return providers as string[];
}

export function getPiModels(provider: string, customModel?: string) {
  // Special handling for Ollama provider
  if (provider === OLLAMA_PROVIDER_ID) {
    // If a custom model is provided, add it to the list
    if (customModel) {
      const customModelEntry: Model<'openai-completions'> = {
        id: customModel,
        name: `${customModel} (Custom)`,
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      };
      const merged = [...OLLAMA_MODELS, customModelEntry];
      return merged.filter((m, i) => merged.findIndex(x => x.id === m.id) === i);
    }
    return OLLAMA_MODELS;
  }

  // OpenAI-Compatible provider - returns empty list, user enters custom model
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    if (customModel) {
      const customModelEntry: Model<'openai-completions'> = {
        id: customModel,
        name: `${customModel} (Custom)`,
        api: 'openai-completions',
        provider: 'openai-compatible',
        baseUrl: '',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      };
      return [customModelEntry];
    }
    return [];
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
  const config = await readPiRuntimeConfig();
  const providerConfig = config.providers[provider];
  
  // For Ollama, pass custom model to getPiModels if configured
  const customModel = provider === OLLAMA_PROVIDER_ID && providerConfig?.ollamaModelSource === 'custom' 
    ? providerConfig.ollamaCustomModel 
    : provider === OPENAI_COMPATIBLE_PROVIDER_ID && providerConfig?.openaiCompatibleModelSource === 'custom'
      ? providerConfig.openaiCompatibleCustomModel
      : undefined;
  
  const models = getPiModels(provider, customModel);
  let model = models.find(m => m.id === modelName);
  
  // For Ollama custom models, create model entry if not found
  if (provider === OLLAMA_PROVIDER_ID && !model && providerConfig?.ollamaModelSource === 'custom') {
    model = {
      id: modelName,
      name: `${modelName} (Custom)`,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
  }

  // For OpenAI-Compatible custom models, create model entry
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const baseUrl = providerConfig?.openaiCompatibleBaseUrl?.trim() || '';
    const normalizedBaseUrl = baseUrl && !baseUrl.endsWith('/v1')
      ? `${baseUrl.replace(/\/+$/, '')}/v1`
      : baseUrl;

    if (!model) {
      const customEntry: Model<'openai-completions'> = {
        id: modelName,
        name: `${modelName} (Custom)`,
        api: 'openai-completions',
        provider: 'openai-compatible',
        baseUrl: normalizedBaseUrl || '',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      };
      model = customEntry;
    } else {
      model = { ...model, baseUrl: normalizedBaseUrl || model.baseUrl };
    }
  }
  
  if (!model) {
    throw new Error(`Model ${modelName} not found for provider ${provider}`);
  }
  
  // For Ollama, we always use the local API endpoint (localhost:11434)
  // Cloud vs Local is distinguished by the model ID, not the URL
  if (provider === OLLAMA_PROVIDER_ID) {
    console.log(`[Ollama Debug] Resolving model ${modelName} for provider ${provider}`);
    console.log(`[Ollama Debug] Mode: ${providerConfig?.ollamaMode || 'local'}`);
    console.log(`[Ollama Debug] Model Source: ${providerConfig?.ollamaModelSource || 'predefined'}`);
    
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
