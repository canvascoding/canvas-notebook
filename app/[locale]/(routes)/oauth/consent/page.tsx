import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

import { auth } from '@/app/lib/auth';
import { buildLocalePath } from '@/app/lib/locale-path';
import {
  type OAuthPageSearchParams,
  resolveDirectMcpConsentPresentation,
} from '@/app/lib/mcp/server/oauth-page-query';
import { isDirectMcpEnabled } from '@/app/lib/mcp/server/config';

import { OAuthConsentClient } from './oauth-consent-client';

export const dynamic = 'force-dynamic';

type OAuthConsentPageProps = {
  searchParams: Promise<OAuthPageSearchParams>;
};

export default async function OAuthConsentPage({
  searchParams,
}: OAuthConsentPageProps) {
  if (!isDirectMcpEnabled()) notFound();

  const params = await searchParams;
  const presentation = await resolveDirectMcpConsentPresentation(params);
  if (!presentation) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    const locale = await getLocale();
    redirect(
      `${buildLocalePath(locale, '/login')}?${presentation.oauthQuery}`,
    );
  }

  return (
    <OAuthConsentClient
      clientName={presentation.clientName}
      instanceHost={presentation.instanceHost}
      oauthQuery={presentation.oauthQuery}
      scopes={presentation.scopes}
    />
  );
}
