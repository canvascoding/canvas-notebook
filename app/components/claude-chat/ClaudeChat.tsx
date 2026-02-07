'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Paperclip, X, Image as ImageIcon, History, Plus, MessageSquare, ChevronLeft, ArrowDown, AlertTriangle, Cpu, Sparkles, Code } from 'lucide-react';

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
  message?: {
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
}

type UpdateFunction = (content: string, type?: string, status?: ChatMessage['status']) => void;

type AIModel = 'claude' | 'gemini' | 'codex';

export default function ClaudeChat() {
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
    if ((event.type === 'assistant' || event.type === 'message') && event.message?.content) {
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
    else if (event.type === 'error' && (event as any).message) {
       updateFn(`[Error] ${(event as any).message}`, 'system', 'error');
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
        setMessages(data.messages.map((m: {id: any, role: any, content: string, type: string}) => ({
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

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/claude/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        setAttachments(prev => [...prev, { name: data.name, path: data.path, type: file.type }]);
      }
    } catch (err) {
      console.error('Upload failed', err);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

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
    let messageToAI = text;
    if (currentAttachments.length > 0) {
      const attachmentRefs = currentAttachments.map(a => `[Attached Image: ${a.path}]`).join('\n');
      messageToAI = `${text}\n\n${attachmentRefs}`.trim();
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageToAI, sessionId, model })
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
          } catch (e) {
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
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 relative overflow-hidden">
      {/* Header */}
      <div className="p-2 border-b border-slate-700 flex justify-between items-center bg-slate-800/50 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
            {showHistory ? (
                <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-slate-700 rounded"><ChevronLeft /></button>
            ) : (
                <button onClick={() => { setShowHistory(true); fetchHistory(model); }} className="p-1 hover:bg-slate-700 rounded"><History size={20} /></button>
            )}
            <div className="flex flex-col">
                <span className="text-[10px] uppercase font-bold text-slate-500 leading-none mb-0.5">{showHistory ? 'History' : 'Chat'}</span>
                <div className="flex items-center gap-1.5">
                    <select 
                        value={model} 
                        onChange={(e) => handleModelChange(e.target.value as AIModel)}
                        className="bg-transparent text-xs font-bold focus:outline-none appearance-none cursor-pointer hover:text-blue-400"
                    >
                        <option value="claude">Claude</option>
                        <option value="gemini">Gemini</option>
                        <option value="codex">Codex</option>
                    </select>
                    {!showHistory && sessionId && <span className="text-[10px] text-slate-600">#{sessionId.substring(0,4)}</span>}
                </div>
            </div>
        </div>
        <div className="flex items-center gap-1">
            <button onClick={startNewChat} className="p-1.5 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded-lg transition-all" title="New Chat"><Plus size={18} /></button>
        </div>
      </div>

      {/* Model Disclaimer */}
      {(model === 'gemini' || model === 'codex') && !showHistory && (
          <div className="bg-amber-950/30 border-b border-amber-900/50 p-1.5 px-3 flex items-center gap-2 text-[10px] text-amber-200/70">
              <AlertTriangle size={12} className="text-amber-500" />
              <span>Note: {model === 'gemini' ? 'Gemini' : 'Codex'} integration is experimental and may contain bugs.</span>
          </div>
      )}

      <div className="flex-1 relative">
        {/* History View */}
        {showHistory && (
            <div className="absolute inset-0 bg-slate-900 z-20 overflow-y-auto p-2 space-y-1">
                <div className="px-2 py-1 text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2">
                    <History size={10} /> {model} sessions
                </div>
                {history.length === 0 && <div className="text-center p-8 text-slate-500 text-sm italic">No recent sessions for {model}</div>}
                {history.map((s) => (
                    <button 
                        key={s.id} 
                        onClick={() => loadSession(s.sessionId)}
                        className="w-full text-left p-3 hover:bg-slate-800 rounded-xl border border-transparent hover:border-slate-700 transition-all group"
                    >
                        <div className="text-sm font-medium truncate group-hover:text-blue-400">{s.title || 'Untitled Session'}</div>
                        <div className="text-[10px] text-slate-500 mt-1">{new Date(s.createdAt).toLocaleString()}</div>
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
                <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4 opacity-40">
                    {model === 'claude' && <Sparkles size={48} />}
                    {model === 'gemini' && <Cpu size={48} />}
                    {model === 'codex' && <Code size={48} />}
                    <div className="text-center">
                        <p className="text-sm font-bold uppercase tracking-widest mb-1">{model} Agent</p>
                        <p className="text-[11px] italic px-8">Ask {model} to help with your project</p>
                    </div>
                </div>
            )}
            {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[95%] sm:max-w-[90%] p-3 rounded-2xl ${ 
                msg.role === 'user' ? 'bg-blue-600 shadow-lg' : 
                msg.role === 'assistant' ? 'bg-slate-800 border border-slate-700' : 'bg-red-900/30 border border-red-800/50'
                }`}> 
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">{msg.role === 'assistant' ? model : msg.role}</span>
                    {msg.status === 'sending' && <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />} 
                </div>
                <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                    {msg.content || (msg.status === 'sending' ? `${model} is processing...` : '')}
                </div>
                {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                    {msg.attachments.map((a, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-black/30 p-1.5 px-2.5 rounded-md text-[10px] border border-white/5">
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
            className="absolute bottom-28 right-4 p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg z-30 transition-all animate-bounce border border-blue-400/30"
            title="Scroll to bottom"
          >
            <ArrowDown size={20} />
          </button>
        )}
      </div>

      {/* Input Area */}
      <div className="p-3 bg-slate-800/80 backdrop-blur-md border-t border-slate-700 absolute bottom-0 left-0 right-0 z-20">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 p-2 bg-slate-950/40 rounded-lg">
            {attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-2 bg-slate-700/50 p-1 px-2 rounded-md text-xs">
                 <ImageIcon className="h-3.5 w-3.5" /> {a.name}
                 <button onClick={() => removeAttachment(i)} className="hover:text-red-400"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 hover:bg-slate-700 rounded-lg transition-colors text-slate-400"
            disabled={model === 'codex'} // Codex might not support images in headless mode as easily
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*" />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Ask ${model}...`}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[44px] max-h-32"
          />
          <button
            onClick={handleSend}
            className="bg-blue-600 hover:bg-blue-500 p-2.5 rounded-xl transition-all disabled:opacity-30 flex-shrink-0"
            disabled={!input.trim() && attachments.length === 0}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
                <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        {queue.length > 0 && (
          <div className="mt-2 text-[10px] text-slate-500 flex items-center gap-2 px-1">
            <span className="w-1 h-1 bg-blue-500 rounded-full animate-ping" />
            {queue.length} in queue
          </div>
        )}
      </div>
    </div>
  );
}