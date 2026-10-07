import 'server-only';
import { createHash } from 'node:crypto';
import { DecisionModelError, type DecisionErrorCode } from '@/app/lib/decision-models/errors';
import { decisionProviderRegistry } from '@/app/lib/decision-models/registry';
import { isDecisionRecord, validateDecisionInput, validateDecisionResult } from '@/app/lib/decision-models/validation';
import type { DecisionInput, DecisionResult } from '@/app/lib/decision-models/types';
import type { ManagedDecisionCatalog, ManagedDecisionModel, ManagedDecisionFailureCode, ManagedDecisionRequest } from '@canvas/decision-models/managed';
import { getManagedSystemUpdateOrigin, hasManagedSystemUpdateIntent } from './control-plane-url-policy';

const COMMON_CODES = new Set<DecisionErrorCode>(['missing_configuration', 'invalid_request', 'unsupported_capability', 'invalid_response', 'refused', 'endpoint_rejected', 'authentication_failed', 'timeout', 'aborted', 'rate_limited', 'provider_error']);
const MANAGED_CODES = new Set<ManagedDecisionFailureCode>([...COMMON_CODES, 'missing_connection', 'scope_denied', 'entitlement_denied', 'budget_exhausted', 'model_changed', 'in_progress', 'outcome_unknown', 'request_conflict', 'provider_unavailable']);
export class ManagedDecisionClientError extends DecisionModelError {
  readonly managedCode: ManagedDecisionFailureCode;
  readonly canReissue: boolean;
  constructor(code: ManagedDecisionFailureCode, options: { retryable?: boolean; retryAfterMs?: number; httpStatus?: number } = {}) {
    super(COMMON_CODES.has(code as DecisionErrorCode) ? code as DecisionErrorCode : 'provider_error', options);
    this.managedCode = code;
    this.canReissue = ['budget_exhausted', 'rate_limited', 'authentication_failed'].includes(code);
    const messages: Partial<Record<ManagedDecisionFailureCode, string>> = {
      missing_connection: 'Connect this instance to Canvas managed services before using managed decision models.',
      scope_denied: 'Decision models are not enabled for this managed instance.',
      entitlement_denied: 'Managed models are not enabled for this organization.',
      budget_exhausted: 'This organization has insufficient usage credits.',
      model_changed: 'The selected managed model changed. Refresh its configuration.',
      in_progress: 'This managed evaluation is already running.',
      outcome_unknown: 'The previous evaluation outcome is uncertain and requires administrative review.',
      request_conflict: 'This operation ID belongs to a different evaluation.',
      provider_unavailable: 'The Control Plane decision service is temporarily unavailable.',
    };
    if (messages[code]) this.message = messages[code]!;
    if (code === 'authentication_failed' && options.httpStatus === 401) this.message = 'The managed instance connection is invalid.';
  }
}
export type ManagedDecisionCatalogResolution = { status: 'ready' | 'missing_connection' | 'unavailable' | 'invalid'; code: ManagedDecisionFailureCode | null; catalog: ManagedDecisionCatalog | null };
export type ManagedDecisionClientDependencies = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number; force?: boolean };
let cached: { key: string; loadedAt: number; resolution: ManagedDecisionCatalogResolution } | null = null;
let pending: { key: string; promise: Promise<ManagedDecisionCatalogResolution> } | null = null;

function connection(env = process.env) {
  if (!hasManagedSystemUpdateIntent(env) || !env.CANVAS_INSTANCE_TOKEN?.trim()) throw new ManagedDecisionClientError('missing_connection');
  try { return { origin: getManagedSystemUpdateOrigin(env), token: env.CANVAS_INSTANCE_TOKEN.trim() }; }
  catch { throw new ManagedDecisionClientError('missing_connection'); }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ManagedDecisionClientError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new ManagedDecisionClientError('invalid_response');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ManagedDecisionClientError) throw error;
    throw new ManagedDecisionClientError('invalid_response');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function responseError(value: unknown, status: number): ManagedDecisionClientError {
  const record = isDecisionRecord(value) ? value : {};
  const code = typeof record.code === 'string' && MANAGED_CODES.has(record.code as ManagedDecisionFailureCode) ? record.code as ManagedDecisionFailureCode : status === 401 ? 'authentication_failed' : status === 403 ? 'scope_denied' : status === 429 ? 'rate_limited' : 'provider_unavailable';
  return new ManagedDecisionClientError(code, { httpStatus: status, retryable: record.retryable === true || !record.code && status >= 500, ...(typeof record.retryAfterMs === 'number' && Number.isSafeInteger(record.retryAfterMs) && record.retryAfterMs >= 0 ? { retryAfterMs: Math.min(record.retryAfterMs, 86400000) } : {}) });
}

