'use client';

import { Film, ImageIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { StudioGenerationMode } from '../../types/generation';

interface ModeToggleProps {
  value: StudioGenerationMode;
  onChange: (value: StudioGenerationMode) => void;
}

export function ModeToggle({ value, onChange }: ModeToggleProps) {
  const Icon = value === 'video' ? Film : ImageIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <Icon className="h-4 w-4" />
          {value === 'video' ? 'Video' : 'Image'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem onSelect={() => onChange('image')}>
          <ImageIcon className="h-4 w-4" />
          Image
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange('video')}>
          <Film className="h-4 w-4" />
          Video
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
