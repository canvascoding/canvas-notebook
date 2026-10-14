import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getLicenseStatus } from '@/app/lib/license';
import { parseAgentDefaultFields, validateAgentDefaultOnConnection } from '@/app/lib/agent-runtime-policy/agent-default-service';
import { getAgentAccessOnConnection } from './access';
import { resolveVerifiedAgentActorContextOnConnection, type VerifiedAgentActorContext } from './actor-context';
import type { SpecialAgentRuntimeFields } from './effective-runtime-config';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot } from './workflow-contracts';
import { compileAgentExtensionConfigurationContext, type CompiledAgentExtensionConfigurationContext } from './extension-context-compiler';
import { assembleAgentExtensionPackageContextOnConnection, buildAgentExtensionPackageContextOnConnection,
  prepareAgentExtensionContextPackageSources, withAgentExtensionContextPackageSources,
  type PreparedAgentExtensionContextPackageSource, type AgentExtensionPackageContext } from './extension-context-package-metadata';
import { collectAgentExtensionContextSharedReferences, buildAgentExtensionProviderContextOnConnection } from './extension-context-provider-metadata';
import { authorizeIntegrationConnectionOnConnection, authorizeIntegrationConnectionBindingsOnConnection,
  lockIntegrationConnectionBindingsOnConnection, prepareEmailV2BindingConfigurationOnConnection,
  type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { holdAgentGrantAuthority, readManagedAgentWorkflowOnConnection, readAgentWorkflowPreferenceSnapshot } from './workflow-configuration';
import { revalidateAgentExtensionOptionsContext, type AgentExtensionOptionsContext } from './extension-options-context';
import type { AgentExtensionOptionsRequest } from './extension-options-contracts';
import type { AgentExtensionProviderContext } from './extension-provider-context-projection';
import { EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS } from '@/app/lib/capabilities/extensions/context-prompt';
import { EMAIL_MANAGED_AGENT_ID } from './storage';

type PreviewRequest = Extract<AgentExtensionOptionsRequest, { operation: 'preview' }>;
export type CompleteAgentExtensionOptionsContext = CompiledAgentExtensionConfigurationContext & {
  packageContext: AgentExtensionPackageContext;
  providerContext: AgentExtensionProviderContext;
};
export type ProposedAgentExtensionPreviewFrame = {
  database: SqlConnection;
  verified: VerifiedAgentActorContext;
  packages: AgentExtensionPackageContext;
  existing: AgentWorkflowInternalSnapshot | null;
  shared: ReadonlyMap<string, IntegrationConnectionBindingAuthorization>;
};
export type ProposedAgentExtensionPreviewProviders = {
  context: AgentExtensionProviderContext;
  /** Fresh private source stamps, not provider credentials or execution authority. */
  fingerprint: string;
};

function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }

async function runtimeFields(context: AgentExtensionOptionsContext, request: PreviewRequest): Promise<SpecialAgentRuntimeFields> {
  const previous = context.snapshot?.agent;
  const modelFields = ['defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking'] as const;
  const enabledTools = request.enabledTools === undefined ? previous?.enabledTools ?? null : request.enabledTools;
  if (!modelFields.some(field => request[field] !== undefined)) {
    return { defaultProvider: previous?.defaultProvider ?? null, defaultModel: previous?.defaultModel ?? null,
      defaultThinking: previous?.defaultThinking ?? null, enabledTools };
  }
  const proposed = Object.fromEntries(modelFields.map(field => [field,
    request[field] === undefined ? previous?.[field] ?? null : request[field]]));
  const selection = parseAgentDefaultFields({ providerInstallationId: proposed.defaultProviderInstallationId,
    providerId: proposed.defaultProvider, modelId: proposed.defaultModel, thinkingLevel: proposed.defaultThinking });
  // Preview validation never retains a model-catalog lock while taking source,
  // connection or Agent locks. Save obtains its own fresh catalog validation.
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(context.actor, database, { lock: true });
    if (context.target.kind === 'existing' || selection !== null) {
      if (!verified.organizationId || !['owner', 'admin'].includes(verified.organizationRole ?? '')
        || previous?.organizationId && previous.organizationId !== verified.organizationId) {
        fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required for model defaults.', 403);
      }
      await validateAgentDefaultOnConnection(database, { organizationId: verified.organizationId, selection,
        expectedCatalogRevision: request.expectedCatalogRevision });
    }
    await database.run('COMMIT');
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
  return { defaultProvider: selection?.providerId ?? null, defaultModel: selection?.modelId ?? null,
    defaultThinking: selection?.thinkingLevel ?? null, enabledTools };
}

