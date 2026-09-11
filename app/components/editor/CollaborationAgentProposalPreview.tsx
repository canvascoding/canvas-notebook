'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import { CANVAS_MARKDOWN_CONTENT_REMARK_PLUGINS, CANVAS_MARKDOWN_REHYPE_PLUGINS } from '@/app/lib/markdown/canvas-markdown';
import {
  agentPreviewAttributeChanges, agentPreviewChanges, canDisplayAgentReviewTarget,
  parseAgentPreviewBlocks, renderAgentPreviewBlocks, type AgentReviewTarget,
} from '@/app/lib/collaboration/agent-proposal-display';
import type { AgentPreviewBlockLocation, AgentPreviewLocationReference } from '@/app/lib/collaboration/agent-proposal-preview';

type Translate = ReturnType<typeof useTranslations<'notebook.collaboration'>>;
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const blockNames: Record<string, string> = {
  paragraph: 'paragraph', heading: 'heading', blockquote: 'quote', bulletList: 'list', orderedList: 'list',
  taskList: 'list', listItem: 'listItem', taskItem: 'listItem', table: 'table', tableRow: 'row', tableCell: 'cell', tableHeader: 'cell',
  codeBlock: 'code', image: 'image', horizontalRule: 'divider', canvasCallout: 'callout', canvasDetails: 'details',
};
const propertyNames = new Set(['level', 'start', 'checked', 'textAlign', 'align', 'width', 'height', 'alt', 'title',
  'src', 'href', 'language', 'colspan', 'rowspan', 'colwidth', 'calloutType', 'fold', 'open', 'latex', 'target', 'embed']);
const classes = 'break-words whitespace-pre-wrap text-xs leading-relaxed [&_p]:min-h-4 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h4]:text-sm [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_strong]:font-bold [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:p-1.5 [&_td]:border [&_td]:p-1.5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_code]:font-mono [&_mark]:bg-yellow-100 [&_hr]:my-3 [&_aside]:border-l-2 [&_aside]:pl-2 [&_details]:rounded [&_details]:border [&_details]:p-2';

function typeLabel(type: string, t: Translate): string { return t(`agentPreviewBlock_${blockNames[type] ?? 'section'}`); }
function referenceLabel(reference: AgentPreviewLocationReference, t: Translate): string {
  return `${typeLabel(reference.type, t)} ${reference.position.join('.')} ${reference.text ? `„${reference.text}${reference.truncated ? '…' : ''}“` : ''}`.trim();
}
function locationLabel(location: AgentPreviewBlockLocation | undefined, t: Translate): string {
  if (!location) return t('agentPreviewNotPresent');
  const parent = location.parent ? referenceLabel(location.parent, t) : t('agentPreviewDocument');
  return location.following ? t('agentPreviewBeforeLocation', { parent, following: referenceLabel(location.following, t) })
    : t('agentPreviewAtEnd', { parent });
}
function valueLabel(value: unknown, t: Translate): string {
  if (value === undefined || value === null) return t('agentPreviewAutomatic');
  if (typeof value === 'boolean') return t(value ? 'agentPreviewYes' : 'agentPreviewNo');
  if (Array.isArray(value)) return value.map((entry) => valueLabel(entry, t)).join(', ');
  return String(value);
}

function SourceText({ content, t }: { content: string; t: Translate }) {
  return content.length === 0 ? <p className="italic text-muted-foreground">{t('agentPreviewEmpty')}</p>
    : <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed [tab-size:4]">{content}</pre>;
}

