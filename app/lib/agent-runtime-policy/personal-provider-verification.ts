import 'server-only';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { readUserWorkspaceProviderGrant, readWorkspaceModelPolicy } from '@/app/lib/agent-runtime-policy/runtime-store';
import { workspaceAllowsInteractiveUserCredentials } from '@/app/lib/agent-runtime-policy/user-credential-policy';
import { ProviderVerificationError, verifyProviderInstallation, type ProviderVerificationResult } from '@/app/lib/agent-runtime-policy/provider-verification-service';
import {
  isPersonalOAuthProvider, personalProviderConnectionId, readPersonalProviderRecord,
  readPersonalProviderVerification, writePersonalProviderVerification,
} from '@/app/lib/agent-runtime-policy/personal-provider-store';
import type { AiRuntimeResolutionContext } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import type { AiCatalogModel, AiProviderInstallation } from '@/app/lib/agent-runtime-policy/types';

export async function assertPersonalProviderProbeAllowed(
  context: AiRuntimeResolutionContext, provider: AiProviderInstallation, model: AiCatalogModel,
): Promise<void> {
  const principal = context.principal;
  if (context.executionMode !== 'interactive' || principal?.type !== 'user'
    || principal.userId !== context.userId || principal.credentialSubjectUserId !== context.userId
    || !isPersonalOAuthProvider(provider) || !provider.enabled || provider.status === 'disabled') {
    throw new ProviderVerificationError('PERSONAL_PROVIDER_NOT_ALLOWED', 'This personal provider cannot be tested in this context.', 403);
  }
  const policy = await readWorkspaceModelPolicy(context.organizationId, context.workspaceId);
  if (!workspaceAllowsInteractiveUserCredentials({ workspaceType: context.workspaceType, policy })
    || (policy?.allowedModels && !policy.allowedModels.some(ref => ref.providerInstallationId === provider.installationId && ref.modelId === model.id))) {
    throw new ProviderVerificationError('PERSONAL_PROVIDER_NOT_ALLOWED', 'The model is not allowed in this workspace.', 403);
  }
  if (context.workspaceType !== 'personal') {
    const grant = await readUserWorkspaceProviderGrant({ ...context, providerInstallationId: provider.installationId });
    if (grant?.status !== 'active' || !grant.allowedExecutionModes.includes('interactive')) {
      throw new ProviderVerificationError('PERSONAL_PROVIDER_APPROVAL_REQUIRED', 'Approve this provider for your interactive runs before testing it.', 403);
    }
  }
}

export async function verifyPersonalProvider(input: {
  context: AiRuntimeResolutionContext; providerInstallationId: string; modelId?: string; signal?: AbortSignal;
}): Promise<ProviderVerificationResult> {
  input.signal?.throwIfAborted();
  const catalog = await readAppRuntimeCatalog(input.context.organizationId);
  const provider = catalog.providers.find(candidate => candidate.installationId === input.providerInstallationId);
  const model = provider?.models.find(candidate => candidate.enabled && (input.modelId ? candidate.id === input.modelId : candidate.isProviderDefault));
  if (!provider || !model) throw new ProviderVerificationError('PROVIDER_MODEL_UNAVAILABLE', 'The configured provider default is unavailable.', 409);
  await assertPersonalProviderProbeAllowed(input.context, provider, model);
  const connectionId = personalProviderConnectionId(provider, input.context.userId);
  if (!connectionId) throw new ProviderVerificationError('CREDENTIAL_NOT_AVAILABLE', 'Connect your personal account before testing it.', 409);
  const [previous, previousState] = await Promise.all([
    readPersonalProviderRecord({ ...input.context, providerInstallationId: provider.installationId }),
    readPersonalProviderVerification({ ...input.context, provider }),
  ]);
  const result = await verifyProviderInstallation({
    organizationId: input.context.organizationId, actorUserId: input.context.userId,
    providerInstallationId: provider.installationId, modelId: model.id, signal: input.signal, probeOnly: true,
    authorize: (currentProvider, currentModel) => assertPersonalProviderProbeAllowed(input.context, currentProvider, currentModel),
  });
  input.signal?.throwIfAborted();
  await assertPersonalProviderProbeAllowed(input.context, provider, model);
  const checkedAt = Date.now();
  const status = result.success ? 'ready' : previousState.verifiedAt ? 'degraded' : 'unverified';
  const verifiedAt = result.success ? checkedAt : previousState.verifiedAt ? Date.parse(previousState.verifiedAt) : null;
  await writePersonalProviderVerification({
    ...input.context, provider, modelId: result.modelId, catalogRevision: result.catalogRevision,
    connectionId, expectedRevision: Number(previous?.revision ?? 0), status,
    failureCode: result.success ? null : result.code, verifiedAt, checkedAt,
  });
  return { ...result, status, verifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null };
}
