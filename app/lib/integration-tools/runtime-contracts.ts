import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type {
  IntegrationExecutionContext,
  IntegrationProviderDescriptor,
  IntegrationProviderError,
  IntegrationSource,
} from './contracts';

/** Private adapter data must never be serialized into model/UI descriptors. */
export type IntegrationResolvedProvider = {
  provider: IntegrationProviderDescriptor;
  bindingRevision: string;
  binding: unknown;
};

export type IntegrationAdapterTool = {
  name: string;
  description: string;
  effect?: 'read' | 'write' | 'unknown';
};

export type IntegrationAdapterToolPage = {
  tools: readonly IntegrationAdapterTool[];
  complete: boolean;
  providerErrors: readonly IntegrationProviderError[];
  nextCursor: string | null;
};

export type IntegrationAdapterToolSchema = IntegrationAdapterTool & {
  inputSchema: Record<string, unknown> | boolean;
  outputSchema?: Record<string, unknown> | boolean;
  toolVersion: string | null;
};

export type IntegrationToolAdapter = {
  source: IntegrationSource;
  resolveProvider(context: IntegrationExecutionContext, providerRef: string): Promise<IntegrationResolvedProvider>;
  listTools(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider, input: {
    query?: string;
    cursor?: string;
    limit: number;
    allowedToolNames?: readonly string[] | null;
    signal?: AbortSignal;
  }): Promise<IntegrationAdapterToolPage>;
  describeTool(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider, toolName: string, signal?: AbortSignal): Promise<IntegrationAdapterToolSchema>;
  /** Recheck binding and concrete schema/version before exactly one provider execution. */
  callTool(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider, tool: IntegrationAdapterToolSchema,
    args: Record<string, unknown>, input: {
      toolCallId: string;
      signal?: AbortSignal;
      /** Trusted runtime authority check after adapter metadata reads, immediately before business dispatch. */
      beforeDispatch?: () => Promise<void>;
    }): Promise<AgentToolResult<unknown>>;
};

export type IntegrationToolAdapters = Record<IntegrationSource, IntegrationToolAdapter>;
