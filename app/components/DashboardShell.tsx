"use client";

import { useState, useRef, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { PanelLeft, MessageSquare, X, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/app/components/LogoutButton';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { AppLayout } from '@/app/components/layout/AppLayout';
import ClaudeChat from '@/app/components/claude-chat/ClaudeChat';

interface DashboardShellProps {
  username: string;
}

export function DashboardShell({ username }: DashboardShellProps) {
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const isResizing = useRef(false);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth > 300 && newWidth < 800) {
      setChatWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  // Use useEffect to manage global listeners when resizing is active
  useEffect(() => {
    const handleMouseUp = () => {
      if (isResizing.current) stopResizing();
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizing.current) handleMouseMove(e);
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, stopResizing]);

  const startResizing = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-slate-900 text-white">
      <header className="z-40 h-16 flex-shrink-0 border-b border-slate-700 bg-slate-800/80 backdrop-blur-sm">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarHidden((prev) => !prev)}
              aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
              className="hidden md:flex"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Image src="/logo.jpg" alt="Canvas Notebook logo" width={32} height={32} className="rounded-md" />
            <h1 className="text-xl md:text-2xl font-bold truncate">CANVAS STUDIOS</h1>
          </div>
          <div className="flex items-center gap-2 md:gap-4">
            <Button
              variant={terminalVisible ? "default" : "ghost"}
              size="sm"
              onClick={() => setTerminalVisible(!terminalVisible)}
              className="gap-2"
            >
              <Terminal className="h-4 w-4" />
              <span className="hidden sm:inline">Terminal</span>
            </Button>
            <Button
              variant={chatVisible ? "default" : "ghost"}
              size="sm"
              onClick={() => setChatVisible(!chatVisible)}
              className="gap-2"
            >
              <MessageSquare className="h-4 w-4" />
              <span className="hidden sm:inline">AI Chat</span>
            </Button>
            <div className="hidden sm:flex flex-col items-end">
                <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">User</span>
                <span className="text-xs text-slate-300">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden relative">
        <AppLayout
          sidebar={<FileBrowser />}
          sidebarHidden={sidebarHidden}
          terminalVisible={terminalVisible}
          main={
            <div className="flex h-full w-full overflow-hidden relative">
              {/* Main Editor Area */}
              <div className="flex-1 min-w-0 border-l border-slate-700 bg-slate-900/80">
                <FileEditor />
              </div>

              {/* Resize Handle */}
              {chatVisible && (
                <div 
                  onMouseDown={startResizing}
                  className="hidden md:flex w-1 hover:w-1.5 bg-slate-700 hover:bg-blue-500 cursor-col-resize z-50 transition-all items-center justify-center"
                >
                  <div className="w-0.5 h-8 bg-slate-500 rounded-full" />
                </div>
              )}

              {/* Chat Panel - Responsive Implementation */}
              <div 
                style={{ width: chatVisible ? (typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : `${chatWidth}px`) : '0px' }}
                className={`
                  ${chatVisible ? 'flex' : 'hidden'} 
                  absolute inset-0 z-50 md:relative md:inset-auto 
                  flex-shrink-0 
                  bg-slate-950 md:bg-transparent md:border-l md:border-slate-700
                  transition-[width] duration-0
                `}
              >
                <div className="flex flex-col w-full h-full relative">
                    {/* Mobile Close Button */}
                    <button 
                        onClick={() => setChatVisible(false)}
                        className="md:hidden absolute top-2 right-2 z-[60] p-2 bg-slate-800 rounded-full text-white shadow-xl border border-slate-700"
                    >
                        <X size={20} />
                    </button>
                    <ClaudeChat />
                </div>
              </div>
            </div>
          }
          terminal={<TerminalPanel />}
        />
      </main>
    </div>
  );
}
