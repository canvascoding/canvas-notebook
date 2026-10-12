import {
  IntegrationContractError,
  parseIntegrationRequest,
  type IntegrationExecutionContext,
  type IntegrationPolicy,
  type IntegrationProviderPage,
  type IntegrationProviderRequest,
  type IntegrationSource,
  type IntegrationSourceSnapshot,
} from './contracts';
import { isIntegrationOperationAllowed } from './policy';
import { projectWorkflowProviderAssociations } from './workflow-provider-associations';
import { listIntegrationProviders, searchIntegrationProviders } from './search';
import { overlayPersonalWorkflowProviderCatalog } from './workflow-personal-bindings';

export type IntegrationCatalogAdapter = (context: IntegrationExecutionContext, policy?: IntegrationPolicy) => Promise<IntegrationSourceSnapshot>;
export type IntegrationCatalogAdapters = Record<IntegrationSource, IntegrationCatalogAdapter>;

const DEFAULT_ADAPTERS: IntegrationCatalogAdapters = {
  mcp: async (context, policy) => (await import('./adapters/mcp')).listMcpIntegrationProviders(context, policy),
  composio: async (context, policy) => (await import('./adapters/composio')).listComposioIntegrationProviders(context, policy),
};

function failedSnapshot(source: IntegrationSource, timeout: boolean): IntegrationSourceSnapshot {
  return {
    source,
    providers: [],
    complete: false,
    revision: `${source}:${timeout ? 'timeout' : 'unavailable'}`,
    providerErrors: [{
      source,
      code: timeout ? 'provider_timeout' : 'provider_unavailable',
      message: timeout ? 'The integration catalogue did not respond in time.' : 'The integration catalogue is temporarily unavailable.',
      retryable: true,
    }],
  };
}

async function readAdapter(
  source: IntegrationSource,
  adapter: IntegrationCatalogAdapter,
  context: IntegrationExecutionContext,
  timeoutMs: number,
  policy: IntegrationPolicy,
): Promise<IntegrationSourceSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<IntegrationSourceSnapshot>((resolve) => {
      timer = setTimeout(() => resolve(failedSnapshot(source, true)), timeoutMs);
    });
    const snapshot = await Promise.race([Promise.resolve().then(() => adapter(context, policy)), timeout]);
    // A source cannot contribute another source's entries or errors, even through a malformed adapter.
    if (snapshot.source !== source
      || snapshot.providers.some((provider) => provider.source !== source)
      || snapshot.providerErrors.some((error) => error.source !== source)) {
      return failedSnapshot(source, false);
    }
    return projectWorkflowProviderAssociations(context, overlayPersonalWorkflowProviderCatalog(context, snapshot));
  } catch {
    // Raw provider errors may contain URLs, tokens or identity data; keep the public issue safe.
    return failedSnapshot(source, false);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only metadata is discovered. Tool catalogues and server starts belong to an explicit tool request. */
export async function getIntegrationProviderCatalog(input: {
  context: IntegrationExecutionContext;
  policy: IntegrationPolicy;
  request: IntegrationProviderRequest;
  adapters?: IntegrationCatalogAdapters;
  timeoutMs?: number;
  preferredSource?: IntegrationSource;
  confirmedProviderRefs?: readonly string[];
}): Promise<IntegrationProviderPage> {
  const request = parseIntegrationRequest(input.request);
  if (!('target' in request) || request.target !== 'providers') {
    throw new IntegrationContractError('invalid_request', 'This catalogue accepts provider discovery requests.');
  }
  if (!input.context.actorUserId.trim() || !input.context.policyRevision.trim()) {
    throw new IntegrationContractError('provider_denied', 'A current authenticated integration context is required.');
  }
  const timeoutMs = input.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new IntegrationContractError('invalid_request', 'Catalogue timeout must be between 1 and 30000 milliseconds.');
  }
  const operation = request.action === 'list' ? 'list_providers' : 'search_providers';
  const sources = (['mcp', 'composio'] as const).filter((source) =>
    (!request.source || request.source === source) && isIntegrationOperationAllowed(input.policy, source, operation));
  const adapters = input.adapters ?? DEFAULT_ADAPTERS;
  const snapshots = await Promise.all(sources.map((source) => readAdapter(source, adapters[source], input.context, timeoutMs, input.policy)));
  const options = { preferredSource: input.preferredSource, confirmedProviderRefs: input.confirmedProviderRefs };
  return request.action === 'list'
    ? listIntegrationProviders(snapshots, request, input.context, input.policy, options)
    : searchIntegrationProviders(snapshots, request, input.context, input.policy, options);
}
