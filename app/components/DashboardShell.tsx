"use client";

import { useState } from 'react';
import Image from 'next/image';
import { PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoutButton } from '@/app/components/LogoutButton';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { AppLayout } from '@/app/components/layout/AppLayout';

interface DashboardShellProps {
  username: string;
}

export function DashboardShell({ username }: DashboardShellProps) {
  const [sidebarHidden, setSidebarHidden] = useState(false);

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
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Image src="/canvas-notebook-logo.png" alt="Canvas Notebook logo" width={32} height={32} />
            <h1 className="text-2xl font-bold">Canvas Notebook</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">Welcome, {username}</span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <AppLayout
          sidebar={<FileBrowser />}
          sidebarHidden={sidebarHidden}
          main={
            <div className="h-full border-l border-slate-700 bg-slate-900/80">
              <FileEditor />
            </div>
          }
          terminal={<TerminalPanel />}
        />
      </main>
    </div>
  );
}
