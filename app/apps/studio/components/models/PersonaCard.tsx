'use client';

import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import type { StudioPersona } from '../../types/models';

interface PersonaCardProps {
  persona: StudioPersona;
}

export function PersonaCard({ persona }: PersonaCardProps) {
  const [imgError, setImgError] = useState(false);

  const thumbnailUrl = persona.images?.[0]
    ? `/api/studio/personas/${persona.id}/images/${persona.images[0].id}`
    : null;

  return (
    <Link href={`/studio/models/${persona.id}`} className="block">
      <Card className="group flex h-full flex-col overflow-hidden border border-border bg-card transition-colors hover:border-primary/40 hover:bg-accent">
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          {thumbnailUrl && !imgError ? (
            <img
              src={thumbnailUrl}
              alt={persona.name}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <ImageOff className="h-8 w-8 text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div className="p-3">
          <p className="truncate text-sm font-semibold text-foreground">{persona.name}</p>
          <p className="text-xs text-muted-foreground">{persona.imageCount} {persona.imageCount === 1 ? 'Bild' : 'Bilder'}</p>
        </div>
      </Card>
    </Link>
  );
}