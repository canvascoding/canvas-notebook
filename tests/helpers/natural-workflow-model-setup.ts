import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';

import type {
  AiAppRuntimeCatalog,
  AiCatalogDiscovery,
  AiCatalogProviderUpdate,
  AiEffectiveRuntimeResolution,
  AiProviderInstallation,
} from '../../app/lib/agent-runtime-policy/types';

const PROVIDER_ID = 'ollama' as const;
const MODEL_ID = 'kimi-k2.6:cloud' as const;
const THINKING_LEVEL = 'off' as const;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INSTALLATION_ID = /^aip_[a-f0-9]{24}$/u;
// Ordinary Better Auth members use opaque IDs; the owned bootstrap actor may use a UUID.
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const CATALOG_PATH = '/api/admin/agent-runtime/catalog';
const ENV_PATH = '/api/integrations/env?scope=agents&secretScope=organization&key=OLLAMA_API_KEY';

type NaturalModelInput = {
  version: 1;
  providerId: typeof PROVIDER_ID;
  ollamaHost: 'http://127.0.0.1:11434' | 'https://cloud.ollama.com';
  modelId: typeof MODEL_ID;
  apiKey?: string;
};

export type NaturalWorkflowModel = {
  installationId: string;
  providerId: typeof PROVIDER_ID;
  modelId: typeof MODEL_ID;
  thinkingLevel: typeof THINKING_LEVEL;
  credentialScope: 'organization';
  status: 'ready';
  catalogRevision: number;
  providerRevision: number;
  verifiedAt: string;
  verificationCode: 'PROVIDER_VERIFIED';
};

export type NaturalWorkflowEffectiveModel = {
  providerInstallationId: string;
  providerId: typeof PROVIDER_ID;
  modelId: typeof MODEL_ID;
  thinkingLevel: typeof THINKING_LEVEL;
  credentialScope: 'organization';
  status: 'ready';
  catalogRevision: number;
  policyRevision: number;
  selectionSource: 'app_default';
  userId: string;
  organizationId: string;
  workspaceId: string;
  agentId: string;
};

export type NaturalWorkflowSessionModel = Omit<NaturalWorkflowEffectiveModel, 'selectionSource'> & {
  selectionSource: 'app_default' | 'session';
  sessionId: string;
};

type NaturalModelPhase = 'input' | 'catalog_read' | 'secret_read' | 'secret_patch'
  | 'catalog_write' | 'provider_verify' | 'catalog_ready' | 'effective_read'
  | 'effective_input' | 'effective_shape' | 'effective_selection' | 'effective_context'
  | 'effective_actor' | 'effective_principal' | 'effective_provider' | 'effective_revisions'
  | 'session_input' | 'session_shape' | 'session_selection' | 'session_context'
  | 'session_principal' | 'session_provider' | 'session_revisions' | 'session_row';

function naturalModelRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function naturalModelRequire(condition: unknown, phase: NaturalModelPhase): asserts condition {
  if (!condition) throw new Error(`Natural workflow model ${phase} did not satisfy its contract.`);
}

