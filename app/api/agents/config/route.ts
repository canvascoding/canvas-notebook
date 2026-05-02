import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
  readPiRuntimeConfig,
  writePiRuntimeConfig,
} from '@/app/lib/agents/storage';
import { getPiModels, getPiProviders } from '@/app/lib/pi/model-resolver';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';

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
    const piConfig = await readPiRuntimeConfig();
    const readiness = await buildAgentConfigReadiness();
    const engine = getActiveAiAgentEngine();

    // Discovery metadata - all models now support files/images
    const providers = getPiProviders();
    console.log(`[agents/config] GET: activeProvider=${piConfig.activeProvider}, providers=${JSON.stringify(Object.keys(piConfig.providers))}`);
    const discovery = Object.fromEntries(
      providers.map(p => {
        // For Ollama, pass the custom model if configured
        const customModel = p === 'ollama' ? piConfig.providers.ollama?.ollamaCustomModel : undefined;
        return [p, { 
          models: getPiModels(p, customModel).map(m => ({
            id: m.id,
            name: m.name,
          })),
        }];
      })
    );

    return NextResponse.json({
      success: true,
      data: {
        piConfig,
        engine,
        readiness,
        discovery,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read runtime config.';
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
    const piConfigInput = payload.piConfig || payload;
    console.log(`[agents/config] PUT: activeProvider=${piConfigInput.activeProvider}, providers=${JSON.stringify(Object.keys(piConfigInput.providers || {}))}, authMethods=${JSON.stringify(
      Object.fromEntries(
        Object.entries(piConfigInput.providers || {}).map(([k, v]) => [k, (v as Record<string, unknown>)?.authMethod ?? 'not set'])
      )
    )}`);

    const piConfig = await writePiRuntimeConfig(piConfigInput);
    const readiness = await buildAgentConfigReadiness();
    const engine = getActiveAiAgentEngine();

    return NextResponse.json({
      success: true,
      data: {
        piConfig,
        engine,
        readiness,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
