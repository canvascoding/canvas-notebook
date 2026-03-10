/**
 * PI-first Runtime Configuration Schema
 */

export type PiThinkingLevel = 'none' | 'low' | 'medium' | 'high';

export type OllamaMode = 'local' | 'cloud';

export interface PiProviderConfig {
  id: string; // e.g., 'openrouter', 'anthropic', 'google', 'ollama', 'groq'
  model: string;
  thinking: PiThinkingLevel;
  enabledTools: string[];
  // Ollama-specific settings
  ollamaMode?: OllamaMode; // 'local' | 'cloud'
  ollamaHost?: string; // Custom Ollama host URL (default: http://127.0.0.1:11434 for local)
}

export interface PiRuntimeConfig {
  version: 2; // Version 2 for PI-first
  activeProvider: string;
  providers: Record<string, PiProviderConfig>;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_PI_CONFIG: PiRuntimeConfig = {
  version: 2,
  activeProvider: 'openrouter',
  providers: {
    openrouter: {
      id: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      thinking: 'medium',
      enabledTools: ['filesystem', 'terminal', 'web-search'],
    },
    anthropic: {
      id: 'anthropic',
      model: 'claude-3-5-sonnet-20240620',
      thinking: 'medium',
      enabledTools: ['filesystem', 'terminal'],
    },
    google: {
      id: 'google',
      model: 'gemini-1.5-pro',
      thinking: 'none',
      enabledTools: ['filesystem', 'terminal'],
    },
    ollama: {
      id: 'ollama',
      model: 'llama3.1',
      thinking: 'none',
      enabledTools: ['filesystem', 'terminal'],
      ollamaMode: 'local',
      ollamaHost: 'http://127.0.0.1:11434',
    },
  },
  updatedAt: new Date().toISOString(),
  updatedBy: 'system:bootstrap',
};

/**
 * Validates PI runtime configuration.
 */
export function validatePiConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object') {
    return 'Configuration must be an object.';
  }

  const candidate = config as Partial<PiRuntimeConfig> & { providers?: Record<string, Partial<PiProviderConfig>> };

  if (candidate.version !== 2) {
    return 'Invalid configuration version. Expected 2.';
  }

  if (!candidate.activeProvider || typeof candidate.activeProvider !== 'string') {
    return 'Active provider must be a non-empty string.';
  }

  if (!candidate.providers || typeof candidate.providers !== 'object') {
    return 'Providers must be an object.';
  }

  const activeProvider = candidate.providers[candidate.activeProvider];
  if (!activeProvider) {
    return `Configuration for active provider "${candidate.activeProvider}" is missing.`;
  }

  if (!activeProvider.model || typeof activeProvider.model !== 'string') {
    return `Model for provider "${candidate.activeProvider}" must be a non-empty string.`;
  }

  return null;
}
