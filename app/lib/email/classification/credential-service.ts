import 'server-only';

import { readUnifiedSecretValue } from '@/app/lib/integrations/env-config';
import { isReservedSecretEnvKey } from '@/app/lib/secrets/env-registry';
import type { EmailClassificationConfiguration } from './settings-types';

export type EmailClassificationSecretReader = (key: string, scope: { secretScope: 'system' }) => string | null;

export interface EmailClassificationCredentialStatus {
  status: 'configured' | 'missing' | 'unavailable';
  configured: boolean;
  scope: 'system';
  anonymous: boolean;
  settingsLink: '/settings?tab=secrets';
}

/** This object is internal. Only its separate status projection belongs in API responses. */
export interface EmailClassificationCredentialResolution {
  value: string | null;
  status: EmailClassificationCredentialStatus;
}

/** No per-user, agent-profile or process-environment credential fallback is permitted. */
export function resolveEmailClassificationCredential(configuration: EmailClassificationConfiguration, dependencies: {
  readSecret?: EmailClassificationSecretReader;
} = {}): EmailClassificationCredentialResolution {
  const status = (state: EmailClassificationCredentialStatus['status'], anonymous = false): EmailClassificationCredentialStatus => ({
    status: state, configured: state === 'configured', scope: 'system', anonymous, settingsLink: '/settings?tab=secrets',
  });
  if (!configuration.credentialKey) {
    // Null is an explicit choice; a missing configured key must never silently become anonymous.
    const anonymous = configuration.providerId === 'systemone' && configuration.allowPrivateNetwork;
    return { value: null, status: status(anonymous ? 'configured' : 'missing', anonymous) };
  }
  if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(configuration.credentialKey) || isReservedSecretEnvKey(configuration.credentialKey)) {
    return { value: null, status: status('unavailable') };
  }
  try {
    const value = (dependencies.readSecret ?? readUnifiedSecretValue)(configuration.credentialKey, { secretScope: 'system' })?.trim() || null;
    if (value && (value.length > 8192 || /\s/u.test(value))) return { value: null, status: status('unavailable') };
    return { value, status: status(value ? 'configured' : 'missing') };
  } catch {
    // Decryption/storage failures are distinct from a missing key, but never expose paths or values.
    return { value: null, status: status('unavailable') };
  }
}
