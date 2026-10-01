export type SecretReadinessCode =
  | 'master_key_missing'
  | 'decryption_failed'
  | 'invalid_secret_format'
  | 'mcp_credential_key_missing';

export type SecretReadiness = {
  status: 'ready' | SecretReadinessCode;
  masterKeySource: 'CANVAS_SECRETS_MASTER_KEY' | 'INTEGRATIONS_ENV_MASTER_KEY' | 'AGENTS_ENV_MASTER_KEY' | null;
};

const messages: Record<SecretReadinessCode, string> = {
  master_key_missing: 'Encrypted secrets cannot be read safely. Restore their original master key in the deployment configuration. See /settings?tab=secrets.',
  decryption_failed: 'Encrypted secrets cannot be read safely because authentication failed. Restore the original key and intact data before saving. See /settings?tab=secrets.',
  invalid_secret_format: 'Encrypted secrets cannot be read safely because their storage format is invalid. Restore intact secret data before saving. See /settings?tab=secrets.',
  mcp_credential_key_missing: 'MCP credential encryption key is missing. Restore the original MCP key before connecting. See /settings?tab=secrets.',
};

export class SecretReadinessError extends Error {
  readonly status = 503;

  constructor(readonly code: SecretReadinessCode, message = messages[code]) {
    super(message);
    this.name = 'SecretReadinessError';
  }
}

export function isSecretReadinessError(error: unknown): error is SecretReadinessError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    && Object.hasOwn(messages, error.code);
}

export function configuredSecretMasterKeySource(): SecretReadiness['masterKeySource'] {
  for (const name of ['CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY'] as const) {
    if (process.env[name]?.trim()) return name;
  }
  return null;
}
