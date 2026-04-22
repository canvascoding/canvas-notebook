'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
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
    auto: 'w-[22px] h-[12px]',
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

const ratioTipKeys: Record<string, string> = {
  '1:1': 'square',
  '16:9': 'widescreen',
  '9:16': 'portraitVideo',
  '4:3': 'standardLandscape',
  '3:4': 'standardPortrait',
  auto: 'adapt',
};

export function AspectRatioPicker({
  aspectRatio,
  onAspectRatioChange,
  aspectRatios,
  isOpenAI,
}: AspectRatioPickerProps) {
  const t = useTranslations('studio.aspectRatio');

  return (
    <TooltipProvider delayDuration={0}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="rounded-full">
            <span className="flex items-center gap-2">
              <AspectRatioShape ratio={aspectRatio} />
              <span className="hidden sm:inline">
                {aspectRatio === 'auto' ? `AR ${t('auto')}` : `AR ${aspectRatio}`}
              </span>
              <span className="sm:hidden">AR</span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {aspectRatios.map((ratio) => {
            const tipKey = ratioTipKeys[ratio];
            const label =
              ratio === '4:3' && isOpenAI
                ? `4:3 (1536×1024)`
                : ratio === '3:4' && isOpenAI
                  ? `3:4 (1024×1536)`
                  : ratio === 'auto'
                    ? t('auto')
                    : ratio;

            return (
              <Tooltip key={ratio}>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onSelect={() => onAspectRatioChange(ratio)}
                    className={cn(
                      'flex items-center justify-between gap-3 cursor-pointer',
                      aspectRatio === ratio && 'bg-accent/50'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <AspectRatioShape ratio={ratio} />
                      <span>{label}</span>
                    </div>
                    {aspectRatio === ratio && (
                      <Check className="h-4 w-4 shrink-0" />
                    )}
                  </DropdownMenuItem>
                </TooltipTrigger>
                {tipKey && (
                  <TooltipContent side="right" className="max-w-[200px] text-xs">
                    <p>{t(`tips.${tipKey}`)}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}
