import assert from 'node:assert/strict';

import {
  createAgentRuntimeModuleLoader,
  type ChannelRouterModule,
  type RuntimeServiceModule,
} from '../server/agent-runtime-loader';

async function main() {
  let runtimeLoads = 0;
  let routerLoads = 0;
  const runtimeModule = { name: 'runtime' } as unknown as RuntimeServiceModule;
  const routerModule = { name: 'router' } as unknown as ChannelRouterModule;
  const loader = createAgentRuntimeModuleLoader({
    runtimeService: async () => {
      runtimeLoads += 1;
      return runtimeModule;
    },
    channelRouter: async () => {
      routerLoads += 1;
      return routerModule;
    },
  });

  const [runtimeA, runtimeB, warmup] = await Promise.all([
    loader.getRuntimeService(),
    loader.getRuntimeService(),
    loader.preload(),
  ]);

  assert.equal(runtimeA, runtimeModule);
  assert.equal(runtimeB, runtimeModule);
  assert.equal(runtimeLoads, 1);
  assert.equal(routerLoads, 1);
  assert.ok(warmup.timing.totalMs >= 0);

  let attempts = 0;
  const retryingLoader = createAgentRuntimeModuleLoader({
    runtimeService: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first import failed');
      return runtimeModule;
    },
    channelRouter: async () => routerModule,
  });

  await assert.rejects(retryingLoader.getRuntimeService(), /first import failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await retryingLoader.getRuntimeService(), runtimeModule);
  assert.equal(attempts, 2);

  console.log('agent-runtime-loader-test: ok');
}

void main();
