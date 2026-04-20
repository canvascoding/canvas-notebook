'use client';

import { UploadCloud, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FrameUploadProps {
  startFrame: File | null;
  endFrame: File | null;
  onStartFrameChange: (file: File | null) => void;
  onEndFrameChange: (file: File | null) => void;
}

function FrameSlot({
  label,
  file,
  inputId,
  onChange,
}: {
  label: string;
  file: File | null;
  inputId: string;
  onChange: (file: File | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
      <label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <UploadCloud className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
          <div className="truncate text-sm font-medium text-foreground">
            {file ? file.name : 'Choose frame image'}
          </div>
        </div>
      </label>
      {file ? (
        <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" onClick={() => onChange(null)}>
          <X className="h-4 w-4" />
        </Button>
      ) : null}
      <input
        id={inputId}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
    </div>
  );
}

export function FrameUpload({
  startFrame,
  endFrame,
  onStartFrameChange,
  onEndFrameChange,
}: FrameUploadProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <FrameSlot label="Start frame" file={startFrame} inputId="studio-start-frame" onChange={onStartFrameChange} />
      <FrameSlot label="End frame" file={endFrame} inputId="studio-end-frame" onChange={onEndFrameChange} />
    </div>
  );
}
