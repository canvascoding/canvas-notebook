'use client';

interface PublicMarpPreviewProps {
  fileName: string;
  previewUrl: string;
}

export function PublicMarpPreview({ fileName, previewUrl }: PublicMarpPreviewProps) {
  return (
    <div className="h-full min-w-0 overflow-hidden bg-slate-950">
      <iframe
        src={previewUrl}
        sandbox="allow-scripts"
        className="block h-full w-full min-w-0 border-0 bg-slate-950"
        title={`Marp preview: ${fileName}`}
      />
    </div>
  );
}
