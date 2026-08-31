'use client';

import { useTranslations } from 'next-intl';
import { Check, ShieldCheck } from 'lucide-react';

import { LanguageSwitcher } from '@/app/components/language-switcher';
import { PublicBrandLogo } from '@/app/components/branding/PublicBrandLogo';
import type { DirectMcpOAuthScope } from '@/app/lib/mcp/server/config';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const SCOPE_TRANSLATION_KEYS: Record<DirectMcpOAuthScope, string> = {
  openid: 'identity',
  offline_access: 'offlineAccess',
  'workspace:list': 'workspaceList',
  'knowledge:tree': 'knowledgeTree',
  'knowledge:search': 'knowledgeSearch',
  'knowledge:read': 'knowledgeRead',
  'knowledge:write': 'knowledgeWrite',
  'knowledge:assets': 'knowledgeAssets',
};

type OAuthConsentClientProps = {
  clientName: string;
  instanceHost: string;
  oauthQuery: string;
  scopes: DirectMcpOAuthScope[];
};

export function OAuthConsentClient({
  clientName,
  instanceHost,
  oauthQuery,
  scopes,
}: OAuthConsentClientProps) {
  const t = useTranslations('oauthConsent');

  return (
    <form
      action="/api/auth/oauth2/consent/redirect"
      method="post"
      className="relative flex min-h-screen items-center justify-center bg-background px-4 py-10"
    >
      <input type="hidden" name="oauth_query" value={oauthQuery} />
      <div className="absolute right-4 top-4">
        <LanguageSwitcher preserveSearch />
      </div>

      <Card className="w-full max-w-xl">
        <CardHeader className="gap-4">
          <div className="flex items-center gap-3">
            <PublicBrandLogo
              alt={t('logoAlt')}
              width={136}
              height={40}
              sizes="136px"
              fallbackSrc="/logo-login.webp"
              className="h-10 max-w-36 object-contain"
              fallbackClassName="w-10 border border-border object-cover"
              brandClassName="w-auto"
            />
            <div className="ml-auto flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl">{t('title', { clientName })}</CardTitle>
            <CardDescription className="leading-6">
              {t('description', { clientName, instanceHost })}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <section aria-labelledby="oauth-permissions-title">
            <h2 id="oauth-permissions-title" className="mb-3 text-sm font-semibold">
              {t('permissionsTitle')}
            </h2>
            <ul className="space-y-3">
              {scopes.map((scope) => (
                <li key={scope} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Check className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="leading-5">
                    {t(`scopes.${SCOPE_TRANSLATION_KEYS[scope]}`)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>{t('securityTitle')}</AlertTitle>
            <AlertDescription>
              <p>{t('securityDescription', { instanceHost })}</p>
            </AlertDescription>
          </Alert>
        </CardContent>

        <CardFooter className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            type="submit"
            name="accept"
            value="false"
            variant="outline"
            className="w-full sm:w-auto"
          >
            {t('deny')}
          </Button>
          <Button
            type="submit"
            name="accept"
            value="true"
            className="w-full sm:w-auto"
          >
            {t('accept')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
