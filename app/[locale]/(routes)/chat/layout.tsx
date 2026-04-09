'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SessionSidebar } from '@/app/components/chat/SessionSidebar';
import type { AISession } from '@/app/components/chat/SessionSidebar';

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 280;

interface ChatLayoutProps {
  children: React.ReactNode;
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width));
}

function getInitialSidebarWidth() {
  const storedWidth = Number(window.localStorage.getItem('canvas.chatSidebarWidth'));
  if (Number.isFinite(storedWidth)) {
    return clampSidebarWidth(storedWidth);
  }
  return SIDEBAR_DEFAULT;
}

export default function ChatLayout({ children }: ChatLayoutProps) {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const isResizing = useRef(false);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  // Save sidebar width
  useEffect(() => {
    window.localStorage.setItem('canvas.chatSidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  // Handle viewport changes
  useEffect(() => {
    const handleViewport = () => {
      const isMobile = window.innerWidth < 768;
      setViewportMode(isMobile ? 'mobile' : 'desktop');
      setSidebarWidth((prev) => clampSidebarWidth(prev));
      if (isMobile) {
        setSidebarVisible(false);
      } else {
        setSidebarVisible(true);
      }
    };

    handleViewport();
    window.addEventListener('resize', handleViewport);
    return () => window.removeEventListener('resize', handleViewport);
  }, []);

  // Handle session selection from sidebar
  useEffect(() => {
    const handleSessionSelect = (event: CustomEvent<{ sessionId: string }>) => {
      setCurrentSessionId(event.detail.sessionId);
      // Force re-render of SessionSidebar to update active state
      setSessionKey((prev) => prev + 1);
    };

    const handleNewSession = () => {
      setCurrentSessionId(null);
      setSessionKey((prev) => prev + 1);
    };

    const handleToggleMobileSidebar = () => {
      setMobileSidebarOpen((prev) => !prev);
    };

    const handleToggleSidebar = () => {
      setSidebarVisible((prev) => !prev);
    };

    window.addEventListener('chat-session-selected', handleSessionSelect as EventListener);
    window.addEventListener('chat-new-session', handleNewSession);
    window.addEventListener('chat-toggle-mobile-sidebar', handleToggleMobileSidebar);
    window.addEventListener('chat-toggle-sidebar', handleToggleSidebar);
    
    return () => {
      window.removeEventListener('chat-session-selected', handleSessionSelect as EventListener);
      window.removeEventListener('chat-new-session', handleNewSession);
      window.removeEventListener('chat-toggle-mobile-sidebar', handleToggleMobileSidebar);
      window.removeEventListener('chat-toggle-sidebar', handleToggleSidebar);
    };
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current || !sidebarResizeRef.current) return;
    const nextWidth = clampSidebarWidth(
      sidebarResizeRef.current.startWidth + (e.clientX - sidebarResizeRef.current.startX)
    );
    setSidebarWidth(nextWidth);
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    sidebarResizeRef.current = null;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  const startResizing = useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    sidebarResizeRef.current = {
      startX: e.clientX,
      startWidth: sidebarWidth,
    };
  }, [sidebarWidth]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizing.current) {
        handleMouseMove(e);
      }
    };

    const handleGlobalMouseUp = () => {
      if (isResizing.current) {
        stopResizing();
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [handleMouseMove, stopResizing]);

  const handleSessionSelect = useCallback((session: AISession) => {
    setCurrentSessionId(session.sessionId);
    window.dispatchEvent(
      new CustomEvent('chat-session-selected', {
        detail: { sessionId: session.sessionId },
      })
    );
  }, []);

  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    setSessionKey((prev) => prev + 1);
    window.dispatchEvent(new CustomEvent('chat-new-session'));
  }, []);

  const isMobile = viewportMode === 'mobile';
  const isDesktop = viewportMode === 'desktop';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Chat Content (with integrated header) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Sidebar */}
        {isDesktop && sidebarVisible && (
          <>
            <SessionSidebar
              key={sessionKey}
              currentSessionId={currentSessionId}
              onSessionSelect={handleSessionSelect}
              sidebarWidth={sidebarWidth}
              isMobile={false}
              onToggleSidebar={() => setSidebarVisible((prev) => !prev)}
            />
            {/* Resize Handle */}
            <div
              aria-label="Resize sidebar"
              className="flex w-1 cursor-col-resize items-center justify-center bg-border transition-all hover:w-1.5 hover:bg-primary/60"
              onMouseDown={startResizing}
            >
              <div className="h-8 w-0.5 bg-muted-foreground/60" />
            </div>
          </>
        )}

        {/* Chat Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {children}
        </div>
      </div>

      {/* Mobile Sidebar (Sheet/Drawer) */}
      {isMobile && (
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-full max-w-none gap-0 border-r p-0"
          >
            <SessionSidebar
              key={sessionKey}
              currentSessionId={currentSessionId}
              onSessionSelect={handleSessionSelect}
              onNewChat={handleNewChat}
              sidebarWidth={window.innerWidth}
              isMobile={true}
              onClose={() => setMobileSidebarOpen(false)}
              onToggleSidebar={() => setMobileSidebarOpen(false)}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
