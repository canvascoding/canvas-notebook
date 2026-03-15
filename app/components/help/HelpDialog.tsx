'use client';

import { X } from 'lucide-react';
import Link from 'next/link';

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
              <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
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
            <div className="prose prose-base max-w-none dark:prose-invert">
              <div className="whitespace-pre-wrap text-foreground">
                {tutorial.content.split('\n').map((line, index) => {
                  if (line.startsWith('## ')) {
                    return <h2 key={index} className="text-xl font-bold mt-6 mb-3">{line.replace('## ', '')}</h2>;
                  }
                  if (line.startsWith('### ')) {
                    return <h3 key={index} className="text-lg font-semibold mt-4 mb-2">{line.replace('### ', '')}</h3>;
                  }
                  if (line.startsWith('- ')) {
                    return <li key={index} className="ml-4 mb-1">{line.replace('- ', '')}</li>;
                  }
                  if (line.startsWith('1. ') || line.startsWith('2. ') || line.startsWith('3. ') || line.startsWith('4. ')) {
                    return <li key={index} className="ml-4 mb-1">{line.substring(3)}</li>;
                  }
                  if (line.startsWith('```')) {
                    return null;
                  }
                  if (line.trim() === '') {
                    return <div key={index} className="h-2" />;
                  }
                  return <p key={index} className="mb-2">{line}</p>;
                })}
              </div>
            </div>

            {/* Links */}
            {tutorial.links.length > 0 && (
              <div className="border-t pt-6">
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
