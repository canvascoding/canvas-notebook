'use client';

import React, { FormEvent, useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MessageSquare, Send, Paperclip, X, Image as ImageIcon, Megaphone, WandSparkles, Clapperboard, BriefcaseBusiness, FileText, FolderTree } from 'lucide-react';
import { getFileIconComponent } from '@/app/lib/files/file-icons';

import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { BUSINESS_STARTER_PROMPTS, type StarterPromptDefinition, type StarterPromptIcon } from '@/app/lib/chat/starter-prompts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Attachment {
  name: string;
  path: string;
  type: string;
}

interface FilePickerFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isImage: boolean;
}

interface RecentSession {
  sessionId: string;
  title: string;
  createdAt: string;
}

const STARTER_PROMPT_ICONS: Record<StarterPromptIcon, React.ComponentType<{ className?: string }>> = {
  campaign: Megaphone,
  creative: WandSparkles,
  video: Clapperboard,
  strategy: BriefcaseBusiness,
  document: FileText,
  organize: FolderTree,
};

function HomeStarterPromptButton({
  prompt,
  onSelect,
}: {
  prompt: StarterPromptDefinition;
  onSelect: (value: string) => void;
}) {
  const Icon = STARTER_PROMPT_ICONS[prompt.icon];

  return (
    <button
      type="button"
      onClick={() => onSelect(prompt.prompt)}
      className="group flex min-w-[280px] flex-col items-start gap-2 border border-border bg-background/80 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent md:min-w-[320px]"
    >
      <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        <Icon className="h-4 w-4 text-primary" />
        Vorlage
      </span>
      <div className="space-y-1">
        <div className="text-sm font-semibold tracking-tight text-foreground">{prompt.title}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{prompt.description}</p>
      </div>
    </button>
  );
}

