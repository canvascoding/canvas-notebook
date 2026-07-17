import type { ChatMessage } from '@/app/lib/chat/types';

export type ChatRuntimeIdentity = {
  provider: string;
  model: string;
};

export type ChatRuntimeChange = {
  from: ChatRuntimeIdentity;
  to: ChatRuntimeIdentity;
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'canvas-control-plane': 'Canvas Control Plane',
  google: 'Google',
  groq: 'Groq',
  ollama: 'Ollama',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'openai-compatible': 'OpenAI-compatible',
  openrouter: 'OpenRouter',
};

function runtimeForMessage(message: ChatMessage): ChatRuntimeIdentity | null {
  if (message.role !== 'assistant' || message.piMessage?.role !== 'assistant') {
    return null;
  }

  const provider = message.piMessage.provider.trim();
  const model = message.piMessage.model.trim();
  return provider && model ? { provider, model } : null;
}

function sameRuntime(left: ChatRuntimeIdentity, right: ChatRuntimeIdentity): boolean {
  return left.provider === right.provider && left.model === right.model;
}

export function formatChatRuntimeIdentity(runtime: ChatRuntimeIdentity): string {
  const provider = PROVIDER_LABELS[runtime.provider.toLowerCase()] ?? runtime.provider;
  return `${provider} / ${runtime.model}`;
}

/**
 * Places a runtime change before the first user message handled by the new
 * model. The assistant metadata is the source of truth, so a merely selected
 * model is not shown until it actually starts a response (including errors).
 */
export function indexChatRuntimeChanges(messages: ChatMessage[]): Map<string, ChatRuntimeChange> {
  const changes = new Map<string, ChatRuntimeChange>();
  let previousRuntime: ChatRuntimeIdentity | null = null;
  let pendingUserMessageId: string | null = null;

  for (const message of messages) {
    if (message.role === 'user' && pendingUserMessageId === null) {
      pendingUserMessageId = message.id;
    }

    const runtime = runtimeForMessage(message);
    if (!runtime) continue;

    if (previousRuntime && !sameRuntime(previousRuntime, runtime)) {
      changes.set(pendingUserMessageId ?? message.id, {
        from: previousRuntime,
        to: runtime,
      });
    }

    previousRuntime = runtime;
    pendingUserMessageId = null;
  }

  return changes;
}