/** Legacy context remains unknown, but proposed model changes still follow the actual writer's rules. */
export async function validateAgentExtensionOptionsPreviewRuntimeFields(context: AgentExtensionOptionsContext,
  request: PreviewRequest): Promise<void> {
  await runtimeFields(context, request);
}

async function compile(context: AgentExtensionOptionsContext,
  verified: VerifiedAgentActorContext, packages: AgentExtensionPackageContext,
  providers: AgentExtensionProviderContext, settings: SpecialAgentRuntimeFields): Promise<CompleteAgentExtensionOptionsContext> {
  const sourceFingerprint = createHash('sha256').update(JSON.stringify([context.contextKey,
    packages.fingerprint, providers.projection, settings])).digest('hex');
  const compiled = await compileAgentExtensionConfigurationContext({ actorUserId: verified.userId,
    runtimeFields: settings, workspacePermissions: verified.workspacePermissions ? {
      canWrite: verified.workspacePermissions.canWrite, canDelete: verified.workspacePermissions.canDelete,
      canShare: verified.workspacePermissions.canCreatePublicLinks } : null,
    presentation: { fingerprint: sourceFingerprint, mode: 'fixed', packages: packages.packages,
      skills: packages.skills, workflowProjection: providers.projection }, requiredProviders: providers.requiredProviders });
  return { ...compiled, packageContext: packages, providerContext: providers };
}

/** Exact proposed data, held real sources and actual inheritance; no prospective Agent or session is created. */
export async function compileProposedAgentExtensionOptionsPreview(context: AgentExtensionOptionsContext, request: PreviewRequest,
  sources: readonly PreparedAgentExtensionContextPackageSource[], options: {
    sharedReferences: readonly string[];
    resolveProviders: (frame: ProposedAgentExtensionPreviewFrame) => Promise<ProposedAgentExtensionPreviewProviders>;
  }): Promise<CompleteAgentExtensionOptionsContext> {
  if (request.configuration?.mode !== 'fixed') fail('AGENT_EXTENSION_PREVIEW_INVALID', 'An explicit proposed configuration is required.', 400);
  await revalidateAgentExtensionOptionsContext(context);
  const settings = await runtimeFields(context, request);
  // Resolve/refresh real licensing before BEGIN. Provider Seat checks reverify
  // the current signed stored revision using the held connection only.
  await getLicenseStatus();
  const database = await openDb();
  let result: CompleteAgentExtensionOptionsContext;
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(context.actor, database, { lock: true });
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: verified.userId, ...verified.context }, options.sharedReferences);
    result = await withAgentExtensionContextPackageSources(database, context.actor, sources, async () => {
      const existing = await currentExistingPreviewTarget(database, context, verified);
      const readShared = async () => {
        const shared = new Map<string, IntegrationConnectionBindingAuthorization>();
        if (existing) {
          const emailV2Configuration = existing.agent.agentId === EMAIL_MANAGED_AGENT_ID
            ? await prepareEmailV2BindingConfigurationOnConnection(database, batch, existing.agent) : undefined;
          for (const authorization of await authorizeIntegrationConnectionBindingsOnConnection(database, batch, existing.agent, 'configure',
            emailV2Configuration ? { emailV2Configuration } : {})) shared.set(authorization.resource.connectionRef, authorization);
        } else for (const reference of batch.connectionRefs) {
          // The real batch holds these resource rows against mutation. A new
          // target has no Agent grant: use only freshly read ordinary ActorUse.
          const authorization = await authorizeIntegrationConnectionOnConnection(database, { userId: verified.userId,
            organizationId: verified.organizationId, workspaceId: verified.context.workspaceId }, reference, 'use');
          shared.set(reference, { ...authorization, canUse: authorization.access.canUse, canManage: authorization.access.canManage });
        }
        return shared;
      };
      const packages = await assembleAgentExtensionPackageContextOnConnection({ database, actor: context.actor,
        workflowVersion: 2, packageSelections: sources, relevantSkills: null, agentKind: 'special' });
      const frame = { database, verified, packages, existing, shared: await readShared() };
      const providers = await options.resolveProviders(frame);
      const compiled = await compile(context, verified, packages, providers.context, settings);
      frame.shared = await readShared();
      const fresh = await options.resolveProviders(frame);
      if (fresh.fingerprint !== providers.fingerprint || JSON.stringify(fresh.context) !== JSON.stringify(providers.context)) {
        fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected connection metadata changed. Reload its preview.');
      }
      return compiled;
    });
    await database.run('COMMIT');
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
  await revalidateAgentExtensionOptionsContext(context);
  return result;
}

