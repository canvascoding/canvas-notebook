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
import { Terminal, Globe, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { SkillManifest } from '@/app/lib/skills/skill-manifest';

interface SkillDetailDialogProps {
  skill: SkillManifest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  children?: ReactNode;
  inline?: boolean;
};

export function SkillDetailDialog({ skill, open, onOpenChange }: SkillDetailDialogProps) {
  const [readme, setReadme] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && skill) {
      loadReadme(skill.name);
    }
  }, [open, skill]);

  async function loadReadme(skillName: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/skills/${skillName}/readme`);
      const data = await response.json();
      if (data.success) {
        setReadme(data.content);
      } else {
        setError(data.error || 'Failed to load README');
      }
    } catch {
      setError('Failed to load README');
    } finally {
      setLoading(false);
    }
  }

  if (!skill) return null;

  const isBuiltIn = !skill.author || skill.author === 'system';

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
            Details, parameters, and documentation for the selected skill.
          </DialogDescription>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {skill.type === 'cli' ? (
                <Terminal className="h-7 w-7 text-muted-foreground" />
              ) : (
                <Globe className="h-7 w-7 text-muted-foreground" />
              )}
              <div>
                <DialogTitle className="text-2xl font-bold">{skill.title}</DialogTitle>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-sm text-muted-foreground font-medium">v{skill.version}</span>
                  <Badge variant="secondary" className="text-xs">
                    {skill.type.toUpperCase()}
                  </Badge>
                  <Badge variant={isBuiltIn ? 'default' : 'outline'} className="text-xs">
                    {isBuiltIn ? 'Built-in' : 'Custom'}
                  </Badge>
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

            {/* Parameters */}
            {Object.keys(skill.tool.parameters).length > 0 && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Parameters</h2>
                <div className="grid gap-3">
                  {Object.entries(skill.tool.parameters).map(([key, param]) => (
                    <div key={key} className="bg-muted rounded-lg p-4 border">
                      <div className="flex items-center gap-3 mb-2">
                        <code className="bg-background px-2 py-1 rounded text-sm font-mono font-semibold">
                          {key}
                        </code>
                        <span className="text-sm text-muted-foreground">({param.type})</span>
                        {param.required && (
                          <Badge variant="destructive" className="text-xs">required</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">
                        {param.description}
                      </p>
                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        {param.default !== undefined && (
                          <span>
                            <span className="font-medium">Default:</span>{' '}
                            <code className="bg-background px-1 rounded">{JSON.stringify(param.default)}</code>
                          </span>
                        )}
                        {param.enum && (
                          <span>
                            <span className="font-medium">Options:</span> {param.enum.join(', ')}
                          </span>
                        )}
                        {(param.minimum !== undefined || param.maximum !== undefined) && (
                          <span>
                            <span className="font-medium">Range:</span>{' '}
                            {param.minimum !== undefined ? param.minimum : '∞'} - {param.maximum !== undefined ? param.maximum : '∞'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* README Content */}
            <div>
              <h2 className="text-lg font-semibold mb-4">Documentation</h2>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive bg-destructive/10 p-4 rounded-lg">{error}</div>
              ) : (
                <div className="prose prose-base max-w-none break-words dark:prose-invert [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
                  <ReactMarkdown
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
                    {readme}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* Metadata Footer */}
            <div className="border-t pt-6 mt-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Tool Name:</span>
                  <div className="font-mono mt-1">{skill.tool.name}</div>
                </div>
                <div>
                  <span className="font-medium text-foreground">Created:</span>
                  <div className="mt-1">{new Date(skill.created_at).toLocaleDateString()}</div>
                </div>
                {skill.author && (
                  <div>
                    <span className="font-medium text-foreground">Author:</span>
                    <div className="mt-1">{skill.author}</div>
                  </div>
                )}
                <div>
                  <span className="font-medium text-foreground">Handler:</span>
                  <div className="mt-1">
                    {skill.handler.type === 'cli' && skill.handler.command ? (
                      <code className="text-xs bg-muted px-1 rounded">{skill.handler.command}</code>
                    ) : skill.handler.type === 'api' && skill.handler.endpoint ? (
                      <code className="text-xs bg-muted px-1 rounded">{skill.handler.endpoint}</code>
                    ) : (
                      skill.handler.type
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
