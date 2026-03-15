'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Terminal, Globe, Loader2 } from 'lucide-react';
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
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3">
            {skill.type === 'cli' ? (
              <Terminal className="h-6 w-6 text-muted-foreground" />
            ) : (
              <Globe className="h-6 w-6 text-muted-foreground" />
            )}
            <div>
              <DialogTitle className="text-xl">{skill.title}</DialogTitle>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-muted-foreground">v{skill.version}</span>
                <Badge variant="secondary" className="text-xs">
                  {skill.type}
                </Badge>
                <Badge variant={isBuiltIn ? 'default' : 'outline'} className="text-xs">
                  {isBuiltIn ? 'Built-in' : 'Custom'}
                </Badge>
              </div>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 my-4">
          <div className="space-y-6 pr-4">
            {/* Description */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Description</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {skill.description}
              </p>
            </div>

            {/* Parameters */}
            {Object.keys(skill.tool.parameters).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Parameters</h3>
                <div className="bg-muted rounded-lg p-3 space-y-2">
                  {Object.entries(skill.tool.parameters).map(([key, param]) => (
                    <div key={key} className="text-sm">
                      <div className="flex items-center gap-2">
                        <code className="bg-background px-1.5 py-0.5 rounded text-xs font-mono">
                          {key}
                        </code>
                        <span className="text-xs text-muted-foreground">({param.type})</span>
                        {param.required && (
                          <Badge variant="destructive" className="text-[10px]">required</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 ml-0.5">
                        {param.description}
                      </p>
                      {param.default !== undefined && (
                        <p className="text-xs text-muted-foreground mt-0.5 ml-0.5">
                          Default: <code className="text-xs">{JSON.stringify(param.default)}</code>
                        </p>
                      )}
                      {param.enum && (
                        <p className="text-xs text-muted-foreground mt-0.5 ml-0.5">
                          Options: {param.enum.join(', ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* README Content */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Documentation</h3>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive">{error}</div>
              ) : (
                <div className="prose prose-sm dark:prose-invert max-w-none">
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

            {/* Metadata */}
            <div className="text-xs text-muted-foreground border-t pt-4">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="font-medium">Tool Name:</span> {skill.tool.name}
                </div>
                <div>
                  <span className="font-medium">Created:</span>{' '}
                  {new Date(skill.created_at).toLocaleDateString()}
                </div>
                {skill.author && (
                  <div>
                    <span className="font-medium">Author:</span> {skill.author}
                  </div>
                )}
                {skill.handler.type === 'cli' && skill.handler.command && (
                  <div>
                    <span className="font-medium">Command:</span>{' '}
                    <code className="text-xs">{skill.handler.command}</code>
                  </div>
                )}
                {skill.handler.type === 'api' && skill.handler.endpoint && (
                  <div>
                    <span className="font-medium">Endpoint:</span>{' '}
                    <code className="text-xs">{skill.handler.endpoint}</code>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
