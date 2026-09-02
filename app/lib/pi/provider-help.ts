/**
 * Provider help documentation for PI AI integration.
 * Maps providers to their configuration requirements and setup instructions.
 */

export type ProviderCategory = 'api-key' | 'oauth-cli' | 'adc' | 'aws' | 'ollama' | 'azure' | 'self-hosted' | 'cloud-infra';
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

function apiKeyProviderHelp(input: {
  title: string;
  shortDescription: string;
  envName: string;
  credentialDescription?: string;
  documentationUrl?: string;
}): ProviderHelpInfo {
  return {
    category: 'api-key',
    title: input.title,
    shortDescription: input.shortDescription,
    setupSteps: [
      `Get a credential for ${input.title}`,
      `Add ${input.envName} to Agent Environment settings`,
      'Save and verify the provider status',
    ],
    envVars: [
      {
        name: input.envName,
        description: input.credentialDescription || `Your ${input.title} API key`,
        scope: 'agents',
        required: true,
      },
    ],
    ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}),
  };
}

/**
 * Provider help information mapping.
 * Covers all 23+ providers available in @earendil-works/pi-ai
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
    shortDescription: 'Anthropic Claude API (API Key)',
    setupSteps: [
      'Get your API key from https://console.anthropic.com/',
      'Add the key to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'ANTHROPIC_API_KEY', description: 'Your Anthropic API key', scope: 'agents', required: true },
      { name: 'ANTHROPIC_AUTH_TOKEN', description: 'Optional Anthropic bearer auth token', scope: 'agents', required: false },
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
    supportsBothAuthMethods: true,
  },

  'canvas-control-plane': {
    category: 'api-key',
    title: 'Canvas Control Plane',
    shortDescription: 'Managed provider hosted by your Canvas Control Plane',
    setupSteps: [
      'Enable Managed Services in the Control Plane',
      'Provision this VM with CANVAS_CONTROL_PLANE_URL and CANVAS_INSTANCE_TOKEN',
      'Select Canvas Control Plane as the active agent provider',
    ],
    envVars: [],
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
    supportsBothAuthMethods: true,
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
    supportsBothAuthMethods: true,
  },

  baseten: apiKeyProviderHelp({
    title: 'Baseten',
    shortDescription: 'Hosted open and proprietary inference models through Baseten',
    envName: 'BASETEN_API_KEY',
    documentationUrl: 'https://docs.baseten.co/',
  }),

  'qwen-token-plan': apiKeyProviderHelp({
    title: 'Qwen Token Plan',
    shortDescription: 'Qwen token-plan models on the international endpoint',
    envName: 'QWEN_TOKEN_PLAN_API_KEY',
  }),

  'qwen-token-plan-cn': apiKeyProviderHelp({
    title: 'Qwen Token Plan CN',
    shortDescription: 'Qwen token-plan models on the China endpoint',
    envName: 'QWEN_TOKEN_PLAN_CN_API_KEY',
  }),

  'qwen-token-plan-individual': apiKeyProviderHelp({
    title: 'Qwen Token Plan Individual',
    shortDescription: 'Qwen individual token-plan models',
    envName: 'QWEN_TOKEN_PLAN_API_KEY',
  }),

  'ant-ling': apiKeyProviderHelp({
    title: 'Ant Ling',
    shortDescription: 'Ant Ling hosted language models',
    envName: 'ANT_LING_API_KEY',
  }),

  deepseek: apiKeyProviderHelp({
    title: 'DeepSeek',
    shortDescription: 'DeepSeek chat and reasoning models',
    envName: 'DEEPSEEK_API_KEY',
    documentationUrl: 'https://api-docs.deepseek.com/',
  }),

  nvidia: apiKeyProviderHelp({
    title: 'NVIDIA NIM',
    shortDescription: 'NVIDIA-hosted inference models',
    envName: 'NVIDIA_API_KEY',
    documentationUrl: 'https://docs.api.nvidia.com/nim/',
  }),

  fireworks: apiKeyProviderHelp({
    title: 'Fireworks AI',
    shortDescription: 'Fireworks hosted inference models',
    envName: 'FIREWORKS_API_KEY',
    documentationUrl: 'https://docs.fireworks.ai/',
  }),

  together: apiKeyProviderHelp({
    title: 'Together AI',
    shortDescription: 'Together AI hosted inference models',
    envName: 'TOGETHER_API_KEY',
    documentationUrl: 'https://docs.together.ai/',
  }),

  'vercel-ai-gateway': apiKeyProviderHelp({
    title: 'Vercel AI Gateway',
    shortDescription: 'AI models routed through Vercel AI Gateway',
    envName: 'AI_GATEWAY_API_KEY',
    documentationUrl: 'https://vercel.com/docs/ai-gateway',
  }),

  moonshotai: apiKeyProviderHelp({
    title: 'Moonshot AI',
    shortDescription: 'Moonshot AI global API',
    envName: 'MOONSHOT_API_KEY',
    documentationUrl: 'https://platform.moonshot.ai/docs/',
  }),

  'moonshotai-cn': apiKeyProviderHelp({
    title: 'Moonshot AI CN',
    shortDescription: 'Moonshot AI China API',
    envName: 'MOONSHOT_API_KEY',
    documentationUrl: 'https://platform.moonshot.cn/docs/',
  }),

  'opencode-go': apiKeyProviderHelp({
    title: 'OpenCode Zen Go',
    shortDescription: 'OpenCode Go models',
    envName: 'OPENCODE_API_KEY',
  }),

  'zai-coding-cn': apiKeyProviderHelp({
    title: 'Z.AI Coding CN',
    shortDescription: 'Z.AI Coding Plan models hosted in China',
    envName: 'ZAI_CODING_CN_API_KEY',
  }),

  xiaomi: apiKeyProviderHelp({
    title: 'Xiaomi MiMo',
    shortDescription: 'Xiaomi MiMo API-billed models',
    envName: 'XIAOMI_API_KEY',
  }),

  'xiaomi-token-plan-cn': apiKeyProviderHelp({
    title: 'Xiaomi MiMo Token Plan CN',
    shortDescription: 'Xiaomi MiMo Token Plan hosted in China',
    envName: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  }),

  'xiaomi-token-plan-ams': apiKeyProviderHelp({
    title: 'Xiaomi MiMo Token Plan AMS',
    shortDescription: 'Xiaomi MiMo Token Plan hosted in Amsterdam',
    envName: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  }),

  'xiaomi-token-plan-sgp': apiKeyProviderHelp({
    title: 'Xiaomi MiMo Token Plan SGP',
    shortDescription: 'Xiaomi MiMo Token Plan hosted in Singapore',
    envName: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  }),

  'github-copilot': apiKeyProviderHelp({
    title: 'GitHub Copilot',
    shortDescription: 'GitHub Copilot models using a token or user OAuth',
    envName: 'COPILOT_GITHUB_TOKEN',
    credentialDescription: 'GitHub token with Copilot access',
    documentationUrl: 'https://docs.github.com/en/copilot',
  }),

  'cloudflare-workers-ai': {
    category: 'api-key',
    title: 'Cloudflare Workers AI',
    shortDescription: 'Models hosted on Cloudflare Workers AI',
    setupSteps: [
      'Create a Cloudflare API token with Workers AI access',
      'Add the API token and account ID to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'CLOUDFLARE_API_KEY', description: 'Cloudflare API token', scope: 'agents', required: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', description: 'Cloudflare account ID', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://developers.cloudflare.com/workers-ai/',
  },

  'cloudflare-ai-gateway': {
    category: 'api-key',
    title: 'Cloudflare AI Gateway',
    shortDescription: 'Models routed through Cloudflare AI Gateway',
    setupSteps: [
      'Create a Cloudflare API token and an AI Gateway',
      'Add the API token, account ID, and gateway ID to Agent Environment settings',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'CLOUDFLARE_API_KEY', description: 'Cloudflare API token', scope: 'agents', required: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', description: 'Cloudflare account ID', scope: 'agents', required: true },
      { name: 'CLOUDFLARE_GATEWAY_ID', description: 'Cloudflare AI Gateway ID', scope: 'agents', required: true },
    ],
    documentationUrl: 'https://developers.cloudflare.com/ai-gateway/',
  },

  // OAuth/CLI Providers - Now using PI OAuth
  'openai-codex': {
    category: 'oauth-cli',
    title: 'OpenAI Codex (ChatGPT Login)',
    shortDescription: 'OpenAI Codex via ChatGPT subscription OAuth (requires eligible ChatGPT plan)',
    setupSteps: [
      'Click "Connect Account" in the OAuth section',
      'Open the device-code URL in your browser',
      'Enter the displayed code and complete login with your ChatGPT account',
      'Keep the dialog open while Canvas waits for PI to finish the token exchange',
    ],
    notes: [
      'Use the regular OpenAI provider with OPENAI_API_KEY for OpenAI API billing',
      'This provider is for Codex subscription-style access through ChatGPT login',
      'Canvas uses pi-ai provider-owned OAuth so the device-code flow works in headless/container setups',
      'Credentials are stored in the user-scoped Canvas settings area',
      'Token refresh is automatic',
    ],
    documentationUrl: 'https://github.com/openai/codex',
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
      { name: 'GOOGLE_CLOUD_API_KEY', description: 'Optional Vertex API key (alternative to ADC)', scope: 'agents', required: false },
      { name: 'GOOGLE_CLOUD_PROJECT', description: 'Project ID (required when using ADC)', scope: 'agents', required: false },
      { name: 'GOOGLE_CLOUD_LOCATION', description: 'Region (required when using ADC)', scope: 'agents', required: false },
      { name: 'GOOGLE_APPLICATION_CREDENTIALS', description: 'Optional ADC service-account JSON path for system-scoped installs', scope: 'agents', required: false },
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
      { name: 'AWS_SESSION_TOKEN', description: 'Optional session token for temporary AWS credentials', scope: 'agents', required: false },
      { name: 'AWS_REGION', description: 'AWS region for Bedrock (e.g., eu-central-1)', scope: 'agents', required: false },
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
      { name: 'AZURE_OPENAI_BASE_URL', description: 'Endpoint URL (required unless a resource name is set)', scope: 'agents', required: false },
      { name: 'AZURE_OPENAI_RESOURCE_NAME', description: 'Resource name (required unless a base URL is set)', scope: 'agents', required: false },
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
    shortDescription: 'Verbinde Canvas mit einem erreichbaren Ollama-Server und wähle dessen Modelle aus',
    setupSteps: [
      'Trage die Ollama-Server-URL so ein, wie sie aus der Canvas-Runtime erreichbar ist',
      'Hinterlege nur dann einen API-Key, wenn dein Ollama-Endpunkt einen verlangt',
      'Teste die Verbindung, um die am Server verfügbaren Modelle zu laden',
      'Aktiviere passende Modelle oder ergänze eigene Modell-IDs',
      'Speichere und prüfe die Konfiguration direkt im Provider-Dialog',
    ],
    envVars: [
      {
        name: 'OLLAMA_API_KEY',
        description: 'Optionaler API-Key für geschützte Ollama-Endpunkte. Lokale Standardinstallationen benötigen normalerweise keinen Key.',
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
      'Verwende den Terminal-Button oben, um Ollama-Befehle direkt auszuführen',
      'Die Server-URL wird aus Sicht der Canvas-Runtime aufgerufen; in Containern zeigt localhost auf den Container selbst',
      'Für Ollama im Docker-Netzwerk ist häufig eine URL wie http://ollama:11434 passend',
      'OLLAMA_API_KEY ist optional und nur für geschützte Endpunkte erforderlich',
      'Eigene Modell-IDs können zusätzlich zur erkannten Modellliste eingetragen werden',
      'Cloud-Modelle werden automatisch beim ersten Pull von Ollama Hub geladen',
    ],
    documentationUrl: 'https://ollama.ai/',
    ollamaModes: [
      {
        mode: 'local',
        label: '🏠 Canvas-Runtime',
        description: 'Ollama ist aus der Canvas-Runtime unter der eingetragenen URL erreichbar',
        defaultHost: 'http://127.0.0.1:11434',
        apiKeyRequired: false,
        setupSteps: [
          'Ollama installieren: https://ollama.ai/',
          'Öffne das Terminal (Button oben) und führe Befehle aus:',
          '  - Modell herunterladen: ollama pull llama3.1',
          '  - Server starten: ollama serve',
          'Verbindung testen: curl http://localhost:11434/api/tags',
          'Trage die aus der Canvas-Runtime erreichbare Server-URL ein',
        ],
        notes: [
          'Kein API Key erforderlich',
          'Kann komplett lokal auf derselben Maschine oder im selben Docker-Netzwerk laufen',
          'Benötigt ausreichend RAM/VRAM für die gewählten Modelle',
          'Funktioniert offline nach dem ersten Download',
          'Verwende das Terminal für alle Ollama-Befehle',
        ]
      },
      {
        mode: 'cloud',
        label: '☁️ Anderer Server',
        description: 'Verbinde dich mit einem Ollama Server im Netzwerk oder in der Cloud',
        defaultHost: '',
        apiKeyRequired: false,
        setupSteps: [
          'Stelle sicher, dass der Remote Ollama Server erreichbar ist',
          'Trage die Server-URL ein (z.B. http://192.168.1.100:11434 oder https://ollama.example.com)',
          'Teste die Verbindung aus Canvas und prüfe die erkannte Modellliste',
          'Speichere die Konfiguration',
        ],
        notes: [
          'Für Netzwerk-Installationen oder Cloud-Instanzen',
          'Kein lokales Model-Pulling nötig - läuft auf dem Remote Server',
          'Server muss dauerhaft erreichbar sein',
          'Netzwerkverbindung erforderlich',
          'Der Server muss aus dem Canvas-Netzwerk erreichbar sein',
        ],
      },
    ],
  },

  'openai-compatible': {
    category: 'self-hosted',
    title: 'OpenAI-Compatible',
    shortDescription: 'Connect to any OpenAI-compatible API server with a custom base URL',
    setupSteps: [
      'Enter the base URL of your OpenAI-compatible server (e.g., http://localhost:8080/v1)',
      'Add the API key (if required) to Agent Environment settings',
      'Select or enter a custom model name',
      'Save and verify the provider status',
    ],
    envVars: [
      { name: 'OPENAI_COMPATIBLE_BASE_URL', description: 'Your server base URL (e.g., http://localhost:8080/v1)', scope: 'agents', required: true },
      { name: 'OPENAI_COMPATIBLE_API_KEY', description: 'Your API key (optional, leave empty if not required)', scope: 'agents', required: false },
    ],
    notes: [
      'The base URL must include the API path, typically ending in /v1',
      'Works with any server implementing the OpenAI Chat Completions API',
      'Examples: LM Studio, LocalAI, vLLM, text-generation-webui, etc.',
      'API key is optional — leave empty if your server does not require authentication',
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
  return help?.category === 'api-key' || Boolean(help?.envVars?.some((entry) => entry.required));
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

export type AuthMethodCategory = 'api-key' | 'oauth' | 'self-hosted' | 'cloud-infra';

export function getVisibleOAuthProviders(): string[] {
  return ['openai-codex', 'openrouter', 'kimi-coding', 'xai'];
}

export function getApiKeyProviders(): string[] {
  return Object.keys(PROVIDER_HELP).filter((id) => {
    const help = PROVIDER_HELP[id];
    return help.category === 'api-key';
  });
}

export function getSelfHostedProviders(): string[] {
  return Object.keys(PROVIDER_HELP).filter((id) => {
    const help = PROVIDER_HELP[id];
    return help.category === 'ollama' || help.category === 'self-hosted';
  });
}

export function getCloudInfraProviders(): string[] {
  return Object.keys(PROVIDER_HELP).filter((id) => {
    const help = PROVIDER_HELP[id];
    return help.category === 'adc' || help.category === 'aws' || help.category === 'azure';
  });
}

export function getProvidersForAuthMethod(method: AuthMethodCategory): string[] {
  switch (method) {
    case 'oauth':
      return getVisibleOAuthProviders();
    case 'self-hosted':
      return getSelfHostedProviders();
    case 'cloud-infra':
      return getCloudInfraProviders();
    case 'api-key':
    default:
      return getApiKeyProviders();
  }
}

export function getAuthMethodForProvider(providerId: string): AuthMethodCategory | 'both' {
  const help = getProviderHelp(providerId);
  if (!help) {
    return 'api-key';
  }
  if (help.supportsBothAuthMethods) {
    return 'both';
  }
  switch (help.category) {
    case 'oauth-cli':
      return 'oauth';
    case 'ollama':
    case 'self-hosted':
      return 'self-hosted';
    case 'adc':
    case 'aws':
    case 'azure':
      return 'cloud-infra';
    default:
      return 'api-key';
  }
}
