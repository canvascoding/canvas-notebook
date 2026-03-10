import { NextRequest } from 'next/server';
import { POST as piPost } from '../stream/route';
import { getActiveAiAgentEngine } from '@/app/lib/agents/runtime';

/**
 * Legacy chat route, now acting as a proxy to the PI runtime if enabled.
 */
export async function POST(request: NextRequest) {
  const engine = getActiveAiAgentEngine();

  if (engine === 'pi') {
    // Forward to the new PI stream implementation
    return piPost(request);
  }

  // If someone explicitly wants legacy while we still have the code (unlikely in main soon)
  // we would keep the old code here. But the goal of pi-028 is to CUT OVER.
  
  // For the cutover phase, we prioritize PI.
  return piPost(request);
}
