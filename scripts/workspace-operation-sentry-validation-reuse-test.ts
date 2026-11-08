import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { workspaceOperationEvidenceReuseTest } from './workspace-operation-evidence-reuse-test';
import { workspaceOperationNativeDeleteHtmlPlanV4Test } from './workspace-operation-native-delete-html-plan-v4-test';

/** Use the installed server SDK's real integration, without starting a client,
 * transport or network call. A fresh integration module avoids reentering a
 * previously installed wrapper's module-local original-function slot. */
export async function workspaceOperationSentryValidationReuseTest(): Promise<void> {
  const require = createRequire(path.resolve('package.json'));
  const next = createRequire(require.resolve('@sentry/nextjs'));
  const node = createRequire(next.resolve('@sentry/node'));
  const core = node.resolve('@sentry/core');
  const integrationPath = path.join(path.dirname(core), 'integrations/functiontostring.js');
  const previousModule = require.cache[integrationPath], descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
  assert(descriptor && typeof descriptor.value === 'function');
  const parse = JSON.parse, stringify = JSON.stringify;
  delete require.cache[integrationPath];
  try {
    const integrationModule = require(integrationPath) as { functionToStringIntegration: () => { name: string; setupOnce?: () => void } };
    const integration = integrationModule.functionToStringIntegration();
    assert.equal(integration.name, 'FunctionToString'); assert.equal(typeof integration.setupOnce, 'function');
    integration.setupOnce!();
    assert.notEqual(Function.prototype.toString, descriptor.value);
    assert.equal(JSON.parse, parse); assert.equal(JSON.stringify, stringify);
    await workspaceOperationEvidenceReuseTest();
    await workspaceOperationNativeDeleteHtmlPlanV4Test();
  } finally {
    Object.defineProperty(Function.prototype, 'toString', descriptor);
    delete require.cache[integrationPath]; if (previousModule) require.cache[integrationPath] = previousModule;
  }
  assert.equal(JSON.parse, parse); assert.equal(JSON.stringify, stringify);
  console.log(JSON.stringify({ suite: 'sentry-historical-validation-reuse', actualInstalledServerIntegration: true,
    jsonFunctionsUnchanged: true, historicalValidationAndStoredPlanCasesPassed: true, globalAndModuleStateRestored: true,
    sentryClientOrTransportStarted: false, executionAuthority: false }));
}