async function readNaturalWorkflowModelInput(inputPath: string): Promise<NaturalModelInput> {
  // This test-only plaintext handoff is never returned, logged or copied into evidence.
  try {
    const uid = process.getuid?.();
    naturalModelRequire(uid !== undefined && path.isAbsolute(inputPath), 'input');
    const directory = path.dirname(inputPath);
    const [before, parent, physicalPath] = await Promise.all([
      lstat(inputPath), lstat(directory), realpath(inputPath),
    ]);
    naturalModelRequire(physicalPath === inputPath && parent.isDirectory() && !parent.isSymbolicLink()
      && parent.uid === uid && (parent.mode & 0o777) === 0o700, 'input');
    naturalModelRequire(before.isFile() && !before.isSymbolicLink() && before.uid === uid
      && before.nlink === 1 && (before.mode & 0o777) === 0o600
      && before.size > 0 && before.size <= MAX_INPUT_BYTES, 'input');
    const file = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    try {
      const opened = await file.stat();
      naturalModelRequire(opened.dev === before.dev && opened.ino === before.ino
        && opened.size === before.size && opened.mtimeMs === before.mtimeMs
        && opened.ctimeMs === before.ctimeMs && opened.uid === uid && opened.nlink === 1
        && (opened.mode & 0o777) === 0o600, 'input');
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const [after, current] = await Promise.all([file.stat(), lstat(inputPath)]);
      naturalModelRequire(bytesRead === before.size && bytesRead <= MAX_INPUT_BYTES, 'input');
      for (const snapshot of [after, current]) {
        naturalModelRequire(snapshot.isFile() && !snapshot.isSymbolicLink() && snapshot.uid === uid
          && snapshot.nlink === 1 && (snapshot.mode & 0o777) === 0o600
          && snapshot.dev === before.dev && snapshot.ino === before.ino && snapshot.size === before.size
          && snapshot.mtimeMs === before.mtimeMs && snapshot.ctimeMs === before.ctimeMs, 'input');
      }
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      naturalModelRequire(naturalModelRecord(value), 'input');
      naturalModelRequire(Object.keys(value).every(key => (
        ['version', 'providerId', 'ollamaHost', 'modelId', 'apiKey'].includes(key)
      )), 'input');
      naturalModelRequire(value.version === 1 && value.providerId === PROVIDER_ID && value.modelId === MODEL_ID, 'input');
      naturalModelRequire(value.ollamaHost === 'http://127.0.0.1:11434'
        || value.ollamaHost === 'https://cloud.ollama.com', 'input');
      naturalModelRequire(value.apiKey === undefined || (typeof value.apiKey === 'string'
        && value.apiKey.length > 0 && value.apiKey.length <= 4096 && value.apiKey === value.apiKey.trim()
        && !/[\u0000-\u001f\u007f]/u.test(value.apiKey)), 'input');
      naturalModelRequire(value.ollamaHost !== 'https://cloud.ollama.com' || typeof value.apiKey === 'string', 'input');
      return value as NaturalModelInput;
    } finally {
      bytes.fill(0);
      await file.close();
    }
  } catch {
    // Filesystem/JSON errors can contain private paths or source text.
    throw new Error('Natural workflow model input did not satisfy its private handoff contract.');
  }
}

async function naturalModelApi(request: APIRequestContext, method: 'GET' | 'PATCH' | 'PUT' | 'POST',
  pathname: string, phase: NaturalModelPhase, data?: Record<string, unknown>,
  headers?: Record<string, string>, envelope: 'data' | 'sessions' = 'data'): Promise<Record<string, unknown>> {
  let status: number | undefined;
  try {
    const response = await request.fetch(pathname, {
      method, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false, timeout: 60_000,
      ...(data === undefined ? {} : { data }), ...(headers ? { headers } : {}),
    });
    try {
      status = response.status();
      naturalModelRequire(status === 200, phase);
      const body = await response.body();
      naturalModelRequire(body.length <= MAX_RESPONSE_BYTES, phase);
      const payload: unknown = JSON.parse(body.toString('utf8'));
      naturalModelRequire(naturalModelRecord(payload) && payload.success === true, phase);
      if (envelope === 'sessions') {
        naturalModelRequire(Array.isArray(payload.sessions) && payload.sessions.length <= 100, phase);
        return payload;
      }
      naturalModelRequire(naturalModelRecord(payload.data), phase);
      return payload.data;
    } finally { await response.dispose(); }
  } catch {
    // Never retain Playwright call logs, postData, provider errors or secret-bearing response bodies.
    throw new Error(`Natural workflow model ${phase} failed${status === undefined ? '' : ` (HTTP ${status})`}.`);
  }
}

