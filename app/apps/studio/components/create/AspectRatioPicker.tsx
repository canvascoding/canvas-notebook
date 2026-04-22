'use client';

import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AspectRatioPickerProps {
  aspectRatio: string;
  onAspectRatioChange: (value: string) => void;
  aspectRatios: readonly string[];
  isOpenAI: boolean;
}

function AspectRatioShape({ ratio }: { ratio: string }) {
  const shapes: Record<string, string> = {
    '1:1': 'w-[14px] h-[14px]',
    '16:9': 'w-[22px] h-[12px]',
    '9:16': 'w-[12px] h-[22px]',
    '4:3': 'w-[20px] h-[15px]',
    '3:4': 'w-[15px] h-[20px]',
    'auto': 'w-[22px] h-[12px]',
  };

  const isAuto = ratio === 'auto';

  return (
    <div className="flex w-[22px] items-center justify-center">
      <div
        className={cn(
          'rounded-[2px] border border-foreground/40 bg-transparent',
          shapes[ratio] ?? 'w-[14px] h-[14px]',
          isAuto && 'border-dashed'
        )}
      />
    </div>
  );
}

export function AspectRatioPicker({
  aspectRatio,
  onAspectRatioChange,
  aspectRatios,
  isOpenAI,
}: AspectRatioPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <span className="flex items-center gap-2">
            <AspectRatioShape ratio={aspectRatio} />
            <span className="hidden sm:inline">{aspectRatio === 'auto' ? 'AR Auto' : `AR ${aspectRatio}`}</span>
            <span className="sm:hidden">AR</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52 bg-zinc-900 text-zinc-100 border-zinc-800">
        {aspectRatios.map((ratio) => (
          <DropdownMenuItem
            key={ratio}
            onSelect={() => onAspectRatioChange(ratio)}
            className={cn(
              'flex items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-sm cursor-pointer',
              'hover:bg-zinc-800 focus:bg-zinc-800 focus:text-zinc-100',
              aspectRatio === ratio && 'bg-zinc-800/50'
            )}
          >
            <div className="flex items-center gap-3">
              <AspectRatioShape ratio={ratio} />
              <span>
                {ratio === '4:3' && isOpenAI
                  ? '4:3 (1536x1024)'
                  : ratio === '3:4' && isOpenAI
                    ? '3:4 (1024x1536)'
                    : ratio === 'auto'
                      ? 'Auto'
                      : ratio}
              </span>
            </div>
            {aspectRatio === ratio && (
              <Check className="h-4 w-4 text-zinc-100" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
