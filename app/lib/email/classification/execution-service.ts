import 'server-only';
import { randomUUID } from 'node:crypto';
import { evaluateDecision } from '@/app/lib/decision-models/service';
import { DecisionModelError } from '@/app/lib/decision-models/errors';
import type { DecisionInput, DecisionResult } from '@/app/lib/decision-models/types';
import { evaluateManagedDecisionModel, readManagedDecisionModels, ManagedDecisionClientError, type ManagedDecisionClientDependencies, type ManagedDecisionCatalogResolution } from '@/app/lib/managed/decision-client';
import type { ManagedDecisionModel } from '@canvas/decision-models/managed';
import { resolveEmailClassificationCredential, type EmailClassificationCredentialResolution, type EmailClassificationSecretReader } from './credential-service';
import type { EmailClassificationConfiguration, EmailClassificationSettings } from './settings-types';
import type { PostgresEmailClassificationStore } from './store';
import { EmailClassificationVersionConflictError } from './store-types';

export type EmailClassificationExecutionDependencies = ManagedDecisionClientDependencies & {
  readSecret?: EmailClassificationSecretReader;
  resolveCredential?: (configuration: EmailClassificationConfiguration) => EmailClassificationCredentialResolution;
  readManagedCatalog?: () => Promise<ManagedDecisionCatalogResolution>;
  evaluate?: (input: DecisionInput) => Promise<DecisionResult>;
  evaluateManaged?: typeof evaluateManagedDecisionModel;
};
export type EmailClassificationExecution = {
  mode: 'direct' | 'managed'; ready: boolean; reason: string | null;
  credential: EmailClassificationCredentialResolution;
  managedModel: ManagedDecisionModel | null;
  catalog: ManagedDecisionCatalogResolution | null;
};

export async function resolveEmailClassificationExecution(configuration: EmailClassificationConfiguration, dependencies: EmailClassificationExecutionDependencies = {}): Promise<EmailClassificationExecution> {
  if (configuration.executionMode !== 'managed') {
    const credential = (dependencies.resolveCredential ?? (value => resolveEmailClassificationCredential(value, dependencies)))(configuration);
    return { mode: 'direct', ready: credential.status.configured, reason: credential.status.status === 'configured' ? null : credential.status.status === 'missing' ? 'missing_configuration' : 'configuration_unavailable', credential, managedModel: null, catalog: null };
  }
  const catalog = await (dependencies.readManagedCatalog ?? (() => readManagedDecisionModels(dependencies)))();
  const ref = configuration.managedModelRef ?? catalog.catalog?.defaultModelRef;
  const model = catalog.catalog?.models.find(value => value.ref === ref) ?? null;
  const ready = catalog.status === 'ready' && model?.available === true;
  const reason = catalog.status !== 'ready' ? catalog.code ?? 'provider_unavailable' : !model ? 'missing_configuration' : !model.available ? model.status : null;
  const credential: EmailClassificationCredentialResolution = { value: null, status: { status: ready ? 'configured' : catalog.status === 'unavailable' || catalog.status === 'invalid' ? 'unavailable' : 'missing', configured: ready, scope: 'system', anonymous: false, settingsLink: '/settings?tab=secrets' } };
  return { mode: 'managed', ready, reason, credential, managedModel: catalog.status === 'ready' ? model : null, catalog };
}

export function managedEmailConfiguration(configuration: EmailClassificationConfiguration, execution: EmailClassificationExecution): EmailClassificationConfiguration {
  const model = execution.managedModel;
  if (configuration.executionMode !== 'managed' || !model) return configuration;
  return { ...configuration, managedModelRef: model.ref, managedModel: { ref: model.ref, providerId: model.providerId, model: model.model, inferenceRevision: model.inferenceRevision, adapterVersion: model.adapterVersion } };
}

export async function reconcileEmailClassificationExecution(store: Pick<PostgresEmailClassificationStore, 'readSettings'> & Partial<Pick<PostgresEmailClassificationStore, 'updateSettings'>>, settings: EmailClassificationSettings, execution: EmailClassificationExecution): Promise<EmailClassificationSettings> {
  if (settings.configuration.executionMode !== 'managed' || !execution.managedModel || !store.updateSettings) return settings;
  const configuration = managedEmailConfiguration(settings.configuration, execution);
  const current = settings.configuration.managedModel;
  const resolved = configuration.managedModel;
  if (current && resolved && current.ref === resolved.ref && current.providerId === resolved.providerId && current.model === resolved.model
    && current.inferenceRevision === resolved.inferenceRevision && current.adapterVersion === resolved.adapterVersion
    && configuration.managedModelRef === settings.configuration.managedModelRef) return settings;
  try { return await store.updateSettings({ expectedRevision: settings.revision, configuration, actorUserId: null, now: Date.now() }); }
  catch (error) { if (error instanceof EmailClassificationVersionConflictError) return store.readSettings(); throw error; }
}

export async function executeEmailClassification(configuration: EmailClassificationConfiguration, input: Pick<DecisionInput, 'state' | 'questions' | 'schemaVersion' | 'signal'>, execution: EmailClassificationExecution, requestId = `email-probe:${randomUUID()}`, dependencies: EmailClassificationExecutionDependencies = {}): Promise<DecisionResult> {
  if (!execution.ready) {
    if (execution.mode === 'managed') throw new ManagedDecisionClientError(execution.catalog?.code ?? 'missing_configuration', { retryable: execution.catalog?.status === 'unavailable' });
    throw new DecisionModelError('missing_configuration');
  }
  const request: DecisionInput = { ...input, configuration: { providerId: configuration.providerId, model: configuration.model, endpoint: configuration.endpoint ?? undefined, allowPrivateNetwork: configuration.allowPrivateNetwork }, timeoutMs: configuration.timeoutMs };
  if (execution.mode === 'managed') {
    const model = execution.managedModel!;
    if (configuration.managedModel?.inferenceRevision !== model.inferenceRevision) throw new ManagedDecisionClientError('model_changed', { retryable: true });
    return (dependencies.evaluateManaged ?? evaluateManagedDecisionModel)(request, model, requestId, dependencies);
  }
  return (dependencies.evaluate ?? evaluateDecision)({ ...request, credential: execution.credential.value ? { apiKey: execution.credential.value } : undefined });
}
