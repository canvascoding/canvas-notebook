import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AiProviderInstallation } from '../app/lib/agent-runtime-policy/types';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-provider-coverage-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
let piCompatModule: unknown;
moduleInternals._load = (request, parent, isMain) => {
  if (request === '@earendil-works/pi-ai/oauth') {
    return { getOAuthProvider: () => null };
  }
  if (request === '@earendil-works/pi-ai/compat' && piCompatModule) {
    return piCompatModule;
  }
  return originalLoad(request, parent, isMain);
};

const EXPECTED_BUILTIN_ENV: Record<string, readonly string[]> = {
  'amazon-bedrock': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  baseten: ['BASETEN_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL'],
  cerebras: ['CEREBRAS_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'],
  'kimi-coding': ['KIMI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': [],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
};

function installation(
  providerId: string,
  credentialScope: AiProviderInstallation['credentialScope'] = 'user',
): AiProviderInstallation {
  return {
    installationId: `coverage-${providerId}-${credentialScope}`,
    providerId,
    name: providerId,
    source: providerId === 'ollama' || providerId === 'openai-compatible' ? 'self-hosted' : 'built-in',
    credentialScope,
    enabled: true,
    status: 'ready',
    config: { authMethod: 'api-key' },
    sourceRevision: null,
    lastSyncedAt: null,
    revision: 1,
    verifiedAt: null,
    verifiedByUserId: null,
    models: [],
  };
}

async function main() {
  piCompatModule = await import(pathToFileURL(path.join(
    process.cwd(),
    'node_modules/@earendil-works/pi-ai/dist/compat.js',
  )).href);
  const {
    resolveProviderInstallationRuntimeAuth,
  } = await import('../app/lib/agent-runtime-policy/installation-credentials');
  const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
  const { getPiProviders } = await import('../app/lib/pi/model-resolver');
  const {
    getAuthMethodForProvider,
    getProviderEnvVars,
    getProviderHelp,
  } = await import('../app/lib/pi/provider-help');

  const discovered = getPiProviders();
  for (const providerId of discovered) {
    const help = getProviderHelp(providerId);
    assert.ok(help, `discovered provider ${providerId} must have ProviderHelp metadata`);
    assert.ok(help.setupSteps.length > 0, `${providerId} must expose a setup path`);

    const authMethod = getAuthMethodForProvider(providerId);
    const hasConfigurePath = Boolean(help.envVars?.length)
      || authMethod === 'oauth'
      || authMethod === 'self-hosted'
      || authMethod === 'cloud-infra';
    assert.equal(hasConfigurePath, true, `${providerId} must expose a credential/configuration path`);
  }

  const builtinProviders = discovered.filter((providerId) => (
    providerId !== 'ollama'
    && providerId !== 'openai-compatible'
    && providerId !== 'canvas-control-plane'
  ));
  assert.deepEqual(
    [...builtinProviders].sort(),
    Object.keys(EXPECTED_BUILTIN_ENV).sort(),
    'the coverage fixture must track every PI built-in provider',
  );
  for (const [providerId, expectedNames] of Object.entries(EXPECTED_BUILTIN_ENV)) {
    const actualNames = new Set((getProviderEnvVars(providerId) ?? []).map((entry) => entry.name));
    for (const expectedName of expectedNames) {
      assert.equal(actualNames.has(expectedName), true, `${providerId} must declare ${expectedName}`);
    }
  }

  const userId = 'provider-coverage-user';
  const organizationId = 'provider-coverage-organization';
  const scopedEntries = Array.from(new Set(
    builtinProviders.flatMap((providerId) => (
      getProviderEnvVars(providerId) ?? []
    ).map((entry) => entry.name)),
  )).map((key) => ({ key, value: `scoped-${key.toLowerCase()}` }));
  await replaceScopedEnvEntries('agents', scopedEntries, { secretScope: 'user', userId });

  for (const providerId of builtinProviders) {
    if (getAuthMethodForProvider(providerId) === 'oauth') continue;
    const auth = await resolveProviderInstallationRuntimeAuth({
      provider: installation(providerId),
      organizationId,
      userId,
    });
    assert.equal(auth.configured, true, `${providerId} must resolve from its declared scoped fields`);
  }

  const scopedAnthropic = await resolveProviderInstallationRuntimeAuth({
    provider: installation('anthropic'),
    organizationId,
    userId,
  });
  assert.equal(scopedAnthropic.apiKey, undefined);
  assert.equal(scopedAnthropic.headers?.Authorization, 'Bearer scoped-anthropic_auth_token');

  process.env.DEEPSEEK_API_KEY = 'ambient-deepseek-key';
  const scopedDeepSeek = await resolveProviderInstallationRuntimeAuth({
    provider: installation('deepseek'),
    organizationId,
    userId,
  });
  assert.equal(scopedDeepSeek.configured, true);
  assert.equal(scopedDeepSeek.apiKey, 'scoped-deepseek_api_key');
  assert.equal(scopedDeepSeek.env.DEEPSEEK_API_KEY, 'scoped-deepseek_api_key');

  const missingScopedDeepSeek = await resolveProviderInstallationRuntimeAuth({
    provider: installation('deepseek'),
    organizationId,
    userId: 'provider-without-scoped-secret',
  });
  assert.equal(missingScopedDeepSeek.configured, false);
  assert.equal(missingScopedDeepSeek.apiKey, undefined);
  assert.equal(missingScopedDeepSeek.env.DEEPSEEK_API_KEY, undefined);

  const systemDeepSeek = await resolveProviderInstallationRuntimeAuth({
    provider: installation('deepseek', 'system'),
    organizationId,
    userId,
  });
  assert.equal(systemDeepSeek.configured, true);
  assert.equal(systemDeepSeek.apiKey, 'ambient-deepseek-key');

  await replaceScopedEnvEntries('agents', [
    { key: 'CLOUDFLARE_API_KEY', value: 'organization-cloudflare-key' },
    { key: 'CLOUDFLARE_ACCOUNT_ID', value: 'organization-account' },
    { key: 'CLOUDFLARE_GATEWAY_ID', value: 'organization-gateway' },
  ], { secretScope: 'organization', organizationId });
  const cloudflare = await resolveProviderInstallationRuntimeAuth({
    provider: installation('cloudflare-ai-gateway', 'organization'),
    organizationId,
    userId,
  });
  assert.equal(cloudflare.configured, true);
  assert.equal(cloudflare.apiKey, 'organization-cloudflare-key');
  assert.deepEqual(cloudflare.env, {
    CLOUDFLARE_API_KEY: 'organization-cloudflare-key',
    CLOUDFLARE_ACCOUNT_ID: 'organization-account',
    CLOUDFLARE_GATEWAY_ID: 'organization-gateway',
  });

  console.log('agent runtime provider coverage tests passed');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    delete process.env.DEEPSEEK_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
