import { ensureCanvasAgent } from '@/app/lib/agents/registry';
import { DEFAULT_AGENT_ID } from './constants';

export async function ensureDefaultAgent(): Promise<void> {
  if (DEFAULT_AGENT_ID !== 'canvas-agent') {
    throw new Error('Default channel agent must be canvas-agent.');
  }
  await ensureCanvasAgent();
}
