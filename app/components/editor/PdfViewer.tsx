'use client';

import { toMediaUrl } from '@/app/lib/utils/media-url';

interface PdfViewerProps {
  path: string;
}

export function PdfViewer({ path }: PdfViewerProps) {
  const src = toMediaUrl(path);

  return (
    <iframe
      title={path}
      src={src}
      className="h-full w-full bg-slate-900"
    />
  );
}
