'use client';

import { useCallback, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { toMediaUrl } from '@/app/lib/utils/media-url';

interface MediaViewerProps {
  path: string;
  kind: 'audio' | 'video';
  mimeType?: string;
  size?: number;
}

function formatBytes(value?: number) {
  if (!value || !Number.isFinite(value)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatDuration(seconds?: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [
    hrs > 0 ? String(hrs).padStart(2, '0') : null,
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].filter(Boolean);
  return parts.join(':');
}

export function MediaViewer({ path, kind, mimeType, size }: MediaViewerProps) {
  const sourceUrl = toMediaUrl(path);
  const [duration, setDuration] = useState<number | null>(null);
  const sizeLabel = formatBytes(size);
  const durationLabel = formatDuration(duration);

  const handleLoadedMetadata = useCallback(
    (event: SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) => {
      const nextDuration = event.currentTarget.duration;
      if (Number.isFinite(nextDuration)) {
        setDuration(nextDuration);
      }
    },
    []
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2 text-xs text-slate-300">
      <span className="rounded bg-slate-800 px-2 py-0.5 uppercase tracking-wide">
        {kind}
      </span>
      <span>{durationLabel ? `Duration ${durationLabel}` : 'Duration --:--'}</span>
      {sizeLabel && <span>Size {sizeLabel}</span>}
    </div>
  );

  if (kind === 'audio') {
    return (
      <div className="flex h-full flex-col bg-slate-950">
        {toolbar}
        <div className="flex flex-1 items-center justify-center p-6">
          <audio
            controls
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            className="w-full max-w-3xl"
          >
          <source src={sourceUrl} type={mimeType} />
          Your browser does not support the audio element.
        </audio>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full max-h-screen flex-col overflow-hidden bg-slate-950">
      {toolbar}
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
      <video
        controls
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        playsInline
        className="h-full w-full max-h-screen max-w-full bg-black object-contain"
      >
        <source src={sourceUrl} type={mimeType} />
        Your browser does not support the video element.
      </video>
      </div>
    </div>
  );
}