async function readNaturalWorkflowCatalog(request: APIRequestContext, organizationId: string): Promise<{
  catalog: AiAppRuntimeCatalog; discovery: AiCatalogDiscovery;
}> {
  const data = await naturalModelApi(request, 'GET', CATALOG_PATH, 'catalog_read');
  naturalModelRequire(naturalModelRecord(data.catalog) && naturalModelRecord(data.discovery), 'catalog_read');
  const catalog = data.catalog;
  naturalModelRequire(catalog.organizationId === organizationId && Number.isSafeInteger(catalog.revision)
    && Number(catalog.revision) >= 0 && Array.isArray(catalog.providers), 'catalog_read');
  for (const provider of catalog.providers) {
    naturalModelRequire(naturalModelRecord(provider) && typeof provider.installationId === 'string'
      && INSTALLATION_ID.test(provider.installationId) && typeof provider.providerId === 'string'
      && typeof provider.enabled === 'boolean' && ['managed', 'system', 'organization', 'user'].includes(String(provider.credentialScope))
      && naturalModelRecord(provider.config) && Number.isSafeInteger(provider.revision)
      && Array.isArray(provider.models), 'catalog_read');
    for (const model of provider.models) {
      naturalModelRequire(naturalModelRecord(model) && typeof model.id === 'string'
        && typeof model.enabled === 'boolean' && typeof model.isProviderDefault === 'boolean'
        && Array.isArray(model.thinkingLevels), 'catalog_read');
    }
  }
  return data as { catalog: AiAppRuntimeCatalog; discovery: AiCatalogDiscovery };
}

function naturalWorkflowProviderUpdate(provider: AiProviderInstallation): AiCatalogProviderUpdate {
  return {
    providerInstallationId: provider.installationId, providerId: provider.providerId,
    enabled: provider.enabled, credentialScope: provider.credentialScope, config: provider.config,
    modelIds: provider.models.filter(model => model.enabled).map(model => model.id),
    defaultModelId: provider.models.find(model => model.enabled && model.isProviderDefault)?.id ?? '',
  };
}

function assertNaturalWorkflowCatalogReady(catalog: AiAppRuntimeCatalog, installationId: string): AiProviderInstallation {
  const provider = catalog.providers.find(candidate => candidate.installationId === installationId);
  naturalModelRequire(provider?.providerId === PROVIDER_ID && provider.credentialScope === 'organization'
    && provider.enabled && provider.status === 'ready' && typeof provider.verifiedAt === 'string'
    && Number.isFinite(Date.parse(provider.verifiedAt)), 'catalog_ready');
  const model = provider.models.find(candidate => candidate.id === MODEL_ID);
  naturalModelRequire(model?.enabled && model.isProviderDefault && model.thinkingLevels.includes(THINKING_LEVEL), 'catalog_ready');
  naturalModelRequire(catalog.defaultSelection?.providerInstallationId === installationId
    && catalog.defaultSelection.providerId === PROVIDER_ID && catalog.defaultSelection.modelId === MODEL_ID
    && catalog.defaultSelection.thinkingLevel === THINKING_LEVEL, 'catalog_ready');
  return provider;
}

