import 'server-only';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { providerUsesOAuth } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import { workspaceAllowsInteractiveUserCredentials } from '@/app/lib/agent-runtime-policy/user-credential-policy';
import {
  deleteWorkspaceModelPolicyStore,
  deleteUserModelPreferenceStore,
  readUserWorkspaceProviderGrant,
  readWorkspaceModelPolicy,
  revokeUserWorkspaceProviderGrant,
  RuntimeContextRevisionConflictError,
  RuntimeRevisionConflictError,
  RuntimeStoredDataError,
  SessionRuntimeContextRevisionConflictError,
  SessionRuntimeSnapshotConflictError,
  writeUserModelPreferenceStore,
  writeUserWorkspaceProviderGrant,
  writeWorkspaceModelPolicyStore,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import {
  AiRuntimePolicyError,
  assertEffectiveRuntimeSelection,
  resolveEffectiveAgentRuntime,
  type AiRuntimeResolutionContext,
} from '@/app/lib/agent-runtime-policy/runtime-resolver';
import type {
  AiEffectiveRuntimeResolution,
  AiModelReference,
  AiRuntimeSelection,
  AiRuntimeExecutionMode,
  AiUserWorkspaceProviderGrant,
  AiWorkspaceModelPolicy,
} from '@/app/lib/agent-runtime-policy/types';
import { AI_THINKING_LEVELS } from '@/app/lib/agent-runtime-policy/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

export { RuntimeContextRevisionConflictError };

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;
const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;
const MAX_POLICY_MODELS = 10_000;
const USER_GRANT_EXECUTION_MODES = new Set<AiRuntimeExecutionMode>(['interactive']);

export class AiRuntimeInputError extends Error {
  readonly status = 400;

  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AiRuntimeInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', `Unsupported field: ${key}`);
    }
  }
}

function stringField(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value.trim())) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', `${field} is invalid.`);
  }
  return value.trim();
}

function revisionField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', `${field} must be a non-negative integer.`);
  }
  return value;
}

function thinkingField(value: unknown): PiThinkingLevel {
  if (typeof value !== 'string' || !AI_THINKING_LEVELS.includes(value as PiThinkingLevel)) {
    throw new AiRuntimeInputError('INVALID_THINKING_LEVEL', 'thinkingLevel is invalid.');
  }
  return value as PiThinkingLevel;
}

export function parseRuntimeSelection(value: unknown): AiRuntimeSelection {
  if (!isRecord(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'selection must be an object.');
  }
  assertAllowedKeys(value, ['providerInstallationId', 'providerId', 'modelId', 'thinkingLevel']);
  return {
    providerInstallationId: stringField(value.providerInstallationId, 'providerInstallationId', INSTALLATION_ID_PATTERN),
    providerId: stringField(value.providerId, 'providerId', PROVIDER_ID_PATTERN),
    modelId: stringField(value.modelId, 'modelId', MODEL_ID_PATTERN),
    thinkingLevel: thinkingField(value.thinkingLevel),
  };
}

export type AiUserPreferenceUpdate = {
  expectedRevision: number;
  expectedCatalogRevision: number;
  expectedPolicyRevision: number;
  selection: AiRuntimeSelection;
};

export function parseUserPreferenceUpdate(value: unknown): AiUserPreferenceUpdate {
  if (!isRecord(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'Preference update must be an object.');
  }
  assertAllowedKeys(value, [
    'workspaceId',
    'agentId',
    'expectedRevision',
    'expectedCatalogRevision',
    'expectedPolicyRevision',
    'selection',
  ]);
  return {
    expectedRevision: revisionField(value.expectedRevision, 'expectedRevision'),
    expectedCatalogRevision: revisionField(value.expectedCatalogRevision, 'expectedCatalogRevision'),
    expectedPolicyRevision: revisionField(value.expectedPolicyRevision, 'expectedPolicyRevision'),
    selection: parseRuntimeSelection(value.selection),
  };
}

export type AiUserProviderGrantUpdate = {
  providerInstallationId: string;
  allowedExecutionModes: AiRuntimeExecutionMode[];
  expectedRevision: number;
};

