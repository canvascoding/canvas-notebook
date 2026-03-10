/**
 * Provider help documentation for PI AI integration.
 * Maps providers to their configuration requirements and setup instructions.
 */

export type ProviderCategory = 'api-key' | 'oauth-cli' | 'adc' | 'aws' | 'ollama' | 'azure';
export type OllamaProviderMode = 'local' | 'cloud';

export interface OllamaModeConfig {
  mode: OllamaProviderMode;
  label: string;
  description: string;
  defaultHost: string;
  apiKeyRequired: boolean;
  setupSteps: string[];
  notes: string[];
}

export interface ProviderHelpInfo {
  category: ProviderCategory;
  title: string;
  shortDescription: string;
  setupSteps: string[];
  envVars?: {
    name: string;
    description: string;
    scope: 'agents' | 'integrations';
    required: boolean;
  }[];
  cliCommands?: {
    command: string;
    description: string;
  }[];
  notes?: string[];
  documentationUrl?: string;
  // Ollama-specific mode configuration
  ollamaModes?: OllamaModeConfig[];
  // Whether provider supports both API key and OAuth
  supportsBothAuthMethods?: boolean;
}

/**
 * Provider help information mapping.
 * Covers all 23+ providers available in @mariozechner/pi-ai
 */
export const PROVIDER_HELP: Record<string, ProviderHelpInfo> = {
  // API Key Providers
  openai: {
    category: 'api-key',
    title: 'OpenAI',
    shortDescription: 'OpenAI API (GPT-4, GPT-3.5, etc.)',
    setupSteps: [
      'Get your API key from https://platform.openai.com/api-keys',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'OPENAI_API_KEY', description: 'Your OpenAI API key', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://platform.openai.com/docs',
  },

  anthropic: {
    category: 'api-key',
    title: 'Anthropic',
    shortDescription: 'Anthropic Claude API (API Key or OAuth)',
    supportsBothAuthMethods: true,
    setupSteps: [
      'Choose your preferred authentication method below',
      'For API Key: Get your key from https://console.anthropic.com/',
      'For OAuth: Click "Connect Account" and complete the OAuth flow',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'ANTHROPIC_API_KEY', description: 'Your Anthropic API key (if using API Key method)', scope: 'agents', required: false },
    ],
    documentationUrl: 'https://docs.anthropic.com/',
  },

  google: {
    category: 'api-key',
    title: 'Google Gemini',
    shortDescription: 'Google Gemini API',
    setupSteps: [
      'Get your API key from https://makersuite.google.com/app/apikey',
      'Add the key to Integrations or Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'GEMINI_API_KEY', description: 'Your Google/Gemini API key', scope: 'integrations', required: true },
      { name: 'GOOGLE_API_KEY', description: 'Alternative: Google API key', scope: 'agents', required: false },
    ],
    documentationUrl: 'https://ai.google.dev/',
  },

  groq: {
    category: 'api-key',
    title: 'Groq',
    shortDescription: 'Fast inference with OpenAI-compatible API',
    setupSteps: [
      'Get your API key from https://console.groq.com/keys',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'GROQ_API_KEY', description: 'Your Groq API key', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://console.groq.com/',
  },

  mistral: {
    category: 'api-key',
    title: 'Mistral AI',
    shortDescription: 'Mistral AI API',
    setupSteps: [
      'Get your API key from https://console.mistral.ai/',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'MISTRAL_API_KEY', description: 'Your Mistral API key', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://docs.mistral.ai/',
  },

  openrouter: {
    category: 'api-key',
    title: 'OpenRouter',
    shortDescription: 'Unified API for multiple AI models',
    setupSteps: [
      'Get your API key from https://openrouter.ai/keys',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'OPENROUTER_API_KEY', description: 'Your OpenRouter API key', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://openrouter.ai/docs',
  },

  zai: {
    category: 'api-key',
    title: 'zAI',
    shortDescription: 'zAI GLM models',
    setupSteps: [
      'Get your API key from your zAI provider',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'ZAI_API_KEY', description: 'Your zAI API key', scope: 'agents', required: true },
    ],
  },

  cerebras: {
    category: 'api-key',
    title: 'Cerebras',
    shortDescription: 'Cerebras inference API',
    setupSteps: [
      'Get your API key from Cerebras',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'CEREBRAS_API_KEY', description: 'Your Cerebras API key', scope: 'agents', required: true },
    ],
  },

  xai: {
    category: 'api-key',
    title: 'xAI',
    shortDescription: 'xAI Grok models',
    setupSteps: [
      'Get your API key from https://x.ai/',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'XAI_API_KEY', description: 'Your xAI API key', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://x.ai/',
  },

  huggingface: {
    category: 'api-key',
    title: 'HuggingFace',
    shortDescription: 'HuggingFace inference API',
    setupSteps: [
      'Get your access token from https://huggingface.co/settings/tokens',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'HF_TOKEN', description: 'Your HuggingFace access token', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://huggingface.co/docs',
  },

  minimax: {
    category: 'api-key',
    title: 'MiniMax',
    shortDescription: 'MiniMax AI models',
    setupSteps: [
      'Get your API key from MiniMax',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'MINIMAX_API_KEY', description: 'Your MiniMax API key', scope: 'agents', required: true },
    ],
  },

  'minimax-cn': {
    category: 'api-key',
    title: 'MiniMax CN',
    shortDescription: 'MiniMax China models',
    setupSteps: [
      'Get your API key from MiniMax China',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'MINIMAX_CN_API_KEY', description: 'Your MiniMax CN API key', scope: 'agents', required: true },
    ],
  },

  opencode: {
    category: 'api-key',
    title: 'OpenCode',
    shortDescription: 'OpenCode Zen models',
    setupSteps: [
      'Get your API key from OpenCode',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'OPENCODE_API_KEY', description: 'Your OpenCode API key', scope: 'agents', required: true },
    ],
  },

  'kimi-coding': {
    category: 'api-key',
    title: 'Kimi Coding',
    shortDescription: 'Moonshot AI Kimi models',
    setupSteps: [
      'Get your API key from Moonshot AI',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'KIMI_API_KEY', description: 'Your Kimi API key', scope: 'agents', required: true },
    ],
  },

  // OAuth/CLI Providers - Now using PI OAuth
  'openai-codex': {
    category: 'oauth-cli',
    title: 'OpenAI Codex',
    shortDescription: 'OpenAI Codex via PI OAuth (requires ChatGPT Plus/Pro)',
    setupSteps: [
      'Click "Connect Account" in the OAuth section',
      'Select OpenAI Codex from the dropdown',
      'Open the authorization URL in your browser',
      'Login with your OpenAI account (ChatGPT Plus/Pro required)',
      'Copy the authorization code and paste it in the dialog',
      'Click "Complete Connection" to finish',
    ],
    notes: [
      'Requires active ChatGPT Plus or Pro subscription',
      'OAuth authentication is handled securely via PI',
      'Credentials are stored encrypted in /data/canvas-agent/',
      'Token refresh is automatic',
    ],
    documentationUrl: 'https://github.com/openai/codex',
  },

  'github-copilot': {
    category: 'oauth-cli',
    title: 'GitHub Copilot',
    shortDescription: 'GitHub Copilot via PI OAuth',
    setupSteps: [
      'Click "Connect Account" in the OAuth section',
      'Select GitHub Copilot from the dropdown',
      'Open the authorization URL in your browser',
      'Authorize the application on GitHub',
      'Copy the authorization code and paste it in the dialog',
      'Click "Complete Connection" to finish',
    ],
    notes: [
      'Requires GitHub Copilot subscription',
      'OAuth authentication is handled securely via PI',
      'Credentials are stored encrypted in /data/canvas-agent/',
      'Token refresh is automatic',
    ],
    documentationUrl: 'https://github.com/features/copilot',
  },

  'google-gemini-cli': {
    category: 'oauth-cli',
    title: 'Google Gemini CLI',
    shortDescription: 'Google Cloud Code Assist via PI OAuth',
    setupSteps: [
      'Click "Connect Account" in the OAuth section',
      'Select Google Gemini CLI from the dropdown',
      'Open the authorization URL in your browser',
      'Login with your Google account',
      'Allow Google Cloud Code Assist access',
      'Copy the authorization code and paste it in the dialog',
      'Click "Complete Connection" to finish',
    ],
    notes: [
      'Requires Google Cloud project',
      'OAuth authentication is handled securely via PI',
      'Credentials are stored encrypted in /data/canvas-agent/',
      'Token refresh is automatic',
    ],
  },

  'google-antigravity': {
    category: 'oauth-cli',
    title: 'Google Antigravity',
    shortDescription: 'Free tier Gemini/Claude via Google Cloud',
    setupSteps: [
      'Install and configure Google Cloud SDK',
      'Login via: gcloud auth login',
      'Set the Antigravity version if needed',
      'Verify the provider status',
    ],
    cliCommands: [
      { command: 'gcloud auth login', description: 'Login to Google Cloud' },
      { command: 'gcloud config set project YOUR_PROJECT_ID', description: 'Set your GCP project' },
    ],
    envVars: [
      { name: 'PI_AI_ANTIGRAVITY_VERSION', description: 'Override User-Agent version', scope: 'agents', required: false },
    ],
    notes: [
      'Free tier available through Google Cloud',
      'OAuth authentication required',
      'Supports both Gemini and Claude models',
    ],
  },

  // ADC Provider
  'google-vertex': {
    category: 'adc',
    title: 'Google Vertex AI',
    shortDescription: 'Google Vertex AI with Application Default Credentials',
    setupSteps: [
      'Install Google Cloud SDK',
      'Authenticate: gcloud auth application-default login',
      'Set your project and location',
      'Verify the provider status',
    ],
    cliCommands: [
      { command: 'gcloud auth application-default login', description: 'Set up Application Default Credentials' },
      { command: 'gcloud config set project YOUR_PROJECT_ID', description: 'Set your GCP project' },
      { command: 'gcloud config set compute/region YOUR_REGION', description: 'Set your region (e.g., us-central1)' },
    ],
    envVars: [
      { name: 'GOOGLE_CLOUD_PROJECT', description: 'Your Google Cloud project ID', scope: 'agents', required: true },
      { name: 'GOOGLE_CLOUD_LOCATION', description: 'Region (e.g., us-central1)', scope: 'agents', required: true },
    ],
    notes: [
      'Uses Application Default Credentials (ADC)',
      'Requires gcloud CLI to be installed',
      'Project and location must be configured',
    ],
    documentationUrl: 'https://cloud.google.com/vertex-ai/docs',
  },

  // AWS Provider
  'amazon-bedrock': {
    category: 'aws',
    title: 'Amazon Bedrock',
    shortDescription: 'AWS Bedrock AI models',
    setupSteps: [
      'Configure AWS credentials',
      'Set up AWS profile or access keys',
      'Ensure Bedrock access is enabled in your AWS account',
      'Verify the provider status',
    ],
    cliCommands: [
      { command: 'aws configure', description: 'Configure AWS CLI with credentials' },
      { command: 'aws bedrock list-foundation-models', description: 'Test Bedrock access' },
    ],
    envVars: [
      { name: 'AWS_PROFILE', description: 'AWS profile name', scope: 'agents', required: false },
      { name: 'AWS_ACCESS_KEY_ID', description: 'AWS access key', scope: 'agents', required: false },
      { name: 'AWS_SECRET_ACCESS_KEY', description: 'AWS secret key', scope: 'agents', required: false },
      { name: 'AWS_BEARER_TOKEN_BEDROCK', description: 'AWS bearer token for Bedrock', scope: 'agents', required: false },
      { name: 'AWS_WEB_IDENTITY_TOKEN_FILE', description: 'Web identity token file path', scope: 'agents', required: false },
    ],
    notes: [
      'Multiple authentication methods supported',
      'Requires AWS account with Bedrock access',
      'Uses standard AWS credential chain',
    ],
    documentationUrl: 'https://docs.aws.amazon.com/bedrock/',
  },

  // Azure Provider
  'azure-openai-responses': {
    category: 'azure',
    title: 'Azure OpenAI',
    shortDescription: 'Azure OpenAI Service',
    setupSteps: [
      'Create Azure OpenAI resource in Azure Portal',
      'Get your API key and endpoint',
      'Add credentials to Agent Environment',
      'Verify the provider status',
    ],
    envVars: [
      { name: 'AZURE_OPENAI_API_KEY', description: 'Your Azure OpenAI API key', scope: 'agents', required: true },
      { name: 'AZURE_OPENAI_BASE_URL', description: 'Azure OpenAI endpoint URL', scope: 'agents', required: true },
      { name: 'AZURE_OPENAI_RESOURCE_NAME', description: 'Resource name (alternative to base URL)', scope: 'agents', required: false },
      { name: 'AZURE_OPENAI_API_VERSION', description: 'API version (optional)', scope: 'agents', required: false },
      { name: 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', description: 'Deployment name mappings (optional)', scope: 'agents', required: false },
    ],
    notes: [
      'Requires Azure subscription',
      'Base URL or Resource Name is required',
      'Deployment names must match your Azure configuration',
    ],
    documentationUrl: 'https://learn.microsoft.com/azure/cognitive-services/openai/',
  },

  // Ollama Provider with Mode Selection
  ollama: {
    category: 'ollama',
    title: 'Ollama',
    shortDescription: 'Run LLMs locally or connect to Ollama Cloud',
    setupSteps: [
      'Wähle unten "Local" oder "Cloud" Mode aus',
      'Folge den angezeigten Schritten für deinen gewählten Mode',
      'Trage die erforderlichen Werte in die Felder ein',
      'Speichere die Konfiguration',
    ],
    envVars: [
      {
        name: 'OLLAMA_HOST',
        description: 'Wird automatisch basierend auf Mode gesetzt',
        scope: 'agents',
        required: false
      },
      {
        name: 'OLLAMA_API_KEY',
        description: 'Nur für Cloud Mode erforderlich',
        scope: 'agents',
        required: false
      },
    ],
    cliCommands: [
      { command: 'ollama pull llama3.1', description: 'Lokales Modell herunterladen' },
      { command: 'ollama pull glm-4.6:cloud', description: 'Cloud-Modell herunterladen' },
      { command: 'ollama pull kimi-k2.5:cloud', description: 'Kimi K2.5 Cloud-Modell' },
      { command: 'ollama pull qwen3.5:397b-cloud', description: 'Qwen 3.5 397B Cloud-Modell' },
      { command: 'ollama list', description: 'Alle installierten Modelle anzeigen' },
      { command: 'ollama serve', description: 'Ollama Server starten' },
      { command: 'ollama ps', description: 'Aktuell geladene Modelle anzeigen' },
    ],
    notes: [
      'Alle Modelle (lokal und cloud) werden über localhost:11434 API aufgerufen',
      'Cloud-Modelle werden automatisch beim ersten Gebrauch gepullt',
    ],
    documentationUrl: 'https://ollama.ai/',
    ollamaModes: [
      {
        mode: 'local',
        label: '🏠 Lokal',
        description: 'Ollama auf deinem eigenen Computer ausführen',
        defaultHost: 'http://127.0.0.1:11434',
        apiKeyRequired: false,
        setupSteps: [
          'Ollama installieren: https://ollama.ai/',
          'Lokales Modell herunterladen: ollama pull llama3.1',
          'ODER Cloud-Modell: ollama pull glm-4.6:cloud',
          'Server starten: ollama serve',
          'Verbindung testen: curl http://localhost:11434/api/tags',
          'OLLAMA_HOST leer lassen',
        ],
        notes: [
          'Kein API Key erforderlich',
          'Cloud-Modelle werden automatisch beim ersten Pull von Ollama Hub geladen',
          'Benötigt ausreichend RAM/VRAM',
          'Funktioniert offline (nach dem ersten Pull)',
        ]
      },
      {
        mode: 'cloud',
        label: '☁️ Remote Server',
        description: 'Zu einem remote Ollama Server verbinden',
        defaultHost: '',
        apiKeyRequired: false,
        setupSteps: [
          'Remote Ollama Server URL eintragen (z.B. http://192.168.1.100:11434)',
          'OLLAMA_HOST mit der Server-URL füllen',
          'Server muss erreichbar sein',
        ],
        notes: [
          'Für Netzwerk- oder Cloud-Installationen',
          'Kein lokales Model-Pulling nötig',
          'Server muss dauerhaft erreichbar sein',
          'Netzwerkverbindung erforderlich',
        ],
      },
    ],
  },
};

