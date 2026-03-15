'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { X } from 'lucide-react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import remarkGfm from 'remark-gfm';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Tutorial } from './help-data';

interface HelpDialogProps {
  tutorial: Tutorial | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  children?: ReactNode;
  inline?: boolean;
};

export function HelpDialog({ tutorial, open, onOpenChange }: HelpDialogProps) {
  if (!tutorial) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="viewport"
        showCloseButton={false}
        className="flex h-full min-h-0 flex-col overflow-hidden border-0 p-0 sm:border"
      >
        {/* Header */}
        <DialogHeader className="flex-shrink-0 border-b bg-muted/50 px-4 py-4 text-left sm:px-6">
          <DialogDescription className="sr-only">
            Tutorial Details für {tutorial.title}
          </DialogDescription>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-2xl font-bold">{tutorial.title}</DialogTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {tutorial.description}
              </p>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              type="button"
              aria-label="Schließen"
              className="p-2 hover:bg-accent rounded-md transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
            {/* Video */}
            {tutorial.videoUrl && (
              <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted shadow-sm">
                <iframe
                  src={tutorial.videoUrl}
                  title={`${tutorial.title} Video`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full border-0"
                />
              </div>
            )}

            {/* Content */}
            <div className="prose prose-lg max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4 prose-h3:text-xl prose-h3:mt-6 prose-h3:mb-3 prose-p:leading-relaxed prose-p:mb-4 prose-li:mb-2 prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-pre:bg-muted/80 prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:p-4 prose-pre:my-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, inline, ...props }: MarkdownCodeProps) {
                    const match = /language-(\w+)/.exec(className || '');

                    return !inline && match ? (
                      <SyntaxHighlighter
                        language={match[1]}
                        PreTag="div"
                        customStyle={{ 
                          maxWidth: '100%', 
                          overflowX: 'auto',
                          background: 'transparent',
                          padding: 0,
                          margin: 0
                        }}
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
                {tutorial.content}
              </ReactMarkdown>
            </div>

            {/* Links */}
            {tutorial.links.length > 0 && (
              <div className="border-t pt-6 mt-4">
                <p className="text-sm font-medium text-muted-foreground mb-3">
                  Weitere Aktionen
                </p>
                <div className="flex flex-wrap gap-3">
                  {tutorial.links.map((link, index) => (
                    <Button
                      key={index}
                      asChild
                      variant={link.variant || 'outline'}
                      size="sm"
                    >
                      <Link href={link.href}>{link.label}</Link>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
