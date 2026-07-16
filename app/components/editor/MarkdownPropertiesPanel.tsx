'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Tags, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  normalizeCanvasTag,
  parseCanvasMarkdownDocument,
  updateCanvasMarkdownProperties,
  type CanvasMarkdownPropertiesPatch,
} from '@/app/lib/markdown/obsidian-metadata';
import {
  loadWorkspaceLinkIndex,
  subscribeWorkspaceLinkIndexInvalidation,
} from '@/app/lib/markdown/workspace-link-index-client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type MarkdownPropertiesPanelProps = {
  className?: string;
  filePath?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  value: string;
};

const RESERVED_PROPERTY_KEYS = new Set(['title', 'tags', 'tag', 'aliases', 'alias']);

function titleFromFilePath(filePath: string | undefined, fallback: string): string {
  const basename = filePath?.split('/').pop()?.replace(/\.(?:md|markdown)$/i, '') ?? '';
  const readable = basename.replace(/[-_]+/g, ' ').trim();
  return readable || fallback;
}

function formatPropertyValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function MarkdownPropertiesPanel({
  className,
  filePath,
  onChange,
  readOnly = false,
  value,
}: MarkdownPropertiesPanelProps) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const tagListId = useId();
  const parsed = useMemo(() => parseCanvasMarkdownDocument(value), [value]);
  const frontmatter = parsed.frontmatter;
  const [expanded, setExpanded] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [knownTagState, setKnownTagState] = useState<{ tags: string[]; workspaceId: string | null }>({
    tags: [],
    workspaceId: null,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (readOnly || !activeWorkspaceId) return undefined;

    let cancelled = false;
    const refresh = () => {
      void loadWorkspaceLinkIndex(activeWorkspaceId)
        .then((index) => {
          if (cancelled) return;
          setKnownTagState({
            tags: Array.from(new Set(index.documents.flatMap((document) => document.tags))).sort(),
            workspaceId: activeWorkspaceId,
          });
        })
        .catch(() => {
          if (!cancelled) setKnownTagState({ tags: [], workspaceId: activeWorkspaceId });
        });
    };
    refresh();
    const unsubscribe = subscribeWorkspaceLinkIndexInvalidation((event) => {
      if (!event.workspaceId || event.workspaceId === activeWorkspaceId) refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeWorkspaceId, readOnly]);

  const applyPatch = useCallback((patch: CanvasMarkdownPropertiesPatch) => {
    if (readOnly || !onChange) return false;
    const result = updateCanvasMarkdownProperties(value, patch);
    if (result.error) {
      setError(result.error);
      return false;
    }
    setError(null);
    if (result.changed) onChange(result.markdown);
    return true;
  }, [onChange, readOnly, value]);

  const addTag = useCallback((rawTag: string) => {
    const tag = normalizeCanvasTag(rawTag);
    setTagDraft('');
    if (!tag || frontmatter?.tags.includes(tag)) return;
    applyPatch({ tags: [...(frontmatter?.tags ?? []), tag] });
  }, [applyPatch, frontmatter?.tags]);

  if (parsed.error) return null;
  if (!frontmatter && readOnly) return null;

  if (!frontmatter) {
    return (
      <div className={cn('px-4 pt-4 md:px-5 md:pl-[4.75rem]', className)}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-2 rounded-full border border-dashed px-3 text-muted-foreground"
          onClick={() => {
            if (applyPatch({ title: titleFromFilePath(filePath, t('markdownEditorPropertiesUntitled')) })) {
              setExpanded(true);
            }
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('markdownEditorPropertiesAdd')}
        </Button>
      </div>
    );
  }

  const extraProperties = Object.entries(frontmatter.data).filter(([key]) => !RESERVED_PROPERTY_KEYS.has(key));
  const propertyCount = frontmatter.tags.length + frontmatter.aliases.length + extraProperties.length + (frontmatter.title ? 1 : 0);
  const knownTags = knownTagState.workspaceId === activeWorkspaceId ? knownTagState.tags : [];

  return (
    <section
      className={cn(
        'mx-3 mt-3 overflow-hidden rounded-2xl border border-border/70 bg-muted/20 shadow-sm md:ml-[4.75rem] md:mr-5 md:mt-4',
        className,
      )}
      aria-label={t('markdownEditorProperties')}
    >
      <button
        type="button"
        className="grid min-h-16 w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:px-4"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-muted-foreground shadow-sm">
          <Tags className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('markdownEditorProperties')}
          </span>
          <span className="mt-0.5 line-clamp-2 block break-words text-sm font-semibold leading-5 text-foreground">
            {frontmatter.title || t('markdownEditorPropertiesUntitled')}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pl-1 text-muted-foreground">
          <span
            className="flex h-7 min-w-7 items-center justify-center rounded-full border border-border/60 bg-background/80 px-1.5 text-[11px] font-medium tabular-nums"
            aria-label={`${propertyCount} ${t('markdownEditorProperties')}`}
            title={t('markdownEditorProperties')}
          >
            {propertyCount}
          </span>
          {expanded
            ? <ChevronDown className="h-4 w-4" aria-hidden="true" />
            : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        </span>
      </button>

      {frontmatter.tags.length > 0 ? (
        <div
          className={cn(
            'flex flex-wrap items-start gap-2 border-t border-border/50 px-3 py-3 sm:px-4',
            !expanded && 'max-h-28 overflow-y-auto overscroll-contain',
          )}
          data-testid="markdown-properties-tags"
        >
          {frontmatter.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-lg border border-primary/15 bg-primary/[0.08] py-1 pl-2.5 pr-1.5 text-xs font-medium text-primary"
            >
              <span className="shrink-0 opacity-70" aria-hidden="true">#</span>
              <span className="min-w-0 break-words leading-4 [overflow-wrap:anywhere]">{tag}</span>
              {!readOnly ? (
                <button
                  type="button"
                  className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('markdownEditorPropertiesRemoveTag', { tag })}
                  onClick={() => applyPatch({ tags: frontmatter.tags.filter((candidate) => candidate !== tag) })}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {expanded ? (
        <div className="grid gap-3 border-t border-border/50 bg-background/60 p-3 sm:grid-cols-2 sm:gap-4 sm:p-4">
          <div className="grid gap-2 rounded-xl border border-border/60 bg-background/75 p-3 sm:col-span-2">
            <Label htmlFor={`${tagListId}-title`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesTitle')}
            </Label>
            {readOnly ? (
              <p className="min-h-10 break-words rounded-lg border bg-muted/20 px-3 py-2 text-sm">{frontmatter.title || '—'}</p>
            ) : (
              <Input
                key={frontmatter.title ?? ''}
                id={`${tagListId}-title`}
                className="min-h-10"
                defaultValue={frontmatter.title ?? ''}
                placeholder={t('markdownEditorPropertiesTitlePlaceholder')}
                onBlur={(event) => applyPatch({ title: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            )}
          </div>

          <div className="grid content-start gap-2 rounded-xl border border-border/60 bg-background/75 p-3">
            <Label htmlFor={`${tagListId}-tag`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesTags')}
            </Label>
            {readOnly ? (
              <p className="min-h-10 break-words rounded-lg border bg-muted/20 px-3 py-2 text-sm [overflow-wrap:anywhere]">
                {frontmatter.tags.length > 0 ? frontmatter.tags.map((tag) => `#${tag}`).join(', ') : '—'}
              </p>
            ) : (
              <Input
                id={`${tagListId}-tag`}
                className="min-h-10"
                list={tagListId}
                value={tagDraft}
                placeholder={t('markdownEditorPropertiesTagPlaceholder')}
                onChange={(event) => setTagDraft(event.target.value)}
                onBlur={() => {
                  if (tagDraft.trim()) addTag(tagDraft);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault();
                    addTag(tagDraft);
                  }
                }}
              />
            )}
            {!readOnly ? (
              <datalist id={tagListId}>
                {knownTags.filter((tag) => !frontmatter.tags.includes(tag)).map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            ) : null}
          </div>

          <div className="grid content-start gap-2 rounded-xl border border-border/60 bg-background/75 p-3">
            <Label htmlFor={`${tagListId}-aliases`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesAliases')}
            </Label>
            {readOnly ? (
              <p className="min-h-10 break-words rounded-lg border bg-muted/20 px-3 py-2 text-sm [overflow-wrap:anywhere]">
                {frontmatter.aliases.join(', ') || '—'}
              </p>
            ) : (
              <Input
                key={frontmatter.aliases.join('\0')}
                id={`${tagListId}-aliases`}
                className="min-h-10"
                defaultValue={frontmatter.aliases.join(', ')}
                placeholder={t('markdownEditorPropertiesAliasesPlaceholder')}
                onBlur={(event) => applyPatch({ aliases: event.currentTarget.value.split(',') })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            )}
          </div>

          {extraProperties.length > 0 ? (
            <div className="grid gap-2 sm:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-muted-foreground">{t('markdownEditorPropertiesAdditional')}</p>
                {!readOnly ? <p className="text-[11px] text-muted-foreground">{t('markdownEditorPropertiesSourceHint')}</p> : null}
              </div>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                {extraProperties.map(([key, propertyValue]) => (
                  <div key={key} className="min-w-0 rounded-xl border border-border/60 bg-background/75 p-3">
                    <dt className="break-words font-medium text-foreground [overflow-wrap:anywhere]">{key}</dt>
                    <dd className="mt-1 min-w-0 break-words font-mono leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                      {formatPropertyValue(propertyValue)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {error ? <p className="text-xs text-destructive sm:col-span-2">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
