'use client';

import { useState, useEffect, useRef, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Power, Loader2, X, Save, AlertCircle } from 'lucide-react';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';

interface SkillDetailDialogProps {
  skill: AnthropicSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SkillDetailDialog({ skill, open, onOpenChange }: SkillDetailDialogProps) {
  const t = useTranslations('skills');
  const [skillContent, setSkillContent] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);

  async function loadSkillContent(skillName: string) {
    setLoading(true);
    setError(null);
    setSaveError(null);
    setDraft('');
    try {
      const response = await fetch(`/api/skills/${skillName}/readme`);
      const data = await response.json();
      if (data.success) {
        setSkillContent(data.content);
        setDraft(data.content);
      } else {
        setError(data.error || t('detail.errors.loadContent'));
      }
    } catch {
      setError(t('detail.errors.loadContent'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && skill) {
      startTransition(() => { loadSkillContent(skill.name); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSkillContent takes skill.name as argument; skill is in deps
  }, [open, skill]);

  useEffect(() => {
    if (!draft || !skill) return;

    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      if (draft === skillContent) {
        return;
      }

      setIsSaving(true);
      setSaveError(null);

      try {
        const response = await fetch(`/api/skills/${skill.name}/readme`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: draft }),
        });

        const data = await response.json();

        if (data.success) {
          setSkillContent(draft);
          setLastSavedAt(Date.now());
        } else {
          setSaveError(data.error || t('detail.errors.saveFailed'));
        }
      } catch {
        setSaveError(t('detail.errors.saveFailed'));
      } finally {
        setIsSaving(false);
      }
    }, 800);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [draft, skill, skillContent, t]);

  const isDirty = draft !== skillContent;
  const savedTime = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  if (!skill) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="viewport"
        showCloseButton={false}
        className="flex h-full min-h-0 flex-col overflow-hidden border-0 p-0 sm:border"
        data-testid="skill-detail-dialog"
      >
        {/* Header */}
        <DialogHeader className="flex-shrink-0 border-b bg-muted/50 px-4 py-4 text-left sm:px-6">
          <DialogDescription className="sr-only">
            {t('detail.srDescription')}
          </DialogDescription>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Power className={`h-7 w-7 ${skill.enabled ? 'text-green-500' : 'text-muted-foreground'}`} />
              <div>
                <DialogTitle className="text-2xl font-bold">{skill.title}</DialogTitle>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-sm text-muted-foreground font-medium">{skill.name}</span>
                  <Badge variant={skill.enabled ? 'default' : 'secondary'} className="text-xs">
                    {skill.enabled ? t('detail.enabled') : t('detail.disabled')}
                  </Badge>
                  {skill.license && (
                    <Badge variant="outline" className="text-xs">
                      {skill.license}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              type="button"
              aria-label={t('detail.close')}
              data-testid="skill-detail-close"
              className="p-2 hover:bg-accent rounded-md transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </DialogHeader>

        {/* Content - Full height with natural scrolling */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-testid="skill-detail-scroll-area"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
            {/* Description */}
            <div className="bg-muted/30 rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-3">{t('detail.description')}</h2>
              <p className="text-base text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {skill.description}
              </p>
            </div>

            {/* SKILL.md Content */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">{t('detail.documentation')}</h2>
                <div className="flex items-center gap-2">
                  {saveError && (
                    <span className="flex items-center gap-1 text-xs text-destructive" title={saveError}>
                      <AlertCircle className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{saveError}</span>
                    </span>
                  )}
                  {isSaving && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span className="hidden sm:inline">{t('saving')}</span>
                    </span>
                  )}
                  {!isSaving && !saveError && isDirty && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Save className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{t('unsavedChanges')}</span>
                    </span>
                  )}
                  {!isSaving && !saveError && !isDirty && savedTime && (
                    <span className="flex items-center gap-1 text-xs text-primary" title={t('savedAt', { time: savedTime })}>
                      <Power className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{t('savedAt', { time: savedTime })}</span>
                    </span>
                  )}
                </div>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive bg-destructive/10 p-4 rounded-lg">{error}</div>
              ) : (
                <div className="h-[400px] border rounded-lg overflow-hidden">
                  <MarkdownEditor key={skill.name} value={draft} onChange={setDraft} />
                </div>
              )}
            </div>

            {/* Metadata Footer */}
            <div className="border-t pt-6 mt-8">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">{t('detail.skillName')}</span>
                  <div className="font-mono mt-1">{skill.name}</div>
                </div>
                <div>
                  <span className="font-medium text-foreground">{t('detail.status')}</span>
                  <div className="mt-1">{skill.enabled ? t('detail.enabled') : t('detail.disabled')}</div>
                </div>
                {skill.license && (
                  <div>
                    <span className="font-medium text-foreground">{t('detail.license')}</span>
                    <div className="mt-1">{skill.license}</div>
                  </div>
                )}
                {skill.compatibility && (
                  <div>
                    <span className="font-medium text-foreground">{t('detail.compatibility')}</span>
                    <div className="mt-1">{skill.compatibility}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