async function currentExistingPreviewTarget(database: SqlConnection, context: AgentExtensionOptionsContext,
  verified: VerifiedAgentActorContext): Promise<AgentWorkflowInternalSnapshot | null> {
  if (context.target.kind !== 'existing' || !context.snapshot) return null;
  await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [context.snapshot.agent.agentId]);
  const current = await readManagedAgentWorkflowOnConnection(database, context.snapshot.agent.agentId);
  if (current.agent.id !== context.snapshot.agent.id || current.agent.revision !== context.snapshot.agent.revision
    || current.workflowRevision !== context.snapshot.workflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The Agent changed. Reload its configuration.');
  await holdAgentGrantAuthority(database, context.actor, current.agent);
  if (!(await getAgentAccessOnConnection(database, verified.userId, current.agent.agentId, verified.context)).canEdit) {
    fail('AGENT_ACCESS_DENIED', 'Current Agent editing permission is required.', 403);
  }
  const preferences = readAgentWorkflowPreferenceSnapshot(await database.get(
    'SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2 FOR SHARE',
    [current.agent.agentId, verified.userId]) as Record<string, unknown> | undefined);
  if (preferences.revision !== context.snapshot.preferenceRevision) {
    fail('AGENT_WORKFLOW_PREFERENCE_CONFLICT', 'Your connection choice changed. Reload its preview.');
  }
  current.choices = preferences.choices; current.preferenceRevision = preferences.revision;
  return current;
}

/** Omitted configuration follows the actual existing rows and preferences, exactly as a native/model-only PATCH. */
export async function compileKeptAgentExtensionOptionsPreview(context: AgentExtensionOptionsContext,
  request: PreviewRequest): Promise<CompleteAgentExtensionOptionsContext | null> {
  if (request.configuration !== undefined || context.target.kind !== 'existing' || !context.snapshot) {
    fail('AGENT_EXTENSION_PREVIEW_INVALID', 'An actual existing configuration is required.', 400);
  }
  await revalidateAgentExtensionOptionsContext(context);
  const settings = await runtimeFields(context, request);
  if (context.snapshot.workflowVersion === null) return null;
  const sources = await prepareAgentExtensionContextPackageSources(context.actor, context.snapshot);
  const database = await openDb();
  let result: CompleteAgentExtensionOptionsContext;
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(context.actor, database, { lock: true });
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: verified.userId, ...verified.context },
      collectAgentExtensionContextSharedReferences(context.snapshot));
    result = await withAgentExtensionContextPackageSources(database, context.actor, sources, async () => {
      const current = await currentExistingPreviewTarget(database, context, verified);
      if (!current) fail('AGENT_EXTENSION_PREVIEW_INVALID', 'An actual existing configuration is required.', 400);
      const packages = await buildAgentExtensionPackageContextOnConnection({ database, actor: context.actor, snapshot: current });
      const providers = await buildAgentExtensionProviderContextOnConnection({ database, actor: verified,
        snapshot: current, batch, packages: packages.configurations, purpose: 'configure' });
      return compile(context, verified, packages, providers, settings);
    });
    await database.run('COMMIT');
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
  await revalidateAgentExtensionOptionsContext(context);
  return result;
}

/** Redact only after the exact internal decision; never rerender with shorter paths to claim a smaller budget. */
export function presentCompiledAgentExtensionOptionsContext(compiled: CompleteAgentExtensionOptionsContext): string {
  let text = compiled.rendered.prompt;
  const skills = [...compiled.packageContext.skills, ...compiled.packageContext.packages.flatMap(pkg => pkg.skills)];
  for (const skill of [...skills].sort((a, b) => b.runtimePath.length - a.runtimePath.length)) {
    text = text.replaceAll(JSON.stringify(skill.runtimePath), JSON.stringify(`SKILL.md (${skill.title || skill.name}; exact internal path)`));
  }
  return text.replaceAll(JSON.stringify('\ud800'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS)), JSON.stringify('<task query>'));
}
