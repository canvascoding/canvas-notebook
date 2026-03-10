/**
 * PI-first Runtime Configuration Schema
 */

export type PiThinkingLevel = 'none' | 'low' | 'medium' | 'high';

export interface PiProviderConfig {
  id: string; // e.g., 'openrouter', 'anthropic', 'google', 'ollama', 'groq'
  model: string;
  thinking: PiThinkingLevel;
  enabledTools: string[];
  // Ollama-specific settings
  ollamaHost?: string; // Custom Ollama host URL (default: http://127.0.0.1:11434)
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
      ollamaHost: 'http://127.0.0.1:11434',
    },
  },
  updatedAt: new Date().toISOString(),
  updatedBy: 'system:bootstrap',
};

/**
 * Validates PI runtime configuration.
 */
export function validatePiConfig(config: any): string | null {
  if (!config || typeof config !== 'object') {
    return 'Configuration must be an object.';
  }

  if (config.version !== 2) {
    return 'Invalid configuration version. Expected 2.';
  }

  if (!config.activeProvider || typeof config.activeProvider !== 'string') {
    return 'Active provider must be a non-empty string.';
  }

  if (!config.providers || typeof config.providers !== 'object') {
    return 'Providers must be an object.';
  }

  const activeProvider = config.providers[config.activeProvider];
  if (!activeProvider) {
    return `Configuration for active provider "${config.activeProvider}" is missing.`;
  }

  if (!activeProvider.model || typeof activeProvider.model !== 'string') {
    return `Model for provider "${config.activeProvider}" must be a non-empty string.`;
  }

  return null;
}
