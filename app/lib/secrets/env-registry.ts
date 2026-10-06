import { PROVIDER_HELP } from '../pi/provider-help';
import { isSystemEmailEnvKey } from '../email/system-email-keys';

export type SecretCategory = 'agent-runtime' | 'media' | 'integrations' | 'other';
const agentKeys = new Set(Object.values(PROVIDER_HELP).flatMap(provider => provider.envVars?.map(entry => entry.name) ?? []));
const mediaKeys = new Set(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'KIE_API_KEY', 'GROQ_API_KEY']);
const encryptionKeys = new Set(['EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', 'MCP_CREDENTIAL_KEY', 'MCP_CREDENTIAL_PREVIOUS_KEYS', 'COMPOSIO_WEBHOOK_SECRET_ENCRYPTION_KEY']);

/** Permission scopes are independent of these descriptive usage categories. */
export function getSecretCategories(key: string): SecretCategory[] {
  // Active agent overrides are also used by MCP and by Studio's media fallback.
  if (key.startsWith('CANVAS_PROFILE_AGENTS__')) {
    const categories = getSecretCategories(key.slice('CANVAS_PROFILE_AGENTS__'.length));
    return [...new Set<SecretCategory>(['agent-runtime', ...categories.filter(category => category !== 'other'), 'integrations'])];
  }
  if (key.startsWith('CANVAS_PROFILE_')) return ['other'];
  const categories: SecretCategory[] = [];
  if (agentKeys.has(key)) categories.push('agent-runtime');
  if (mediaKeys.has(key)) categories.push('media');
  if (/^(CANVAS_MCP_|BRAVE_|WEB_SEARCH_PROVIDER$|COMPOSIO_|MCP_|TELEGRAM_|DISCORD_|SLACK_|GITHUB_|GOOGLE_(CLIENT|OAUTH)_|MICROSOFT_|EMAIL_|SYSTEM_SMTP_|TYPESAFE_API_KEY$)/.test(key)) categories.push('integrations');
  return categories.length ? categories : ['other'];
}

export function isHiddenSecretEnvKey(key: string): boolean {
  return key.startsWith('CANVAS_CREDENTIAL_') || key.startsWith('CANVAS_PROFILE_OWNERS__') || encryptionKeys.has(key);
}

/** Connection credentials and encryption material have their own lifecycle adapters. */
export function isReservedSecretEnvKey(key: string): boolean {
  return isHiddenSecretEnvKey(key) || isSystemEmailEnvKey(key);
}
