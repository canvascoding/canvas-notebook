'use client';

import { useTranslations } from 'next-intl';
import { useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Upload, Link as LinkIcon, X, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PendingImage {
  id: string;
  file: File;
  preview: string;
}

interface ImageUploadAreaProps {
  maxImages?: number;
  onFilesSelected: (files: File[]) => void;
  pendingImages: PendingImage[];
  onRemoveImage: (id: string) => void;
  onReorderImages: (fromIndex: number, toIndex: number) => void;
}

export function ImageUploadArea({
  maxImages = 10,
  onFilesSelected,
  pendingImages,
  onRemoveImage,
  onReorderImages,
}: ImageUploadAreaProps) {
  const t = useTranslations('studio');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length > 0) {
      onFilesSelected(files);
    }
  }, [onFilesSelected]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      onFilesSelected(files);
    }
    e.target.value = '';
  }, [onFilesSelected]);

  const handleDragStart = (index: number) => setDragIndex(index);

  const handleDragOverItem = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    onReorderImages(dragIndex, index);
    setDragIndex(index);
  };

  const handleDragEnd = () => setDragIndex(null);

  return (
    <div className="flex flex-col gap-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors',
          isDragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
        )}
      >
        <Upload className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('modelCreate.dropzone')}</p>
        <p className="text-xs text-muted-foreground">{t('modelCreate.maxImages', { max: maxImages })}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />
      </div>

      {pendingImages.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {pendingImages.map((img, index) => (
            <div
              key={img.id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOverItem(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'group relative aspect-square cursor-grab overflow-hidden rounded-md border border-border',
                dragIndex === index && 'opacity-50',
              )}
            >
              <img src={img.preview} alt="" className="h-full w-full object-cover" />
              <button
                onClick={(e) => { e.stopPropagation(); onRemoveImage(img.id); }}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-1 left-1 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <GripVertical className="h-3 w-3" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}