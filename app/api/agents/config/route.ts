import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
  DEFAULT_MANAGED_AGENT_ID,
  readPiRuntimeConfig,
  writePiRuntimeConfig,
} from '@/app/lib/agents/storage';
import { resolveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';
import { normalizeManagedAgentId, updateAgentProfile } from '@/app/lib/agents/registry';
import {
  CANVAS_CONTROL_PLANE_PROVIDER_ID,
  findModelWithCompatibilityFallback,
  getCanvasControlPlaneModels,
  getPiModels,
  getPiProviders,
  modelSupportsImageInput,
  OLLAMA_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  resolvePiModel,
} from '@/app/lib/pi/model-resolver';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';
import type { PiRuntimeConfig, PiThinkingLevel } from '@/app/lib/pi/config';
import type { EffectiveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';

type PatchConfigPayload = {
  agentId?: unknown;
  provider?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  makeActiveProvider?: unknown;
};

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeThinkingLevel(value: unknown): PiThinkingLevel | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

function getProviderCustomModel(piConfig: PiRuntimeConfig, provider: string): string | undefined {
  const providerConfig = piConfig.providers[provider];
  if (provider === OLLAMA_PROVIDER_ID && providerConfig?.ollamaModelSource === 'custom') {
    return providerConfig.ollamaCustomModel?.trim() || undefined;
  }
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID && providerConfig?.openaiCompatibleModelSource === 'custom') {
    return providerConfig.openaiCompatibleCustomModel?.trim() || undefined;
  }
  return undefined;
}

async function isValidProviderModel(piConfig: PiRuntimeConfig, provider: string, model: string): Promise<boolean> {
  const customModel = getProviderCustomModel(piConfig, provider);
  const models = provider === CANVAS_CONTROL_PLANE_PROVIDER_ID
    ? await getCanvasControlPlaneModels()
    : getPiModels(provider, customModel);
  return Boolean(findModelWithCompatibilityFallback(models, model));
}

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

async function buildAgentConfigResponseData(
  effective: EffectiveAgentRuntimeSettings,
  options: {
    piConfig?: PiRuntimeConfig;
    model?: string | null;
    modelResolutionError?: string | null;
    includeReadiness?: boolean;
  } = {},
) {
  const includeReadiness = options.includeReadiness !== false;
  const readiness = includeReadiness ? await buildAgentConfigReadiness() : null;
  const engine = getActiveAiAgentEngine();
  const model = options.model !== undefined
    ? options.model
    : effective.providerConfig.model?.trim() || null;

  return {
    piConfig: options.piConfig ?? effective.piConfig,
    effectiveConfig: {
      agentId: effective.agentId,
      isMainAgent: effective.isMainAgent,
      activeProvider: effective.activeProvider,
      model,
      thinkingLevel: effective.thinkingLevel,
      enabledTools: effective.enabledTools,
      modelResolutionError: options.modelResolutionError ?? null,
      setupState: effective.setupState,
    },
    inheritedFromMain: !effective.isMainAgent,
    overrideState: effective.overrideState,
    engine,
    ...(readiness ? { readiness } : {}),
    setupState: effective.setupState,
    managed: {
      canvasControlPlaneAvailable: effective.setupState.managedControlPlaneAvailable,
    },
  };
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-config-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agentId = request.nextUrl.searchParams.get('agentId');
    const includeReadiness = request.nextUrl.searchParams.get('readiness') !== 'false';
    const effective = await resolveAgentRuntimeSettings(agentId);
    let resolvedModel: string | null = effective.providerConfig.model?.trim() || null;
    let modelResolutionError: string | null = null;
    if (resolvedModel) {
      try {
        resolvedModel = (await resolvePiModel(effective.activeProvider, resolvedModel)).id;
      } catch (error) {
        modelResolutionError = error instanceof Error ? error.message : 'Failed to resolve configured model.';
        console.warn(`[agents/config] GET: ${modelResolutionError}`);
      }
    }
    const piConfig = effective.piConfig;

    // Discovery metadata mirrors each model's declared input capabilities.
    const providers = getPiProviders();
    console.log(`[agents/config] GET: activeProvider=${piConfig.activeProvider}, providers=${JSON.stringify(Object.keys(piConfig.providers))}`);
    const discoveryEntries = await Promise.all(
      providers.map(async (p) => {
        const customModel = p === 'ollama'
          ? effective.mainPiConfig.providers.ollama?.ollamaCustomModel
          : p === 'openai-compatible'
            ? effective.mainPiConfig.providers['openai-compatible']?.openaiCompatibleCustomModel
            : undefined;
        const models = p === CANVAS_CONTROL_PLANE_PROVIDER_ID
          ? await getCanvasControlPlaneModels()
          : getPiModels(p, customModel);
        return [p, { 
          models: models.map(m => ({
            id: m.id,
            name: m.name,
            reasoning: Boolean(m.reasoning),
            supportsVision: modelSupportsImageInput(m),
          })),
        }] as const;
      })
    );
    const discovery = Object.fromEntries(discoveryEntries);
    const data = await buildAgentConfigResponseData(effective, {
      model: resolvedModel,
      modelResolutionError,
      includeReadiness,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...data,
        discovery,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function PATCH(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-config-patch',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as PatchConfigPayload;
    const agentId = normalizeManagedAgentId(normalizeOptionalString(payload.agentId));
    const provider = normalizeOptionalString(payload.provider);
    const model = normalizeOptionalString(payload.model);
    const thinkingLevel = normalizeThinkingLevel(payload.thinkingLevel);

    if (!provider) {
      return NextResponse.json({ success: false, error: 'Provider is required.' }, { status: 400 });
    }
    if (payload.thinkingLevel !== undefined && !thinkingLevel) {
      return NextResponse.json({ success: false, error: 'Invalid thinking level.' }, { status: 400 });
    }
    if (!model && !thinkingLevel && payload.makeActiveProvider !== true) {
      return NextResponse.json({ success: false, error: 'No configuration changes provided.' }, { status: 400 });
    }

    const currentConfig = await readPiRuntimeConfig();
    const providerConfig = currentConfig.providers[provider];
    if (!providerConfig) {
      return NextResponse.json({ success: false, error: 'Provider is not configured.' }, { status: 400 });
    }
    if (model && !(await isValidProviderModel(currentConfig, provider, model))) {
      return NextResponse.json({ success: false, error: 'Invalid model for provider.' }, { status: 400 });
    }

    if (agentId !== DEFAULT_MANAGED_AGENT_ID) {
      await updateAgentProfile({
        agentId,
        defaultProvider: provider,
        defaultModel: model || providerConfig.model,
        defaultThinking: thinkingLevel || providerConfig.thinking || 'off',
      });
      const effective = await resolveAgentRuntimeSettings(agentId);

      return NextResponse.json({
        success: true,
        data: await buildAgentConfigResponseData(effective),
      });
    }

    const piConfig = await writePiRuntimeConfig({
      ...currentConfig,
      activeProvider: payload.makeActiveProvider === true ? provider : currentConfig.activeProvider,
      providers: {
        ...currentConfig.providers,
        [provider]: {
          ...providerConfig,
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
        },
      },
    });
    const effective = await resolveAgentRuntimeSettings(agentId);

    return NextResponse.json({
      success: true,
      data: await buildAgentConfigResponseData(effective, { piConfig }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-config-put',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const agentId = normalizeManagedAgentId(normalizeOptionalString(payload.agentId));
    const piConfigInput = payload.piConfig || payload;
    console.log(`[agents/config] PUT: activeProvider=${piConfigInput.activeProvider}, providers=${JSON.stringify(Object.keys(piConfigInput.providers || {}))}, authMethods=${JSON.stringify(
      Object.fromEntries(
        Object.entries(piConfigInput.providers || {}).map(([k, v]) => [k, (v as Record<string, unknown>)?.authMethod ?? 'not set'])
      )
    )}`);

    if (agentId !== DEFAULT_MANAGED_AGENT_ID) {
      const provider = normalizeOptionalString(piConfigInput.activeProvider);
      const providerConfig = provider && piConfigInput.providers ? piConfigInput.providers[provider] : null;
      const model = providerConfig ? normalizeOptionalString(providerConfig.model) : null;
      const thinking = providerConfig ? normalizeThinkingLevel(providerConfig.thinking) : null;
      if (!provider || !model) {
        return NextResponse.json({ success: false, error: 'Provider and model are required for agent overrides.' }, { status: 400 });
      }

      const currentConfig = await readPiRuntimeConfig();
      if (!(await isValidProviderModel(currentConfig, provider, model))) {
        return NextResponse.json({ success: false, error: 'Invalid model for provider.' }, { status: 400 });
      }

      await updateAgentProfile({
        agentId,
        defaultProvider: provider,
        defaultModel: model,
        defaultThinking: thinking,
      });

      const effective = await resolveAgentRuntimeSettings(agentId);

      return NextResponse.json({
        success: true,
        data: await buildAgentConfigResponseData(effective),
      });
    }

    const piConfig = await writePiRuntimeConfig(piConfigInput);
    const effective = await resolveAgentRuntimeSettings(agentId);

    return NextResponse.json({
      success: true,
      data: await buildAgentConfigResponseData(effective, { piConfig }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
