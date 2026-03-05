import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
  readAgentRuntimeConfig,
  resolveOpenRouterApiKey,
} from '@/app/lib/agents/storage';

type DoctorPayload = {
  livePing?: boolean;
};

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

async function runOptionalLivePing(params: {
  enabled: boolean;
  timeoutMs: number;
  baseUrl: string;
  apiKey: string | null;
}) {
  const { enabled, timeoutMs, baseUrl, apiKey } = params;

  if (!enabled) {
    return {
      enabled: false,
      ok: null as boolean | null,
      warning: null as string | null,
      latencyMs: null as number | null,
      status: null as number | null,
      target: null as string | null,
    };
  }

  if (!apiKey) {
    return {
      enabled: true,
      ok: false,
      warning: 'OpenRouter API key missing. Ping skipped.',
      latencyMs: null,
      status: null,
      target: `${baseUrl.replace(/\/+$/, '')}/models`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = `${baseUrl.replace(/\/+$/, '')}/models`;
  const startedAt = Date.now();

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        enabled: true,
        ok: false,
        warning: `OpenRouter ping returned HTTP ${response.status}.`,
        latencyMs,
        status: response.status,
        target,
      };
    }

    return {
      enabled: true,
      ok: true,
      warning: null,
      latencyMs,
      status: response.status,
      target,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const warning =
      error instanceof Error && error.name === 'AbortError'
        ? `OpenRouter ping timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : 'OpenRouter ping failed.';

    return {
      enabled: true,
      ok: false,
      warning,
      latencyMs,
      status: null,
      target,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  const { response } = await requireSession(request);
  if (response) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-doctor-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as DoctorPayload;
    const config = await readAgentRuntimeConfig();
    const readiness = await buildAgentConfigReadiness(config);
    const openRouterKey = await resolveOpenRouterApiKey(config);

    const livePingEnabled =
      typeof payload.livePing === 'boolean' ? payload.livePing : config.doctor.enableLivePing;
    const livePing = await runOptionalLivePing({
      enabled: livePingEnabled,
      timeoutMs: config.doctor.timeoutMs,
      baseUrl: config.providers.openrouter.baseUrl,
      apiKey: openRouterKey.apiKey,
    });

    const errors = Object.values(readiness.providers).filter((provider) => provider.enabled && !provider.available)
      .length;
    const warnings = livePing.warning ? 1 : 0;

    return NextResponse.json({
      success: true,
      data: {
        checkedAt: new Date().toISOString(),
        timeoutMs: config.doctor.timeoutMs,
        checks: {
          cli: {
            'codex-cli': {
              command: readiness.providers['codex-cli'].command,
              available: readiness.providers['codex-cli'].commandExists,
            },
            'claude-cli': {
              command: readiness.providers['claude-cli'].command,
              available: readiness.providers['claude-cli'].commandExists,
            },
            'gemini-cli': {
              command: readiness.providers['gemini-cli'].command,
              available: readiness.providers['gemini-cli'].commandExists,
            },
          },
          openrouter: {
            key: {
              isSet: openRouterKey.isSet,
              source: openRouterKey.source,
              last4: openRouterKey.last4,
            },
            model: {
              value: config.providers.openrouter.model,
              plausible: readiness.providers.openrouter.modelPlausible,
            },
          },
          livePing,
        },
        readiness,
        summary: {
          ready: readiness.activeProviderReady,
          errors,
          warnings,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run doctor checks.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
