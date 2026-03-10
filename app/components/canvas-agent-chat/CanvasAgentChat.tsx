'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Paperclip,
  X,
  Image as ImageIcon,
  History,
  Plus,
  ChevronLeft,
  ArrowDown,
  Trash2,
  Pencil,
  Sparkles,
  Wrench,
  File as FileIcon,
} from 'lucide-react';

interface Attachment {
  name: string;
  path: string;
  type: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  type?: 'tool_use' | 'tool_result' | 'system';
  status?: 'pending' | 'sending' | 'sent' | 'error';
  attachments?: Attachment[];
  piMessage?: AgentMessage;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
}

interface AISession {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
}

interface ChatEvent {
  type: string;
  message?: AgentMessage;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: {
    content?: unknown[];
  };
  error?: string;
  messages?: AgentMessage[];
}

type PersistedChatMessage = AgentMessage & {
  id?: number | string;
};
type UserPiMessage = Extract<AgentMessage, { role: 'user' }>;
type UserPiContent = UserPiMessage['content'];

type QueuedMessage = {
  id: string;
  text: string;
  attachments: Attachment[];
};

type UpdateFunction = (content: string, type?: ChatMessage['type'], status?: ChatMessage['status']) => void;

interface CanvasAgentChatProps {
  onClose?: () => void;
  initialPrompt?: string | null;
  initialPromptStorageKey?: string;
}

const DEFAULT_MODEL_ID = 'pi';
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextPart(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isThinkingPart(value: unknown): value is { type: 'thinking'; thinking: string } {
  return isRecord(value) && value.type === 'thinking' && typeof value.thinking === 'string';
}

function isImagePart(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  return isRecord(value) && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string';
}

function buildPromptContent(text: string, attachments: Attachment[]): UserPiContent {
  if (attachments.length === 0) {
    return text;
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const attachment of attachments) {
    content.push({
      type: 'image',
      data: attachment.path,
      mimeType: attachment.type,
    });
  }

  return content;
}

function normalizeMessageStart(text: string): string {
  return text.replace(/^\s+/, '');
}

function extractPiMessageText(piMessage?: AgentMessage | null): string {
  if (!piMessage || !Array.isArray(piMessage.content)) {
    return typeof piMessage?.content === 'string' ? piMessage.content : '';
  }

  const textContent = piMessage.content
    .map((part) => {
      if (isTextPart(part)) return part.text;
      if (isThinkingPart(part)) return part.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  if (textContent) {
    return normalizeMessageStart(textContent);
  }

  if (piMessage.role === 'assistant' && piMessage.stopReason === 'error' && piMessage.errorMessage) {
    return `[Error] ${piMessage.errorMessage}`;
  }

  return '';
}

function toPiMessage(message: ChatMessage, fallbackModel: string) {
  if (message.role === 'system') {
    return null;
  }

  if (message.piMessage) {
    return message.piMessage;
  }

  if (message.role === 'user') {
    return {
      role: 'user',
      content: buildPromptContent(message.content, message.attachments || []),
      timestamp: Date.now(),
    };
  }

  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      api: 'legacy',
      provider: 'legacy',
      model: fallbackModel,
      usage: EMPTY_USAGE,
      stopReason: message.status === 'error' ? 'error' : 'stop',
      errorMessage: message.status === 'error' ? message.content : undefined,
      timestamp: Date.now(),
    };
  }

  if (message.role === 'toolResult') {
    return {
      role: 'toolResult',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
      timestamp: Date.now(),
    } as AgentMessage;
  }

  return null;
}

function extractToolResultText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return normalizeMessageStart(
    content
      .map((part) => (isTextPart(part) ? part.text : ''))
      .filter(Boolean)
      .join('\n'),
  );
}

function extractImageAttachments(content: AgentMessage['content']): Attachment[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const attachments = content.reduce<Attachment[]>((result, part, index) => {
    if (isImagePart(part)) {
      result.push({
        name: `attachment-${index + 1}`,
        path: part.data,
        type: part.mimeType,
      });
    }
    return result;
  }, []);

  return attachments.length > 0 ? attachments : undefined;
}

