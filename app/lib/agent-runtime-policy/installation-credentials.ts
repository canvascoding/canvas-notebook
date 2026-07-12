import 'server-only';

import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProviderEnv } from '@earendil-works/pi-ai';

import type { AiProviderInstallation } from '@/app/lib/agent-runtime-policy/types';
import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';
import { readScopedEnvState, type EnvStorageScope } from '@/app/lib/integrations/env-config';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';
import { getProviderApiKey, isOAuthProvider, type OAuthProviderId } from '@/app/lib/pi/oauth';
import { getAuthMethodForProvider, getProviderEnvVars } from '@/app/lib/pi/provider-help';

const PROVIDER_API_KEY_NAMES: Record<string, readonly string[]> = {
  'ant-ling': ['ANT_LING_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  google: ['GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  huggingface: ['HF_TOKEN'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
};
const LOCAL_RUNTIME_CREDENTIAL = 'canvas-local-runtime';
const AMBIENT_RUNTIME_CREDENTIAL = '<authenticated>';
const SECRET_ENV_NAME_PATTERN = /(api[_-]?key|token|secret|password)/iu;
const PROVIDER_AUTH_ENV_EXTRAS: Record<string, readonly string[]> = {
  'google-vertex': [
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCLOUD_PROJECT',
  ],
  'amazon-bedrock': [
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_BEDROCK_SKIP_AUTH',
  ],
};
const AMBIENT_SCOPE_SENSITIVE_PROVIDERS = new Set([
  'amazon-bedrock',
  'azure-openai-responses',
]);

export type ProviderInstallationRuntimeAuth = {
  configured: boolean;
  apiKey?: string;
  env: ProviderEnv;
};

function storageScopeFor(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): EnvStorageScope | null {
  if (input.provider.credentialScope === 'user') {
    return { secretScope: 'user', userId: input.userId };
  }
  if (input.provider.credentialScope === 'organization') {
    return { secretScope: 'organization', organizationId: input.organizationId };
  }
  if (input.provider.credentialScope === 'system') {
    // The app-wide integrations file is the canonical system credential store.
    return null;
  }
  return null;
}

async function readProviderEnv(input: {
  providerId: string;
  storageScope: EnvStorageScope | null;
  includeProcessEnvironment: boolean;
}): Promise<ProviderEnv> {
  const names = providerEnvNames(input.providerId);
  const [integrations, agents] = await Promise.all([
    readScopedEnvState('integrations', input.storageScope),
    readScopedEnvState('agents', input.storageScope),
  ]);
  const values = new Map([
    ...integrations.entries.map((entry) => [entry.key, entry.value] as const),
    ...agents.entries.map((entry) => [entry.key, entry.value] as const),
  ]);
  const env: ProviderEnv = {};
  for (const key of names) {
    const value = values.get(key)?.trim()
      || (input.includeProcessEnvironment ? process.env[key]?.trim() : undefined);
    if (value) env[key] = value;
  }
  return env;
}

function providerEnvNames(providerId: string): string[] {
  return Array.from(new Set([
    ...(PROVIDER_API_KEY_NAMES[providerId] ?? []),
    ...(getProviderEnvVars(providerId) ?? []).map((entry) => entry.name),
    ...(PROVIDER_AUTH_ENV_EXTRAS[providerId] ?? []),
  ]));
}

function hasAmbientScopeConflict(providerId: string, env: ProviderEnv): boolean {
  if (!AMBIENT_SCOPE_SENSITIVE_PROVIDERS.has(providerId)) return false;
  return providerEnvNames(providerId).some((name) => {
    const ambient = process.env[name]?.trim();
    if (!ambient) return false;
    // Bedrock consults process.env directly for this one flag even when an
    // installation-scoped env bundle is present, so it cannot be isolated.
    if (providerId === 'amazon-bedrock' && name === 'AWS_PROFILE') return true;
    // All other PI lookups prefer a non-empty scoped value. Reject only the
    // missing scoped variables that would otherwise fall through to ambient.
    return !env[name]?.trim();
  });
}

function firstValue(env: ProviderEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function apiKeyForProvider(providerId: string, env: ProviderEnv): string | undefined {
  const declaredSecretNames = (getProviderEnvVars(providerId) ?? [])
    .map((entry) => entry.name)
    .filter((name) => SECRET_ENV_NAME_PATTERN.test(name));
  return firstValue(env, [
    ...(PROVIDER_API_KEY_NAMES[providerId] ?? []),
    ...declaredSecretNames,
  ]);
}

function hasRequiredProviderConfig(providerId: string, env: ProviderEnv): boolean {
  return (getProviderEnvVars(providerId) ?? [])
    .filter((entry) => entry.required && !SECRET_ENV_NAME_PATTERN.test(entry.name))
    .every((entry) => Boolean(env[entry.name]?.trim()));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasSystemGoogleAdc(env: ProviderEnv): Promise<boolean> {
  const explicitPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicitPath) return fileExists(explicitPath);
  return fileExists(path.join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'));
}

async function hasSystemAwsCredentials(env: ProviderEnv): Promise<boolean> {
  if (
    env.AWS_PROFILE
    || env.AWS_WEB_IDENTITY_TOKEN_FILE
    || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    || env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    return true;
  }
  return fileExists(path.join(homedir(), '.aws', 'credentials'));
}

/**
 * Resolve the credential for one concrete provider installation. Credentials
 * never fall through to a broader scope: user installations read user secrets,
 * organization installations read organization secrets, and only system
 * installations may consult the process environment.
 */
export async function resolveProviderInstallationCredential(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<string | undefined> {
  const auth = await resolveProviderInstallationRuntimeAuth(input);
  return auth.apiKey || (auth.configured ? AMBIENT_RUNTIME_CREDENTIAL : undefined);
}

/** Resolve request auth plus provider-scoped environment without mutating process.env. */
export async function resolveProviderInstallationRuntimeAuth(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<ProviderInstallationRuntimeAuth> {
  const providerId = input.provider.providerId.toLowerCase();
  if (providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    const apiKey = input.provider.credentialScope === 'managed'
      ? process.env.CANVAS_INSTANCE_TOKEN?.trim() || undefined
      : undefined;
    return {
      configured: Boolean(apiKey) && isManagedControlPlaneAvailable(),
      ...(apiKey ? { apiKey } : {}),
      env: {},
    };
  }

  const authMethod = getAuthMethodForProvider(providerId);
  const wantsOAuth = input.provider.config.authMethod === 'oauth'
    || (authMethod === 'oauth' && input.provider.config.authMethod !== 'api-key');
  if (wantsOAuth) {
    if (input.provider.credentialScope !== 'user' || !isOAuthProvider(providerId)) {
      return { configured: false, env: {} };
    }
    const apiKey = (await getProviderApiKey(providerId as OAuthProviderId, { userId: input.userId }))?.apiKey;
    return { configured: Boolean(apiKey), ...(apiKey ? { apiKey } : {}), env: {} };
  }

  const env = await readProviderEnv({
    providerId,
    storageScope: storageScopeFor(input),
    includeProcessEnvironment: input.provider.credentialScope === 'system',
  });
  if (
    input.provider.credentialScope !== 'system'
    && input.provider.credentialScope !== 'managed'
    && hasAmbientScopeConflict(providerId, env)
  ) {
    throw new Error(
      'Scoped provider credentials conflict with ambient system configuration.',
    );
  }
  const apiKey = apiKeyForProvider(providerId, env);
  if (providerId === 'openai-compatible' || providerId === 'ollama') {
    return { configured: true, apiKey: apiKey || LOCAL_RUNTIME_CREDENTIAL, env };
  }
  if (providerId === 'google-vertex') {
    const hasProject = Boolean(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
    const hasLocation = Boolean(env.GOOGLE_CLOUD_LOCATION);
    const hasAdc = input.provider.credentialScope === 'system' && await hasSystemGoogleAdc(env);
    const configured = Boolean(apiKey) || (hasProject && hasLocation && hasAdc);
    return { configured, ...(apiKey ? { apiKey } : {}), env };
  }
  if (providerId === 'amazon-bedrock') {
    const hasKeyPair = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    const hasBearer = Boolean(env.AWS_BEARER_TOKEN_BEDROCK);
    const skipAuth = env.AWS_BEDROCK_SKIP_AUTH === '1';
    const hasAmbient = input.provider.credentialScope === 'system' && await hasSystemAwsCredentials(env);
    return { configured: hasKeyPair || hasBearer || skipAuth || hasAmbient, env };
  }
  if (providerId === 'azure-openai-responses') {
    const hasEndpoint = Boolean(
      env.AZURE_OPENAI_BASE_URL?.trim()
      || env.AZURE_OPENAI_RESOURCE_NAME?.trim(),
    );
    return { configured: Boolean(apiKey) && hasEndpoint, ...(apiKey ? { apiKey } : {}), env };
  }

  const configured = Boolean(apiKey) && hasRequiredProviderConfig(providerId, env);
  return { configured, ...(apiKey ? { apiKey } : {}), env };
}

/** PI requires a non-empty callback value even for local endpoints without auth. */
export async function resolveProviderInstallationRuntimeCredential(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<string | undefined> {
  return resolveProviderInstallationCredential(input);
}

export async function isProviderInstallationCredentialAvailable(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  try {
    return (await resolveProviderInstallationRuntimeAuth(input)).configured;
  } catch {
    return false;
  }
}