/** Use a trace-free normal admin request context; no inherited process credentials or fake LLM. */
export async function provisionNaturalWorkflowModel(adminRequest: APIRequestContext, options: {
  organizationId: string; inputPath: string;
}): Promise<NaturalWorkflowModel> {
  naturalModelRequire(typeof options.organizationId === 'string' && ORGANIZATION_ID.test(options.organizationId), 'input');
  const input = await readNaturalWorkflowModelInput(options.inputPath);
  try {
    const before = await readNaturalWorkflowCatalog(adminRequest, options.organizationId);
    const discovery = before.discovery[PROVIDER_ID];
    const installationId = discovery?.installationIds?.organization;
    naturalModelRequire(typeof installationId === 'string' && INSTALLATION_ID.test(installationId)
      && discovery.models.some(model => model.id === MODEL_ID && model.thinkingLevels?.includes(THINKING_LEVEL)), 'catalog_read');
    const secret = await naturalModelApi(adminRequest, 'GET', ENV_PATH, 'secret_read');
    naturalModelRequire(typeof secret.revision === 'string' && /^[a-f0-9]{64}$/u.test(secret.revision)
      && secret.readable === true, 'secret_read');
    const savedSecret = await naturalModelApi(adminRequest, 'PATCH', '/api/integrations/env', 'secret_patch', {
      scope: 'agents', secretScope: 'organization', baseRevision: secret.revision,
      // An absent key means a genuine unprotected local endpoint, never a stale scoped key.
      patches: [{ key: 'OLLAMA_API_KEY', value: input.apiKey ?? null }],
    });
    naturalModelRequire(savedSecret.readable === true && typeof savedSecret.revision === 'string', 'secret_patch');
    const providers = before.catalog.providers.filter(provider => (
      provider.providerId !== PROVIDER_ID || provider.credentialScope !== 'organization'
    )).map(naturalWorkflowProviderUpdate);
    providers.push({
      providerInstallationId: installationId, providerId: PROVIDER_ID, enabled: true,
      credentialScope: 'organization', modelIds: [MODEL_ID], defaultModelId: MODEL_ID,
      config: { authMethod: 'api-key', ollamaMode: input.ollamaHost === 'http://127.0.0.1:11434' ? 'local' : 'cloud',
        ollamaHost: input.ollamaHost, ollamaModelSource: 'predefined' },
    });
    const saved = await naturalModelApi(adminRequest, 'PUT', CATALOG_PATH, 'catalog_write', {
      expectedRevision: before.catalog.revision, providers,
      defaultSelection: { providerInstallationId: installationId, providerId: PROVIDER_ID,
        modelId: MODEL_ID, thinkingLevel: THINKING_LEVEL },
    });
    naturalModelRequire(naturalModelRecord(saved.catalog)
      && saved.catalog.revision === before.catalog.revision + 1, 'catalog_write');
    // No body or credential in verification: the server resolves the saved org installation.
    const verified = await naturalModelApi(adminRequest, 'POST',
      `/api/admin/agent-runtime/providers/${installationId}/verify`, 'provider_verify');
    naturalModelRequire(verified.success === true && verified.code === 'PROVIDER_VERIFIED'
      && verified.providerInstallationId === installationId && verified.providerId === PROVIDER_ID
      && verified.modelId === MODEL_ID && verified.status === 'ready'
      && verified.catalogRevision === before.catalog.revision + 2, 'provider_verify');
    const current = await readNaturalWorkflowCatalog(adminRequest, options.organizationId);
    const provider = assertNaturalWorkflowCatalogReady(current.catalog, installationId);
    naturalModelRequire(current.catalog.revision === verified.catalogRevision && provider.revision === verified.providerRevision
      && provider.verifiedAt === verified.verifiedAt && provider.config.ollamaHost === input.ollamaHost, 'catalog_ready');
    return {
      installationId, providerId: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: THINKING_LEVEL,
      credentialScope: 'organization', status: 'ready', catalogRevision: current.catalog.revision,
      providerRevision: provider.revision, verifiedAt: provider.verifiedAt!, verificationCode: 'PROVIDER_VERIFIED',
    };
  } finally { delete input.apiKey; }
}

