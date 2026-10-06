import { createHash } from 'node:crypto';
import {
  INTEGRATION_CONTRACT_VERSION,
  INTEGRATION_MAX_PAGE_SIZE,
  IntegrationContractError,
  parseIntegrationRequest,
  type IntegrationExecutionContext,
  type IntegrationNextAction,
  type IntegrationOperation,
  type IntegrationPolicy,
  type IntegrationProviderDescriptor,
  type IntegrationProviderPage,
  type IntegrationProviderRequest,
  type IntegrationSource,
  type IntegrationSourceSnapshot,
} from './contracts';
import { isIntegrationOperationAllowed, isIntegrationProviderVisible } from './policy';

const DEFAULT_PAGE_SIZE = 12;
const CURSOR_MAX_AGE_MS = 15 * 60 * 1000;

export type IntegrationSearchOptions = {
  preferredSource?: IntegrationSource;
  confirmedProviderRefs?: readonly string[];
};

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('base64url');
}

function cursorBinding(
  snapshots: readonly IntegrationSourceSnapshot[],
  request: IntegrationProviderRequest,
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  options: IntegrationSearchOptions,
): string {
  const { cursor: _cursor, ...filters } = request;
  return fingerprint({
    version: INTEGRATION_CONTRACT_VERSION,
    context,
    filters,
    policy,
    options,
    snapshots: snapshots.map((snapshot) => ({
      source: snapshot.source,
      revision: snapshot.revision,
      complete: snapshot.complete,
      // Timestamps alone do not invalidate a page; changed identity/state/metadata does.
      providers: snapshot.providers.map(({ checkedAt: _checkedAt, ...provider }) => provider)
        .sort((a, b) => a.providerRef < b.providerRef ? -1 : a.providerRef > b.providerRef ? 1 : 0),
      errors: snapshot.providerErrors,
    })).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
  });
}

function createCursor(offset: number, binding: string): string {
  const expiresAt = Date.now() + CURSOR_MAX_AGE_MS;
  return Buffer.from(JSON.stringify({
    v: INTEGRATION_CONTRACT_VERSION,
    offset,
    expiresAt,
    proof: fingerprint([binding, offset, expiresAt]),
  })).toString('base64url');
}

function readCursor(cursor: string | undefined, binding: string): number {
  if (!cursor) return 0;
  const invalid = () => new IntegrationContractError('invalid_cursor', 'This page has expired or its integration context changed. Start the search again.');
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor) || cursor.length > 2048) throw invalid();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded.v !== INTEGRATION_CONTRACT_VERSION || typeof decoded.offset !== 'number'
      || !Number.isSafeInteger(decoded.offset) || decoded.offset < 1
      || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)
      || decoded.expiresAt < Date.now() || decoded.expiresAt > Date.now() + CURSOR_MAX_AGE_MS
      || decoded.proof !== fingerprint([binding, decoded.offset, decoded.expiresAt])) throw invalid();
    return decoded.offset;
  } catch {
    throw invalid();
  }
}

function gatewayOperation(action: IntegrationNextAction): IntegrationOperation | null {
  if (action.kind !== 'gateway') return null;
  const request = action.request;
  return request.action === 'describe' || request.action === 'call'
    ? request.action
    : `${request.action}_${request.target}`;
}

function projectProvider(provider: IntegrationProviderDescriptor, policy: IntegrationPolicy): IntegrationProviderDescriptor {
  const canExecute = provider.canExecute
    && isIntegrationOperationAllowed(policy, provider.source, 'call')
    && policy.allowedToolNames?.length !== 0;
  return {
    ...provider,
    canExecute,
    nextActions: provider.nextActions.filter((next) => {
      const operation = gatewayOperation(next);
      return operation === null || (isIntegrationOperationAllowed(policy, provider.source, operation)
        && (operation !== 'call' || canExecute));
    }),
  };
}

function matchesFilters(provider: IntegrationProviderDescriptor, request: IntegrationProviderRequest): boolean {
  if (request.source && provider.source !== request.source) return false;
  if (request.state && provider.state !== request.state) return false;
  if (request.application && (!provider.application || normalized(provider.application) !== normalized(request.application))) return false;
  if (request.pluginRef && !provider.pluginRefs.includes(request.pluginRef)) return false;
  if (request.capabilityRef && !provider.capabilityRefs?.includes(request.capabilityRef)) return false;
  return true;
}

