import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { MarkdownEditor } from '../../app/components/editor/MarkdownEditor';
import { AppThemeProvider } from '../../app/components/ThemeProvider';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkspaceStore } from '../../app/store/workspace-store';
import messages from '../../messages/en.json';

declare global {
  interface Window {
    modePositionFixture: { content: string; initialMode: 'read' | 'rich' | 'source' };
  }
}

useWorkspaceStore.setState({ activeWorkspaceId: null });
const router = {
  bfcacheId: 'local-mode-position-fixture',
  back: () => history.back(), forward: () => history.forward(), refresh: () => location.reload(),
  push: (href: string) => history.pushState(null, '', href),
  replace: (href: string) => history.replaceState(null, '', href), prefetch: async () => {},
};

function App() {
  const [value, setValue] = useState(window.modePositionFixture.content);
  const [mode, setMode] = useState(window.modePositionFixture.initialMode);
  return <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
    <AppRouterContext.Provider value={router}><PathnameContext.Provider value="/notebook">
    <AppThemeProvider><TooltipProvider>
      <main style={{ height: '100dvh', overflow: 'hidden' }}>
        <MarkdownEditor value={value} onChange={setValue} filePath="local-mode-position.md"
          documentKey="local-mode-position" collaborationEnabled={false} mode={mode} onModeChange={setMode} />
      </main>
      <pre data-testid="local-saved-markdown" hidden>{value}</pre>
    </TooltipProvider></AppThemeProvider>
    </PathnameContext.Provider></AppRouterContext.Provider>
  </NextIntlClientProvider>;
}

createRoot(document.getElementById('root')!).render(<App />);
