'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Paperclip, X, Image as ImageIcon, History, Plus, ChevronLeft, ArrowDown, AlertTriangle, Cpu, Sparkles, Code, Trash2, Globe } from 'lucide-react';
import { AGENT_CATALOG, type AgentId } from '@/app/lib/agents/catalog';

interface Attachment {
  name: string;
  path: string;
  type: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: string; 
  status?: 'pending' | 'sending' | 'sent' | 'error';
  attachments?: Attachment[];
}

interface AISession {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
}

interface ChatEvent {
  type: string;
  message?:
    | string
    | {
        content: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: {
            command: string;
          };
        }>;
      };
  tool_use_result?: {
    stdout?: string;
    stderr?: string;
  };
  result?: string;
  session_id?: string;
  sessionId?: string;
  success?: boolean;
  initialEvent?: ChatEvent;
  content?: string; // Codex support
  thread_id?: string;
  threadId?: string;
}

type UpdateFunction = (content: string, type?: string, status?: ChatMessage['status']) => void;

type AIModel = AgentId;

interface ClaudeChatProps {
  onClose?: () => void;
}

type SessionMessagePayload = {
  id: number | string;
  role: ChatMessage['role'];
  content: string;
  type?: string;
};

export default function ClaudeChat({ onClose }: ClaudeChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [queue, setQueue] = useState<{text: string, attachments: Attachment[]}[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<AISession[]>([]);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [model, setModel] = useState<AIModel>('claude');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const updateAssistantMessage = useCallback((id: string, content: string, type?: string, status?: ChatMessage['status']) => {
    setMessages(prev => prev.map(m => 
      m.id === id ? { ...m, content, type: type || m.type, status: status || m.status } : m
    ));
  }, []);

  const handleEvent = useCallback((event: ChatEvent, msgId: string, updateFn: UpdateFunction) => {
    // Claude & Gemini Format
    if (
      (event.type === 'assistant' || event.type === 'message') &&
      event.message &&
      typeof event.message !== 'string' &&
      event.message.content
    ) {
      for (const part of event.message.content) {
        if (part.type === 'text') {
          updateFn(part.text || '', 'text');
        } else if (part.type === 'tool_use') {
          if (part.name === 'Bash' && part.input) {
            const cmd = part.input.command;
            updateFn('\n```bash\n$ ' + cmd + '\n```\n', 'tool_use');
          } else {
            updateFn('\n[Tool: ' + part.name + ']\n', 'tool_use');
          }
        }
      }
    } 
    // Codex Format or simple text event
    else if (event.type === 'text' && event.content) {
       updateFn(event.content, 'text');
    }
    else if (event.type === 'error' && typeof event.message === 'string') {
       updateFn(`[Error] ${event.message}`, 'system', 'error');
    }
    else if (event.type === 'user' && event.tool_use_result) {
      const result = event.tool_use_result;
      if (result.stdout || result.stderr) {
        const out = result.stdout || result.stderr;
        updateFn('\n```text\n' + out + '\n```\n', 'tool_result');
      } else {
        updateFn('\n[Success]\n', 'tool_result');
      }
    }
    else if (event.type === 'result' && event.result) {
       setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: event.result as string, status: 'sent', type: 'result' } : m));
    }
    
    if (event.session_id) setSessionId(event.session_id);
    if (event.sessionId) setSessionId(event.sessionId);
    if (event.thread_id) setSessionId(event.thread_id);
    if (event.threadId) setSessionId(event.threadId);
  }, []);

  const fetchHistory = useCallback(async (selectedModel: AIModel) => {
    try {
      const res = await fetch(`/api/sessions?model=${selectedModel}`);
      const data = await res.json();
      if (data.success) setHistory(data.sessions);
    } catch (err) {
      console.error('Failed to fetch history', err);
    }
  }, []);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setSessionId(id);
    setMessages([{ id: 'system', role: 'system', content: `Loading ${model} session...` }]);
    setShowHistory(false);

    try {
      const res = await fetch(`/api/sessions/messages?sessionId=${id}&model=${model}`);
      const data = await res.json();
      if (data.success && data.messages) {
        setMessages(data.messages.map((m: SessionMessagePayload) => ({
          id: m.id.toString(),
          role: m.role,
          content: m.content,
          type: m.type,
          status: 'sent'
        })));
      }
    } catch (err) {
      console.error('Failed to load messages', err);
      setMessages([{ id: 'error', role: 'system', content: 'Failed to load message history.' }]);
    }
  }, [model]);

  const deleteSession = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
      const res = await fetch(`/api/sessions?sessionId=${id}&model=${model}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        setHistory(prev => prev.filter(s => s.sessionId !== id));
        if (sessionId === id) {
          startNewChat();
        }
      }
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  }, [model, sessionId, startNewChat]);

  const handleFileUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload/screenshot', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        setAttachments(prev => [...prev, { name: data.name, path: data.path, type: file.type }]);
      }
    } catch (err) {
      console.error('Upload failed', err);
    }
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFileUpload]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          // Rename file to a more useful name if it's generic 'image.png'
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          handleFileUpload(renamedFile);
        }
      }
    }
  }, [handleFileUpload]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(() => {
    if (!input.trim() && attachments.length === 0) return;
    const text = input.trim();
    const currentAttachments = [...attachments];
    setInput('');
    setAttachments([]);
    
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      status: 'pending',
      attachments: currentAttachments
    }]);
    
    setQueue(prev => [...prev, { text, attachments: currentAttachments }]);
  }, [input, attachments]);

  const processMessage = useCallback(async (text: string, currentAttachments: Attachment[]) => {
    setIsProcessing(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, model, attachments: currentAttachments })
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const assistantMsgId = Date.now().toString() + '-assistant';
      
      setMessages(prev => [...prev, {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        status: 'sending'
      }]);

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
            const event = JSON.parse(line);
            if (event.success && event.initialEvent) {
                handleEvent(event.initialEvent, assistantMsgId, (content, type, status) => {
                    fullContent += content;
                    updateAssistantMessage(assistantMsgId, fullContent, type, status);
                });
            } else {
                handleEvent(event, assistantMsgId, (content, type, status) => {
                    fullContent += content;
                    updateAssistantMessage(assistantMsgId, fullContent, type, status);
                });
            }
          } catch {
              // Try to handle raw text if not JSON
              if (line.trim()) {
                  fullContent += line + '\n';
                  updateAssistantMessage(assistantMsgId, fullContent, 'text', 'sending');
              }
          }
        }
      }
      
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, status: 'sent' } : m));
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'system',
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        status: 'error'
      }]);
    } finally {
      setIsProcessing(false);
    }
  }, [sessionId, model, handleEvent, updateAssistantMessage]);

  useEffect(() => {
    if (!isProcessing && queue.length > 0) {
      const next = queue[0];
      setQueue(prev => prev.slice(1));
      processMessage(next.text, next.attachments);
    }
  }, [isProcessing, queue, processMessage]);

  const handleModelChange = (newModel: AIModel) => {
      setModel(newModel);
      setSessionId(null);
      setMessages([]);
      setShowHistory(false);
  };

  return (
    <div className="flex flex-col h-full bg-card text-card-foreground relative overflow-hidden">
      {/* Header */}
      <div className="z-10 flex items-center justify-between border-b border-border bg-background/95 p-2">
        <div className="flex items-center gap-2 min-w-0">
            {showHistory ? (
                <button onClick={() => setShowHistory(false)} className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"><ChevronLeft /></button>
            ) : (
                <button onClick={() => { setShowHistory(true); fetchHistory(model); }} className="border border-transparent p-1 transition-colors hover:border-border hover:bg-accent"><History size={20} /></button>
            )}
            <div className="flex flex-col min-w-0">
                <span className="text-[10px] uppercase font-bold text-muted-foreground leading-none mb-1">{showHistory ? 'History' : 'Chat'}</span>
                <div className="flex items-center gap-1.5 border border-border bg-muted/70 px-2 py-0.5">
                    <select 
                        value={model} 
                        onChange={(e) => handleModelChange(e.target.value as AIModel)}
                        className="bg-transparent text-xs font-bold focus:outline-none appearance-none cursor-pointer hover:text-primary pr-1"
                    >
                        {AGENT_CATALOG.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.label}
                          </option>
                        ))}
                    </select>
                    {!showHistory && sessionId && <span className="text-[10px] text-muted-foreground border-l border-border pl-1.5">#{sessionId.substring(0,4)}</span>}
                </div>
            </div>
        </div>
        <div className="flex items-center gap-1">
            <button 
              onClick={startNewChat} 
              className="group flex items-center gap-1.5 border border-primary/30 bg-primary/15 p-1.5 text-primary transition-all hover:bg-primary/25" 
              title="New Chat"
            >
              <Plus size={18} />
              <span className="text-xs font-bold hidden sm:inline group-hover:inline-block">New</span>
            </button>
            {onClose && (
              <button 
                onClick={onClose}
                className="border border-transparent p-1.5 text-muted-foreground transition-all hover:border-border hover:bg-accent"
                title="Close Chat"
              >
                <X size={18} />
              </button>
            )}
        </div>
      </div>

      {/* Model Disclaimer */}
      {model === 'gemini' && !showHistory && (
          <div className="flex items-center gap-2 border-b border-border bg-accent/35 p-1.5 px-3 text-[10px] text-muted-foreground">
              <AlertTriangle size={12} className="shrink-0 text-primary" />
              <span>Note: Gemini integration is experimental and may contain bugs.</span>
          </div>
      )}

      <div className="flex-1 relative">
        {/* History View */}
        {showHistory && (
            <div className="absolute inset-0 bg-background z-20 overflow-y-auto p-2 space-y-1 pb-20">
                <div className="px-2 py-2 text-[10px] font-bold text-muted-foreground uppercase flex items-center gap-2 tracking-widest border-b border-border mb-2">
                    <History size={10} /> {model} sessions
                </div>
                {history.length === 0 && <div className="text-center p-8 text-muted-foreground text-sm italic">No recent sessions for {model}</div>}
                {history.map((s) => (
                    <button 
                        key={s.id} 
                        onClick={() => loadSession(s.sessionId)}
                        className="group mb-1 flex w-full items-center justify-between border border-transparent bg-muted/30 p-3 text-left transition-all hover:border-border hover:bg-accent"
                    >
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate group-hover:text-primary text-foreground">{s.title || 'Untitled Session'}</div>
                            <div className="text-[10px] text-muted-foreground mt-1">{new Date(s.createdAt).toLocaleString()}</div>
                        </div>
                        <div 
                            onClick={(e) => deleteSession(e, s.sessionId)}
                            className="ml-2 shrink-0 border border-transparent p-2.5 text-muted-foreground opacity-100 transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
                            title="Delete Session"
                        >
                            <Trash2 size={16} />
                        </div>
                    </button>
                ))}
            </div>
        )}

        {/* Messages View */}
        <div 
          ref={scrollContainerRef}
          className="absolute inset-0 overflow-y-auto p-4 space-y-4 pb-24 scroll-smooth"
        >
            {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4 opacity-40">
                    {model === 'claude' && <Sparkles size={48} />}
                    {model === 'gemini' && <Cpu size={48} />}
                    {model === 'codex' && <Code size={48} />}
                    {model === 'openrouter' && <Globe size={48} />}
                    <div className="text-center">
                        <p className="text-sm font-bold uppercase tracking-widest mb-1">{model} Agent</p>
                        <p className="text-[11px] italic px-8">Ask {model} to help with your project</p>
                    </div>
                </div>
            )}
            {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[95%] border p-3 sm:max-w-[90%] ${ 
                msg.role === 'user' ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 
                msg.role === 'assistant' ? 'bg-muted border-border text-foreground' : 'border-destructive/40 bg-destructive/10 text-destructive'
                }`}> 
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">{msg.role === 'assistant' ? model : msg.role}</span>
                    {msg.status === 'sending' && <span className="h-1.5 w-1.5 animate-pulse bg-primary" />} 
                </div>
                <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                    {msg.content || (msg.status === 'sending' ? `${model} is processing...` : '')}
                </div>
                {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {msg.attachments.map((a, i) => (
                          <div key={i} className="flex items-center gap-1.5 border border-border bg-background/50 p-1.5 px-2.5 text-[10px]">
                          <ImageIcon className="h-3 w-3" /> {a.name}
                          </div>
                      ))}
                    </div>
                )}
                </div>
            </div>
            ))}
            <div ref={messagesEndRef} />
        </div>

        {/* Scroll to Bottom Button */}
        {!isAtBottom && messages.length > 0 && (
          <button 
            onClick={() => scrollToBottom()}
            className="absolute bottom-28 right-4 z-30 border border-primary/30 bg-primary p-2 text-primary-foreground shadow-sm transition-all hover:bg-primary/90"
            title="Scroll to bottom"
          >
            <ArrowDown size={20} />
          </button>
        )}
      </div>

      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 p-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 border border-border bg-muted/60 p-2">
            {attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs">
                 <ImageIcon className="h-3.5 w-3.5" /> {a.name}
                 <button onClick={() => removeAttachment(i)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent"
            disabled={model === 'codex' || model === 'openrouter'}
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*" />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Ask ${model}... (Paste images supported)`}
            className="max-h-32 min-h-[44px] flex-1 resize-none border border-border bg-background p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={handleSend}
            className="flex-shrink-0 bg-primary p-2.5 text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-30"
            disabled={!input.trim() && attachments.length === 0}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
                <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        {queue.length > 0 && (
          <div className="mt-2 text-[10px] text-muted-foreground flex items-center gap-2 px-1">
            <span className="h-1 w-1 animate-ping bg-primary" />
            {queue.length} in queue
          </div>
        )}
      </div>
    </div>
  );
}
