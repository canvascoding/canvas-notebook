'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';

import { Cloud, KeyRound, ShieldAlert } from 'lucide-react';

import type { AiCredentialScope } from '@/app/lib/agent-runtime-policy/types';
import { getAuthMethodForProvider, getProviderHelp } from '@/app/lib/pi/provider-help';

import { PiOAuthButton } from './PiOAuthButton';
import { ProviderEnvEditor, type ProviderEnvEditorHandle } from './ProviderEnvEditor';

export type CredentialEditableProviderInstallation = {
  installationId: string;
  providerId: string;
  name: string;
  credentialScope: AiCredentialScope;
  authMethod?: 'api-key' | 'oauth';
};

type ProviderInstallationCredentialEditorProps = {
  installation: CredentialEditableProviderInstallation;
  locale?: string;
  showIdentity?: boolean;
  showCredentialActions?: boolean;
  onCredentialsSaved?: () => void;
};

export type ProviderInstallationCredentialEditorHandle = {
  save: () => Promise<boolean>;
};

const COPY = {
  de: {
    provider: 'Provider',
    installation: 'Installation',
    scope: 'Credential-Scope',
    scopeLabel: {
      managed: 'Managed · Control Plane',
      system: 'Systemweit',
      organization: 'Organisation',
      user: 'Pro Nutzer',
    },
    managed: 'Die Zugangsdaten werden sicher durch die verbundene Canvas Control Plane bereitgestellt.',
    oauthScope: 'OAuth-Verbindungen sind persönlich. Verwende für OAuth eine Installation mit dem Credential-Scope „Pro Nutzer“ oder stelle diese Installation auf API-Key-Authentifizierung um.',
    noFields: 'Für diesen Provider sind keine Zugangsdatenfelder in der App hinterlegt.',
    integrations: 'Integrations-Variablen öffnen',
    secretBoundary: 'Secrets werden ausschließlich im ausgewählten Credential-Scope gespeichert und nie in den Modellkatalog übernommen.',
    userOwnership: 'Im Scope „Pro Nutzer“ gelten die hier hinterlegten Werte nur für dein aktuelles Konto.',
  },
  en: {
    provider: 'Provider',
    installation: 'Installation',
    scope: 'Credential scope',
    scopeLabel: {
      managed: 'Managed · Control Plane',
      system: 'System wide',
      organization: 'Organization',
      user: 'Per user',
    },
    managed: 'Credentials are supplied securely by the connected Canvas Control Plane.',
    oauthScope: 'OAuth connections are personal. Use a per-user credential installation for OAuth, or configure this installation to use API-key authentication.',
    noFields: 'No in-app credential fields are registered for this provider.',
    integrations: 'Open integration variables',
    secretBoundary: 'Secrets are stored only in the selected credential scope and are never written to the model catalog.',
    userOwnership: 'In the per-user scope, values entered here apply only to your current account.',
  },
} as const;

export const ProviderInstallationCredentialEditor = forwardRef<
  ProviderInstallationCredentialEditorHandle,
  ProviderInstallationCredentialEditorProps
>(function ProviderInstallationCredentialEditor({
  installation,
  locale,
  showIdentity = true,
  showCredentialActions = true,
  onCredentialsSaved,
}, ref) {
  const copy = locale?.toLowerCase().startsWith('de') ? COPY.de : COPY.en;
  const envEditorRef = useRef<ProviderEnvEditorHandle>(null);
  const help = getProviderHelp(installation.providerId);
  const providerAuthMethod = getAuthMethodForProvider(installation.providerId);
  const wantsOAuth = installation.authMethod === 'oauth'
    || (!installation.authMethod && providerAuthMethod === 'oauth');
  const credentialEnvVars = help?.envVars?.filter((entry) => (
    installation.providerId !== 'openai-compatible' || entry.name !== 'OPENAI_COMPATIBLE_BASE_URL'
  ));

  useImperativeHandle(ref, () => ({
    save: async () => envEditorRef.current?.save() ?? true,
  }));

  return (
    <div className="space-y-4">
      {showIdentity && <dl className="grid min-w-0 gap-3 rounded-lg border bg-muted/10 p-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.provider}</dt>
          <dd className="mt-1 truncate font-medium" title={installation.name}>{installation.name}</dd>
          <dd className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{installation.providerId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.installation}</dt>
          <dd className="mt-1 break-all font-mono text-[11px]">{installation.installationId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.scope}</dt>
          <dd className="mt-1 font-medium">{copy.scopeLabel[installation.credentialScope]}</dd>
        </div>
      </dl>}

      {installation.credentialScope === 'managed' ? (
        <div className="flex items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm">
          <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p>{copy.managed}</p>
        </div>
      ) : wantsOAuth ? (
        installation.credentialScope === 'user' ? (
          <PiOAuthButton activeProviderId={installation.providerId} onStatusChange={onCredentialsSaved} />
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <p>{copy.oauthScope}</p>
          </div>
        )
      ) : credentialEnvVars?.length ? (
        <ProviderEnvEditor
          ref={envEditorRef}
          providerId={installation.providerId}
          envVars={credentialEnvVars}
          credentialScope={installation.credentialScope}
          onSaveComplete={onCredentialsSaved}
          showActions={showCredentialActions}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <p>{copy.noFields}</p>
          <a className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline" href="?tab=integrations">
            {copy.integrations}
          </a>
        </div>
      )}

      {installation.credentialScope !== 'managed' && (
        <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {copy.secretBoundary}
            {installation.credentialScope === 'user' ? ` ${copy.userOwnership}` : ''}
          </span>
        </p>
      )}
    </div>
  );
});
