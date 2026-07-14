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
        'mx-4 mt-4 overflow-hidden rounded-xl border border-border/70 bg-muted/25 md:ml-[4.75rem] md:mr-5',
        className,
      )}
      aria-label={t('markdownEditorProperties')}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Tags className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {frontmatter.title || t('markdownEditorProperties')}
        </span>
        <span className="rounded-full bg-background/80 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {propertyCount}
        </span>
      </button>

      {frontmatter.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border/50 px-3 py-2">
          {frontmatter.tags.map((tag) => (
            <span key={tag} className="inline-flex min-h-6 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <span aria-hidden="true">#</span>{tag}
              {!readOnly ? (
                <button
                  type="button"
                  className="-mr-0.5 rounded-full p-0.5 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="grid gap-4 border-t border-border/50 bg-background/55 p-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={`${tagListId}-title`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesTitle')}
            </Label>
            {readOnly ? (
              <p className="min-h-9 rounded-md border bg-muted/20 px-3 py-2 text-sm">{frontmatter.title || '—'}</p>
            ) : (
              <Input
                key={frontmatter.title ?? ''}
                id={`${tagListId}-title`}
                defaultValue={frontmatter.title ?? ''}
                placeholder={t('markdownEditorPropertiesTitlePlaceholder')}
                onBlur={(event) => applyPatch({ title: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            )}
          </div>

          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${tagListId}-tag`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesTags')}
            </Label>
            {readOnly ? (
              <p className="min-h-9 rounded-md border bg-muted/20 px-3 py-2 text-sm">
                {frontmatter.tags.length > 0 ? frontmatter.tags.map((tag) => `#${tag}`).join(', ') : '—'}
              </p>
            ) : (
              <Input
                id={`${tagListId}-tag`}
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

          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${tagListId}-aliases`} className="text-xs text-muted-foreground">
              {t('markdownEditorPropertiesAliases')}
            </Label>
            {readOnly ? (
              <p className="min-h-9 rounded-md border bg-muted/20 px-3 py-2 text-sm">
                {frontmatter.aliases.join(', ') || '—'}
              </p>
            ) : (
              <Input
                key={frontmatter.aliases.join('\0')}
                id={`${tagListId}-aliases`}
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
              <dl className="grid gap-x-4 gap-y-2 rounded-lg border bg-muted/15 p-3 text-xs sm:grid-cols-[minmax(8rem,0.35fr)_1fr]">
                {extraProperties.map(([key, propertyValue]) => (
                  <div key={key} className="contents">
                    <dt className="font-medium text-foreground">{key}</dt>
                    <dd className="min-w-0 break-words font-mono text-muted-foreground">{formatPropertyValue(propertyValue)}</dd>
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
