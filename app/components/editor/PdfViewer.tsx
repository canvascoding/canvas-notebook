'use client';

import { useIsMobile } from '@/hooks/use-mobile';
import { toMediaUrl } from '@/app/lib/utils/media-url';

interface PdfViewerProps {
  path: string;
}

export function PdfViewer({ path }: PdfViewerProps) {
  const src = toMediaUrl(path);
  const isMobile = useIsMobile();

  return (
    <div className="h-full w-full overflow-auto bg-background">
      <iframe
        title={path}
        src={src}
        className="h-full w-full border-0"
        style={{
          maxWidth: '100%',
          ...(isMobile ? { minWidth: '100%' } : {}),
        }}
      />
    </div>
  );
}
