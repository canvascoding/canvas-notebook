import type { AiCredentialScope } from '@/app/lib/agent-runtime-policy/types';

/** Status-only discovery. Secret values stay in their existing credential editor and scope. */
export async function findStoredCredentialScope(input: {
  requiredKeys: readonly string[];
  scopes: readonly AiCredentialScope[];
  preferredScope: AiCredentialScope;
  signal: AbortSignal;
}): Promise<AiCredentialScope | null> {
  if (!input.requiredKeys.length) return null;
  const results = await Promise.all(input.scopes.filter(scope => scope !== 'managed').map(async scope => {
    const response = await fetch(`/api/integrations/env?scope=all&secretScope=${scope}&metadataOnly=1`, {
      credentials: 'include', cache: 'no-store', signal: input.signal,
    });
    if (response.status === 403) return null;
    const payload = await response.json();
    if (!response.ok || !payload.success || !Array.isArray(payload.data?.entries)) throw new Error('Credential status could not be loaded.');
    const entries = payload.data.entries as Array<{ key: string; configured: boolean; readable: boolean }>;
    if (entries.some(entry => input.requiredKeys.includes(entry.key) && entry.readable === false)) throw new Error('Stored credentials are not readable.');
    return input.requiredKeys.every(key => entries.some(entry => entry.key === key && entry.configured && entry.readable)) ? scope : null;
  }));
  input.signal.throwIfAborted();
  return results.find(scope => scope === input.preferredScope) ?? results.find(scope => scope !== null) ?? null;
}
