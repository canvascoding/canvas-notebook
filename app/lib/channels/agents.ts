import { ensureCanvasAgent } from '@/app/lib/agents/registry';

export async function ensureDefaultAgent(): Promise<void> {
  await ensureCanvasAgent();
}