export function parseUserProviderGrantUpdate(value: unknown): AiUserProviderGrantUpdate {
  if (!isRecord(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'User provider credential grant must be an object.');
  }
  assertAllowedKeys(value, [
    'workspaceId',
    'agentId',
    'providerInstallationId',
    'allowedExecutionModes',
    'expectedRevision',
  ]);
  if (!Array.isArray(value.allowedExecutionModes) || value.allowedExecutionModes.length === 0) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'allowedExecutionModes must be a non-empty array.');
  }
  const modes = Array.from(new Set(value.allowedExecutionModes.map((mode) => {
    if (typeof mode !== 'string' || !USER_GRANT_EXECUTION_MODES.has(mode as AiRuntimeExecutionMode)) {
      throw new AiRuntimeInputError(
        'INVALID_RUNTIME_INPUT',
        'Only interactive user credential grants are currently supported.',
      );
    }
    return mode as AiRuntimeExecutionMode;
  })));
  return {
    providerInstallationId: stringField(value.providerInstallationId, 'providerInstallationId', INSTALLATION_ID_PATTERN),
    allowedExecutionModes: modes,
    expectedRevision: revisionField(value.expectedRevision, 'expectedRevision'),
  };
}

async function assertUserProviderGrantTarget(input: {
  context: AiRuntimeResolutionContext;
  providerInstallationId: string;
}): Promise<void> {
  if (input.context.workspaceType === 'personal') {
    throw new AiRuntimePolicyError(
      'PROVIDER_INSTALLATION_NOT_ALLOWED',
      'Personal workspaces do not require a team credential grant.',
    );
  }
  if (
    input.context.principal?.type === 'organization_service'
    || (input.context.principal?.type === 'user' && input.context.principal.userId !== input.context.userId)
  ) {
    throw new AiRuntimePolicyError('PROVIDER_INSTALLATION_NOT_ALLOWED', 'Only the credential owner can manage this grant.');
  }
  const [catalog, policy] = await Promise.all([
    readAppRuntimeCatalog(input.context.organizationId),
    readWorkspaceModelPolicy(input.context.organizationId, input.context.workspaceId),
  ]);
  const provider = catalog.providers.find((candidate) => candidate.installationId === input.providerInstallationId);
  if (!provider || !provider.enabled || provider.credentialScope !== 'user' || !providerUsesOAuth(provider)) {
    throw new AiRuntimePolicyError(
      'PROVIDER_INSTALLATION_NOT_ALLOWED',
      'The selected provider installation is not an enabled personal OAuth provider.',
    );
  }
  if (!workspaceAllowsInteractiveUserCredentials({
    workspaceType: input.context.workspaceType,
    policy,
  })) {
    throw new AiRuntimePolicyError(
      'PROVIDER_INSTALLATION_NOT_ALLOWED',
      'Personal provider credentials are disabled by this workspace policy.',
    );
  }
}

export async function setUserProviderGrant(input: {
  context: AiRuntimeResolutionContext;
  update: AiUserProviderGrantUpdate;
}): Promise<AiUserWorkspaceProviderGrant> {
  await assertUserProviderGrantTarget({
    context: input.context,
    providerInstallationId: input.update.providerInstallationId,
  });
  return writeUserWorkspaceProviderGrant({
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId,
    agentId: input.context.agentId,
    providerInstallationId: input.update.providerInstallationId,
    allowedExecutionModes: input.update.allowedExecutionModes,
    expectedRevision: input.update.expectedRevision,
  });
}

export async function getUserProviderGrant(input: {
  context: AiRuntimeResolutionContext;
  providerInstallationId: string;
}): Promise<AiUserWorkspaceProviderGrant | null> {
  return readUserWorkspaceProviderGrant({
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId,
    agentId: input.context.agentId,
    providerInstallationId: input.providerInstallationId,
  });
}

export async function revokeUserProviderGrant(input: {
  context: AiRuntimeResolutionContext;
  providerInstallationId: string;
  expectedRevision?: number;
}): Promise<AiUserWorkspaceProviderGrant | null> {
  if (
    input.context.principal?.type === 'organization_service'
    || (input.context.principal?.type === 'user' && input.context.principal.userId !== input.context.userId)
  ) {
    throw new AiRuntimePolicyError('PROVIDER_INSTALLATION_NOT_ALLOWED', 'Only the credential owner can revoke this grant.');
  }
  return revokeUserWorkspaceProviderGrant({
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId,
    agentId: input.context.agentId,
    providerInstallationId: input.providerInstallationId,
    expectedRevision: input.expectedRevision,
  });
}

