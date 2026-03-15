'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Power, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';

interface SkillDetailDialogProps {
  skill: AnthropicSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  children?: ReactNode;
  inline?: boolean;
};

export function SkillDetailDialog({ skill, open, onOpenChange }: SkillDetailDialogProps) {
  const [skillContent, setSkillContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && skill) {
      loadSkillContent(skill.name);
    }
  }, [open, skill]);

  async function loadSkillContent(skillName: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/skills/${skillName}/readme`);
      const data = await response.json();
      if (data.success) {
        setSkillContent(data.content);
      } else {
        setError(data.error || 'Failed to load skill content');
      }
    } catch {
      setError('Failed to load skill content');
    } finally {
      setLoading(false);
    }
  }

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
            Details and documentation for the selected skill.
          </DialogDescription>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Power className={`h-7 w-7 ${skill.enabled ? 'text-green-500' : 'text-muted-foreground'}`} />
              <div>
                <DialogTitle className="text-2xl font-bold">{skill.title}</DialogTitle>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-sm text-muted-foreground font-medium">{skill.name}</span>
                  <Badge variant={skill.enabled ? 'default' : 'secondary'} className="text-xs">
                    {skill.enabled ? 'Enabled' : 'Disabled'}
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
              aria-label="Close skill details"
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
              <h2 className="text-lg font-semibold mb-3">Description</h2>
              <p className="text-base text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {skill.description}
              </p>
            </div>

            {/* SKILL.md Content */}
            <div>
              <h2 className="text-lg font-semibold mb-4">Documentation</h2>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive bg-destructive/10 p-4 rounded-lg">{error}</div>
              ) : (
                <div className="prose prose-base max-w-none break-words dark:prose-invert [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkFrontmatter]}
                    components={{
                      code({ className, children, inline, ...props }: MarkdownCodeProps) {
                        const match = /language-(\w+)/.exec(className || '');

                        return !inline && match ? (
                          <SyntaxHighlighter
                            language={match[1]}
                            PreTag="div"
                            customStyle={{ maxWidth: '100%', overflowX: 'auto' }}
                          >
                            {String(children).replace(/\n$/, '')}
                          </SyntaxHighlighter>
                        ) : (
                          <code className={`break-words ${className || ''}`.trim()} {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {skillContent}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* Metadata Footer */}
            <div className="border-t pt-6 mt-8">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Skill Name:</span>
                  <div className="font-mono mt-1">{skill.name}</div>
                </div>
                <div>
                  <span className="font-medium text-foreground">Status:</span>
                  <div className="mt-1">{skill.enabled ? 'Enabled' : 'Disabled'}</div>
                </div>
                {skill.license && (
                  <div>
                    <span className="font-medium text-foreground">License:</span>
                    <div className="mt-1">{skill.license}</div>
                  </div>
                )}
                {skill.compatibility && (
                  <div>
                    <span className="font-medium text-foreground">Compatibility:</span>
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