export function HomeChatPrompt() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  // File picker state for @-mention
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [, setFilePickerQuery] = useState('');
  const [filePickerFiles, setFilePickerFiles] = useState<FilePickerFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [latestSession, setLatestSession] = useState<RecentSession | null>(null);
  const filePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isActive = true;

    const loadLatestSession = async () => {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        if (!isActive) return;

        if (data.success && Array.isArray(data.sessions) && data.sessions.length > 0) {
          const latest = data.sessions[0] as RecentSession;
          setLatestSession({
            sessionId: latest.sessionId,
            title: latest.title || 'Letzte Session',
            createdAt: latest.createdAt,
          });
          return;
        }

        setLatestSession(null);
      } catch (err) {
        console.error('Failed to load latest session', err);
        if (isActive) {
          setLatestSession(null);
        }
      }
    };

    void loadLatestSession();

    return () => {
      isActive = false;
    };
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload/screenshot', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        setAttachments((prev) => [...prev, { name: data.name, path: data.path, type: file.type }]);
      }
    } catch (err) {
      console.error('Upload failed', err);
    }
  }, []);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleFileUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFileUpload]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          handleFileUpload(renamedFile);
        }
      }
    }
  }, [handleFileUpload]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  // Fetch files for @-mention picker
  const fetchFiles = useCallback(async (query: string = '') => {
    setIsLoadingFiles(true);
    try {
      const res = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=50`);
      const data = await res.json();
      if (data.success) {
        setFilePickerFiles(data.files);
        setSelectedFileIndex(0);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  // Handle @-mention in textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setPrompt(value);

    // Check if we should show file picker
    const lastAtIndex = value.lastIndexOf('@', cursorPos);
    if (lastAtIndex !== -1 && cursorPos > lastAtIndex) {
      const textAfterAt = value.slice(lastAtIndex + 1, cursorPos);
      
      // Don't show picker if:
      // 1. There's a space in the query (user is typing after file selection)
      // 2. There's a closing quote followed by space (file was already selected with quotes)
      // 3. There's another @ symbol (user started a new mention)
      const hasSpace = textAfterAt.includes(' ');
      const hasCompletedQuote = textAfterAt.includes('"') && textAfterAt.indexOf('"') < textAfterAt.length - 1;
      const hasAnotherAt = textAfterAt.includes('@');
      
      if (!hasSpace && !hasCompletedQuote && !hasAnotherAt) {
        const query = textAfterAt;
        setFilePickerQuery(query);
        setShowFilePicker(true);
        // Fetch files with query
        void fetchFiles(query);
        return;
      }
    }
    
    setShowFilePicker(false);
  }, [fetchFiles]);

  // Handle file selection from picker
  const handleFileSelect = useCallback((file: FilePickerFile) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    
    const cursorPos = textarea.selectionStart;
    const value = prompt;
    const lastAtIndex = value.lastIndexOf('@', cursorPos);
    
    if (lastAtIndex !== -1) {
      const before = value.slice(0, lastAtIndex);
      const after = value.slice(cursorPos);
      // Wrap path in quotes for clarity, with space after
      const newValue = `${before}"${file.path}" ${after}`;
      setPrompt(newValue);
      setShowFilePicker(false);
      setFilePickerQuery('');
      
      // Focus back to textarea after selection
      setTimeout(() => {
        textarea.focus();
        const newCursorPos = before.length + file.path.length + 3; // +2 for quotes, +1 for space
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }
  }, [prompt]);

  // Handle keyboard navigation in file picker
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle file picker navigation when it's open
    if (showFilePicker && filePickerFiles.length > 0) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedFileIndex((prev) => 
            prev < filePickerFiles.length - 1 ? prev + 1 : prev
          );
          return;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedFileIndex((prev) => (prev > 0 ? prev - 1 : 0));
          return;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          if (filePickerFiles[selectedFileIndex]) {
            handleFileSelect(filePickerFiles[selectedFileIndex]);
          }
          return;
        case 'Escape':
          setShowFilePicker(false);
          return;
      }
    }

    // Send on Enter, allow Shift+Enter for new line
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt && attachments.length === 0) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Store prompt and attachments in sessionStorage
      const data = {
        prompt: normalizedPrompt,
        attachments: attachments,
      };
      window.sessionStorage.setItem(
        CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, 
        JSON.stringify(data)
      );
    } catch (error) {
      console.error('Failed to persist initial Canvas Chat prompt.', error);
    }

    router.push('/chat');
  };

  const applyStarterPrompt = useCallback((value: string) => {
    setPrompt(value);
    textareaRef.current?.focus();
  }, []);

  return (
    <Card className="border border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4" />
            Canvas Chat
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {latestSession ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/chat?session=${encodeURIComponent(latestSession.sessionId)}`}>
                  Letzte Session
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="default" size="sm">
              <Link href="/chat">
                Neuer Chat
              </Link>
            </Button>
          </div>
        </div>
        {latestSession ? (
          <p className="text-xs text-muted-foreground">
            Quicklink zur letzten Session: {latestSession.title}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Produktive Prompt-Vorlagen</p>
            <div className="flex gap-3 overflow-x-auto pb-1 no-scrollbar">
              {BUSINESS_STARTER_PROMPTS.map((starterPrompt) => (
                <HomeStarterPromptButton key={starterPrompt.id} prompt={starterPrompt} onSelect={applyStarterPrompt} />
              ))}
            </div>
          </div>

          {/* Attachment Preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border border-border bg-muted/60 p-2">
              {attachments.map((attachment, index) => (
                <div key={index} className="flex items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs">
                  <ImageIcon className="h-3.5 w-3.5" /> {attachment.name}
                  <button 
                    type="button"
                    onClick={() => removeAttachment(index)} 
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Starte mit einem Business-Use-Case oder passe eine Vorlage an. Enter sendet, @ referenziert Dateien."
              className="min-h-24 w-full resize-y border border-border bg-background p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            
            {/* File Picker Dropdown */}
            {showFilePicker && (
              <div
                ref={filePickerRef}
                className="absolute bottom-full left-0 mb-1 w-full max-h-48 overflow-y-auto border border-border bg-background shadow-lg z-50"
              >
                <div className="p-2 text-xs text-muted-foreground border-b border-border">
                  {isLoadingFiles ? 'Loading files...' : `${filePickerFiles.length} files found`}
                </div>
                {filePickerFiles.map((file, index) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => handleFileSelect(file)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                      index === selectedFileIndex ? 'bg-accent' : ''
                    }`}
                  >
                    {getFileIconComponent({
                      name: file.name,
                      path: file.path,
                      type: file.type,
                    })}
                    <span className="truncate">{file.name}</span>
                    {file.type === 'directory' && (
                      <span className="text-xs text-muted-foreground ml-auto">(dir)</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          
          <div className="flex justify-between items-center">
            {/* Upload Button */}
            <div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="border border-transparent p-2 text-muted-foreground transition-colors hover:border-border hover:bg-accent rounded-md"
                title="Bild anhängen"
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={onFileChange} 
                className="hidden" 
                accept="image/*" 
              />
            </div>

            {/* Submit Button */}
            <Button 
              type="submit" 
              size="sm" 
              className="gap-2" 
              disabled={isSubmitting || (!prompt.trim() && attachments.length === 0)}
            >
              <Send className="h-4 w-4" />
              In Canvas Chat öffnen
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