function assertContextRevisions(
  resolution: AiEffectiveRuntimeResolution,
  expectedCatalogRevision: number,
  expectedPolicyRevision: number,
): void {
  if (
    resolution.catalogRevision !== expectedCatalogRevision
    || resolution.policyRevision !== expectedPolicyRevision
  ) {
    throw new RuntimeContextRevisionConflictError(resolution.catalogRevision, resolution.policyRevision);
  }
}

export async function setUserRuntimePreference(input: {
  context: AiRuntimeResolutionContext;
  update: AiUserPreferenceUpdate;
}): Promise<AiEffectiveRuntimeResolution> {
  const validation = await resolveEffectiveAgentRuntime({
    ...input.context,
    sessionId: null,
    requestedSelection: input.update.selection,
  });
  assertContextRevisions(
    validation,
    input.update.expectedCatalogRevision,
    input.update.expectedPolicyRevision,
  );
  assertEffectiveRuntimeSelection(validation);

  await writeUserModelPreferenceStore({
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId,
    agentId: input.context.agentId,
    expectedRevision: input.update.expectedRevision,
    expectedCatalogRevision: input.update.expectedCatalogRevision,
    expectedPolicyRevision: input.update.expectedPolicyRevision,
    selection: input.update.selection,
  });
  return resolveEffectiveAgentRuntime({ ...input.context, sessionId: null, requestedSelection: null });
}

export async function resetUserRuntimePreference(input: {
  context: AiRuntimeResolutionContext;
  expectedRevision?: number;
}): Promise<AiEffectiveRuntimeResolution> {
  await deleteUserModelPreferenceStore({
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId,
    agentId: input.context.agentId,
    expectedRevision: input.expectedRevision,
  });
  return resolveEffectiveAgentRuntime({ ...input.context, sessionId: null, requestedSelection: null });
}

export type AiWorkspacePolicyUpdate = {
  expectedRevision: number;
  expectedCatalogRevision: number;
  allowedModels: AiModelReference[] | null;
  defaultSelection: AiRuntimeSelection | null;
  allowUserCredentials: boolean;
};

function parseModelReference(value: unknown): AiModelReference {
  if (!isRecord(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'Each allowed model must be an object.');
  }
  assertAllowedKeys(value, ['providerInstallationId', 'modelId']);
  return {
    providerInstallationId: stringField(value.providerInstallationId, 'providerInstallationId', INSTALLATION_ID_PATTERN),
    modelId: stringField(value.modelId, 'modelId', MODEL_ID_PATTERN),
  };
}

export function parseWorkspacePolicyUpdate(value: unknown): AiWorkspacePolicyUpdate {
  if (!isRecord(value)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'Workspace policy update must be an object.');
  }
  assertAllowedKeys(value, [
    'workspaceId',
    'expectedRevision',
    'expectedCatalogRevision',
    'allowedModels',
    'defaultSelection',
    'allowUserCredentials',
  ]);
  if (value.allowedModels !== null && !Array.isArray(value.allowedModels)) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'allowedModels must be an array or null.');
  }
  if (Array.isArray(value.allowedModels) && value.allowedModels.length > MAX_POLICY_MODELS) {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'allowedModels exceeds the supported limit.');
  }
  if (typeof value.allowUserCredentials !== 'boolean') {
    throw new AiRuntimeInputError('INVALID_RUNTIME_INPUT', 'allowUserCredentials must be a boolean.');
  }
  const references = value.allowedModels === null
    ? null
    : Array.from(new Map(
        (value.allowedModels as unknown[])
          .map(parseModelReference)
          .map((reference) => [`${reference.providerInstallationId}\0${reference.modelId}`, reference]),
      ).values());
  return {
    expectedRevision: revisionField(value.expectedRevision, 'expectedRevision'),
    expectedCatalogRevision: revisionField(value.expectedCatalogRevision, 'expectedCatalogRevision'),
    allowedModels: references,
    defaultSelection: value.defaultSelection === null ? null : parseRuntimeSelection(value.defaultSelection),
    allowUserCredentials: value.allowUserCredentials,
  };
}

