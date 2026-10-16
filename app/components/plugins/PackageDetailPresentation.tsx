'use client';

import { useTranslations } from 'next-intl';
import type { CapabilityPackagePresentation } from '@/app/lib/capabilities/packages/presentation-contracts';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

/** Package declarations describe requirements. They never prove account access or provider readiness. */
export function PackageDetailPresentation({ presentation, identity }: { presentation: CapabilityPackagePresentation; identity: string }) {
  const t = useTranslations('skills.workspace.detail');
  return <div className="space-y-6" data-testid="package-detail-requirements">
    <InlineNotice size="compact">{t('declarationHint')}</InlineNotice>
    {presentation.capabilities.length ? <section className="space-y-3">
      <h3 className="text-base font-semibold">{t('workflowRequirements')}</h3>
      <div className="grid gap-3 md:grid-cols-2">{presentation.capabilities.map((capability, index) => <article
        key={`${capability.declaredBy.kind}:${capability.declaredBy.name}:${capability.id}:${index}`} className="min-w-0 rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <PluginExtensionAvatar name={capability.application} identity={JSON.stringify([identity, capability.declaredBy, 'capability', capability.id, index])} size="sm" />
            <h4 className="min-w-0 break-words font-medium">{capability.application}</h4>
          </div>
          <Badge variant="outline">{t(capability.required ? 'required' : 'optional')}</Badge>
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">{t('declaredBy', { name: capability.declaredBy.name })}</p>
        <p className="mt-3 text-xs text-muted-foreground">{t('alternativeHint')}</p>
        <ul className="mt-2 space-y-2">{capability.alternatives.map((alternative, position) => <li key={`${alternative.source}:${position}`}
          className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <PluginExtensionAvatar name={alternative.label} identity={JSON.stringify([identity, capability.declaredBy, capability.id, index, 'alternative', alternative.source, alternative.selector, position])} size="sm" />
          <Badge variant="secondary">{alternative.source === 'mcp' ? 'MCP' : 'Composio'}</Badge><span className="break-words">{alternative.label}</span>
        </li>)}</ul>
      </article>)}</div>
    </section> : null}
    {presentation.requirements.length ? <section className="space-y-3">
      <h3 className="text-base font-semibold">{t('connectionRequirements')}</h3>
      <div className="divide-y rounded-xl border">{presentation.requirements.map((requirement, index) => <div
        key={`${requirement.declaredBy.name}:${requirement.source}:${index}`} className="flex min-w-0 flex-wrap items-start justify-between gap-3 p-4">
        <PluginExtensionAvatar name={requirement.label} identity={JSON.stringify([identity, requirement.declaredBy, 'requirement', requirement.source, requirement.selector, index])} size="sm" />
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{requirement.label}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{requirement.source === 'mcp' ? 'MCP' : requirement.source === 'composio' ? 'Composio' : 'Canvas Email'}
            {' · '}{t('declaredBy', { name: requirement.declaredBy.name })}</p></div>
        <Badge variant="outline">{t(requirement.required ? 'required' : requirement.recommended ? 'recommended' : 'optional')}</Badge>
      </div>)}</div>
    </section> : null}
    {!presentation.capabilities.length && !presentation.requirements.length ? <p className="text-sm text-muted-foreground">{t('noRequirements')}</p> : null}
    {presentation.requiredEnv.length ? <section className="space-y-3">
      <h3 className="text-base font-semibold">{t('configurationKeys')}</h3>
      <p className="text-sm text-muted-foreground">{t('configurationKeysHint')}</p>
      <ul className="flex flex-wrap gap-2">{presentation.requiredEnv.map(key => <li key={key} className="max-w-full rounded-md border px-2.5 py-1 font-mono text-xs [overflow-wrap:anywhere]">{key}</li>)}</ul>
    </section> : null}
  </div>;
}
