import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import type { SessionRuntimePhase } from '@/app/lib/chat/types';

export function normalizeSessionRuntimePhase(value: unknown): SessionRuntimePhase | null {
  return value === 'idle' || value === 'streaming' || value === 'running_tool' || value === 'aborting'
    ? value
    : null;
}

export function getHistoryRuntimePhase(status: RuntimeStatus): SessionRuntimePhase | null {
  return status.phase === 'idle' ? null : status.phase;
}

export function getHistoryRuntimeActiveToolName(status: RuntimeStatus): string | null {
  return status.phase === 'running_tool' ? status.activeTool?.name ?? null : null;
}