function parseCatalog(value: unknown): ManagedDecisionCatalog {
  if (!isDecisionRecord(value) || value.contractVersion !== 1 || typeof value.catalogRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.catalogRevision)
    || !(value.defaultModelRef === null || typeof value.defaultModelRef === 'string') || !Array.isArray(value.models) || value.models.length > 200) throw new ManagedDecisionClientError('invalid_response');
  const models: ManagedDecisionModel[] = value.models.map(entry => {
    if (!isDecisionRecord(entry) || typeof entry.ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(entry.ref)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120 || typeof entry.providerId !== 'string'
      || typeof entry.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u.test(entry.model)
      || typeof entry.inferenceRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.inferenceRevision)
      || typeof entry.timeoutMs !== 'number' || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1000 || entry.timeoutMs > 120000
      || !['ready', 'missing_credentials', 'configuration_unavailable', 'missing_pricing'].includes(String(entry.status)) || entry.available !== (entry.status === 'ready')) throw new ManagedDecisionClientError('invalid_response');
    const provider = decisionProviderRegistry.get(entry.providerId);
    if (!provider || entry.adapterVersion !== provider.adapterVersion || JSON.stringify(entry.capabilities) !== JSON.stringify(provider.capabilities)) throw new ManagedDecisionClientError('unsupported_capability');
    return { ref: entry.ref, name: entry.name, providerId: entry.providerId, model: entry.model, inferenceRevision: entry.inferenceRevision, adapterVersion: provider.adapterVersion, capabilities: provider.capabilities, status: entry.status as ManagedDecisionModel['status'], available: entry.available, timeoutMs: entry.timeoutMs };
  });
  if (new Set(models.map(model => model.ref)).size !== models.length || value.defaultModelRef !== null && !models.some(model => model.ref === value.defaultModelRef)) throw new ManagedDecisionClientError('invalid_response');
  return { contractVersion: 1, catalogRevision: value.catalogRevision, defaultModelRef: value.defaultModelRef as string | null, models };
}

export async function readManagedDecisionModels(dependencies: ManagedDecisionClientDependencies = {}): Promise<ManagedDecisionCatalogResolution> {
  let selected: ReturnType<typeof connection>;
  try { selected = connection(dependencies.env); } catch { return { status: 'missing_connection', code: 'missing_connection', catalog: null }; }
  const key = createHash('sha256').update(`${selected.origin}\0${selected.token}`).digest('hex');
  const now = dependencies.now ?? Date.now;
  if (!dependencies.force && cached?.key === key && now() - cached.loadedAt < 30000) return cached.resolution;
  if (pending?.key === key) return pending.promise;
  const operation = async (): Promise<ManagedDecisionCatalogResolution> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await (dependencies.fetch ?? fetch)(`${selected.origin}/v1/managed/decisions/models`, { headers: { authorization: `Bearer ${selected.token}` }, redirect: 'error', cache: 'no-store', signal: controller.signal });
      const value = await readJson(response);
      if (!response.ok) throw responseError(value, response.status);
      const resolution = { status: 'ready' as const, code: null, catalog: parseCatalog(value) };
      cached = { key, loadedAt: now(), resolution }; return resolution;
    } catch (error) {
      const code = controller.signal.aborted ? 'provider_unavailable' : error instanceof ManagedDecisionClientError ? error.managedCode : 'provider_unavailable';
      return { status: code === 'invalid_response' || code === 'unsupported_capability' ? 'invalid' : 'unavailable', code, catalog: cached?.key === key ? cached.resolution.catalog : null };
    } finally { clearTimeout(timer); }
  };
  const promise = operation(); pending = { key, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
}

export async function evaluateManagedDecisionModel(input: DecisionInput, model: ManagedDecisionModel, requestId: string, dependencies: ManagedDecisionClientDependencies = {}): Promise<DecisionResult> {
  const selected = connection(dependencies.env);
  const provider = decisionProviderRegistry.get(model.providerId);
  if (!provider || provider.adapterVersion !== model.adapterVersion) throw new ManagedDecisionClientError('unsupported_capability');
  const validated = { ...input, configuration: { providerId: model.providerId, model: model.model } };
  validateDecisionInput(validated, provider);
  if (input.signal?.aborted) throw new ManagedDecisionClientError('aborted');
  const controller = new AbortController();
  const onAbort = () => controller.abort(); input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.min(130000, model.timeoutMs + 10000));
  const request: ManagedDecisionRequest = { contractVersion: 1, requestId, modelRef: model.ref, inferenceRevision: model.inferenceRevision, schemaVersion: input.schemaVersion, state: input.state, questions: input.questions };
  try {
    const response = await (dependencies.fetch ?? fetch)(`${selected.origin}/v1/managed/decisions/evaluate`, { method: 'POST', headers: { authorization: `Bearer ${selected.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', cache: 'no-store', signal: controller.signal });
    const value = await readJson(response);
    if (!response.ok) throw responseError(value, response.status);
    if (!isDecisionRecord(value) || value.contractVersion !== 1 || value.requestId !== requestId || value.modelRef !== model.ref || value.inferenceRevision !== model.inferenceRevision || !isDecisionRecord(value.result)) throw new ManagedDecisionClientError('invalid_response');
    const result = value.result as unknown as DecisionResult;
    validateDecisionResult(result, validated, provider);
    if (result.providerId !== model.providerId || result.model !== model.model || result.adapterVersion !== model.adapterVersion || result.probabilitySemantics !== provider.capabilities.probabilitySemantics || !Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) throw new ManagedDecisionClientError('invalid_response');
    return { answers: result.answers, providerId: result.providerId, model: result.model, adapterVersion: result.adapterVersion, probabilitySemantics: result.probabilitySemantics, latencyMs: result.latencyMs, ...(result.usage ? { usage: result.usage } : {}), ...(provider.capabilities.calibrationReference ? { calibrationReference: provider.capabilities.calibrationReference } : {}) };
  } catch (error) {
    if (input.signal?.aborted) throw new ManagedDecisionClientError('aborted');
    if (controller.signal.aborted) throw new ManagedDecisionClientError('provider_unavailable', { retryable: true });
    if (error instanceof DecisionModelError) throw error;
    throw new ManagedDecisionClientError('provider_unavailable', { retryable: true });
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); }
}
