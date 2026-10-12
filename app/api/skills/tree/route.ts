import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { loadCapabilityCandidatesForResourceActor, assertReadableCapabilityCandidate } from '@/app/lib/capabilities/resources/read';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { parseCapabilityManagementScope } from '@/app/lib/capabilities/request-scope';
import {
  buildCapabilitySkillTree,
  selectBrowsableSkillCandidates,
} from '@/app/lib/skills/capability-skill-browser';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const parsedDepth = Number.parseInt(searchParams.get('depth') || '4', 10);
    const depth = Number.isFinite(parsedDepth) ? Math.min(8, Math.max(1, parsedDepth)) : 4;
    const managementScope = parseCapabilityManagementScope(searchParams.get('scope'));
    const actor = { userId: session.user.id, workspaceId: searchParams.get('workspaceId') };
    const candidates = await loadCapabilityCandidatesForResourceActor(actor);
    const selected = selectBrowsableSkillCandidates(candidates, managementScope);
    const tree = await buildCapabilitySkillTree(selected, { maxDepth: depth });
    for (const candidate of selected) await assertReadableCapabilityCandidate(actor, candidate, candidates);
    return NextResponse.json({ success: true, data: tree });
  } catch (error) {
    if (error instanceof CapabilityResourceError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('[Skills Tree API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skill tree' },
      { status: 500 }
    );
  }
}
