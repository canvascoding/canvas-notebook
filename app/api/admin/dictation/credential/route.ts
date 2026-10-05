import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { readDictationCredentialStatuses, saveDictationCredential, type CloudDictationProvider } from '@/app/lib/dictation/credentials';
import { readDictationAvailability } from '@/app/lib/dictation/service';
import { readTranscriptionAvailability } from '@/app/lib/transcription/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function PUT(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: `dictation-credential:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null) as { provider?: unknown; apiKey?: unknown } | null;
  const provider = payload?.provider;
  const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
  if ((provider !== 'openai' && provider !== 'groq') || !apiKey || apiKey.length > 512 || /\s/u.test(apiKey)) {
    return NextResponse.json({ success: false, error: 'Choose a cloud provider and enter a valid API key.' }, { status: 400 });
  }

  try {
    await saveDictationCredential(provider as CloudDictationProvider, apiKey);
    await recordAuditEvent({
      organizationId: null,
      userId: admin.session.user.id,
      source: 'integrations',
      eventType: 'secret',
      entityType: 'env_scope',
      entityId: 'integrations',
      action: 'env.update',
      status: 'success',
      summary: `System dictation credential for ${provider} updated.`,
      metadata: { scope: 'integrations', secretScope: 'system', key: provider === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY' },
    });
    return NextResponse.json({
      success: true,
      data: {
        credentials: await readDictationCredentialStatuses(),
        status: await readDictationAvailability(),
        transcriptionStatus: await readTranscriptionAvailability(),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not save the dictation API key.',
    }, { status: 500 });
  }
}