function formatSessionId(value: string | null): string {
  if (!value) {
    return 'new chat';
  }

  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatToolArgs(args: unknown): string {
  if (args === undefined) {
    return '';
  }

  if (typeof args === 'string') {
    return args;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function MarkdownMessage({ content, variant }: { content: string; variant: 'user' | 'assistant' | 'tool' }) {
  const sharedClasses =
    'break-words text-sm leading-relaxed [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold';
  const toneClasses =
    variant === 'user'
      ? '[&_blockquote]:border-primary-foreground/40 [&_pre]:border-primary-foreground/20 [&_pre]:bg-primary-foreground/10 [&_code]:bg-primary-foreground/15 [&_th]:border-primary-foreground/20 [&_td]:border-primary-foreground/20'
      : '[&_blockquote]:border-border/80 [&_pre]:border-border [&_pre]:bg-background/80 [&_code]:bg-background/80 [&_th]:border-border [&_td]:border-border';

  return (
    <div className={`${sharedClasses} ${toneClasses}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function CanvasAgentChat({ onClose, initialPrompt, initialPromptStorageKey }: CanvasAgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<AISession[]>([]);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);

  // @-mention file picker state
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerFiles, setFilePickerFiles] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; isImage: boolean }>>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const filePickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursorPosition, setCursorPosition] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialPromptConsumedRef = useRef(false);
  const toolMessageIdsRef = useRef<Record<string, string>>({});

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 100;
    setIsAtBottom(atBottom);
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  useEffect(() => {
    if (messages.length === 0) return;
    const lastMessage = messages[messages.length - 1];
    if (isAtBottom || lastMessage.role === 'user') {
      scrollToBottom(lastMessage.role === 'user' ? 'smooth' : 'auto');
    }
  }, [messages, isAtBottom]);

  const updateAssistantMessage = useCallback((id: string, content: string, type?: ChatMessage['type'], status?: ChatMessage['status']) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? { ...message, content: message.content ? content : normalizeMessageStart(content), type: type || message.type, status: status || message.status }
          : message,
      ),
    );
  }, []);

  const syncPiMessage = useCallback((id: string, piMessage: AgentMessage) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== id) return message;

        const nextContent = extractPiMessageText(piMessage);
        const isAssistantError = piMessage.role === 'assistant' && piMessage.stopReason === 'error';

        return {
          ...message,
          content: nextContent || message.content,
          status: isAssistantError ? 'error' : message.status,
          type: isAssistantError ? 'system' : message.type,
          piMessage,
        };
      }),
    );
  }, []);

  const upsertToolMessage = useCallback((params: {
    assistantMessageId?: string;
    content?: string;
    status?: ChatMessage['status'];
    toolCallId?: string;
    toolName?: string;
    toolArgs?: string;
    piMessage?: AgentMessage;
    type?: ChatMessage['type'];
  }) => {
    const { assistantMessageId, toolCallId, toolName, toolArgs, content, status, piMessage, type } = params;
    const knownMessageId = toolCallId ? toolMessageIdsRef.current[toolCallId] : undefined;
    const messageId = knownMessageId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (toolCallId && !knownMessageId) {
      toolMessageIdsRef.current[toolCallId] = messageId;
    }

    setMessages((prev) => {
      const index = prev.findIndex((message) => message.id === messageId);
      const assistantIndex = assistantMessageId ? prev.findIndex((message) => message.id === assistantMessageId) : -1;
      const nextMessage: ChatMessage = {
        id: messageId,
        role: 'toolResult',
        content: content || '',
        status: status || 'sent',
        toolCallId,
        toolName,
        toolArgs,
        piMessage,
        type: type || 'tool_result',
      };

      if (index === -1) {
        if (assistantIndex === -1) {
          return [...prev, nextMessage];
        }

        const nextMessages = [...prev];
        nextMessages.splice(assistantIndex, 0, nextMessage);
        return nextMessages;
      }

      const mergedMessage: ChatMessage = {
        ...prev[index],
        ...nextMessage,
        content: content ?? prev[index].content,
        toolArgs: toolArgs ?? prev[index].toolArgs,
        toolName: toolName ?? prev[index].toolName,
        piMessage: piMessage ?? prev[index].piMessage,
        type: type || prev[index].type,
      };

      if (assistantIndex !== -1 && index > assistantIndex) {
        const nextMessages = [...prev];
        nextMessages.splice(index, 1);
        const nextAssistantIndex = nextMessages.findIndex((message) => message.id === assistantMessageId);
        nextMessages.splice(nextAssistantIndex, 0, mergedMessage);
        return nextMessages;
      }

      const nextMessages = [...prev];
      nextMessages[index] = mergedMessage;
      return nextMessages;
    });
  }, []);

  const handleEvent = useCallback((event: ChatEvent, msgId: string, updateFn: UpdateFunction) => {
    if (event.message?.role === 'assistant') {
      syncPiMessage(msgId, event.message);
    }

    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent?.type === 'text_delta' || event.assistantMessageEvent?.type === 'thinking_delta') {
          updateFn(event.assistantMessageEvent.delta || '', undefined, 'sending');
        }
        break;
      case 'tool_execution_start':
        upsertToolMessage({
          assistantMessageId: msgId,
          toolCallId: event.toolCallId,
          toolName: event.toolName || 'Tool',
          toolArgs: formatToolArgs(event.args),
          status: 'sending',
          type: 'tool_use',
        });
        break;
      case 'tool_execution_end': {
        const text = extractToolResultText(event.result?.content);
        upsertToolMessage({
          assistantMessageId: msgId,
          toolCallId: event.toolCallId,
          toolName: event.toolName || 'Tool',
          content: text,
          status: 'sent',
          type: 'tool_result',
          piMessage: {
            role: 'toolResult',
            content: text ? [{ type: 'text', text }] : [],
            timestamp: Date.now(),
          } as AgentMessage,
        });
        break;
      }
      case 'error':
        updateFn(`[Error] ${event.error || 'Unknown error'}`, 'system', 'error');
        break;
      default:
        break;
    }
  }, [syncPiMessage, upsertToolMessage]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (data.success) {
        setHistory(data.sessions || []);
      }
    } catch (err) {
      console.error('Failed to fetch history', err);
    }
  }, []);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
    setActiveModel(DEFAULT_MODEL_ID);
    toolMessageIdsRef.current = {};
  }, []);

  const loadSession = useCallback(async (session: AISession) => {
    setSessionId(session.sessionId);
    setActiveModel(session.model || DEFAULT_MODEL_ID);
    setMessages([{ id: 'system', role: 'system', content: 'Loading...' }]);
    setShowHistory(false);
    toolMessageIdsRef.current = {};

    try {
      const res = await fetch(`/api/sessions/messages?sessionId=${encodeURIComponent(session.sessionId)}`);
      const data = await res.json();
      if (data.success && data.messages) {
        setMessages(
          data.messages.map((rawMessage: PersistedChatMessage) => {
            const isToolResult = rawMessage.role === 'toolResult';
            const content = isToolResult
              ? extractToolResultText(Array.isArray(rawMessage.content) ? rawMessage.content : undefined) || extractPiMessageText(rawMessage)
              : extractPiMessageText(rawMessage);

            return {
              id: rawMessage.id?.toString() || Math.random().toString(),
              role: rawMessage.role,
              content,
              status: 'sent',
              type: isToolResult ? 'tool_result' : undefined,
              attachments: extractImageAttachments(rawMessage.content),
              piMessage: rawMessage,
            };
          }),
        );
      }
    } catch (err) {
      console.error('Failed to load messages', err);
      setMessages([{ id: 'error', role: 'system', content: 'Failed to load message history.' }]);
    }
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
      const res = await fetch(`/api/sessions?sessionId=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.filter((session) => session.sessionId !== id));
        if (sessionId === id) {
          startNewChat();
        }
      }
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  }, [sessionId, startNewChat]);

  const renameSession = useCallback(async (session: AISession) => {
    const nextTitle = prompt('Rename session', session.title || '');
    if (!nextTitle || !nextTitle.trim()) {
      return;
    }

    try {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          title: nextTitle.trim(),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setHistory((prev) =>
          prev.map((item) =>
            item.sessionId === session.sessionId
              ? { ...item, title: nextTitle.trim() }
              : item,
          ),
        );
      }
    } catch (err) {
      console.error('Failed to rename session', err);
    }
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
    setInput(value);
    setCursorPosition(cursorPos);

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
  const handleFileSelect = useCallback((file: { name: string; path: string }) => {
    const lastAtIndex = input.lastIndexOf('@', cursorPosition);
    if (lastAtIndex !== -1) {
      const before = input.slice(0, lastAtIndex);
      const after = input.slice(cursorPosition);
      // Wrap path in quotes for clarity, with space after
      const newValue = `${before}"${file.path}" ${after}`;
      setInput(newValue);
      setShowFilePicker(false);
      setFilePickerQuery('');
      
      // Focus back to textarea after selection
      setTimeout(() => {
        textareaRef.current?.focus();
        const newCursorPos = before.length + file.path.length + 3; // +2 for quotes, +1 for space
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }
  }, [input, cursorPosition]);



  // Scan text for image references and auto-attach them
  // Supports both quoted paths: "path/to/image.jpg" and unquoted paths: path/to/image.jpg
  const scanForImageReferences = useCallback(async (text: string): Promise<Attachment[]> => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
    const escapedExtensions = imageExtensions.map(ext => ext.replace(/\./g, '\\.'));
    
    // Pattern 1: Quoted paths: "path/to/file.jpg"
    const quotedPattern = `"([^"]*(?:${escapedExtensions.join('|')}))"`;
    // Pattern 2: Unquoted paths (word boundaries)
    const unquotedPattern = `\\b([\\w\\-./]+(?:${escapedExtensions.join('|')}))\\b`;
    
    const foundAttachments: Attachment[] = [];
    const processedPaths = new Set<string>();
    
    // Try quoted pattern first
    const quotedRegex = new RegExp(quotedPattern, 'gi');
    let match;
    while ((match = quotedRegex.exec(text)) !== null) {
      const path = match[1];
      if (processedPaths.has(path)) continue;
      processedPaths.add(path);
      
      // Skip if already attached
      if (attachments.some(att => att.path === path)) continue;
      
      // Check if file exists
      try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || 'application/octet-stream';
          const isImage = contentType.startsWith('image/');
          if (isImage) {
            foundAttachments.push({
              name: path.split('/').pop() || path,
              path: path,
              type: contentType,
            });
          }
        }
      } catch {
        // File doesn't exist or can't be read, skip
      }
    }
    
    // Try unquoted pattern
    const unquotedRegex = new RegExp(unquotedPattern, 'gi');
    while ((match = unquotedRegex.exec(text)) !== null) {
      const path = match[1];
      if (processedPaths.has(path)) continue;
      processedPaths.add(path);
      
      // Skip if already attached
      if (attachments.some(att => att.path === path)) continue;
      
      // Check if file exists
      try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || 'application/octet-stream';
          const isImage = contentType.startsWith('image/');
          if (isImage) {
            foundAttachments.push({
              name: path.split('/').pop() || path,
              path: path,
              type: contentType,
            });
          }
        }
      } catch {
        // File doesn't exist or can't be read, skip
      }
    }
    
    return foundAttachments;
  }, [attachments]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const queueMessage = useCallback((text: string, messageAttachments: Attachment[]) => {
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const piMessage: UserPiMessage = {
      role: 'user',
      content: buildPromptContent(text, messageAttachments),
      timestamp: Date.now(),
    };

    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        role: 'user',
        content: text,
        status: 'pending',
        attachments: messageAttachments,
        piMessage,
      },
    ]);

    setQueue((prev) => [...prev, { id: messageId, text, attachments: messageAttachments }]);
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachments.length === 0) return;
    const text = input.trim();
    
    // Auto-scan for image references in the text
    const autoAttachments = await scanForImageReferences(text);
    const allAttachments = [...attachments, ...autoAttachments];
    
    // Update attachments state with found images
    if (autoAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...autoAttachments]);
    }
    
    const currentAttachments = [...allAttachments];
    setInput('');
    setAttachments([]);
    queueMessage(text, currentAttachments);
  }, [input, attachments, queueMessage, scanForImageReferences]);

  // Handle keyboard navigation in file picker and textarea
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle file picker navigation when it's open
    if (showFilePicker && filePickerFiles.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedFileIndex((prev) => 
            prev < filePickerFiles.length - 1 ? prev + 1 : prev
          );
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedFileIndex((prev) => (prev > 0 ? prev - 1 : 0));
          return;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          if (filePickerFiles[selectedFileIndex]) {
            handleFileSelect(filePickerFiles[selectedFileIndex]);
          }
          return;
        case 'Escape':
          setShowFilePicker(false);
          return;
      }
    }

    // Handle Enter key to send message (only when picker is not open)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [showFilePicker, filePickerFiles, selectedFileIndex, handleFileSelect, handleSend]);

  useEffect(() => {
    if (initialPromptConsumedRef.current) return;
    const candidatePrompt = (initialPrompt || '').trim();
    if (candidatePrompt) {
      initialPromptConsumedRef.current = true;
      queueMessage(candidatePrompt, []);
      return;
    }
    if (!initialPromptStorageKey || typeof window === 'undefined') return;
    const storedPrompt = window.sessionStorage.getItem(initialPromptStorageKey);
    if (storedPrompt?.trim()) {
      initialPromptConsumedRef.current = true;
      window.sessionStorage.removeItem(initialPromptStorageKey);
      queueMessage(storedPrompt.trim(), []);
    }
  }, [initialPrompt, initialPromptStorageKey, queueMessage]);

  const processMessage = useCallback(async ({ id, text, attachments: currentAttachments }: QueuedMessage) => {
    setIsProcessing(true);
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, status: 'sending' } : message)));

    try {
      let effectiveSessionId = sessionId;
      if (!effectiveSessionId) {
        const createSessionResponse = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'New session' }),
        });

        const createSessionPayload = await createSessionResponse.json().catch(() => null);
        if (!createSessionResponse.ok || !createSessionPayload?.success || !createSessionPayload?.session?.sessionId) {
          const createErrorMessage =
            createSessionPayload?.error || `Failed to create session (HTTP ${createSessionResponse.status})`;
          throw new Error(createErrorMessage);
        }

        effectiveSessionId = createSessionPayload.session.sessionId;
        setSessionId(effectiveSessionId);
      }

      const currentUserMessage = messages.find((message) => message.id === id);
      const piMessages: AgentMessage[] = messages
        .filter((message) => message.id !== id && message.role !== 'system')
        .map((message) => toPiMessage(message, activeModel))
        .filter((message): message is AgentMessage => message !== null);

      piMessages.push(
        currentUserMessage?.piMessage || {
          role: 'user',
          content: buildPromptContent(text, currentAttachments),
          timestamp: Date.now(),
        },
      );

      const response = await fetch('/api/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: piMessages, sessionId: effectiveSessionId }),
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const assistantMsgId = `${Date.now()}-assistant`;

      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          status: 'sending',
        },
      ]);

      let fullContent = '';
      let lineBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as ChatEvent;
            handleEvent(event, assistantMsgId, (content, type, status) => {
              fullContent += fullContent ? content : normalizeMessageStart(content);
              updateAssistantMessage(assistantMsgId, fullContent, type, status);
            });
          } catch {
            // Ignore malformed stream lines.
          }
        }
      }

      setMessages((prev) =>
        prev.map((message) => {
          if (message.id === id) {
            return { ...message, status: 'sent' };
          }

          if (message.id === assistantMsgId) {
            return message.status === 'error' ? message : { ...message, status: 'sent' };
          }

          if (message.role === 'toolResult' && message.status === 'sending') {
            return { ...message, status: 'sent' };
          }

          return message;
        }),
      );
      void fetchHistory();
    } catch (error) {
      console.error('Chat error:', error);
      setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, status: 'error' } : message)));
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'system',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          status: 'error',
          type: 'system',
        },
      ]);
    } finally {
      setIsProcessing(false);
    }
  }, [messages, sessionId, handleEvent, updateAssistantMessage, fetchHistory, activeModel]);

  useEffect(() => {
    if (!isProcessing && queue.length > 0) {
      const next = queue[0];
      setQueue((prev) => prev.slice(1));
      processMessage(next);
    }
  }, [isProcessing, queue, processMessage]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-card text-card-foreground">
      <div className="z-10 flex items-center justify-between border-b border-border bg-background/95 p-2">
        <div className="flex min-w-0 items-center gap-2">
          {showHistory ? (
            <button onClick={() => setShowHistory(false)} className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent" title="Back to chat">
              <ChevronLeft />
            </button>
          ) : (
            <button
              onClick={() => {
                setShowHistory(true);
                void fetchHistory();
              }}
              className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"
              title="Open history"
            >
              <History size={20} />
            </button>
          )}
          <div className="min-w-0">
            {showHistory ? (
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">History</span>
            ) : (
              <div
                data-testid="chat-session-id"
                title={sessionId || 'New chat'}
                className="inline-flex min-w-0 items-center gap-2 border border-border bg-muted/70 px-2.5 py-1 text-xs font-semibold text-foreground"
              >
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Session</span>
                <span className="min-w-0 truncate font-mono">{formatSessionId(sessionId)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={startNewChat}
            className="group flex items-center gap-1.5 border border-primary/30 bg-primary/15 p-1.5 text-primary transition-all hover:bg-primary/25"
            title="New Chat"
          >
            <Plus size={18} />
            <span className="hidden text-xs font-bold sm:inline">New</span>
          </button>
          {onClose && (
            <button onClick={onClose} className="border border-transparent p-1.5 text-muted-foreground transition-all hover:border-border hover:bg-accent" title="Close Chat">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1">
        {showHistory && (
          <div className="absolute inset-0 z-20 space-y-1 overflow-y-auto bg-background p-2 pb-20">
            <div className="mb-2 flex items-center gap-2 border-b border-border px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              <History size={10} /> Sessions
            </div>
            {history.length === 0 && <div className="p-8 text-center text-sm italic text-muted-foreground">No recent sessions</div>}
            {history.map((session) => (
              <div key={session.id} className="group mb-1 flex w-full items-center border border-transparent bg-muted/30 p-2 transition-all hover:border-border hover:bg-accent">
                <button onClick={() => void loadSession(session)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-foreground group-hover:text-primary">{session.title || session.sessionId}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                    <span>{new Date(session.createdAt).toLocaleString()}</span>
                    <span>&bull;</span>
                    <span>{session.model}</span>
                  </div>
                </button>
                <button onClick={() => void renameSession(session)} className="ml-2 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-border hover:bg-accent" title="Rename Session">
                  <Pencil size={15} />
                </button>
                <button onClick={() => void deleteSession(session.sessionId)} className="ml-1 shrink-0 border border-transparent p-2 text-muted-foreground transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive" title="Delete Session">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div ref={scrollContainerRef} className="absolute inset-0 space-y-4 overflow-y-auto p-4 pb-24 scroll-smooth">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center space-y-4 text-muted-foreground opacity-40">
              <Sparkles size={48} />
              <div className="text-center">
                <p className="mb-1 text-sm font-bold uppercase tracking-widest">Start a conversation</p>
                <p className="px-8 text-[11px] italic">Markdown replies, tool output, and session history will appear here.</p>
              </div>
            </div>
          )}
          {messages.map((message) => {
            const isUser = message.role === 'user';
            const isAssistant = message.role === 'assistant';
            const isTool = message.role === 'toolResult';

            const bubbleClass = isUser
              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
              : isAssistant
                ? 'border-border bg-muted text-foreground'
                : isTool
                  ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
                  : 'border-destructive/40 bg-destructive/10 text-destructive';

            const title = isUser ? 'You' : isTool ? (message.toolName || 'Tool') : isAssistant ? 'Assistant' : 'System';
            const bodyContent = message.content || (message.status === 'sending' ? (isTool ? 'Running tool...' : 'Thinking...') : '');

            return (
              <div key={message.id} data-testid={`chat-message-${message.role}`} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[95%] border p-3 sm:max-w-[90%] ${bubbleClass}`}>
                  <div className="mb-2 flex items-center gap-2">
                    {isTool ? <Wrench className="h-3.5 w-3.5 opacity-70" /> : null}
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                    {message.status === 'sending' && <span className="h-1.5 w-1.5 animate-pulse bg-current opacity-70" />}
                  </div>

                  {isTool && message.toolArgs ? (
                    <div className="mb-3 rounded-md border border-amber-500/30 bg-background/60 p-2">
                      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Input</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{message.toolArgs}</pre>
                    </div>
                  ) : null}

                  {isUser ? (
                    <MarkdownMessage content={bodyContent} variant="user" />
                  ) : isAssistant || isTool ? (
                    <MarkdownMessage content={bodyContent} variant={isTool ? 'tool' : 'assistant'} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{bodyContent}</div>
                  )}

                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment, index) => (
                        <div key={index} className="flex items-center gap-1.5 border border-border bg-background/50 p-1.5 px-2.5 text-[10px]">
                          <ImageIcon className="h-3 w-3" /> {attachment.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {!isAtBottom && messages.length > 0 && (
          <button onClick={() => scrollToBottom()} className="absolute bottom-28 right-4 z-30 border border-primary/30 bg-primary p-2 text-primary-foreground shadow-sm transition-all hover:bg-primary/90" title="Scroll to bottom">
            <ArrowDown size={20} />
          </button>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 p-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 border border-border bg-muted/60 p-2">
            {attachments.map((attachment, index) => (
              <div key={index} className="flex items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs">
                <ImageIcon className="h-3.5 w-3.5" /> {attachment.name}
                <button onClick={() => removeAttachment(index)} className="hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button onClick={() => fileInputRef.current?.click()} className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent" title="Attach image">
            <Paperclip className="h-5 w-5" />
          </button>
          <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*" />
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              data-testid="chat-input"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask about your project... (Type @ to reference files)"
              className="min-h-[44px] max-h-32 w-full resize-none border border-border bg-background p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
                    onClick={() => handleFileSelect(file)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                      index === selectedFileIndex ? 'bg-accent' : ''
                    }`}
                  >
                    {file.isImage ? (
                      <ImageIcon className="h-4 w-4 text-blue-500" />
                    ) : (
                      <FileIcon className="h-4 w-4 text-gray-500" />
                    )}
                    <span className="flex-1 truncate">{file.path}</span>
                    {index === selectedFileIndex && (
                      <span className="text-xs text-muted-foreground">↵</span>
                    )}
                  </button>
                ))}
                {filePickerFiles.length === 0 && !isLoadingFiles && (
                  <div className="p-3 text-sm text-muted-foreground text-center">
                    {filePickerQuery ? (
                      <>No files found matching &ldquo;{filePickerQuery}&rdquo;</>
                    ) : (
                      <>No files in workspace</>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <button data-testid="chat-send" onClick={handleSend} className="flex-shrink-0 bg-primary p-2.5 text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-30" disabled={!input.trim() && attachments.length === 0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-5 w-5">
              <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {queue.length > 0 && (
          <div className="mt-2 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
            <span className="h-1 w-1 animate-ping bg-primary" />
            {queue.length} in queue
          </div>
        )}
      </div>
    </div>
  );
}
