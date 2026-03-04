"use client";

import { useState, useRef, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { PanelLeft, MessageSquare, X, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarProvider } from '@/components/ui/sidebar';
import { LogoutButton } from '@/app/components/LogoutButton';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { AppLayout } from '@/app/components/layout/AppLayout';
import ClaudeChat from '@/app/components/claude-chat/ClaudeChat';
import { ThemeToggle } from '@/app/components/ThemeToggle';

interface DashboardShellProps {
  username: string;
}

export function DashboardShell({ username }: DashboardShellProps) {
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 768
  );
  const [chatVisible, setChatVisible] = useState(false);
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
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 md:z-40 h-16 flex-shrink-0 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button
              variant={sidebarVisible ? "default" : "ghost"}
              size="icon-sm"
              onClick={() => setSidebarVisible((prev) => !prev)}
              aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Image src="/logo.jpg" alt="Canvas Notebook logo" width={32} height={32} className="rounded-md shrink-0" />
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">CANVAS STUDIOS</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <ThemeToggle />
            <Button
              variant={terminalVisible ? "default" : "ghost"}
              size="sm"
              onClick={() => setTerminalVisible(!terminalVisible)}
              className="gap-2 px-2 sm:px-3"
            >
              <TerminalIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Terminal</span>
            </Button>
            <Button
              variant={chatVisible ? "default" : "ghost"}
              size="sm"
              onClick={() => setChatVisible(!chatVisible)}
              className="gap-2 px-2 sm:px-3"
            >
              <MessageSquare className="h-4 w-4" />
              <span className="hidden sm:inline">AI Chat</span>
            </Button>
            <div className="hidden lg:flex flex-col items-end shrink-0">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">User</span>
                <span className="text-xs text-foreground/90">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden relative">
        {/* Mobile Sidebar Overlay */}
        {sidebarVisible && (
          <div 
            className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-[70] transition-opacity duration-300"
            onClick={() => setSidebarVisible(false)}
          />
        )}

        {/* Sidebar Container - Sliding on mobile, fixed on desktop */}
        <div className={`
          fixed md:relative top-0 left-0 bottom-0 z-[80] md:z-auto
          w-[280px] flex-shrink-0 bg-card border-r border-border
          transition-all duration-300 ease-in-out
          ${sidebarVisible 
            ? 'translate-x-0 opacity-100' 
            : '-translate-x-full md:hidden opacity-0 pointer-events-none'
          }
        `}>
          <div className="flex flex-col h-full">
            <div className="md:hidden p-4 border-b border-border flex justify-between items-center bg-muted/40">
              <span className="font-bold text-sm tracking-widest uppercase opacity-70 text-foreground">Files</span>
              <button onClick={() => setSidebarVisible(false)} className="p-1 hover:bg-accent rounded-full">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <SidebarProvider className="h-full min-h-0">
                <FileBrowser />
              </SidebarProvider>
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 h-full flex flex-col relative">
          <AppLayout
            sidebar={<div />} // Handled manually for better mobile control
            sidebarHidden={true}
            terminalVisible={terminalVisible && (typeof window === 'undefined' || window.innerWidth >= 768)}
            main={
              <div className="flex h-full w-full overflow-hidden relative">
                {/* Main Editor Area */}
                <div className="flex-1 min-w-0 bg-background">
                  <FileEditor />
                </div>

                {/* Mobile Chat Backdrop Overlay */}
                {chatVisible && (
                  <div 
                    className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-[70] transition-opacity duration-300"
                    onClick={() => setChatVisible(false)}
                  />
                )}

                {/* Resize Handle - Desktop Only */}
                {chatVisible && (
                  <div 
                    onMouseDown={startResizing}
                    className="hidden md:flex w-1 hover:w-1.5 bg-border hover:bg-primary/60 cursor-col-resize z-50 transition-all items-center justify-center"
                  >
                    <div className="w-0.5 h-8 bg-muted-foreground/60 rounded-full" />
                  </div>
                )}

                {/* Chat Panel - Responsive Sliding Implementation */}
                <div 
                  style={{ 
                    width: typeof window !== 'undefined' && window.innerWidth < 768 ? 'min(90%, 400px)' : (chatVisible ? `${chatWidth}px` : '0px')
                  }}
                  className={`
                    fixed md:relative top-0 right-0 bottom-0 z-[80] md:z-auto
                    flex-shrink-0 bg-card md:bg-background md:border-l md:border-border
                    transition-all duration-300 ease-in-out
                    ${chatVisible 
                      ? 'translate-x-0 opacity-100' 
                      : 'translate-x-full md:translate-x-0 opacity-0 md:opacity-100 overflow-hidden pointer-events-none md:w-0 md:border-none'
                    }
                  `}
                >
                  <div className="flex flex-col w-full h-full relative">
                      <ClaudeChat onClose={() => setChatVisible(false)} />
                  </div>
                </div>
              </div>
            }
            terminal={<TerminalPanel />}
          />

          {/* Fullscreen Mobile Terminal */}
          {terminalVisible && (
            <div className="md:hidden fixed inset-0 z-[100] bg-background flex flex-col">
              <div className="flex items-center justify-between p-2 bg-card border-b border-border">
                <div className="flex items-center gap-2 px-2">
                  <TerminalIcon size={14} className="text-blue-400" />
                  <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Terminal</span>
                </div>
                <button 
                  onClick={() => setTerminalVisible(false)}
                  className="p-2 hover:bg-accent rounded-full text-muted-foreground"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-hidden pb-safe">
                <TerminalPanel />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
