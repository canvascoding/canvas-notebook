import { notFound } from 'next/navigation';

import { BrowserLabClient } from '@/app/components/browser-lab/BrowserLabClient';
import { SuitePageLayout } from '@/app/components/SuitePageLayout';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requirePageSession } from '@/app/lib/auth-guards';
import { assertUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';

export const metadata = {
  title: 'Live Browser · Canvas Notebook',
  robots: { index: false, follow: false },
};

type LiveBrowserPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    agentId?: string | string[];
    sessionId?: string | string[];
  }>;
};

function firstQueryValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() || '';
}

export default async function LiveBrowserPage({ params, searchParams }: LiveBrowserPageProps) {
  const [session, { locale }, query] = await Promise.all([
    requirePageSession(),
    params,
    searchParams,
  ]);
  if (!session) notFound();
  const rawAgentId = firstQueryValue(query.agentId);
  const sessionId = firstQueryValue(query.sessionId);
  if (!rawAgentId || !sessionId) notFound();

  let liveContext: {
    agentId: string;
    sessionId: string;
  };
  try {
    const agentId = normalizeManagedAgentId(rawAgentId);
    const agentSession = await assertUnambiguousOwnedPiSessionForRuntime({
      sessionId,
      userId: session.user.id,
      agentId,
    });
    await resolveAgentExecutionContextForSession({
      sessionId: agentSession.sessionId,
      userId: session.user.id,
      agentId: agentSession.agentId,
    });
    liveContext = {
      agentId: agentSession.agentId,
      sessionId: agentSession.sessionId,
    };
  } catch {
    notFound();
  }

  return (
    <SuitePageLayout
      title={locale === 'en' ? 'Live Browser' : 'Live-Browser'}
      mainClassName="overflow-hidden"
    >
      <BrowserLabClient
        locale={locale}
        variant="live"
        agentId={liveContext.agentId}
        sessionId={liveContext.sessionId}
      />
    </SuitePageLayout>
  );
}
