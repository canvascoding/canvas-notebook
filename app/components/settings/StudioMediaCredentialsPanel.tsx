'use client';

import { startTransition, useEffect, useState } from 'react';
import { ImageIcon } from 'lucide-react';

import { ProviderEnvEditor } from '@/app/components/settings/ProviderEnvEditor';
import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { ProviderHelpInfo } from '@/app/lib/pi/provider-help';

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
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let frame: number | undefined;
    const openFromHash = () => {
      if (window.location.hash !== '#studio-media-credentials') return;
      startTransition(() => setIsOpen(true));
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const panel = document.getElementById('studio-media-credentials');
        panel?.scrollIntoView({ block: 'start' });
        panel?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      });
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => {
      window.removeEventListener('hashchange', openFromHash);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <SettingsAccordionCard
      id="studio-media-credentials"
      title={copy.title}
      description={copy.description}
      icon={ImageIcon}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      summaryItems={[copy.capabilities]}
      cardClassName="scroll-mt-6"
      contentClassName="space-y-4"
    >
      <InlineNotice variant="info" size="compact" title={copy.capabilities}>
        {managedControlPlaneAvailable ? copy.managed : copy.selfHosted}
      </InlineNotice>
      <ProviderEnvEditor
        providerId="studio-media"
        envVars={STUDIO_MEDIA_ENV_VARS}
        credentialScope="system"
      />
    </SettingsAccordionCard>
  );
}
