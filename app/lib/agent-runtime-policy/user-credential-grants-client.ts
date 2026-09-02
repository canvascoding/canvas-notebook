import type { AiUserWorkspaceProviderGrant } from '@/app/lib/agent-runtime-policy/types';

type GrantResponse = {
  success?: boolean;
  data?: { grant?: AiUserWorkspaceProviderGrant | null };
  error?: string;
};

async function readGrantResponse(response: Response, fallbackError: string): Promise<GrantResponse> {
  const payload = await response.json().catch(() => null) as GrantResponse | null;
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.error || fallbackError);
  }
  return payload;
}

export async function enableInteractiveUserCredentialGrant(input: {
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
  fallbackError: string;
}): Promise<AiUserWorkspaceProviderGrant> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerInstallationId: input.providerInstallationId,
  });
  const currentResponse = await fetch(
    `/api/agent-runtime/user-credential-grants?${query.toString()}`,
    { credentials: 'include', cache: 'no-store' },
  );
  const currentPayload = await readGrantResponse(currentResponse, input.fallbackError);
  const response = await fetch('/api/agent-runtime/user-credential-grants', {
    method: 'PUT',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      providerInstallationId: input.providerInstallationId,
      allowedExecutionModes: ['interactive'],
      expectedRevision: currentPayload.data?.grant?.revision ?? 0,
    }),
  });
  const payload = await readGrantResponse(response, input.fallbackError);
  if (!payload.data?.grant) throw new Error(input.fallbackError);
  return payload.data.grant;
}