/**
 * Get help information for a specific provider.
 */
export function getProviderHelp(providerId: string): ProviderHelpInfo | undefined {
  return PROVIDER_HELP[providerId.toLowerCase()];
}

/**
 * Check if a provider requires an API key.
 */
export function requiresApiKey(providerId: string): boolean {
  const help = getProviderHelp(providerId);
  return help?.category === 'api-key';
}

/**
 * Check if a provider requires CLI authentication.
 */
export function requiresCliAuth(providerId: string): boolean {
  const help = getProviderHelp(providerId);
  return help?.category === 'oauth-cli' || help?.category === 'adc' || help?.category === 'aws';
}

/**
 * Get environment variables for a provider.
 */
export function getProviderEnvVars(providerId: string): ProviderHelpInfo['envVars'] {
  const help = getProviderHelp(providerId);
  return help?.envVars || [];
}

/**
 * Get the primary environment variable name for a provider (if any).
 */
export function getPrimaryEnvVar(providerId: string): string | undefined {
  const envVars = getProviderEnvVars(providerId);
  const required = envVars?.find(ev => ev.required);
  return required?.name || envVars?.[0]?.name;
}

/**
 * Check if a provider supports both API key and OAuth authentication.
 */
export function supportsBothAuthMethods(providerId: string): boolean {
  const help = getProviderHelp(providerId);
  return help?.supportsBothAuthMethods === true;
}