/** Assert each normal Team user's actual central default, without setting personal overrides. */
export async function assertNaturalWorkflowModel(request: APIRequestContext, options: {
  workspaceId: string; agentId: string; providerInstallationId: string; userId: string;
}): Promise<NaturalWorkflowEffectiveModel> {
  naturalModelRequire(typeof options.workspaceId === 'string' && options.workspaceId.length > 0
    && options.workspaceId.length <= 200 && typeof options.agentId === 'string' && options.agentId.length > 0
    && options.agentId.length <= 200 && INSTALLATION_ID.test(options.providerInstallationId)
    && typeof options.userId === 'string' && USER_ID.test(options.userId), 'effective_input');
  const query = new URLSearchParams({ workspaceId: options.workspaceId, agentId: options.agentId });
  const data = await naturalModelApi(request, 'GET', `/api/agent-runtime/effective?${query}`, 'effective_read',
    undefined, { 'x-canvas-workspace-id': options.workspaceId });
  naturalModelRequire(naturalModelRecord(data.context) && Array.isArray(data.providers)
    && naturalModelRecord(data.effectiveSelection) && naturalModelRecord(data.effectiveSelection.selection), 'effective_shape');
  const resolution = data as unknown as AiEffectiveRuntimeResolution;
  const effective = resolution.effectiveSelection!;
  const context = resolution.context;
  const provider = resolution.providers.find(candidate => candidate.installationId === options.providerInstallationId);
  naturalModelRequire(resolution.valid === true && Array.isArray(resolution.issues) && resolution.issues.length === 0
    && resolution.preference === null && resolution.source === 'app_default' && effective.selectionSource === 'app_default'
    && effective.credentialScope === 'organization' && effective.selection.providerInstallationId === options.providerInstallationId
    && effective.selection.providerId === PROVIDER_ID && effective.selection.modelId === MODEL_ID
    && effective.selection.thinkingLevel === THINKING_LEVEL, 'effective_selection');
  naturalModelRequire(context.workspaceId === options.workspaceId && context.agentId === options.agentId
    && context.workspaceType === 'team' && context.executionMode === 'interactive'
    && typeof context.organizationId === 'string' && ORGANIZATION_ID.test(context.organizationId), 'effective_context');
  naturalModelRequire(typeof context.userId === 'string' && USER_ID.test(context.userId)
    && context.userId === options.userId, 'effective_actor');
  naturalModelRequire(naturalModelRecord(context.principal) && context.principal.type === 'user'
    && context.principal.userId === options.userId && context.principal.credentialSubjectUserId === options.userId, 'effective_principal');
  naturalModelRequire(provider?.providerId === PROVIDER_ID && provider.credentialScope === 'organization'
    && provider.status === 'ready' && provider.selectable === true && provider.credentialAvailable === true
    && provider.models.some(model => model.id === MODEL_ID && model.enabled && model.thinkingLevels.includes(THINKING_LEVEL)), 'effective_provider');
  naturalModelRequire(Number.isSafeInteger(resolution.catalogRevision) && Number.isSafeInteger(resolution.policyRevision)
    && effective.catalogRevision === resolution.catalogRevision && effective.policyRevision === resolution.policyRevision, 'effective_revisions');
  return {
    providerInstallationId: options.providerInstallationId, providerId: PROVIDER_ID,
    modelId: MODEL_ID, thinkingLevel: THINKING_LEVEL, credentialScope: 'organization', status: 'ready',
    catalogRevision: resolution.catalogRevision, policyRevision: resolution.policyRevision, selectionSource: 'app_default',
    userId: context.userId, organizationId: context.organizationId, workspaceId: context.workspaceId, agentId: context.agentId,
  };
}

