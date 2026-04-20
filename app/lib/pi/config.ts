/**
 * PI-first Runtime Configuration Schema
 */

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type OllamaMode = 'local' | 'cloud';

export interface PiProviderConfig {
  id: string; // e.g., 'openrouter', 'anthropic', 'google', 'ollama', 'groq'
  model: string;
  thinking: PiThinkingLevel;
  enabledTools: string[];
  // Ollama-specific settings
  ollamaMode?: OllamaMode; // 'local' | 'cloud'
  ollamaHost?: string; // Custom Ollama host URL (default: http://127.0.0.1:11434 for local)
  // Ollama custom model support
  ollamaModelSource?: 'predefined' | 'custom'; // Whether to use dropdown or custom input
  ollamaCustomModel?: string; // Custom model name when ollamaModelSource is 'custom'
  // Auth method preference for providers supporting both API key and OAuth
  authMethod?: 'api-key' | 'oauth';
}

export interface PiRuntimeConfig {
  version: 2; // Version 2 for PI-first
  activeProvider: string;
  providers: Record<string, PiProviderConfig>;
  enabledSkills: string[]; // List of enabled skill names (empty = all enabled)
  qmd?: {
    allowExpensiveQueryMode?: boolean;
  };
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
      enabledTools: [],
    },
    anthropic: {
      id: 'anthropic',
      model: 'claude-3-5-sonnet-20240620',
      thinking: 'medium',
      enabledTools: [],
    },
    google: {
      id: 'google',
      model: 'gemini-1.5-pro',
      thinking: 'off',
      enabledTools: [],
    },
    ollama: {
      id: 'ollama',
      model: 'llama3.1',
      thinking: 'off',
      enabledTools: [],
      ollamaMode: 'local',
    },
  },
  enabledSkills: [], // Empty array means all skills are enabled by default
  qmd: {
    allowExpensiveQueryMode: false,
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

  for (const [providerId, providerConfig] of Object.entries(candidate.providers)) {
    if (providerConfig && 'enabledTools' in providerConfig) {
      if (!Array.isArray(providerConfig.enabledTools)) {
        return `enabledTools for provider "${providerId}" must be an array.`;
      }
      for (const toolName of providerConfig.enabledTools as unknown[]) {
        if (typeof toolName !== 'string') {
          return `enabledTools for provider "${providerId}" must contain only strings.`;
        }
      }
    }
  }

  const activeProvider = candidate.providers[candidate.activeProvider];
  if (!activeProvider) {
    return `Configuration for active provider "${candidate.activeProvider}" is missing.`;
  }

  if (!activeProvider.model || typeof activeProvider.model !== 'string') {
    return `Model for provider "${candidate.activeProvider}" must be a non-empty string.`;
  }

  if (
    candidate.activeProvider === 'ollama' &&
    activeProvider.ollamaModelSource === 'custom' &&
    (!activeProvider.ollamaCustomModel || !activeProvider.ollamaCustomModel.trim())
  ) {
    return 'Custom Ollama model must be a non-empty string.';
  }

  if (
    candidate.qmd !== undefined &&
    (typeof candidate.qmd !== 'object' ||
      candidate.qmd === null ||
      ('allowExpensiveQueryMode' in candidate.qmd &&
        typeof candidate.qmd.allowExpensiveQueryMode !== 'boolean'))
  ) {
    return 'qmd.allowExpensiveQueryMode must be a boolean when provided.';
  }

  return null;
}
