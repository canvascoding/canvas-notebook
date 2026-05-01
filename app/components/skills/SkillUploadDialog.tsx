'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Upload, X, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ValidationResult } from '@/app/lib/skills/skill-manifest-anthropic';

interface SkillUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export function SkillUploadDialog({ open, onOpenChange, onUploaded }: SkillUploadDialogProps) {
  const t = useTranslations('skills.upload');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');

  const reset = useCallback(() => {
    setContent('');
    setFileName('');
    setValidationResult(null);
    setIsUploading(false);
    setUploadError('');
    setUploadSuccess('');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    setUploadError('');
    setUploadSuccess('');
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setContent(text);
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const validate = useCallback(async () => {
    if (!content.trim()) return;
    setUploadError('');
    setIsUploading(true);
    try {
      const res = await fetch('/api/skills/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      setValidationResult(data.validation);
    } catch {
      setUploadError('Validation request failed');
    } finally {
      setIsUploading(false);
    }
  }, [content]);

  const upload = useCallback(async () => {
    if (!content.trim()) return;
    setIsUploading(true);
    setUploadError('');
    try {
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (data.success) {
        setUploadSuccess(t('success', { name: data.name }));
        onUploaded();
      } else {
        setUploadError(data.error || 'Upload failed');
        if (data.validation) {
          setValidationResult(data.validation);
        }
      }
    } catch {
      setUploadError('Upload request failed');
    } finally {
      setIsUploading(false);
    }
  }, [content, t, onUploaded]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {t('title')}
          </h2>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-muted-foreground">{t('description')}</p>

          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              isDragging ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 hover:border-primary/50'
            }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-3">
              {fileName ? fileName : t('dropzone')}
            </p>
            <label>
              <input
                type="file"
                accept=".md,.txt"
                onChange={handleFileInput}
                className="hidden"
              />
              <Button variant="outline" size="sm" asChild>
                <span>{t('fileLabel')}</span>
              </Button>
            </label>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t('pasteLabel')}</label>
            <textarea
              className="w-full min-h-[200px] rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setValidationResult(null);
                setUploadError('');
                setUploadSuccess('');
              }}
              placeholder={`---\nname: my-skill\ndescription: What this skill does and when to use it\n---\n\n# My Skill\n\nInstructions here...`}
            />
          </div>

          {validationResult && !validationResult.valid && validationResult.errors.length > 0 && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive mb-1">
                <AlertCircle className="h-4 w-4" />
                {t('validationErrors')}
              </div>
              <ul className="text-sm text-destructive/80 list-disc list-inside">
                {validationResult.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {validationResult && validationResult.valid && (
            <div className="rounded-md bg-green-500/10 border border-green-500/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Validation passed
              </div>
            </div>
          )}

          {uploadError && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
              {uploadError}
            </div>
          )}

          {uploadSuccess && (
            <div className="rounded-md bg-green-500/10 border border-green-500/30 p-3 text-sm text-green-600">
              {uploadSuccess}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={validate}
              disabled={!content.trim() || isUploading}
            >
              {isUploading ? t('validating') : 'Validate'}
            </Button>
            <Button
              onClick={upload}
              disabled={!content.trim() || isUploading}
            >
              {isUploading ? t('uploading') : t('button')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}