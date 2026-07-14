import type { OperationTimingSnapshot } from '@/app/lib/observability/operation-timing';
import { createOperationTiming } from '@/app/lib/observability/operation-timing';

export type RuntimeServiceModule = typeof import('@/app/lib/pi/runtime-service');
export type ChannelRouterModule = typeof import('@/app/lib/channels/router');

type AgentRuntimeModuleImporters = {
  runtimeService: () => Promise<RuntimeServiceModule>;
  channelRouter: () => Promise<ChannelRouterModule>;
};

export type AgentRuntimeWarmupResult = {
  timing: OperationTimingSnapshot;
};

export function createAgentRuntimeModuleLoader(importers: AgentRuntimeModuleImporters) {
  let runtimeServicePromise: Promise<RuntimeServiceModule> | null = null;
  let channelRouterPromise: Promise<ChannelRouterModule> | null = null;

  function loadRuntimeService(): Promise<RuntimeServiceModule> {
    if (!runtimeServicePromise) {
      const current = importers.runtimeService();
      runtimeServicePromise = current;
      void current.catch(() => {
        if (runtimeServicePromise === current) runtimeServicePromise = null;
      });
    }
    return runtimeServicePromise;
  }

  function loadChannelRouter(): Promise<ChannelRouterModule> {
    if (!channelRouterPromise) {
      const current = importers.channelRouter();
      channelRouterPromise = current;
      void current.catch(() => {
        if (channelRouterPromise === current) channelRouterPromise = null;
      });
    }
    return channelRouterPromise;
  }

  async function preload(): Promise<AgentRuntimeWarmupResult> {
    const timing = createOperationTiming();
    await Promise.all([loadRuntimeService(), loadChannelRouter()]);
    timing.mark('moduleImports');
    return { timing: timing.snapshot() };
  }

  return {
    getRuntimeService: loadRuntimeService,
    getChannelRouter: loadChannelRouter,
    preload,
  };
}

const defaultLoader = createAgentRuntimeModuleLoader({
  runtimeService: () => import('@/app/lib/pi/runtime-service'),
  channelRouter: () => import('@/app/lib/channels/router'),
});

export const getRuntimeService = defaultLoader.getRuntimeService;
export const getChannelRouter = defaultLoader.getChannelRouter;
export const preloadAgentRuntimeModules = defaultLoader.preload;