/** Bind the completed normal UI chat to its actual persisted model and exact actor/workspace. */
export async function assertNaturalWorkflowSessionModel(request: APIRequestContext, options: {
  workspaceId: string; agentId: string; sessionId: string; providerInstallationId: string;
  userId: string; organizationId: string;
}): Promise<NaturalWorkflowSessionModel> {
  naturalModelRequire(typeof options.workspaceId === 'string' && options.workspaceId.length > 0
    && options.workspaceId.length <= 200 && typeof options.agentId === 'string' && options.agentId.length > 0
    && options.agentId.length <= 200 && typeof options.sessionId === 'string' && options.sessionId.length > 0
    && options.sessionId.length <= 200 && INSTALLATION_ID.test(options.providerInstallationId)
    && typeof options.userId === 'string' && USER_ID.test(options.userId) && typeof options.organizationId === 'string'
    && ORGANIZATION_ID.test(options.organizationId), 'session_input');
  const headers = { 'x-canvas-workspace-id': options.workspaceId };
  const query = new URLSearchParams({ workspaceId: options.workspaceId, agentId: options.agentId, sessionId: options.sessionId });
  // The effective route itself requires the exact current user's owned agent/session tuple.
  const data = await naturalModelApi(request, 'GET', `/api/agent-runtime/effective?${query}`, 'effective_read', undefined, headers);
  naturalModelRequire(naturalModelRecord(data.context) && Array.isArray(data.providers)
    && naturalModelRecord(data.effectiveSelection) && naturalModelRecord(data.effectiveSelection.selection)
    && naturalModelRecord(data.inheritedSelection) && naturalModelRecord(data.inheritedSelection.selection), 'session_shape');
  const resolution = data as unknown as AiEffectiveRuntimeResolution;
  const effective = resolution.effectiveSelection!, inherited = resolution.inheritedSelection!;
  const context = resolution.context;
  const provider = resolution.providers.find(candidate => candidate.installationId === options.providerInstallationId);
  naturalModelRequire(resolution.valid === true && Array.isArray(resolution.issues) && resolution.issues.length === 0
    && resolution.preference === null && (resolution.source === 'app_default' || resolution.source === 'session')
    && effective.selectionSource === resolution.source && inherited.selectionSource === 'app_default', 'session_selection');
  for (const selected of [effective, inherited]) {
    naturalModelRequire(selected.credentialScope === 'organization'
      && selected.selection.providerInstallationId === options.providerInstallationId
      && selected.selection.providerId === PROVIDER_ID && selected.selection.modelId === MODEL_ID
      && selected.selection.thinkingLevel === THINKING_LEVEL
      && selected.catalogRevision === resolution.catalogRevision && selected.policyRevision === resolution.policyRevision, 'session_selection');
  }
  naturalModelRequire(context.userId === options.userId && context.organizationId === options.organizationId
    && context.workspaceId === options.workspaceId && context.agentId === options.agentId
    && context.workspaceType === 'team' && context.executionMode === 'interactive', 'session_context');
  naturalModelRequire(naturalModelRecord(context.principal) && context.principal.type === 'user'
    && context.principal.userId === options.userId && context.principal.credentialSubjectUserId === options.userId, 'session_principal');
  naturalModelRequire(provider?.providerId === PROVIDER_ID && provider.credentialScope === 'organization'
    && provider.status === 'ready' && provider.selectable === true && provider.credentialAvailable === true
    && provider.models.some(model => model.id === MODEL_ID && model.enabled && model.thinkingLevels.includes(THINKING_LEVEL)), 'session_provider');
  naturalModelRequire(Number.isSafeInteger(resolution.catalogRevision) && Number.isSafeInteger(resolution.policyRevision), 'session_revisions');
  // A default resolution alone could describe a legacy session without a snapshot. Inspect the
  // real persisted Pi row too; this ordinary list is already owner/agent/workspace constrained.
  const listing = await naturalModelApi(request, 'GET', `/api/sessions?${new URLSearchParams({
    agentId: options.agentId, workspaceId: options.workspaceId,
  })}`, 'effective_read', undefined, headers, 'sessions');
  const sessions = (listing.sessions as unknown[]).filter(row => naturalModelRecord(row) && row.sessionId === options.sessionId);
  naturalModelRequire(sessions.length === 1 && naturalModelRecord(sessions[0]), 'session_row');
  const session = sessions[0];
  naturalModelRequire(session.userId === options.userId && session.agentId === options.agentId && session.engine === 'pi'
    && session.provider === PROVIDER_ID && session.model === MODEL_ID && session.thinkingLevel === THINKING_LEVEL
    && naturalModelRecord(session.workspace) && session.workspace.workspaceId === options.workspaceId
    && session.workspace.workspaceType === 'team' && session.workspace.organizationId === options.organizationId, 'session_row');
  return {
    providerInstallationId: options.providerInstallationId, providerId: PROVIDER_ID,
    modelId: MODEL_ID, thinkingLevel: THINKING_LEVEL, credentialScope: 'organization', status: 'ready',
    catalogRevision: resolution.catalogRevision, policyRevision: resolution.policyRevision,
    selectionSource: resolution.source as 'app_default' | 'session', sessionId: options.sessionId,
    userId: context.userId, organizationId: context.organizationId, workspaceId: context.workspaceId, agentId: context.agentId,
  };
}
