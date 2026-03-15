'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Terminal, Globe, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SkillManifest } from '@/app/lib/skills/skill-manifest';

interface SkillDetailDialogProps {
  skill: SkillManifest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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
    } catch (err) {
      setError('Failed to load README');
    } finally {
      setLoading(false);
    }
  }

  if (!skill) return null;

  const isBuiltIn = !skill.author || skill.author === 'system';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] h-[95vh] max-w-none p-0 overflow-hidden flex flex-col">
        {/* Header */}
        <DialogHeader className="flex-shrink-0 border-b bg-muted/50 px-6 py-4">
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
              className="p-2 hover:bg-accent rounded-md transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </DialogHeader>

        {/* Content - Full height with natural scrolling */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
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
                <div className="prose prose-base dark:prose-invert max-w-none">
                  <ReactMarkdown
                    components={{
                      code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                          <SyntaxHighlighter
                            style={vscDarkPlus}
                            language={match[1]}
                            PreTag="div"
                            {...props}
                          >
                            {String(children).replace(/\n$/, '')}
                          </SyntaxHighlighter>
                        ) : (
                          <code className={className} {...props}>
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
