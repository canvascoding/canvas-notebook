// app/components/claude-chat/ClaudeChat.tsx
'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Paperclip, X, Image as ImageIcon, History, Plus, MessageSquare, ChevronLeft } from 'lucide-react';

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

interface ClaudeSession {
  id: number;
  sessionId: string;
  title: string;
  createdAt: string;
}

export default function ClaudeChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [queue, setQueue] = useState<{text: string, attachments: Attachment[]}[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ClaudeSession[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!isProcessing && queue.length > 0) {
      const next = queue[0];
      setQueue(prev => prev.slice(1));
      processMessage(next.text, next.attachments);
    }
  }, [isProcessing, queue]);

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/claude/sessions');
      const data = await res.json();
      if (data.success) setHistory(data.sessions);
    } catch (err) {
      console.error('Failed to fetch history', err);
    }
  };

  const startNewChat = () => {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
  };

  const loadSession = async (id: string) => {
    setSessionId(id);
    setMessages([{ id: 'system', role: 'system', content: `Loading session ${id.substring(0,8)}...` }]);
    setShowHistory(false);

    try {
      const res = await fetch(`/api/claude/sessions/messages?sessionId=${id}`);
      const data = await res.json();
      if (data.success && data.messages) {
        setMessages(data.messages.map((m: any) => ({
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
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
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
  };

  const processMessage = async (text: string, currentAttachments: Attachment[]) => {
    setIsProcessing(true);
    let messageToClaude = text;
    if (currentAttachments.length > 0) {
      const attachmentRefs = currentAttachments.map(a => `[Attached Image: ${a.path}]`).join('\n');
      messageToClaude = `${text}\n\n${attachmentRefs}`.trim();
    }

    try {
      const response = await fetch('/api/claude/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageToClaude, sessionId })
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
          } catch (e) {}
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
  };

  const handleEvent = (event: any, msgId: string, updateFn: (content: string, type?: string, status?: any) => void) => {
    if (event.type === 'assistant' && event.message?.content) {
      for (const part of event.message.content) {
        if (part.type === 'text') {
          updateFn(part.text, 'text');
        } else if (part.type === 'tool_use') {
          if (part.name === 'Bash') {
            const cmd = part.input.command;
            updateFn('\n```bash\n$ ' + cmd + '\n```\n', 'tool_use');
          } else {
            updateFn('\n[Tool: ' + part.name + ']\n', 'tool_use');
          }
        }
      }
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
       setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: event.result, status: 'sent', type: 'result' } : m));
    }
    
    if (event.session_id) setSessionId(event.session_id);
    if (event.sessionId) setSessionId(event.sessionId);
  };

  const updateAssistantMessage = (id: string, content: string, type?: string, status?: any) => {
    setMessages(prev => prev.map(m => 
      m.id === id ? { ...m, content, type: type || m.type, status: status || m.status } : m
    ));
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 relative overflow-hidden">
      {/* Header */}
      <div className="p-2 border-b border-slate-700 flex justify-between items-center bg-slate-800/50 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
            {showHistory ? (
                <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-slate-700 rounded"><ChevronLeft /></button>
            ) : (
                <button onClick={() => { setShowHistory(true); fetchHistory(); }} className="p-1 hover:bg-slate-700 rounded"><History size={20} /></button>
            )}
            <span className="text-sm font-bold tracking-tight">{showHistory ? 'History' : (sessionId ? `Session ${sessionId.substring(0,6)}` : 'New Chat')}</span>
        </div>
        <button onClick={startNewChat} className="p-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg transition-all" title="New Chat"><Plus size={18} /></button>
      </div>

      <div className="flex-1 relative">
        {/* History View */}
        {showHistory && (
            <div className="absolute inset-0 bg-slate-900 z-20 overflow-y-auto p-2 space-y-1">
                {history.length === 0 && <div className="text-center p-8 text-slate-500 text-sm italic">No recent sessions</div>}
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
        <div className="absolute inset-0 overflow-y-auto p-4 space-y-4 pb-24">
            {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4 opacity-40">
                    <MessageSquare size={48} />
                    <p className="text-sm text-center px-8 italic">Ask Claude to help with your project</p>
                </div>
            )}
            {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[95%] sm:max-w-[90%] p-3 rounded-2xl ${ 
                msg.role === 'user' ? 'bg-blue-600 shadow-lg' : 
                msg.role === 'assistant' ? 'bg-slate-800 border border-slate-700' : 'bg-red-900/30 border border-red-800/50'
                }`}> 
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">{msg.role}</span>
                    {msg.status === 'sending' && <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />} 
                </div>
                <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                    {msg.content || (msg.status === 'sending' ? 'Claude is processing...' : '')}
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
      </div>

      {/* Input Area */}
      <div className="p-3 bg-slate-800/80 backdrop-blur-md border-t border-slate-700 absolute bottom-0 left-0 right-0">
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
            placeholder="Ask Claude..."
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