export function CollaborationAgentProposalPreview({ target, index, t, onReady }: {
  target: AgentReviewTarget; index: number; t: Translate; onReady?: (target: AgentReviewTarget, ready: boolean) => void;
}) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const valid = canDisplayAgentReviewTarget(target);
  const rendered = useMemo(() => {
    if (!mounted || !valid || target.previewFormat !== 'blocks') return null;
    try {
      const labels = { image: t('agentPreviewBlock_image'), link: t('agentPreviewProperty_href') };
      return { before: renderAgentPreviewBlocks(parseAgentPreviewBlocks(target.currentText!)!, labels),
        after: renderAgentPreviewBlocks(parseAgentPreviewBlocks(target.proposedReplacement)!, labels) };
    } catch { return null; }
  }, [mounted, valid, target, t]);
  useEffect(() => { onReady?.(target, valid && (target.previewFormat !== 'blocks' || rendered !== null)); },
    [onReady, target, valid, rendered]);
  const changes = target.previewFormat === 'blocks' ? agentPreviewChanges(target) : [];
  const attributes = target.previewFormat === 'blocks' ? agentPreviewAttributeChanges(target) : [];
  const side = (content: string | null, html: string | undefined) => {
    if (content === null || !valid) return <p className="text-muted-foreground">{t('agentPreviewUnavailable')}</p>;
    if (target.previewFormat === 'blocks') return html === undefined
      ? <p className="text-muted-foreground">{t(mounted ? 'agentPreviewUnavailable' : 'agentPreviewPreparing')}</p>
      : html ? <div className={classes} dangerouslySetInnerHTML={{ __html: html }} /> : <SourceText content="" t={t} />;
    if (target.previewFormat === 'markdown') return (
      <div className={classes}>
        <ReactMarkdown remarkPlugins={CANVAS_MARKDOWN_CONTENT_REMARK_PLUGINS} rehypePlugins={CANVAS_MARKDOWN_REHYPE_PLUGINS}
          components={{
            a: ({ children, href }) => <span>{children}{href ? ` (${t('agentPreviewProperty_href')}: ${href})` : ''}</span>,
            img: ({ src, alt }) => <span className="block rounded border border-dashed p-2">{t('agentPreviewBlock_image')}: {alt} ({typeof src === 'string' ? src : ''})</span>,
          }}>{content}</ReactMarkdown>
        <div className="mt-3 border-t pt-2"><p className="mb-1 font-medium">{t('agentPreviewExactText')}</p><SourceText content={content} t={t} /></div>
      </div>
    );
    return <SourceText content={content} t={t} />;
  };
  return (
    <section className="overflow-hidden rounded-md border" aria-label={t('agentPreviewChange', { number: index + 1 })}>
      <div className="space-y-1 border-b bg-muted/30 px-3 py-2 text-xs">
        <p className="font-semibold">{t('agentPreviewChange', { number: index + 1 })}</p>
        {changes.map((change) => <div key={change.id}>
          <p>{typeLabel(change.type, t)} · {change.kinds.map((kind) => t(`agentPreviewChange_${kind}`)).join(' · ')}</p>
          {change.kinds.includes('moved') ? <p className="text-muted-foreground">
            {locationLabel(target.blockLocations?.before.find((entry) => entry.id === change.id), t)}
            {' → '}{locationLabel(target.blockLocations?.after.find((entry) => entry.id === change.id), t)}
          </p> : null}
        </div>)}
        {attributes.map((attribute, position) => <p key={position} className="break-words">
          {typeLabel(attribute.type, t)} · {t(`agentPreviewProperty_${propertyNames.has(attribute.key) ? attribute.key : 'other'}`)}:
          {' '}{valueLabel(attribute.before, t)} → {valueLabel(attribute.after, t)}
        </p>)}
        {!valid ? <p role="status">{t('agentPreviewUnavailable')}</p> : null}
      </div>
      <div className="grid sm:grid-cols-2">
        <div className="min-w-0 border-b p-3 sm:border-b-0 sm:border-r">
          <p className="mb-2 text-[11px] font-semibold text-muted-foreground">{t('agentCurrentVersion')}</p>
          {side(target.currentText, rendered?.before)}
        </div>
        <div className="min-w-0 bg-violet-500/[0.04] p-3">
          <p className="mb-2 text-[11px] font-semibold text-violet-700 dark:text-violet-300">{t('agentProposedVersion')}</p>
          {side(target.proposedReplacement, rendered?.after)}
        </div>
      </div>
    </section>
  );
}
