'use client';

import { Film, ImageIcon, Music2 } from 'lucide-react';

import { ProviderEnvEditor } from '@/app/components/settings/ProviderEnvEditor';
import type { ProviderHelpInfo } from '@/app/lib/pi/provider-help';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type StudioMediaCredentialsPanelProps = {
  locale?: string;
  managedControlPlaneAvailable?: boolean;
};

const STUDIO_MEDIA_ENV_VARS: NonNullable<ProviderHelpInfo['envVars']> = [
  {
    name: 'GEMINI_API_KEY',
    description: 'Google Gemini API key for Gemini images, Veo videos, and Lyria sound',
    scope: 'integrations',
    required: false,
  },
  {
    name: 'OPENAI_API_KEY',
    description: 'OpenAI API key for GPT Image generation',
    scope: 'integrations',
    required: false,
  },
  {
    name: 'KIE_API_KEY',
    description: 'KIE.ai API key for Seedance video generation',
    scope: 'integrations',
    required: false,
  },
];

const COPY = {
  de: {
    title: 'Studio-Medien-Zugangsdaten',
    description: 'Diese systemweiten Provider-Keys werden einmal vom Administrator konfiguriert und stehen danach allen Studio-Nutzern zur Verfügung.',
    managed: 'Die Canvas Control Plane ist verbunden. Nicht gesetzte Keys werden automatisch durch den Managed-Media-Fallback ersetzt; ein eigener zentraler Key hat Vorrang.',
    selfHosted: 'Auf einer Self-Hosted-Instanz wird für jeden verwendeten Studio-Provider ein zentraler Key benötigt. Persönliche Benutzer-Keys bleiben als optionaler Override möglich.',
    capabilities: 'Bilder · Videos · Sound',
  },
  en: {
    title: 'Studio media credentials',
    description: 'These system-wide provider keys are configured once by an administrator and are then available to every Studio user.',
    managed: 'Canvas Control Plane is connected. Missing keys automatically use the managed media fallback; a central custom key takes precedence.',
    selfHosted: 'Self-hosted instances need a central key for every Studio provider they use. Personal user keys remain available as an optional override.',
    capabilities: 'Images · Video · Sound',
  },
} as const;

export function StudioMediaCredentialsPanel({
  locale,
  managedControlPlaneAvailable = false,
}: StudioMediaCredentialsPanelProps) {
  const copy = locale?.toLowerCase().startsWith('de') ? COPY.de : COPY.en;

  return (
    <Card id="studio-media-credentials" className="scroll-mt-6">
      <CardHeader className="border-b bg-muted/20">
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="flex items-center gap-1 text-primary" aria-hidden="true">
            <ImageIcon className="h-4 w-4" />
            <Film className="h-4 w-4" />
            <Music2 className="h-4 w-4" />
          </span>
          {copy.title}
        </CardTitle>
        <CardDescription className="mt-1">{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{copy.capabilities}</p>
          <p className="mt-1 leading-5">
            {managedControlPlaneAvailable ? copy.managed : copy.selfHosted}
          </p>
        </div>
        <ProviderEnvEditor
          providerId="studio-media"
          envVars={STUDIO_MEDIA_ENV_VARS}
          credentialScope="system"
        />
      </CardContent>
    </Card>
  );
}
