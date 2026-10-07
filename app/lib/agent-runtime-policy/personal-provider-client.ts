import type { AiEffectiveRuntimeResolution } from '@/app/lib/agent-runtime-policy/types';

export async function verifyPersonalProviderConnection(input: {
  workspaceId: string; agentId: string; providerInstallationId: string; modelId: string; signal: AbortSignal;
}): Promise<{ success: boolean; code: string; resolution?: AiEffectiveRuntimeResolution }> {
  const { signal, ...target } = input;
  const response = await fetch('/api/agent-runtime/personal-provider-verify', {
    method: 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target),
  });
  const payload = await response.json().catch(() => null);
  return {
    success: response.ok && payload?.success === true,
    code: typeof payload?.code === 'string' ? payload.code : 'PROVIDER_VERIFICATION_FAILED',
    ...(payload?.data?.resolution ? { resolution: payload.data.resolution } : {}),
  };
}
