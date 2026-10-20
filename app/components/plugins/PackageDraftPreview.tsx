'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plug, Puzzle, Sparkles } from 'lucide-react';
import { InlineNotice } from '@/components/ui/inline-notice';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import type { CapabilityPackageDraftPresentation } from '@/app/lib/capabilities/packages/draft-presentation-contracts';
import type { CapabilityPackageFileRead } from '@/app/lib/capabilities/packages/contracts';
import { draftPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

function DraftSkillPreview({ draftRef, revision, workspaceId, path }: { draftRef: string; revision: number; workspaceId?: string | null; path: string }) {
  const t = useTranslations('skills.packageEditor');
  const [open, setOpen] = useState(false), [content, setContent] = useState<string | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ path, maxBytes: '65536' });
    if (workspaceId) query.set('workspaceId', workspaceId);
    void fetch(`/api/capabilities/packages/drafts/${encodeURIComponent(draftRef)}/file?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { success: boolean; data?: {draft: {draftRevision: number}; file: CapabilityPackageFileRead} };
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.success || !payload.data || payload.data.draft.draftRevision !== revision || !payload.data.file.eof) throw new Error('Preview unavailable');
        const bytes = Uint8Array.from(atob(payload.data.file.content), character => character.charCodeAt(0));
        const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
        setContent(markdown); setError(false);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [draftRef, open, path, revision, workspaceId]);
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="mt-3 rounded-md border bg-background/60 p-3">
    <summary className="cursor-pointer text-xs font-medium">{t('skillPreview')}</summary>
    {open ? error ? <p role="status" className="mt-3 text-xs text-muted-foreground">{t('skillPreviewUnavailable')}</p>
      : content === null ? <p role="status" className="mt-3 text-xs text-muted-foreground">{t('loading')}</p>
        : <MarkdownRenderer content={content} className="mt-3 text-sm" /> : null}
  </details>;
}

/** Preview metadata never claims a valid publication, account selection or provider readiness. */
export function PackageDraftPreview({ draftRef, revision, workspaceId }: { draftRef: string; revision: number; workspaceId?: string | null }) {
  const t = useTranslations('skills.packageEditor');
  const [state, setState] = useState<{ key: string; data?: CapabilityPackageDraftPresentation; error?: boolean } | null>(null);
  const key = `${workspaceId ?? ''}:${draftRef}:${revision}`, current = useRef(key);
  useLayoutEffect(() => { current.current = key; }, [key]);
  useEffect(() => {
    const controller = new AbortController(), query = new URLSearchParams({ expectedDraftRevision: String(revision) });
    if (workspaceId) query.set('workspaceId', workspaceId);
    void fetch(`/api/capabilities/packages/drafts/${encodeURIComponent(draftRef)}/presentation?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { success: boolean; data?: CapabilityPackageDraftPresentation };
        if (controller.signal.aborted || current.current !== key) return;
        if (!response.ok || !payload.success || !payload.data || payload.data.draftRef !== draftRef || payload.data.draftRevision !== revision) throw new Error('Preview unavailable');
        setState({ key, data: payload.data });
      }).catch(() => { if (!controller.signal.aborted && current.current === key) setState({ key, error: true }); });
    return () => controller.abort();
  }, [draftRef, key, revision, workspaceId]);
  const active = state?.key === key ? state : null;
  if (active?.error) return <InlineNotice variant="warning" size="compact">{t('previewUnavailable')}</InlineNotice>;
  if (!active?.data) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t('previewLoading')}</p>;
  const data = active.data;
  const requirements = [...(data.presentation?.requirements ?? []).map(requirement => ({ key: JSON.stringify(requirement), label: requirement.label,
    source: requirement.source, required: requirement.required })), ...(data.presentation?.capabilities ?? []).map(capability => ({ key: JSON.stringify(capability),
      label: capability.application, source: capability.alternatives.map(alternative => alternative.label).join(' / '), required: capability.required }))];
  return <section aria-label={t('previewTitle')} data-testid="package-draft-preview" className="min-w-0 space-y-5 rounded-xl border bg-background p-4 sm:p-5">
    <div className="flex min-w-0 items-start gap-4">
      <PluginExtensionAvatar name={data.title} identity={key} icon={data.imageAvailable ? draftPluginExtensionIcon(draftRef, revision, workspaceId) : undefined}
        size="lg" className="size-20 sm:size-24" />
      <div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{t('previewTitle')} · {t('privateDraft')}</p>
        <h3 className="mt-1 break-words text-lg font-semibold tracking-tight">{data.title}</h3>
        {data.description ? <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{data.description}</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">{t(data.ownership.type === 'organization' ? 'organization'
          : data.ownership.type === 'team' ? 'team' : 'personal')}{data.version ? ` · ${data.version}` : ''}</p>
      </div>
    </div>
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="package-draft-audience">
      <p className="font-medium text-foreground">{t('audienceNotSpecified')}</p><p>{t('draftDoesNotGrantUse')}</p>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t(data.previewIncomplete ? 'previewIncomplete' : 'previewNotPublished')}</p>
    {data.skills.length ? <div className="space-y-3"><h4 className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4" aria-hidden="true" />{t('includedSkills', { count: data.skills.length })}</h4>
      <ul className="divide-y rounded-lg border">{data.skills.map(skill => <li key={skill.path} className="min-w-0 p-3 sm:p-4">
        <div className="flex items-start gap-2"><Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0"><p className="break-words text-sm font-medium">{skill.title}<span className="ml-2 text-xs font-normal text-muted-foreground">{skill.version}</span></p>
            <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t(skill.origin === 'captured' ? 'skillCaptured' : 'skillAuthoredInDraft')}</p></div></div>
        <DraftSkillPreview key={`${key}:${skill.path}`} draftRef={draftRef} revision={revision} workspaceId={workspaceId} path={skill.path} />
      </li>)}</ul>{data.skillsTruncated ? <p className="text-xs text-muted-foreground">{t('previewSkillsTruncated')}</p> : null}
    </div> : null}
    <details className="rounded-md border p-3" data-testid="package-draft-provenance">
      <summary className="cursor-pointer text-sm font-medium">{t('provenanceTitle')}</summary>
      <div className="mt-3 space-y-3 text-xs">
        {data.ownership.type === 'organization' ? <p className="break-all text-muted-foreground">{t('organizationIdentity', { id: data.ownership.organizationId })}</p> : null}
        <p className="text-muted-foreground">{t(`authoringOperation.${data.authoring.operation}`)}</p>
        <p className="leading-relaxed text-muted-foreground">{t('captureHistoryHint')}</p>
        {data.authoring.captures.length ? <ul className="space-y-3">{data.authoring.captures.map((capture, index) => <li key={`${index}:${capture.sourceName}:${capture.targetName}`} className="space-y-1 rounded-md border p-3">
          <p className="break-words font-medium">{capture.targetName}</p>
          <p className="break-words">{t(capture.source === 'package' ? 'capturePackageSource' : 'captureWorkspaceSource', { name: capture.sourceName, version: capture.sourceVersion })}</p>
          {capture.parent ? <p className="break-words text-muted-foreground">{t('captureParent', capture.parent)}</p> : null}
          <p className="break-words">{t(capture.versionChangedAtCapture ? 'captureVersionChanged' : 'captureVersionKept', {
            source: capture.sourceVersion, target: capture.targetVersionAtCapture })}</p>
          {capture.adjustmentsAtCapture.length ? <ul className="list-inside list-disc text-muted-foreground">{capture.adjustmentsAtCapture.map(adjustment => <li key={adjustment}>{t(`captureAdjustments.${adjustment}`)}</li>)}</ul> : null}
        </li>)}</ul> : <p className="text-muted-foreground">{t('noCaptureHistory')}</p>}
        {data.authoring.capturesTruncated ? <p className="text-muted-foreground">{t('captureHistoryTruncated')}</p> : null}
      </div>
    </details>
    {requirements.length ? <div className="space-y-2"><h4 className="flex items-center gap-2 text-sm font-medium"><Plug className="size-4" aria-hidden="true" />{t('requirementsTitle')}</h4>
      <ul className="space-y-2">{requirements.map(requirement => <li key={requirement.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs">
        <span className="min-w-0 break-words font-medium">{requirement.label}<span className="ml-2 font-normal text-muted-foreground">{requirement.source}</span></span>
        <span className="text-muted-foreground">{t(requirement.required ? 'requiredConnection' : 'optionalConnection')}</span>
      </li>)}</ul><p className="text-xs text-muted-foreground">{t('requirementsPreviewHint')}</p>
    </div> : null}
  </section>;
}
