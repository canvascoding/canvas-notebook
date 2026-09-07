import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MarkdownEditor } from '../../app/components/editor/MarkdownEditor';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkspaceStore } from '../../app/store/workspace-store';
import { initialMarkdown } from './markdown-migration-session';
import messages from '../../messages/en.json';

useWorkspaceStore.setState({ activeWorkspaceId: 'migration-workspace' });
function App() {
  const [value, setValue] = useState(initialMarkdown);
  return <NextIntlClientProvider locale="en" messages={messages}><TooltipProvider>
    <MarkdownEditor value={value} onChange={setValue} filePath="copy.md"
      readOnly={location.search.includes('read-only')}
      collaborationEnabled={!location.search.includes('local')} layout="field" />
    <pre id="saved-value" hidden>{value}</pre>
  </TooltipProvider></NextIntlClientProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