function assertWorkspacePolicyAllowed(input: {
  catalog: Awaited<ReturnType<typeof readAppRuntimeCatalog>>;
  workspaceType: AiRuntimeResolutionContext['workspaceType'];
  update: AiWorkspacePolicyUpdate;
}): void {
  const catalogModels = new Map(input.catalog.providers.flatMap((provider) => (
    provider.models.filter((model) => model.enabled).map((model) => [
      `${provider.installationId}\0${model.id}`,
      { provider, model },
    ] as const)
  )));
  for (const reference of input.update.allowedModels ?? []) {
    const entry = catalogModels.get(`${reference.providerInstallationId}\0${reference.modelId}`);
    if (!entry || !entry.provider.enabled) {
      throw new AiRuntimePolicyError('MODEL_NOT_ALLOWED', 'Workspace policy cannot allow a model outside the app catalog.');
    }
  }

  const selection = input.update.defaultSelection;
  if (!selection) return;
  const entry = catalogModels.get(`${selection.providerInstallationId}\0${selection.modelId}`);
  if (!entry || !entry.provider.enabled) {
    throw new AiRuntimePolicyError('MODEL_NOT_ALLOWED', 'Workspace default must use an enabled app model.');
  }
  if (entry.provider.providerId !== selection.providerId) {
    throw new AiRuntimePolicyError('PROVIDER_ID_MISMATCH', 'Workspace default provider does not match its installation.');
  }
  if (!entry.model.thinkingLevels.includes(selection.thinkingLevel)) {
    throw new AiRuntimePolicyError('INVALID_INTELLIGENCE', 'Workspace default intelligence is not supported by its model.');
  }
  if (
    input.workspaceType !== 'personal'
    && entry.provider.credentialScope === 'user'
    && !input.update.allowUserCredentials
  ) {
    throw new AiRuntimePolicyError(
      'PROVIDER_INSTALLATION_NOT_ALLOWED',
      'Workspace default cannot use personal credentials while they are disabled.',
    );
  }
  if (input.update.allowedModels && !input.update.allowedModels.some((reference) => (
    reference.providerInstallationId === selection.providerInstallationId
    && reference.modelId === selection.modelId
  ))) {
    throw new AiRuntimePolicyError('MODEL_NOT_ALLOWED', 'Workspace default must be in the workspace model allowlist.');
  }
}

export async function replaceWorkspaceRuntimePolicy(input: {
  organizationId: string;
  workspaceId: string;
  workspaceType: AiRuntimeResolutionContext['workspaceType'];
  actorUserId: string;
  update: AiWorkspacePolicyUpdate;
}): Promise<AiWorkspaceModelPolicy> {
  const [catalog, currentPolicy] = await Promise.all([
    readAppRuntimeCatalog(input.organizationId),
    readWorkspaceModelPolicy(input.organizationId, input.workspaceId),
  ]);
  const currentPolicyRevision = currentPolicy?.revision ?? 0;
  if (
    catalog.revision !== input.update.expectedCatalogRevision
    || currentPolicyRevision !== input.update.expectedRevision
  ) {
    throw new RuntimeContextRevisionConflictError(catalog.revision, currentPolicyRevision);
  }
  assertWorkspacePolicyAllowed({
    catalog,
    workspaceType: input.workspaceType,
    update: input.update,
  });
  return writeWorkspaceModelPolicyStore({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    expectedRevision: input.update.expectedRevision,
    expectedCatalogRevision: input.update.expectedCatalogRevision,
    allowedModels: input.update.allowedModels,
    defaultSelection: input.update.defaultSelection,
    allowUserCredentials: input.update.allowUserCredentials,
  });
}

export async function resetWorkspaceRuntimePolicy(input: {
  organizationId: string;
  workspaceId: string;
  expectedRevision?: number;
}): Promise<boolean> {
  return deleteWorkspaceModelPolicyStore(input);
}

export function runtimeErrorResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, number>;
} {
  if (error instanceof AiRuntimeInputError || error instanceof AiRuntimePolicyError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeStoredDataError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof RuntimeRevisionConflictError) {
    return {
      status: error.status,
      code: error.entity === 'user_preference'
        ? 'PREFERENCE_REVISION_CONFLICT'
        : 'WORKSPACE_POLICY_REVISION_CONFLICT',
      message: error.message,
      details: { currentRevision: error.currentRevision },
    };
  }
  if (error instanceof RuntimeContextRevisionConflictError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: {
        currentCatalogRevision: error.currentCatalogRevision,
        currentPolicyRevision: error.currentPolicyRevision,
      },
    };
  }
  if (error instanceof SessionRuntimeContextRevisionConflictError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: {
        currentCatalogRevision: error.currentCatalogRevision,
        currentPolicyRevision: error.currentPolicyRevision,
      },
    };
  }
  if (error instanceof SessionRuntimeSnapshotConflictError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: 500, code: 'RUNTIME_UPDATE_FAILED', message: 'Failed to update the AI runtime selection.' };
}
