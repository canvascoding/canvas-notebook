import assert from 'node:assert/strict';
import Module from 'node:module';
import { getComposioConnectionObservationRevision } from '../app/lib/composio/composio-connection-observation-revision';

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  const actualEsm = new Map<string, unknown>();
  try {
    // The actual gateway imports SDK ESM entry points through application .ts
    // files loaded by tsx as CJS. Only bridge the real namespaces, never tools.
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      actualEsm.set(name, await import(name));
    }
    loader._load = (name, parent, isMain) => actualEsm.has(name) ? actualEsm.get(name) : original(name, parent, isMain);
    const { clearComposioGatewayCaches } = await import('../app/lib/composio/composio-gateway');
    const before = getComposioConnectionObservationRevision();
    clearComposioGatewayCaches();
    assert.equal(getComposioConnectionObservationRevision(), before + 1);
    clearComposioGatewayCaches(null);
    assert.equal(getComposioConnectionObservationRevision(), before + 2);
    console.log('PASS actual central Composio cache invalidation advances Chat connection observations; no provider, account choice or business action.');
  } finally { loader._load = original; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
