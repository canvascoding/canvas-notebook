'use client';

import { useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Upload, X, CheckCircle2, AlertCircle, FileText, Info, Archive, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ValidationResult } from '@/app/lib/skills/canvas-skill-manifest';

interface SkillUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export function SkillUploadDialog({ open, onOpenChange, onUploaded }: SkillUploadDialogProps) {
  const t = useTranslations('skills.upload');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setContent('');
    setFileName('');
    setPackageFile(null);
    setFolderFiles([]);
    setValidationResult(null);
    setIsUploading(false);
    setUploadError('');
    setUploadSuccess('');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  const setFolderInputNode = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (node) {
      node.setAttribute('webkitdirectory', '');
      node.setAttribute('directory', '');
    }
  }, []);

  const clearUploadState = useCallback(() => {
    setUploadError('');
    setUploadSuccess('');
    setValidationResult(null);
  }, []);

  const isArchiveFile = useCallback((file: File) => {
    const lowerName = file.name.toLowerCase();
    return lowerName.endsWith('.zip') || lowerName.endsWith('.skill');
  }, []);

  const getRelativePath = useCallback((file: File) => {
    return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  }, []);

  const getFolderName = useCallback((files: File[]) => {
    const firstPath = files[0] ? getRelativePath(files[0]) : '';
    return firstPath.split('/').filter(Boolean)[0] || t('selectedFolder');
  }, [getRelativePath, t]);

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    clearUploadState();
    setFolderFiles([]);

    if (isArchiveFile(file)) {
      setContent('');
      setPackageFile(file);
      return;
    }

    setPackageFile(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setContent(text);
    };
    reader.readAsText(file);
  }, [clearUploadState, isArchiveFile]);

  const handleFolderFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    clearUploadState();
    setContent('');
    setPackageFile(null);
    setFolderFiles(files);
    setFileName(t('folderSummary', { name: getFolderName(files), count: files.length }));
  }, [clearUploadState, getFolderName, t]);

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

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
    e.target.value = '';
  }, [handleFile]);

  const handleFolderInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    handleFolderFiles(files);
    e.target.value = '';
  }, [handleFolderFiles]);

  const _validate = useCallback(async () => {
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
    if (!content.trim() && !packageFile && folderFiles.length === 0) return;
    setIsUploading(true);
    setUploadError('');
    try {
      let res: Response;
      if (packageFile) {
        const formData = new FormData();
        formData.set('mode', 'archive');
        formData.set('file', packageFile, packageFile.name);
        res = await fetch('/api/skills/upload', {
          method: 'POST',
          body: formData,
        });
      } else if (folderFiles.length > 0) {
        const formData = new FormData();
        formData.set('mode', 'folder');
        formData.set('sourceName', getFolderName(folderFiles));
        formData.set('paths', JSON.stringify(folderFiles.map(getRelativePath)));
        folderFiles.forEach((file) => {
          formData.append('files', file, file.name);
        });
        res = await fetch('/api/skills/upload', {
          method: 'POST',
          body: formData,
        });
      } else {
        res = await fetch('/api/skills/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      }
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
  }, [content, folderFiles, getFolderName, getRelativePath, onUploaded, packageFile, t]);

  const canUpload = Boolean(content.trim() || packageFile || folderFiles.length > 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-lg max-w-xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <Button variant="ghost" size="icon" onClick={handleClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-5 space-y-5">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
              isDragging ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 hover:border-primary/50'
            }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t('dropzone')}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.skill,.zip"
              onChange={handleFileInput}
              className="hidden"
            />
            <input
              ref={setFolderInputNode}
              type="file"
              multiple
              onChange={handleFolderInput}
              className="hidden"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Archive className="mr-2 h-4 w-4" />
              {t('chooseArchive')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => folderInputRef.current?.click()}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('chooseFolder')}
            </Button>
          </div>

          <div className="rounded-md bg-muted/50 border border-border p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-xs font-medium text-foreground">{t('requirementsTitle')}</p>
            </div>
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1 ml-6">
              <li>{t('requirement1')}</li>
              <li>{t('requirement2')}</li>
            </ul>
            <a
              href="https://agentskills.io/skill-creation/quickstart"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline ml-6"
            >
              {t('readMore')}
            </a>
          </div>

          {fileName && (
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{fileName}</span>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1.5 block">{t('pasteLabel')}</label>
            <textarea
              className="w-full min-h-[180px] rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary resize-y"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setPackageFile(null);
                setFolderFiles([]);
                setFileName('');
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

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={upload}
              disabled={!canUpload || isUploading}
            >
              {isUploading ? t('uploading') : t('button')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
