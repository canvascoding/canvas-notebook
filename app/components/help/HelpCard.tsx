'use client';

import Image from 'next/image';
import { Play } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { Tutorial } from './help-data';

interface HelpCardProps {
  tutorial: Tutorial;
  onClick: () => void;
}

export function HelpCard({ tutorial, onClick }: HelpCardProps) {
  const hasVideo = !!tutorial.videoUrl;

  return (
    <Card
      className="group cursor-pointer overflow-hidden border border-border bg-card transition-all hover:border-primary/50 hover:shadow-md"
      onClick={onClick}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        <Image
          src={tutorial.thumbnail || '/images/help/thumbnail-fallback.svg'}
          alt={tutorial.title}
          fill
          className="object-cover transition-transform group-hover:scale-105"
        />
        {hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 shadow-lg">
              <Play className="h-5 w-5 fill-primary text-primary" />
            </div>
          </div>
        )}
      </div>

      <CardHeader className="pb-2 pt-4">
        <h3 className="text-base font-semibold line-clamp-1">{tutorial.title}</h3>
      </CardHeader>

      <CardContent className="pb-4">
        <p className="text-sm text-muted-foreground line-clamp-2">
          {tutorial.description}
        </p>
      </CardContent>
    </Card>
  );
}
