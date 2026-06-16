'use client';

import { FileVideo, Image as ImageIcon, Music } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { getVideoImageReferenceLimit } from '../../utils/video-reference-limits';

export type VideoReferencePickerTarget = 'image' | 'video' | 'audio' | 'extendVideo';

interface VideoReferenceControlsProps {
  mode?: 'image' | 'video' | 'sound';
  provider?: string;
  imageReferenceCount: number;
  videoReferenceCount: number;
  audioReferenceCount: number;
  hasExtendSource: boolean;
  onPick: (target: VideoReferencePickerTarget) => void;
}

function CountBadge({ value, max }: { value: number; max: number }) {
  return <span className="ml-auto text-xs text-muted-foreground">{value}/{max}</span>;
}

export function VideoReferenceControls({
  mode,
  provider,
  imageReferenceCount,
  videoReferenceCount,
  audioReferenceCount,
  hasExtendSource,
  onPick,
}: VideoReferenceControlsProps) {
  const t = useTranslations('studio.promptBar');
  if (mode !== 'video') return null;

  const imageReferenceLimit = getVideoImageReferenceLimit(provider);

  if (provider === 'bytedance') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => onPick('image')}>
          <ImageIcon className="h-4 w-4" />
          {t('imageReferences')}
          <CountBadge value={imageReferenceCount} max={imageReferenceLimit} />
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => onPick('video')}>
          <FileVideo className="h-4 w-4" />
          {t('videoReferences')}
          <CountBadge value={videoReferenceCount} max={3} />
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => onPick('audio')}>
          <Music className="h-4 w-4" />
          {t('audioReferences')}
          <CountBadge value={audioReferenceCount} max={3} />
        </Button>
      </div>
    );
  }

  if (provider === 'veo') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => onPick('image')}>
          <ImageIcon className="h-4 w-4" />
          {t('imageReferences')}
          <CountBadge value={imageReferenceCount} max={imageReferenceLimit} />
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => onPick('extendVideo')}>
          <FileVideo className="h-4 w-4" />
          {t('extendSource')}
          <CountBadge value={hasExtendSource ? 1 : 0} max={1} />
        </Button>
      </div>
    );
  }

  return null;
}