function scoreProvider(provider: IntegrationProviderDescriptor, query: string): { quality: number; reasons: string[] } {
  const term = normalized(query);
  if (provider.application && normalized(provider.application) === term) return { quality: 4, reasons: ['application_exact'] };
  if (provider.application && provider.aliases?.some((alias) => normalized(alias) === term)) {
    return { quality: 4, reasons: ['application_alias'] };
  }
  if (normalized(provider.displayName) === term) return { quality: 3, reasons: ['display_name_exact'] };
  const terms = term.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const name = normalized(provider.displayName);
  const metadata = normalized([provider.application || '', ...(provider.application ? provider.aliases || [] : []), name, provider.description || ''].join(' '));
  if (terms.length > 0 && terms.every((word) => metadata.includes(word))) {
    return { quality: terms.every((word) => name.includes(word)) ? 2 : 1, reasons: ['metadata_terms'] };
  }
  return { quality: 0, reasons: [] };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function providerPage(
  snapshots: readonly IntegrationSourceSnapshot[],
  request: IntegrationProviderRequest,
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  options: IntegrationSearchOptions,
): IntegrationProviderPage {
  const validated = parseIntegrationRequest(request);
  if (!('target' in validated) || validated.target !== 'providers') {
    throw new IntegrationContractError('invalid_request', 'This operation requires a provider list or search request.');
  }
  const operation = validated.action === 'list' ? 'list_providers' : 'search_providers';
  const activeSnapshots = snapshots.filter((snapshot) => (!validated.source || validated.source === snapshot.source)
    && isIntegrationOperationAllowed(policy, snapshot.source, operation));
  const visible = activeSnapshots.flatMap((snapshot) => snapshot.providers)
    .filter((provider) => isIntegrationProviderVisible(context, policy, provider))
    .map((provider) => projectProvider(provider, policy));
  const visibleRefs = new Set(visible.map((provider) => provider.providerRef));
  const unique = new Map<string, IntegrationProviderDescriptor>();
  // Deduplicate identity, never display names; two accounts for one app remain separate.
  for (const provider of visible) if (!unique.has(provider.providerRef)) unique.set(provider.providerRef, provider);
  const query = validated.action === 'search' ? validated.query : '';
  const ranked = Array.from(unique.values())
    .filter((provider) => matchesFilters(provider, validated))
    .map((provider) => ({ provider, match: query ? scoreProvider(provider, query) : { quality: 1, reasons: ['available'] } }))
    .filter(({ match }) => match.quality > 0)
    .sort((a, b) => {
      const preference = Number(b.provider.source === options.preferredSource) - Number(a.provider.source === options.preferredSource);
      const confirmed = Number(options.confirmedProviderRefs?.includes(b.provider.providerRef))
        - Number(options.confirmedProviderRefs?.includes(a.provider.providerRef));
      return preference || confirmed || Number(b.provider.canExecute) - Number(a.provider.canExecute)
        || b.match.quality - a.match.quality
        || Number(b.provider.source === 'mcp') - Number(a.provider.source === 'mcp')
        || compareText(normalized(a.provider.displayName), normalized(b.provider.displayName))
        || compareText(a.provider.providerRef, b.provider.providerRef);
    });
  const binding = cursorBinding(activeSnapshots, validated, context, policy, options);
  const offset = readCursor(validated.cursor, binding);
  if (offset > ranked.length) throw new IntegrationContractError('invalid_cursor', 'This page is no longer available. Start the search again.');
  const limit = Math.min(validated.limit || DEFAULT_PAGE_SIZE, INTEGRATION_MAX_PAGE_SIZE);
  const providers = ranked.slice(offset, offset + limit).map(({ provider, match }) => ({ ...provider, matchReasons: match.reasons }));
  const nextCursor = offset + limit < ranked.length ? createCursor(offset + limit, binding) : null;
  const providerErrors = activeSnapshots.flatMap((snapshot) => snapshot.providerErrors)
    .filter((error) => !error.providerRef || visibleRefs.has(error.providerRef));
  const sources = activeSnapshots.map(({ source, complete }) => ({ source, complete }));
  return {
    version: INTEGRATION_CONTRACT_VERSION,
    target: 'providers',
    providers,
    complete: sources.every((source) => source.complete) && providerErrors.length === 0,
    sources,
    providerErrors,
    nextCursor,
    nextActions: nextCursor ? [{
      kind: 'gateway', label: 'Show more integrations', request: { ...validated, cursor: nextCursor },
    }] : [],
  };
}

export function listIntegrationProviders(
  snapshots: readonly IntegrationSourceSnapshot[],
  request: Extract<IntegrationProviderRequest, { action: 'list' }>,
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  options: IntegrationSearchOptions = {},
): IntegrationProviderPage {
  return providerPage(snapshots, request, context, policy, options);
}

export function searchIntegrationProviders(
  snapshots: readonly IntegrationSourceSnapshot[],
  request: Extract<IntegrationProviderRequest, { action: 'search' }>,
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  options: IntegrationSearchOptions = {},
): IntegrationProviderPage {
  return providerPage(snapshots, request, context, policy, options);
}
